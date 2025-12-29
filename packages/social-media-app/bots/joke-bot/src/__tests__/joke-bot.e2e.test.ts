import { TestSession } from "@peerbit/test-utils";
import { expect } from "chai";
import { afterEach, beforeEach, describe, it } from "vitest";
import { createRoot } from "@giga-app/interface";
import { waitForResolved } from "@peerbit/time";
import { JokeBot } from "../joke-bot.js";

describe("JokeBot (e2e)", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(1);
    });

    afterEach(async () => {
        await session.stop();
    });

    it("publishes a joke post under the public root", async () => {
        const peer = session.peers[0];
        const { canvas: root } = await createRoot(peer, { persisted: false });

        const prefix = `JokeBot e2e ${Date.now()}`;

        await peer.open(new JokeBot(), {
            args: {
                replicate: false,
                intervalMs: 60_000,
                runOnStart: true,
                dryRun: false,
                prefix,
            },
            existing: "reuse",
        });

        await waitForResolved(
            async () => {
                const elements = await root.nearestScope.elements.index
                    .iterate({})
                    .all();

                const found = elements.some((el: any) => {
                    const text = el?.content?.content?.text;
                    return typeof text === "string" && text.includes(prefix);
                });

                expect(found).to.equal(true);
            },
            { timeout: 20_000, delayInterval: 100 }
        );
    });
});
