import { describe, expect, it, vi } from "vitest";

// Mock database pool for repository testing
vi.mock("../db", () => {
    const memoryRevisions: any[] = [];
    let currentId = 1;

    return {
        default: {
            query: async (queryText: string, params: any[]) => {
                const text = queryText.trim().toLowerCase();

                if (text.includes("coalesce(max(revision_num)")) {
                    const mapNum = params[0];
                    const mapRevs = memoryRevisions.filter((r) => r.map_num === mapNum);
                    const maxRev = mapRevs.length > 0 ? Math.max(...mapRevs.map((r) => r.revision_num)) : 0;
                    return { rows: [{ next_rev: String(maxRev + 1) }] };
                }

                if (text.includes("insert into game_map_revisions")) {
                    const [map_num, revision_num, action, deltaJson, snapshotJson, author_account_id] = params;
                    const row = {
                        id: currentId++,
                        map_num,
                        revision_num,
                        action,
                        delta: JSON.parse(deltaJson),
                        snapshot: snapshotJson ? JSON.parse(snapshotJson) : null,
                        author_account_id,
                        created_at: new Date().toISOString(),
                    };
                    memoryRevisions.push(row);
                    return { rows: [row] };
                }

                if (text.includes("from game_map_revisions") && text.includes("between")) {
                    const [mapNum, startRev, endRev] = params;
                    const filtered = memoryRevisions
                        .filter((r) => r.map_num === mapNum && r.revision_num >= startRev && r.revision_num <= endRev)
                        .sort((a, b) => a.revision_num - b.revision_num);
                    return { rows: filtered };
                }

                if (text.includes("from game_map_revisions")) {
                    const mapNum = params[0];
                    const limit = params[1] || 50;
                    const filtered = memoryRevisions
                        .filter((r) => r.map_num === mapNum)
                        .sort((a, b) => b.revision_num - a.revision_num)
                        .slice(0, limit);
                    return { rows: filtered };
                }

                return { rows: [] };
            },
        },
    };
});

import {
    diffMapRevisions,
    getMapRevisionHistory,
    getNextRevisionNum,
    recordMapRevision,
    redoMapRevision,
    undoLatestMapRevision,
} from "../repositories/gameMapRevisions";

describe("Map Revisions, Audit Log & Undo/Redo Engine (Issue #12)", () => {
    it("should correctly increment revision numbers and record map edits", async () => {
        const mapNum = 101;
        const nextRev1 = await getNextRevisionNum(mapNum);
        expect(nextRev1).toBe(1);

        const rev1 = await recordMapRevision(mapNum, "edit", [
            { x: 50, y: 50, layer: 1, grhIndex: 100, blocked: false, prevGrhIndex: 0, prevBlocked: false },
        ]);

        expect(rev1.revisionNum).toBe(1);
        expect(rev1.action).toBe("edit");
        expect(rev1.delta.length).toBe(1);

        const nextRev2 = await getNextRevisionNum(mapNum);
        expect(nextRev2).toBe(2);
    });

    it("should store revision history and audit log entries", async () => {
        const mapNum = 102;
        await recordMapRevision(mapNum, "edit", [
            { x: 10, y: 10, layer: 1, grhIndex: 500, blocked: false },
        ]);
        await recordMapRevision(mapNum, "edit", [
            { x: 11, y: 10, layer: 1, grhIndex: 501, blocked: true },
        ]);

        const history = await getMapRevisionHistory(mapNum);
        expect(history.length).toBe(2);
        expect(history[0].revisionNum).toBe(2);
        expect(history[1].revisionNum).toBe(1);
    });

    it("should undo the latest map revision and produce inverse deltas", async () => {
        const mapNum = 103;
        await recordMapRevision(mapNum, "edit", [
            { x: 20, y: 20, layer: 2, grhIndex: 800, blocked: false, prevGrhIndex: 100, prevBlocked: true },
        ]);

        const result = await undoLatestMapRevision(mapNum);
        expect(result).not.toBeNull();
        expect(result?.newRevision.action).toBe("undo");
        expect(result?.newRevision.delta[0].grhIndex).toBe(100);
        expect(result?.newRevision.delta[0].blocked).toBe(true);
    });

    it("should redo an undone map revision", async () => {
        const mapNum = 104;
        await recordMapRevision(mapNum, "edit", [
            { x: 30, y: 30, layer: 1, grhIndex: 999, blocked: true, prevGrhIndex: 0, prevBlocked: false },
        ]);

        await undoLatestMapRevision(mapNum);
        const redoResult = await redoMapRevision(mapNum);

        expect(redoResult).not.toBeNull();
        expect(redoResult?.redoRevision.action).toBe("redo");
        expect(redoResult?.redoRevision.delta[0].grhIndex).toBe(999);
    });

    it("should compute structured diffs between map revision numbers", async () => {
        const mapNum = 105;
        await recordMapRevision(mapNum, "edit", [
            { x: 5, y: 5, layer: 1, grhIndex: 10, blocked: false },
        ]);
        await recordMapRevision(mapNum, "edit", [
            { x: 5, y: 5, layer: 1, grhIndex: 50, blocked: true },
        ]);

        const diff = await diffMapRevisions(mapNum, 1, 2);
        expect(diff.mapNum).toBe(105);
        expect(diff.changes.length).toBe(1);
        expect(diff.changes[0].before.grhIndex).toBe(10);
        expect(diff.changes[0].after.grhIndex).toBe(50);
    });
});
