import { TestSession } from "@peerbit/test-utils";
import { AIResponseProgram, ModelRequest, ModelResponse } from "../index";
import { v4 as uuid } from "uuid";
import { expect } from "chai";
import { DEEP_SEEK_R1 } from "../model.js";

describe("AIResponseProgram", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });

    it("can query AI", async () => {
        // Open the program on the first peer as the server.
        const server = await session.peers[0].open(new AIResponseProgram(), {
            args: { server: true },
        });
        // Open a client on the second peer.
        const client = await session.peers[1].open<AIResponseProgram>(
            server.address
        );
        await client.waitForModel(DEEP_SEEK_R1);

        // Query with a valid prompt.
        const response = await client.query("Hello, how are you?");
        expect(response).to.not.be.undefined;
        expect(response?.response).to.be.a("string");
        expect(response!.response!.length > 0).to.be.true;
    });

    it("returns undefined for an empty prompt", async () => {
        const server = await session.peers[0].open(new AIResponseProgram(), {
            args: { server: true },
        });
        const client = await session.peers[1].open<AIResponseProgram>(
            server.address
        );
        await client.waitForModel(DEEP_SEEK_R1);

        // When the prompt is empty, the query method should return undefined.
        const response = await client.query("");
        expect(response).to.be.undefined;
    });

    it("has a reasonable timeout", async () => {
        const server = await session.peers[0].open(new AIResponseProgram(), {
            args: { server: true },
        });
        const client = await session.peers[1].open<AIResponseProgram>(
            server.address
        );
        await client.waitForModel(DEEP_SEEK_R1);

        const start = Date.now();
        try {
            // Use a prompt unlikely to succeed quickly (simulate with a random UUID)
            await client.query(`This prompt should timeout ${uuid()}`, {
                timeout: 1000,
            });
        } catch (error) {
            // Error/timeout expected.
        }
        const duration = Date.now() - start;
        expect(duration).to.be.lessThan(5000);
    });

    it("responds to model requests with supported models", async () => {
        // Open the program on the first peer as the server (which advertises its supported models).
        const server = await session.peers[0].open(new AIResponseProgram(), {
            args: { server: true },
        });
        // Open a client on the second peer.
        const client = await session.peers[1].open<AIResponseProgram>(
            server.address
        );
        await client.waitFor(server.node.identity.publicKey);

        // Directly send a ModelRequest.
        const responses = await client.rpc.request(new ModelRequest(), {
            amount: 1,
            timeout: 1000,
        });
        expect(responses).to.not.be.empty;
        const modelResp = responses[0]?.response as ModelResponse;
        expect(modelResp).to.be.instanceof(ModelResponse);
        expect(modelResp.model).to.include("deepseek-r1:1.5b");
    });
});
