import pool from "../db";

export type MapRevisionAction = "edit" | "undo" | "redo" | "rollback" | "publish";

export interface TileOverrideDelta {
    x: number;
    y: number;
    layer: number;
    grhIndex: number | null;
    blocked: boolean | null;
    prevGrhIndex?: number | null;
    prevBlocked?: boolean | null;
}

export interface MapRevisionRecord {
    id: string;
    mapNum: number;
    revisionNum: number;
    action: MapRevisionAction;
    delta: TileOverrideDelta[];
    snapshot: Record<string, unknown> | null;
    authorAccountId: string | null;
    createdAt: Date;
}

export interface MapDiffChange {
    x: number;
    y: number;
    layer: number;
    before: { grhIndex: number | null; blocked: boolean | null };
    after: { grhIndex: number | null; blocked: boolean | null };
}

export interface MapDiffResult {
    mapNum: number;
    revA: number;
    revB: number;
    changes: MapDiffChange[];
}

export const SNAPSHOT_FREQUENCY = 20;

export async function getNextRevisionNum(mapNum: number): Promise<number> {
    const query = `
        SELECT COALESCE(MAX(revision_num), 0) + 1 AS next_rev
        FROM game_map_revisions
        WHERE map_num = $1
    `;
    const result = await pool.query<{ next_rev: string }>(query, [mapNum]);
    return Number.parseInt(result.rows[0]?.next_rev ?? "1", 10);
}

export async function recordMapRevision(
    mapNum: number,
    action: MapRevisionAction,
    delta: TileOverrideDelta[],
    authorAccountId?: string | null,
    fullSnapshot?: Record<string, unknown> | null,
): Promise<MapRevisionRecord> {
    const revisionNum = await getNextRevisionNum(mapNum);

    const shouldSaveSnapshot =
        fullSnapshot || (revisionNum % SNAPSHOT_FREQUENCY === 0);

    const snapshotPayload = shouldSaveSnapshot ? (fullSnapshot ?? { mapNum, revisionNum, delta }) : null;

    const query = `
        INSERT INTO game_map_revisions (
            map_num, revision_num, action, delta, snapshot, author_account_id, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING id, map_num, revision_num, action, delta, snapshot, author_account_id, created_at
    `;

    const result = await pool.query(query, [
        mapNum,
        revisionNum,
        action,
        JSON.stringify(delta),
        snapshotPayload ? JSON.stringify(snapshotPayload) : null,
        authorAccountId ?? null,
    ]);

    const row = result.rows[0];
    return {
        id: String(row.id),
        mapNum: row.map_num,
        revisionNum: row.revision_num,
        action: row.action as MapRevisionAction,
        delta: row.delta as TileOverrideDelta[],
        snapshot: row.snapshot as Record<string, unknown> | null,
        authorAccountId: row.author_account_id ? String(row.author_account_id) : null,
        createdAt: new Date(row.created_at),
    };
}

export async function getMapRevisionHistory(
    mapNum: number,
    limit = 50,
): Promise<MapRevisionRecord[]> {
    const query = `
        SELECT id, map_num, revision_num, action, delta, snapshot, author_account_id, created_at
        FROM game_map_revisions
        WHERE map_num = $1
        ORDER BY revision_num DESC
        LIMIT $2
    `;

    const result = await pool.query(query, [mapNum, limit]);

    return result.rows.map((row) => ({
        id: String(row.id),
        mapNum: row.map_num,
        revisionNum: row.revision_num,
        action: row.action as MapRevisionAction,
        delta: row.delta as TileOverrideDelta[],
        snapshot: row.snapshot as Record<string, unknown> | null,
        authorAccountId: row.author_account_id ? String(row.author_account_id) : null,
        createdAt: new Date(row.created_at),
    }));
}

export async function undoLatestMapRevision(
    mapNum: number,
    authorAccountId?: string | null,
): Promise<{ undoneRevision: MapRevisionRecord; newRevision: MapRevisionRecord } | null> {
    const history = await getMapRevisionHistory(mapNum, 1);
    if (history.length === 0) {
        return null;
    }

    const latest = history[0];
    if (latest.action === "undo") {
        // Double undo not supported directly without redo
        return null;
    }

    // Inverse deltas for undo
    const inverseDelta: TileOverrideDelta[] = latest.delta.map((item) => ({
        x: item.x,
        y: item.y,
        layer: item.layer,
        grhIndex: item.prevGrhIndex ?? null,
        blocked: item.prevBlocked ?? null,
        prevGrhIndex: item.grhIndex ?? null,
        prevBlocked: item.blocked ?? null,
    }));

    const newRev = await recordMapRevision(
        mapNum,
        "undo",
        inverseDelta,
        authorAccountId,
    );

    return { undoneRevision: latest, newRevision: newRev };
}

export async function redoMapRevision(
    mapNum: number,
    authorAccountId?: string | null,
): Promise<{ redoRevision: MapRevisionRecord } | null> {
    const history = await getMapRevisionHistory(mapNum, 2);
    if (history.length === 0 || history[0].action !== "undo") {
        return null;
    }

    const lastUndo = history[0];
    // Re-apply original delta
    const reapplyDelta: TileOverrideDelta[] = lastUndo.delta.map((item) => ({
        x: item.x,
        y: item.y,
        layer: item.layer,
        grhIndex: item.prevGrhIndex ?? null,
        blocked: item.prevBlocked ?? null,
        prevGrhIndex: item.grhIndex ?? null,
        prevBlocked: item.blocked ?? null,
    }));

    const newRev = await recordMapRevision(
        mapNum,
        "redo",
        reapplyDelta,
        authorAccountId,
    );

    return { redoRevision: newRev };
}

export async function diffMapRevisions(
    mapNum: number,
    revA: number,
    revB: number,
): Promise<MapDiffResult> {
    const query = `
        SELECT revision_num, delta
        FROM game_map_revisions
        WHERE map_num = $1 AND revision_num BETWEEN $2 AND $3
        ORDER BY revision_num ASC
    `;

    const startRev = Math.min(revA, revB);
    const endRev = Math.max(revA, revB);

    const result = await pool.query<{ revision_num: number; delta: TileOverrideDelta[] }>(query, [
        mapNum,
        startRev,
        endRev,
    ]);

    const stateA = new Map<string, { grhIndex: number | null; blocked: boolean | null }>();
    const stateB = new Map<string, { grhIndex: number | null; blocked: boolean | null }>();

    for (const row of result.rows) {
        for (const change of row.delta) {
            const key = `${change.x},${change.y},${change.layer}`;
            if (row.revision_num <= startRev) {
                stateA.set(key, { grhIndex: change.grhIndex, blocked: change.blocked });
            }
            if (row.revision_num <= endRev) {
                stateB.set(key, { grhIndex: change.grhIndex, blocked: change.blocked });
            }
        }
    }

    const changes: MapDiffChange[] = [];
    const allKeys = new Set([...stateA.keys(), ...stateB.keys()]);

    for (const key of allKeys) {
        const before = stateA.get(key) ?? { grhIndex: null, blocked: null };
        const after = stateB.get(key) ?? { grhIndex: null, blocked: null };

        if (before.grhIndex !== after.grhIndex || before.blocked !== after.blocked) {
            const [xStr, yStr, layerStr] = key.split(",");
            changes.push({
                x: Number.parseInt(xStr, 10),
                y: Number.parseInt(yStr, 10),
                layer: Number.parseInt(layerStr, 10),
                before,
                after,
            });
        }
    }

    return {
        mapNum,
        revA,
        revB,
        changes,
    };
}
