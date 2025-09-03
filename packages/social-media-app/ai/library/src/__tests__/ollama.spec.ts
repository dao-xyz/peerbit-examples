import { expect } from "chai";
import sinon from "sinon";
import * as ollamaModule from "../ollama";

describe("queryOllama", () => {
    let ollamaChatStub: sinon.SinonStub;

    beforeEach(() => {
        ollamaChatStub = sinon.stub();
        // Inject stubbed client
        ollamaModule.setOllamaClient({ chat: ollamaChatStub } as any);
    });

    afterEach(() => {
        ollamaModule.resetOllamaClient();
        sinon.restore();
    });

    it("should return the response after </think> tag", async () => {
        const prompt = "Hello, Ollama!";
        const model = "test-model";
        const responseContent = "<think>thinking...</think>Actual response";
        ollamaChatStub.resolves({
            message: { content: responseContent },
        });

        const result = await ollamaModule.queryOllama(prompt, model);
        expect(result).to.equal("Actual response");
        expect(ollamaChatStub.calledOnce).to.be.true;
        expect(ollamaChatStub.firstCall.args[0]).to.deep.include({
            model,
            messages: [{ role: "user", content: prompt }],
            stream: false,
        });
    });

    it("should throw error if ollama.chat fails", async () => {
        const error = new Error("Ollama error");
        ollamaChatStub.rejects(error);

        try {
            await ollamaModule.queryOllama("test");
            expect.fail("Expected error to be thrown");
        } catch (err) {
            expect(err).to.equal(error);
        }
    });

    it("should trim whitespace from the response", async () => {
        const responseContent = "<think>...</think>   Trimmed response   ";
        ollamaChatStub.resolves({
            message: { content: responseContent },
        });

        const result = await ollamaModule.queryOllama("prompt");
        expect(result).to.equal("Trimmed response");
    });
});
