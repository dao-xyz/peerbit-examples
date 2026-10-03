import { Peerbit } from "peerbit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openSharedFs, type SharedFsHandle } from "../index.js";
import { stopTestPeers } from "./stop-test-peers.js";

describe("shared fs change listener across close and reopen", () => {
    const peers: Peerbit[] = [];
    let fs: SharedFsHandle;
    let program: any;

    beforeEach(async () => {
        const peer = await Peerbit.create();
        peers.push(peer);
        fs = await openSharedFs({ peerbit: peer, machineLabel: "listener" });
        program = fs.program;
    });

    afterEach(async () => {
        await stopTestPeers(peers);
    });

    it("runs one change listener after a same-instance reopen", async () => {
        await fs.writeFile("/f.txt", "v1");

        // Documents' event emitter outlives close, so a listener that close
        // failed to detach would keep running next to the reopened one.
        // listenerCount cannot show that (main-event 1.0.3-1.0.4 report the
        // removal while the listener still fires), so dispatch for real.
        let calls = 0;
        const applyCacheChanges = program.applyCacheChanges;
        program.applyCacheChanges = function (...args: unknown[]) {
            calls++;
            return applyCacheChanges.apply(this, args);
        };
        const dispatchChange = () => {
            calls = 0;
            program.entries.events.dispatchEvent(
                new CustomEvent("change", {
                    detail: { added: [], removed: [] },
                })
            );
            return calls;
        };
        expect(dispatchChange()).toBe(1);

        for (const machineLabel of ["listener-reopen-1", "listener-reopen-2"]) {
            await program.close();
            expect(dispatchChange()).toBe(0);
            const reopened = await peers[0].open(program, {
                existing: "reuse",
                args: {
                    machineLabel,
                    allowPartialWrites: true,
                    addressOpen: true,
                    bootstrap: false,
                    gc: false,
                },
            });
            expect(reopened).toBe(program);
            expect(dispatchChange()).toBe(1);
        }
    });
});
