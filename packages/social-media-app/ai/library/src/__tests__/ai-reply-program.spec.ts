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
import {
    AddressReference,
    Canvas,
    Scope,
    createRoot,
} from "@giga-app/interface";
import { waitForResolved } from "@peerbit/time";
import { ProgramClient } from "@peerbit/program";

/* ------------------------------------------------------------------ */
/* Helpers that respect the new Canvas/Scope model                     */
/* ------------------------------------------------------------------ */

async function openUserScope(client: ProgramClient): Promise<Scope> {
    return client.open(
        new Scope({ publicKey: client.identity.publicKey }),
        { existing: "reuse" }
    );
}

/** Create a top-level root Canvas in a new/opened scope for `client`. */
async function createRootCanvas(
    client: ProgramClient
): Promise<Canvas> {
    const scope = await openUserScope(client);
    const draft = new Canvas({
        publicKey: client.identity.publicKey,
        selfScope: new AddressReference({ address: scope.address }),
    });
    const [, root] = await scope.getOrCreateReply(undefined, draft);
    return root;
}

/** Create a reply under `parent` in the parent’s home scope. */
async function createReplyUnder(
    parent: Canvas,
    client: ProgramClient
): Promise<Canvas> {
    const scope = parent.nearestScope;
    const draft = new Canvas({
        publicKey: client.identity.publicKey,
        selfScope: new AddressReference({ address: scope.address }),
    });
    const [, child] = await scope.getOrCreateReply(parent, draft);
    return child;
}

/** Build a default root with initial text. */
async function createDefaultCanvas(
    text = "Hey! what is 1+1",
    client: ProgramClient
): Promise<Canvas> {
    const root = await createRootCanvas(client);
    await insertTextIntoCanvas(text, root);
    return root;
}

describe("AIResponseProgram", () => {
    let session: TestSession;

    beforeEach(async () => {
        session = await TestSession.connected(2);
    });

    afterEach(async () => {
        await session.stop();
    });

    it("ollama", async () => {
        const canvas = await createDefaultCanvas("Hey! what is 1+1", session.peers[0]);

        // Server on peer[0]
        const server = await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama" },
        });
        // Client on peer[1]
        const client = await session.peers[1].open<CanvasAIReply>(server.address);
        await client.waitForModel({ model: DEEP_SEEK_R1_7b });

        const response = await client.query(canvas);
        expect(response).to.not.be.undefined;
        expect(response).to.be.instanceof(QueryResponse);

        // Wait until a reply canvas gets created under the same scope
        await waitForResolved(async () => {
            const scope = canvas.nearestScope;
            // there should be at least one child reply created
            expect(await scope.replies.index.getSize()).to.be.greaterThan(0);
        });

        // sanity: some text written somewhere in the tree
        const scope = canvas.nearestScope;
        const all = await scope.elements.index.iterate({}).all();
        expect(all.length).to.be.greaterThan(0);
    });

    it("ollama different model", async () => {
        const server = await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama", model: DEEP_SEEK_R1_1_5b },
        });
        const client = await session.peers[1].open<CanvasAIReply>(server.address);
        await client.waitForModel({ model: DEEP_SEEK_R1_1_5b });
    });

    it("can use context", async () => {
        const canvas = await createDefaultCanvas("Chat room", session.peers[0]);

        const reply1 = await createReplyUnder(canvas, session.peers[1]);
        await insertTextIntoCanvas("My name is XQC!", reply1);

        const reply2 = await createReplyUnder(canvas, session.peers[1]);
        await insertTextIntoCanvas("What is my name?", reply2);

        const server = await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama" },
        });
        const client = await session.peers[1].open<CanvasAIReply>(server.address);
        await client.waitForModel({ model: DEEP_SEEK_R1_7b });

        const response = await client.query(reply2);
        expect(response).to.not.be.undefined;
        expect(response).to.be.instanceof(QueryResponse);

        await waitForResolved(async () => {
            const scope = canvas.nearestScope;
            // at least something got written as a consequence of the reply generation
            expect(await scope.elements.index.getSize()).to.be.greaterThan(0);
        });
    });

    it("replicates by default", async () => {
        await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama" },
        });

        const { canvas: clientCanvasRoot } = await createRoot(session.peers[1], {
            persisted: true,
        });

        await clientCanvasRoot.replies.log.waitForReplicators();
        expect([...(await clientCanvasRoot.replies.log.getReplicators())]).to.deep.eq([
            session.peers[0].identity.publicKey.hashcode(),
        ]);
    });

    it("has a reasonable timeout", async () => {
        const canvas = await createDefaultCanvas("Time test", session.peers[0]);

        const server = await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama" },
        });
        const client = await session.peers[1].open<CanvasAIReply>(server.address);
        await client.waitForModel({ model: DEEP_SEEK_R1_7b });

        const start = Date.now();
        try {
            await client.query(canvas, { timeout: 1000 });
        } catch {
            // expected
        }
        const duration = Date.now() - start;
        expect(duration).to.be.lessThan(5000);
    });

    it("responds to model requests with supported models", async () => {
        const server = await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama" },
        });
        const client = await session.peers[1].open<CanvasAIReply>(server.address);
        await client.waitFor(server.node.identity.publicKey);

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
        const server = await session.peers[0].open(new CanvasAIReply(), {
            args: { server: true, llm: "ollama" },
        });
        const client = await session.peers[1].open<CanvasAIReply>(server.address);

        await client.waitForModel({ model: DEEP_SEEK_R1_7b });

        // Server announces their name (root)
        const canvas = await createDefaultCanvas("My name is A", session.peers[0]);

        // Client posts a reply with their name
        const reply1 = await createReplyUnder(canvas, session.peers[1]);
        await insertTextIntoCanvas("My name is B", reply1);

        // Client asks the model to recall their name
        const reply2 = await createReplyUnder(canvas, session.peers[1]);
        await insertTextIntoCanvas(
            "There are two names in the chat, but what is my name again?",
            reply2
        );

        // Make sure indices have some content locally
        const rootScopeFromClient = reply2.nearestScope;
        await waitForResolved(async () => {
            expect((await rootScopeFromClient.replies.index.getSize()) >= 3).to.eq(true);
            expect((await rootScopeFromClient.elements.index.getSize()) >= 3).to.eq(true);
        });

        const response = await client.suggest(reply2);
        expect(response).to.exist;
        const suggestion = response as SuggestedReplyResponse;
        expect(suggestion).to.be.instanceof(SuggestedReplyResponse);
        expect(suggestion.reply.length).to.be.greaterThan(0);
    });
});