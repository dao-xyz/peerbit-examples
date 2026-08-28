import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import { parkNextRowQuery } from "./cache-race-park.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

/**
 * Naming-side twin of cache-race.test.ts — see the note there on why the
 * two races live in separate files.
 */
describe("shared fs cache fill/event race (naming)", () => {
    let peer: Peerbit;
    let fs: SharedFsHandle;

    beforeEach(async () => {
        peer = await Peerbit.create();
        fs = await openSharedFs({ peerbit: peer, machineLabel: "race" });
    });

    afterEach(async () => {
        try {
            await peer.stop();
        } catch (error) {
            if (
                !(
                    error instanceof TypeError &&
                    error.message.includes("clearAll")
                )
            ) {
                throw error;
            }
        }
    });

    it("a naming fill racing a rename never installs a stale bucket", async () => {
        await fs.writeFile("/g.txt", "content");
        const program: any = fs.program;
        const nodeId = (await program.resolvePath("/g.txt")).nodeId;
        program.namingRowCache.clear();

        const { release, parkedReached } = parkNextRowQuery(program);
        const fill = program.namingStatesForNodes([nodeId]);
        await parkedReached;
        await fs.rename("/g.txt", "/h.txt");
        // Settle every (possibly async) change dispatch so the parked
        // install is the LAST bucket write — nothing can heal it after.
        await new Promise((resolve) => setTimeout(resolve, 50));
        release();
        await fill;

        // The parked fill's pre-rename snapshot must not have been
        // installed over the (correctly warmed) bucket: if a bucket is
        // warm it must contain the rename's superseding event.
        const bucket = program.namingRowCache.get(nodeId);
        const events: any[] = bucket ? [...bucket.values()] : [];
        if (bucket) {
            expect(events.some((event) => event.causalDepth > 1n)).toBe(true);
        }
        expect(await fs.stat("/g.txt")).toBeUndefined();
        expect((await fs.stat("/h.txt"))?.kind).toBe("file");
        expect(decode(await fs.readFile("/h.txt"))).toBe("content");
    });
});
