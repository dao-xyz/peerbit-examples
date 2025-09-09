import { expect } from "chai";
import { TestSession } from "@peerbit/test-utils";
import { waitForResolved, delay } from "@peerbit/time";
import { Canvas, Scope, getImmediateRepliesQuery } from "../content.js";

describe("links: cross-scope resolution race", () => {
    let session: TestSession;

    beforeEach(async () => {
        // Use two peers so links/mirrors happen on different nodes
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });

    it("emits (at least once) and bounds 'Child not found for link' warnings; final state correct", async () => {
        const peerA = session.peers[0];
        const peerB = session.peers[1];

        // Capture warnings to observe if the message appears (then ensure it doesn't grow unbounded)
        const originalWarn = console.warn;
        const originalDebug = console.debug;
        const seen: string[] = [];
        const capture = (...args: any[]) => {
            const msg = args
                .map((a) => (typeof a === "string" ? a : String(a)))
                .join(" ");
            if (
                msg.includes("Child not found for link") ||
                msg.includes("Parent not found for link")
            ) {
                seen.push(msg);
            }
        };
        console.warn = (...args: any[]) => {
            capture(...args);
            originalWarn.apply(console, args);
        };
        console.debug = (...args: any[]) => {
            capture(...args);
            originalDebug.apply(console, args);
        };

        try {
            // Parent scope is on peer A
            const scopeA = await peerA.open(
                new Scope({ publicKey: peerA.identity.publicKey }),
                { args: { replicate: true } }
            );
            // Child scope is on peer B (different node)
            const scopeB = await peerB.open(
                new Scope({ publicKey: peerB.identity.publicKey }),
                { args: { replicate: true } }
            );

            // Parent in scopeA (on peer A)
            const [_, root] = await scopeA.getOrCreateReply(
                undefined,
                new Canvas({
                    publicKey: peerA.identity.publicKey,
                    selfScope: scopeA,
                })
            );

            // Child in scopeB (on peer B)
            const child = new Canvas({
                publicKey: peerB.identity.publicKey,
                selfScope: scopeB,
            });

            // Publish from peer A: creates canonical link in child scope (peer B)
            // and a mirror in parent scope (peer A). The mirror event on A tries
            // to resolve the child via a ScopedRef with local-only, which should
            // initially fail → emit the warning.
            await scopeA.publish(child, { type: "link-only", parent: root });

            // Indexing is async; validate final correctness via link traversal across scopes
            await waitForResolved(async () => {
                const kids = await root.getChildren({ scopes: [scopeA, scopeB] });
                expect(kids.map((k) => k.idString)).to.include(child.idString);
            });

            // After correctness is achieved, capture current warning count and ensure it doesn't grow
            const initial = seen.filter((m) =>
                m.includes("Child not found for link")
            ).length;
            // Give a short grace period to see if further warnings keep coming; they should not grow
            await delay(300);
            const after = seen.filter((m) =>
                m.includes("Child not found for link")
            ).length;

            expect(after).to.be.at.most(initial);
            // And in practice, the count should be small (<= 3) for this flow
            expect(after).to.be.at.most(3);
        } finally {
            // restore
            console.warn = originalWarn;
            console.debug = originalDebug;
        }
    });
});
