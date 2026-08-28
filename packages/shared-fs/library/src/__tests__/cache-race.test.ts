import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import { parkNextRowQuery } from "./cache-race-park.js";

const decode = (value: Uint8Array | undefined) =>
    value ? new TextDecoder().decode(value) : undefined;

/**
 * A cache-miss fill races a change event: the fill's row query snapshots
 * the index, a document arrives (bumping the node's epoch; the bucket is
 * still cold so the upsert is skipped), and the fill then tries to install
 * its pre-event snapshot. The install must be dropped — a stale warm
 * bucket would silently hide the superseding row for as long as it stays
 * warm. One race per file: warm-process event timing heals the second
 * scenario in a shared worker, so each must run in a fresh one (the
 * naming-side twin lives in cache-race-naming.test.ts).
 */
describe("shared fs cache fill/event race (versions)", () => {
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

    it("a version fill racing a write never installs a stale bucket", async () => {
        await fs.writeFile("/f.txt", "v1");
        const program: any = fs.program;
        const nodeId = (await program.resolvePath("/f.txt")).nodeId;
        program.versionRowCache.clear();

        const { release, parkedReached } = parkNextRowQuery(program);
        const fill = program.headsForNodes([nodeId]);
        await parkedReached;
        // While the fill is parked on its pre-write snapshot, a
        // superseding version lands (and warms the bucket correctly).
        await fs.writeFile("/f.txt", "v2");
        // Let every (possibly async) change dispatch settle so the parked
        // install is the LAST bucket write — nothing can heal it after.
        await new Promise((resolve) => setTimeout(resolve, 50));
        release();
        await fill;

        expect(decode(await fs.readFile("/f.txt"))).toBe("v2");
        const heads = (await fs.versions("/f.txt")).filter((v) => v.head);
        expect(heads).toHaveLength(1);
    });
});
