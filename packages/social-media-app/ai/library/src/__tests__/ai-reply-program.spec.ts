import { TestSession } from "@peerbit/test-utils";
import {
    CanvasAIReply,
    insertTextIntoCanvas,
    ModelRequest,
    ModelResponse,
    QueryResponse,
    SuggestedReplyResponse,
} from "../ai-reply-program";
import { expect } from "chai";
import { DEEP_SEEK_R1_1_5b, DEEP_SEEK_R1_7b } from "../model.js";
import { Canvas, createRoot } from "@giga-app/interface";
import { waitForResolved } from "@peerbit/time";
import { ProgramClient } from "@peerbit/program";

describe("AIResponseProgram", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });

    const createDefaultCanvas = async (
        text = "Hey! what is 1+1",
        client: ProgramClient = session.peers[0]
    ) => {
        const root = await createReply(undefined, client);
        await insertTextIntoCanvas(text, root);
        return root;
    };
    const createReply = async (
        to?: Canvas,
        client: ProgramClient = session.peers[0]
    ) => {
        const canvas = await client.open(
            new Canvas({
                parent: to,
                publicKey: client.identity.publicKey,
            })
        );
        return canvas;
    };

    it("ollama", async () => {
        // If OOlama starts slowly this test will fail. (run the test twice

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

    it("ollama different model", async () => {
        // Open the program on the first peer as the server.
        const server = await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama", model: DEEP_SEEK_R1_1_5b },
        });
        // Open a client on the second peer.
        const client = await session.peers[1].open<CanvasAIReply>(
            server.address
        );
        await client.waitForModel({ model: DEEP_SEEK_R1_1_5b });
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

    it("replicates by default", async () => {
        await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama" },
        });

        const clientCanvasRoot = await createRoot(await session.peers[1], true);
        await clientCanvasRoot.replies.log.waitForReplicators();
        expect([
            ...(await clientCanvasRoot.replies.log.getReplicators()),
        ]).to.deep.eq([session.peers[0].identity.publicKey.hashcode()]);
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

    it("generates a suggested reply using actAs", async () => {
        // Open the program on the first peer as the server.
        const server = await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama" },
        });
        // Open a client on the second peer.
        const client = await session.peers[1].open<CanvasAIReply>(
            server.address
        );

        await client.waitForModel({ model: DEEP_SEEK_R1_7b });

        // Server announces their name
        const canvas = await createDefaultCanvas(
            "My name is A",
            session.peers[0]
        );

        // Client responds withs their name
        const reply1 = await createReply(canvas, session.peers[1]);
        await insertTextIntoCanvas("My name is B", reply1);

        // Client also responds with a question figuring out their name
        const reply2 = await createReply(canvas, session.peers[1]);
        await insertTextIntoCanvas(
            "There are two names in the chat, but what is my name again?",
            reply2
        );

        // wait for client to have 2 messages in total
        await reply2.load();
        const rootFromClient = reply2.origin;
        await waitForResolved(async () => {
            expect((await rootFromClient!.replies.index.getSize()) === 3);
            expect((await rootFromClient!.elements.index.getSize()) === 3);
        });

        // Send the SuggestedReplyQuery.
        const response = await client.suggest(reply2);

        expect(response).to.exist;
        const suggestion = response as SuggestedReplyResponse;
        expect(suggestion).to.be.instanceof(SuggestedReplyResponse);
        // Check that the generated reply is non-empty.
        expect(suggestion.reply.length).to.be.greaterThan(0);
    });
});
