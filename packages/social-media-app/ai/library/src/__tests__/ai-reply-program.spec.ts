import { TestSession } from "@peerbit/test-utils";
import {
    CanvasAIReply,
    insertTextIntoCanvas,
    ModelRequest,
    ModelResponse,
    QueryResponse,
} from "../ai-reply-program";
import { expect } from "chai";
import { DEEP_SEEK_R1_7b } from "../model.js";
import { Canvas } from "@giga-app/interface";
import { waitForResolved } from "@peerbit/time";

describe("AIResponseProgram", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });

    const createDefaultCanvas = async (text = "Hey! what is 1+1") => {
        const root = await createReply();
        await insertTextIntoCanvas(text, root);
        return root;
    };
    const createReply = async (to?: Canvas) => {
        const canvas = await session.peers[0].open(
            new Canvas({
                parent: to,
                publicKey: session.peers[0].identity.publicKey,
            })
        );
        return canvas;
    };

    it("ollama", async () => {
        const canvas = await createDefaultCanvas();

        // Open the program on the first peer as the server.
        const server = await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama" },
        });
        // Open a client on the second peer.
        const client = await session.peers[1].open<CanvasAIReply>(
            server.address
        );
        await client.waitForModel({ model: DEEP_SEEK_R1_7b });

        // Query with a valid prompt.
        const response = await client.query(canvas);
        expect(response).to.not.be.undefined;
        expect(response).to.be.instanceof(QueryResponse);

        // Check if the response is a string and has a length greater than 0.
        await waitForResolved(() =>
            expect(canvas.replies.log.log.length).to.be.greaterThan(0)
        );
        const [text] = await canvas.replies.index.iterate({}).all();
        expect((await text.getText()).length).to.be.greaterThan(0);
    });

    it("can use context", async () => {
        const canvas = await createDefaultCanvas("Chat room");
        const reply1 = await createReply(canvas);
        await insertTextIntoCanvas("My name is XQC!", reply1);
        const reply2 = await createReply(canvas);
        await insertTextIntoCanvas("What is my name?", reply2);

        // Open the program on the first peer as the server.
        const server = await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama" },
        });
        // Open a client on the second peer.
        const client = await session.peers[1].open<CanvasAIReply>(
            server.address
        );
        await client.waitForModel({ model: DEEP_SEEK_R1_7b });

        // Query with a valid prompt.
        const response = await client.query(reply2);
        expect(response).to.not.be.undefined;
        expect(response).to.be.instanceof(QueryResponse);

        // Check if the response is a string and has a length greater than 0.
        await waitForResolved(() =>
            expect(canvas.replies.log.log.length).to.be.greaterThan(0)
        );
        const [text] = await canvas.replies.index.iterate({}).all();
        expect((await text.getText()).length).to.be.greaterThan(0);
    });

    /*  it("chatgpt", async () => {
         const canvas = await createDefaultCanvas();
         const API_KEY = "sk-"
         // Open the program on the first peer as the server.
         const server = await session.peers[0].open(new CanvasAIReply(), {
             args: { server: true, llm: 'chatgpt', apiKey: API_KEY },
         });
         // Open a client on the second peer.
         const client = await session.peers[1].open<CanvasAIReply>(
             server.address
         );
         await client.waitForModel();
 
         // Query with a valid prompt.
         const response = await client.query(canvas);
         expect(response).to.not.be.undefined;
         expect(response).to.be.instanceof(QueryResponse);
 
         // Check if the response is a string and has a length greater than 0.
         await waitForResolved(() => expect(canvas.replies.log.log.length).to.be.greaterThan(0));
         const [text] = await canvas.replies.index.iterate({}).all()
         const resp = await text.getText()
         expect(resp.length).to.be.greaterThan(0);
     }); */

    it("has a reasonable timeout", async () => {
        const canvas = await createDefaultCanvas();

        const server = await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama" },
        });
        const client = await session.peers[1].open<CanvasAIReply>(
            server.address
        );
        await client.waitForModel({ model: DEEP_SEEK_R1_7b });

        const start = Date.now();
        try {
            // Use a prompt unlikely to succeed quickly (simulate with a random UUID)
            await client.query(canvas, {
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
        const server = await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama" },
        });
        // Open a client on the second peer.
        const client = await session.peers[1].open<CanvasAIReply>(
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
        expect(modelResp.model).to.include(DEEP_SEEK_R1_7b);
    });
});
