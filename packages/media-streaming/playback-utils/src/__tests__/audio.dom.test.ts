// @vitest-environment happy-dom

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(
    URL,
    "createObjectURL"
);
const originalAudioContext = Object.getOwnPropertyDescriptor(
    globalThis,
    "AudioContext"
);
const originalAudioWorkletNode = Object.getOwnPropertyDescriptor(
    globalThis,
    "AudioWorkletNode"
);
const originalAudio = Object.getOwnPropertyDescriptor(globalThis, "Audio");
const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(
    URL,
    "revokeObjectURL"
);
const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "requestAnimationFrame"
);
const originalCancelAnimationFrame = Object.getOwnPropertyDescriptor(
    globalThis,
    "cancelAnimationFrame"
);
const originalVisibilityState = Object.getOwnPropertyDescriptor(
    document,
    "visibilityState"
);

const restoreProperty = (
    target: object,
    property: PropertyKey,
    descriptor?: PropertyDescriptor
) => {
    if (descriptor) {
        Object.defineProperty(target, property, descriptor);
    } else {
        Reflect.deleteProperty(target, property);
    }
};

const installNeverSettlingAudio = () => {
    const audioDescriptor = Object.getOwnPropertyDescriptor(
        globalThis,
        "Audio"
    );
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
        URL,
        "createObjectURL"
    );
    const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
        URL,
        "revokeObjectURL"
    );
    const objectUrl = "blob:never-settling-audio";
    const createObjectURL = vi.fn(() => objectUrl);
    const revokeObjectURL = vi.fn();
    const elements: NeverSettlingAudio[] = [];

    class NeverSettlingAudio extends EventTarget {
        crossOrigin = "";
        preload = "";
        pause = vi.fn();
        remove = vi.fn();

        constructor(public readonly src: string) {
            super();
            elements.push(this);
        }
    }

    Object.defineProperty(globalThis, "Audio", {
        configurable: true,
        value: NeverSettlingAudio,
    });
    Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: createObjectURL,
    });
    Object.defineProperty(URL, "revokeObjectURL", {
        configurable: true,
        value: revokeObjectURL,
    });

    return {
        createObjectURL,
        elements,
        objectUrl,
        restore: () => {
            restoreProperty(globalThis, "Audio", audioDescriptor);
            restoreProperty(URL, "createObjectURL", createObjectUrlDescriptor);
            restoreProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
        },
        revokeObjectURL,
    };
};

if (!URL.createObjectURL) {
    Object.defineProperty(URL, "createObjectURL", {
        configurable: true,
        value: () => "blob:audio-worklet",
    });
}

type PendingDecode = {
    resolve: (buffer: AudioBuffer) => void;
    reject: (error: unknown) => void;
};

class FakeMessagePort extends EventTarget {
    postMessage = vi.fn();
    start = vi.fn();
    close = vi.fn();
}

class FakeMediaElementSource {
    connect = vi.fn();
    disconnect = vi.fn();
}

class FakeAudioWorkletNode {
    static instances: FakeAudioWorkletNode[] = [];

    port = new FakeMessagePort();
    connect = vi.fn();
    disconnect = vi.fn();

    constructor() {
        FakeAudioWorkletNode.instances.push(this);
    }
}

class FakeAudioContext extends EventTarget {
    static instances: FakeAudioContext[] = [];
    static nextCloseFailuresRemaining = 0;
    static createGainFailuresRemaining = 0;

    state: AudioContextState = "suspended";
    currentTime = 0;
    sampleRate = 48_000;
    destination = { disconnect: vi.fn() };
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    pendingDecodes: PendingDecode[] = [];
    startedSources: Array<{ start: ReturnType<typeof vi.fn> }> = [];
    mediaElementSources: FakeMediaElementSource[] = [];
    closeFailuresRemaining = 0;
    closeCalls = 0;
    closeGate?: Promise<void>;

    constructor() {
        super();
        this.closeFailuresRemaining =
            FakeAudioContext.nextCloseFailuresRemaining;
        FakeAudioContext.nextCloseFailuresRemaining = 0;
        FakeAudioContext.instances.push(this);
    }

    createGain() {
        if (FakeAudioContext.createGainFailuresRemaining > 0) {
            FakeAudioContext.createGainFailuresRemaining--;
            throw new Error("synthetic gain setup failure");
        }
        return {
            gain: { value: 1 },
            connect: vi.fn(),
            disconnect: vi.fn(),
        };
    }

    createBufferSource() {
        const source = {
            buffer: undefined as AudioBuffer | undefined,
            connect: vi.fn(),
            start: vi.fn(),
        };
        this.startedSources.push(source);
        return source;
    }

    createMediaElementSource() {
        const source = new FakeMediaElementSource();
        this.mediaElementSources.push(source);
        return source;
    }

    decodeAudioData() {
        return new Promise<AudioBuffer>((resolve, reject) => {
            this.pendingDecodes.push({ resolve, reject });
        });
    }

    async resume() {
        this.state = "running";
        this.dispatchEvent(new Event("statechange"));
    }

    async suspend() {
        this.state = "suspended";
        this.dispatchEvent(new Event("statechange"));
    }

    async close() {
        this.closeCalls++;
        if (this.closeGate) {
            await this.closeGate;
        }
        if (this.closeFailuresRemaining > 0) {
            this.closeFailuresRemaining--;
            throw new Error("synthetic audio context close failure");
        }
        this.state = "closed";
        this.dispatchEvent(new Event("statechange"));
    }
}

Object.defineProperty(globalThis, "AudioContext", {
    configurable: true,
    value: FakeAudioContext,
});
Object.defineProperty(globalThis, "AudioWorkletNode", {
    configurable: true,
    value: FakeAudioWorkletNode,
});

const scheduledFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 1;
const requestAnimationFrameMock = vi.fn((callback: FrameRequestCallback) => {
    const id = nextFrameId++;
    scheduledFrames.set(id, callback);
    return id;
});
const cancelAnimationFrameMock = vi.fn((id: number) => {
    scheduledFrames.delete(id);
});

Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: requestAnimationFrameMock,
});
Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: cancelAnimationFrameMock,
});

afterAll(() => {
    restoreProperty(URL, "createObjectURL", originalCreateObjectUrl);
    restoreProperty(globalThis, "AudioContext", originalAudioContext);
    restoreProperty(globalThis, "AudioWorkletNode", originalAudioWorkletNode);
    restoreProperty(globalThis, "Audio", originalAudio);
    restoreProperty(URL, "revokeObjectURL", originalRevokeObjectUrl);
    restoreProperty(
        globalThis,
        "requestAnimationFrame",
        originalRequestAnimationFrame
    );
    restoreProperty(
        globalThis,
        "cancelAnimationFrame",
        originalCancelAnimationFrame
    );
});

const { createAudioStreamListener, WAVEncoder } = await import("../audio");

describe("audio stream listener lifecycle", () => {
    beforeEach(() => {
        FakeAudioContext.instances = [];
        FakeAudioContext.nextCloseFailuresRemaining = 0;
        FakeAudioContext.createGainFailuresRemaining = 0;
        FakeAudioWorkletNode.instances = [];
        scheduledFrames.clear();
        nextFrameId = 1;
        requestAnimationFrameMock.mockClear();
        cancelAnimationFrameMock.mockClear();
    });

    it("suppresses late decode and scheduled render work after pause/close", async () => {
        const listener = createAudioStreamListener(
            { source: { sampleRate: 48_000 } } as any,
            false,
            { recoverLag: true }
        );

        await listener.play();
        const firstContext = FakeAudioContext.instances[0];
        listener.push({
            chunk: new Uint8Array([1]),
            time: 0,
        } as any);
        await vi.waitFor(() =>
            expect(firstContext.pendingDecodes).toHaveLength(1)
        );

        await listener.pause();
        expect(firstContext.startedSources).toHaveLength(0);

        await listener.play();
        const secondContext = FakeAudioContext.instances[1];
        secondContext.state = "running";
        listener.push({
            chunk: new Uint8Array([2]),
            time: 100_000,
        } as any);
        await vi.waitFor(() =>
            expect(secondContext.pendingDecodes).toHaveLength(1)
        );
        // The retired decode may still finish, but it cannot block or feed the
        // new generation.
        firstContext.pendingDecodes[0].resolve({
            duration: 0.1,
        } as AudioBuffer);
        await Promise.resolve();
        await Promise.resolve();
        expect(firstContext.startedSources).toHaveLength(0);
        secondContext.pendingDecodes[0].resolve({
            duration: 0.1,
        } as AudioBuffer);
        await vi.waitFor(() =>
            expect(secondContext.startedSources).toHaveLength(1)
        );
        expect(requestAnimationFrameMock).toHaveBeenCalledOnce();

        const lateFrame = [...scheduledFrames.values()][0];
        await listener.close();
        expect(cancelAnimationFrameMock).toHaveBeenCalledOnce();
        lateFrame(0);
        await Promise.resolve();
        expect(secondContext.startedSources).toHaveLength(1);

        listener.push({
            chunk: new Uint8Array([3]),
            time: 200_000,
        } as any);
        expect(secondContext.pendingDecodes).toHaveLength(1);
    });

    it("cancels the background timer generation on close", async () => {
        vi.useFakeTimers();
        Object.defineProperty(document, "visibilityState", {
            configurable: true,
            value: "hidden",
        });
        try {
            const listener = createAudioStreamListener(
                { source: { sampleRate: 48_000 } } as any,
                false,
                { recoverLag: true }
            );
            await listener.play();
            const context = FakeAudioContext.instances[0];
            context.state = "running";
            listener.push({
                chunk: new Uint8Array([1]),
                time: 0,
            } as any);
            for (let i = 0; i < 5; i++) {
                await Promise.resolve();
            }
            expect(context.pendingDecodes).toHaveLength(1);
            context.pendingDecodes[0].resolve({
                duration: 0.1,
            } as AudioBuffer);
            for (let i = 0; i < 5; i++) {
                await Promise.resolve();
            }
            expect(context.startedSources).toHaveLength(1);
            expect(vi.getTimerCount()).toBe(1);

            await listener.close();
            expect(vi.getTimerCount()).toBe(0);
            await vi.runAllTimersAsync();
            expect(context.startedSources).toHaveLength(1);
        } finally {
            vi.useRealTimers();
            restoreProperty(
                document,
                "visibilityState",
                originalVisibilityState
            );
        }
    });

    it("retains an audio context across repeated close failures", async () => {
        const listener = createAudioStreamListener(
            { source: { sampleRate: 48_000 } } as any,
            false,
            { recoverLag: true }
        );
        await listener.play();
        const context = FakeAudioContext.instances[0];
        context.closeFailuresRemaining = 2;

        await expect(listener.close()).rejects.toThrow(
            "synthetic audio context close failure"
        );
        expect(context.closeCalls).toBe(1);
        expect(context.state).not.toBe("closed");

        await expect(listener.close()).rejects.toThrow(
            "synthetic audio context close failure"
        );
        expect(context.closeCalls).toBe(2);
        expect(context.state).not.toBe("closed");

        await listener.close();
        expect(context.closeCalls).toBe(3);
        expect(context.state).toBe("closed");
    });

    it("rolls back failed context setup and retries retained cleanup before replay", async () => {
        FakeAudioContext.createGainFailuresRemaining = 1;
        FakeAudioContext.nextCloseFailuresRemaining = 1;
        const listener = createAudioStreamListener(
            { source: { sampleRate: 48_000 } } as any,
            false,
            { recoverLag: true }
        );

        const firstPlay = listener.play();
        await expect(firstPlay).rejects.toMatchObject({
            message: "Failed to set up and retire the audio context",
            errors: [
                expect.objectContaining({
                    message: "synthetic gain setup failure",
                }),
                expect.objectContaining({
                    message: "synthetic audio context close failure",
                }),
            ],
        });
        const failedContext = FakeAudioContext.instances[0];
        expect(failedContext.closeCalls).toBe(1);
        expect(failedContext.state).not.toBe("closed");

        await listener.play();
        expect(failedContext.closeCalls).toBe(2);
        expect(failedContext.state).toBe("closed");
        expect(FakeAudioContext.instances).toHaveLength(2);
        const replayContext = FakeAudioContext.instances[1];
        expect(replayContext.state).not.toBe("closed");

        await listener.close();
        expect(replayContext.closeCalls).toBe(1);
        expect(replayContext.state).toBe("closed");
    });

    it("keeps overload decoding at one in-flight call per context", async () => {
        const listener = createAudioStreamListener(
            { source: { sampleRate: 48_000 } } as any,
            false,
            { recoverLag: true }
        );
        await listener.play();
        const context = FakeAudioContext.instances[0];
        context.state = "running";

        for (let index = 0; index < 120; index++) {
            listener.push({
                chunk: new Uint8Array([index]),
                time: index,
            } as any);
        }
        await vi.waitFor(() => expect(context.pendingDecodes).toHaveLength(1));
        await Promise.resolve();
        expect(context.pendingDecodes).toHaveLength(1);

        await listener.close();
    });
});

const prepareDirectWorkletEncoder = (
    encoder: InstanceType<typeof WAVEncoder>,
    port: FakeMessagePort
) => {
    encoder.initializing = {
        promise: Promise.resolve(),
    } as any;
    (encoder as any).node = {};
    (encoder as any).activePort = port;
    encoder.port = port as any;
};

describe("WAV encoder lifecycle", () => {
    beforeEach(() => {
        FakeAudioContext.instances = [];
        FakeAudioContext.nextCloseFailuresRemaining = 0;
        FakeAudioContext.createGainFailuresRemaining = 0;
        FakeAudioWorkletNode.instances = [];
    });

    it("aborts never-settling file element preparation on destroy", async () => {
        const provisional = installNeverSettlingAudio();
        try {
            const encoder = new WAVEncoder();
            const file = {} as File;
            const initializing = encoder.init({ file, useElement: true });
            const rejected = expect(initializing).rejects.toThrow(
                "WAVEncoder element preparation was retired"
            );
            await vi.waitFor(() =>
                expect(provisional.elements).toHaveLength(1)
            );

            await encoder.destroy();
            await rejected;

            const element = provisional.elements[0];
            expect(element.pause).toHaveBeenCalledOnce();
            expect(element.remove).toHaveBeenCalledOnce();
            expect(provisional.createObjectURL).toHaveBeenCalledWith(file);
            expect(provisional.revokeObjectURL).toHaveBeenCalledOnce();
            expect(provisional.revokeObjectURL).toHaveBeenCalledWith(
                provisional.objectUrl
            );

            // The removed metadata listener cannot resurrect the retired init.
            element.dispatchEvent(new Event("loadedmetadata"));
            await Promise.resolve();
            expect(FakeAudioContext.instances).toHaveLength(0);
        } finally {
            provisional.restore();
        }
    });

    it("aborts never-settling file element preparation before re-init", async () => {
        const provisional = installNeverSettlingAudio();
        try {
            const encoder = new WAVEncoder();
            const file = {} as File;
            const firstInitialization = encoder.init({
                file,
                useElement: true,
            });
            const firstRejected = expect(firstInitialization).rejects.toThrow(
                "WAVEncoder element preparation was retired"
            );
            await vi.waitFor(() =>
                expect(provisional.elements).toHaveLength(1)
            );

            const nextElement = document.createElement("audio");
            vi.spyOn(nextElement, "pause").mockImplementation(() => {});
            await encoder.init({ element: nextElement });
            await firstRejected;

            const oldElement = provisional.elements[0];
            expect(oldElement.pause).toHaveBeenCalledOnce();
            expect(oldElement.remove).toHaveBeenCalledOnce();
            expect(provisional.revokeObjectURL).toHaveBeenCalledOnce();
            expect(FakeAudioContext.instances).toHaveLength(1);
            expect(FakeAudioWorkletNode.instances).toHaveLength(1);

            // Preserve the old public p-defer-compatible call shape.
            encoder.initializing.resolve();

            oldElement.dispatchEvent(new Event("loadedmetadata"));
            await Promise.resolve();
            expect(FakeAudioContext.instances).toHaveLength(1);

            await encoder.destroy();
        } finally {
            provisional.restore();
        }
    });

    it("revokes a provisional object URL when Audio construction throws", async () => {
        const audioDescriptor = Object.getOwnPropertyDescriptor(
            globalThis,
            "Audio"
        );
        const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
            URL,
            "createObjectURL"
        );
        const revokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
            URL,
            "revokeObjectURL"
        );
        const objectUrl = "blob:throwing-audio";
        const createObjectURL = vi.fn(() => objectUrl);
        const revokeObjectURL = vi.fn();
        const constructionFailure = new Error(
            "synthetic Audio construction failure"
        );

        class ThrowingAudio {
            constructor() {
                throw constructionFailure;
            }
        }

        Object.defineProperty(globalThis, "Audio", {
            configurable: true,
            value: ThrowingAudio,
        });
        Object.defineProperty(URL, "createObjectURL", {
            configurable: true,
            value: createObjectURL,
        });
        Object.defineProperty(URL, "revokeObjectURL", {
            configurable: true,
            value: revokeObjectURL,
        });

        try {
            const encoder = new WAVEncoder();
            const file = {} as File;
            await expect(encoder.init({ file, useElement: true })).rejects.toBe(
                constructionFailure
            );

            expect(createObjectURL).toHaveBeenCalledOnce();
            expect(createObjectURL).toHaveBeenCalledWith(file);
            expect(revokeObjectURL).toHaveBeenCalledOnce();
            expect(revokeObjectURL).toHaveBeenCalledWith(objectUrl);

            await encoder.destroy();
            expect(revokeObjectURL).toHaveBeenCalledOnce();
        } finally {
            restoreProperty(globalThis, "Audio", audioDescriptor);
            restoreProperty(URL, "createObjectURL", createObjectUrlDescriptor);
            restoreProperty(URL, "revokeObjectURL", revokeObjectUrlDescriptor);
        }
    });

    it("retains a failed encoder context until a later destroy closes it", async () => {
        const encoder = new WAVEncoder();
        const element = document.createElement("audio");
        vi.spyOn(element, "pause").mockImplementation(() => {});
        await encoder.init({ element });
        const context = FakeAudioContext.instances[0];
        context.closeFailuresRemaining = 2;

        await expect(encoder.destroy()).rejects.toThrow(
            "synthetic audio context close failure"
        );
        expect(context.closeCalls).toBe(1);
        expect(context.state).not.toBe("closed");

        await expect(encoder.destroy()).rejects.toThrow(
            "synthetic audio context close failure"
        );
        expect(context.closeCalls).toBe(2);
        expect(context.state).not.toBe("closed");

        await encoder.destroy();
        expect(context.closeCalls).toBe(3);
        expect(context.state).toBe("closed");
    });

    it("does not let re-init overtake an in-progress destroy", async () => {
        const encoder = new WAVEncoder();
        const oldElement = document.createElement("audio");
        const newElement = document.createElement("audio");
        vi.spyOn(oldElement, "pause").mockImplementation(() => {});
        vi.spyOn(newElement, "pause").mockImplementation(() => {});
        await encoder.init({ element: oldElement });
        const oldContext = FakeAudioContext.instances[0];
        let releaseClose!: () => void;
        oldContext.closeGate = new Promise<void>((resolve) => {
            releaseClose = resolve;
        });

        const destroying = encoder.destroy();
        let reinitialized = false;
        const reinitializing = encoder
            .init({ element: newElement })
            .then(() => {
                reinitialized = true;
            });
        await vi.waitFor(() => expect(oldContext.closeCalls).toBe(1));
        await Promise.resolve();

        expect(reinitialized).toBe(false);
        expect(oldContext.state).not.toBe("closed");
        expect(FakeAudioContext.instances).toHaveLength(1);
        expect(FakeAudioWorkletNode.instances).toHaveLength(1);

        releaseClose();
        await destroying;
        await reinitializing;
        expect(reinitialized).toBe(true);
        expect(oldContext.state).toBe("closed");
        expect(FakeAudioContext.instances).toHaveLength(2);
        expect(FakeAudioWorkletNode.instances).toHaveLength(2);

        await encoder.destroy();
    });

    it("removes its listener after each acknowledged flush", async () => {
        const encoder = new WAVEncoder();
        const port = new FakeMessagePort();
        port.postMessage = vi.fn((request: { requestId: number }) => {
            queueMicrotask(() => {
                port.dispatchEvent(
                    new MessageEvent("message", {
                        data: {
                            eventType: "flush-ack",
                            requestId: request.requestId,
                            terminal: false,
                        },
                    })
                );
            });
        });
        prepareDirectWorkletEncoder(encoder, port);
        const removeListener = vi.spyOn(port, "removeEventListener");

        await encoder.flush({ timeout: 100 });
        await encoder.flush({ timeout: 100 });

        expect(port.postMessage).toHaveBeenCalledTimes(2);
        expect(port.postMessage).toHaveBeenLastCalledWith({
            eventType: "flush",
            requestId: 2,
            terminal: false,
        });
        expect(removeListener).toHaveBeenCalledTimes(2);
    });

    it("bounds a missing worklet flush acknowledgement", async () => {
        vi.useFakeTimers();
        try {
            const encoder = new WAVEncoder();
            const port = new FakeMessagePort();
            prepareDirectWorkletEncoder(encoder, port);
            const removeListener = vi.spyOn(port, "removeEventListener");

            const flushing = encoder.flush({ timeout: 25 });
            const rejected = expect(flushing).rejects.toThrow(
                "Timed out waiting for audio worklet flush after 25 ms"
            );
            await vi.advanceTimersByTimeAsync(25);
            await rejected;
            expect(port.postMessage).toHaveBeenCalledWith({
                eventType: "flush",
                requestId: 1,
                terminal: false,
            });
            expect(removeListener).toHaveBeenCalledWith(
                "message",
                expect.any(Function)
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not let a late acknowledgement satisfy a newer flush", async () => {
        vi.useFakeTimers();
        try {
            const encoder = new WAVEncoder();
            const port = new FakeMessagePort();
            prepareDirectWorkletEncoder(encoder, port);

            const firstFlush = encoder.flush({ timeout: 25 });
            const firstRejected = expect(firstFlush).rejects.toThrow(
                "Timed out waiting for audio worklet flush after 25 ms"
            );
            await vi.advanceTimersByTimeAsync(25);
            await firstRejected;

            const secondFlush = encoder.flush({ timeout: 100 });
            await Promise.resolve();
            const firstRequest = port.postMessage.mock.calls[0][0];
            const secondRequest = port.postMessage.mock.calls[1][0];
            let secondSettled = false;
            void secondFlush.then(() => {
                secondSettled = true;
            });

            port.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        eventType: "flush-ack",
                        requestId: firstRequest.requestId,
                        terminal: false,
                    },
                })
            );
            await Promise.resolve();
            expect(secondSettled).toBe(false);

            port.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        eventType: "flush-ack",
                        requestId: secondRequest.requestId,
                        terminal: false,
                    },
                })
            );
            await secondFlush;
            expect(secondSettled).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("keeps public flush non-terminal and tags an ended flush", async () => {
        const encoder = new WAVEncoder();
        const element = document.createElement("audio");
        vi.spyOn(element, "pause").mockImplementation(() => {});
        const onEnded = vi.fn();
        await encoder.init({ element }, { onEnded });
        const port = FakeAudioWorkletNode.instances[0].port;

        const flushing = encoder.flush({ timeout: 100 });
        await Promise.resolve();
        const publicRequest = port.postMessage.mock.calls[0][0];
        expect(publicRequest).toMatchObject({
            eventType: "flush",
            terminal: false,
        });
        port.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    eventType: "flush-ack",
                    requestId: publicRequest.requestId,
                    terminal: false,
                },
            })
        );
        await flushing;
        expect(onEnded).not.toHaveBeenCalled();

        element.dispatchEvent(new Event("ended"));
        await Promise.resolve();
        const endedRequest = port.postMessage.mock.calls[1][0];
        expect(endedRequest).toMatchObject({
            eventType: "flush",
            terminal: true,
        });
        port.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    eventType: "flush-ack",
                    requestId: endedRequest.requestId,
                    terminal: true,
                },
            })
        );
        await vi.waitFor(() => expect(onEnded).toHaveBeenCalledOnce());

        await encoder.destroy();
    });

    it("coalesces overlapping finishes before destructive onEnded cleanup", async () => {
        const encoder = new WAVEncoder();
        const element = document.createElement("audio");
        vi.spyOn(element, "pause").mockImplementation(() => {});
        let destroying: Promise<void> | undefined;
        const onEnded = vi.fn(() => {
            destroying = encoder.destroy();
        });
        await encoder.init({ element }, { onEnded });
        const port = FakeAudioWorkletNode.instances[0].port;

        const firstFinish = encoder.finish();
        const secondFinish = encoder.finish();
        await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
        const request = port.postMessage.mock.calls[0][0];
        expect(request).toMatchObject({
            eventType: "flush",
            terminal: true,
        });

        port.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    eventType: "flush-ack",
                    requestId: request.requestId,
                    terminal: true,
                },
            })
        );

        await expect(Promise.all([firstFinish, secondFinish])).resolves.toEqual(
            [undefined, undefined]
        );
        expect(onEnded).toHaveBeenCalledOnce();
        expect(destroying).toBeDefined();
        await destroying;
        expect(port.postMessage).toHaveBeenCalledOnce();
        expect(port.close).toHaveBeenCalledOnce();
    });

    it.each([
        ["residual terminal data", true],
        ["an empty terminal buffer", false],
    ])(
        "settles finish before onEnded retires the encoder for %s",
        async (_description, withTerminalData) => {
            const encoder = new WAVEncoder();
            const element = document.createElement("audio");
            vi.spyOn(element, "pause").mockImplementation(() => {});
            let destroying: Promise<void> | undefined;
            const onEnded = vi.fn(() => {
                destroying = encoder.destroy();
            });
            await encoder.init({ element }, { onEnded });
            const port = FakeAudioWorkletNode.instances[0].port;

            const finishing = encoder.finish();
            await vi.waitFor(() =>
                expect(port.postMessage).toHaveBeenCalledOnce()
            );
            const request = port.postMessage.mock.calls[0][0];
            expect(request).toMatchObject({
                eventType: "flush",
                terminal: true,
            });

            if (withTerminalData) {
                port.dispatchEvent(
                    new MessageEvent("message", {
                        data: {
                            eventType: "data",
                            audioBuffer: new Uint8Array([1]),
                            last: true,
                        },
                    })
                );
            } else {
                port.dispatchEvent(
                    new MessageEvent("message", {
                        data: {
                            eventType: "flush-ack",
                            requestId: request.requestId,
                            terminal: true,
                        },
                    })
                );
            }

            await expect(finishing).resolves.toBeUndefined();
            expect(onEnded).toHaveBeenCalledOnce();
            expect(destroying).toBeDefined();
            await destroying;
            expect(port.close).toHaveBeenCalledOnce();

            // A residual final chunk settles the request before user cleanup;
            // its following acknowledgement is late. For an empty buffer this
            // is a duplicate acknowledgement. Neither can notify twice.
            port.dispatchEvent(
                new MessageEvent("message", {
                    data: {
                        eventType: "flush-ack",
                        requestId: request.requestId,
                        terminal: true,
                    },
                })
            );
            expect(onEnded).toHaveBeenCalledOnce();
        }
    );

    it("keeps public finish successful when onChunk tears down after final data", async () => {
        const encoder = new WAVEncoder();
        const element = document.createElement("audio");
        vi.spyOn(element, "pause").mockImplementation(() => {});
        const onEnded = vi.fn();
        let destroying: Promise<void> | undefined;
        await encoder.init(
            { element },
            {
                onChunk: ({ last }) => {
                    if (last) {
                        destroying = encoder.destroy();
                    }
                },
                onEnded,
            }
        );
        const port = FakeAudioWorkletNode.instances[0].port;

        const finishing = encoder.finish();
        await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledOnce());
        const request = port.postMessage.mock.calls[0][0];
        port.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    eventType: "data",
                    audioBuffer: new Uint8Array([1]),
                    last: true,
                },
            })
        );

        await expect(finishing).resolves.toBeUndefined();
        expect(destroying).toBeDefined();
        await destroying;
        expect(onEnded).toHaveBeenCalledOnce();
        expect(port.close).toHaveBeenCalledOnce();

        port.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    eventType: "flush-ack",
                    requestId: request.requestId,
                    terminal: true,
                },
            })
        );
        await Promise.resolve();
        expect(onEnded).toHaveBeenCalledOnce();
    });

    it("notifies terminal completion from the last chunk before cleanup removes the acknowledgement listener", async () => {
        const encoder = new WAVEncoder();
        const element = document.createElement("audio");
        vi.spyOn(element, "pause").mockImplementation(() => {});
        const onEnded = vi.fn();
        let destroying: Promise<void> | undefined;
        await encoder.init(
            { element },
            {
                onChunk: ({ last }) => {
                    if (last) {
                        destroying = encoder.destroy();
                    }
                },
                onEnded,
            }
        );
        const port = FakeAudioWorkletNode.instances[0].port;

        element.dispatchEvent(new Event("ended"));
        await Promise.resolve();
        const request = port.postMessage.mock.calls[0][0];
        port.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    eventType: "data",
                    audioBuffer: new Uint8Array([1]),
                    last: true,
                },
            })
        );
        expect(destroying).toBeDefined();
        await destroying;
        expect(port.close).toHaveBeenCalledOnce();
        expect(onEnded).toHaveBeenCalledOnce();

        // A late acknowledgement is either fenced by destroy or deduplicated.
        port.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    eventType: "flush-ack",
                    requestId: request.requestId,
                    terminal: true,
                },
            })
        );
        await Promise.resolve();
        expect(onEnded).toHaveBeenCalledOnce();
    });

    it("suspends and pauses when a terminal finish flush times out", async () => {
        vi.useFakeTimers();
        try {
            const encoder = new WAVEncoder();
            const port = new FakeMessagePort();
            prepareDirectWorkletEncoder(encoder, port);
            const context = new FakeAudioContext();
            const suspend = vi.spyOn(context, "suspend");
            const mediaElement = { pause: vi.fn() };
            const sourceNode = { disconnect: vi.fn() };
            encoder.ctx = context as any;
            (encoder as any).mediaEl = mediaElement;
            (encoder as any).srcNode = sourceNode;

            const finishing = encoder.finish();
            const rejected = expect(finishing).rejects.toThrow(
                "Timed out waiting for audio worklet flush after 2000 ms"
            );
            for (let index = 0; index < 4; index++) {
                await Promise.resolve();
            }
            expect(port.postMessage).toHaveBeenCalledWith({
                eventType: "flush",
                requestId: 1,
                terminal: true,
            });
            await vi.advanceTimersByTimeAsync(2_000);
            await rejected;
            expect(sourceNode.disconnect).toHaveBeenCalledOnce();
            expect(suspend).toHaveBeenCalledOnce();
            expect(mediaElement.pause).toHaveBeenCalledOnce();
        } finally {
            vi.useRealTimers();
        }
    });

    it("awaits the offline producer and delivered completion in finish", async () => {
        const encoder = new WAVEncoder();
        const onEnded = vi.fn();
        const file = {
            arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1)),
        } as unknown as File;
        await encoder.init({ file, useElement: false }, { onEnded });
        const context = FakeAudioContext.instances[0];
        await vi.waitFor(() => expect(context.pendingDecodes).toHaveLength(1));

        let finished = false;
        const finishing = encoder.finish().then(() => {
            finished = true;
        });
        await Promise.resolve();
        expect(finished).toBe(false);

        context.pendingDecodes[0].resolve({
            duration: 0,
            length: 0,
            numberOfChannels: 1,
            sampleRate: 48_000,
            getChannelData: () => new Float32Array(),
        } as unknown as AudioBuffer);
        await finishing;
        expect(finished).toBe(true);
        expect(onEnded).toHaveBeenCalledOnce();

        await encoder.destroy();
        expect(onEnded).toHaveBeenCalledOnce();
    });

    it("retains failed offline producer context cleanup for another destroy", async () => {
        const encoder = new WAVEncoder();
        const file = {
            arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1)),
        } as unknown as File;
        await encoder.init({ file, useElement: false });
        const context = FakeAudioContext.instances[0];
        context.closeFailuresRemaining = 2;
        await vi.waitFor(() => expect(context.pendingDecodes).toHaveLength(1));
        context.pendingDecodes[0].resolve({
            duration: 0,
            length: 0,
            numberOfChannels: 1,
            sampleRate: 48_000,
            getChannelData: () => new Float32Array(),
        } as unknown as AudioBuffer);
        await vi.waitFor(() => expect(context.closeCalls).toBe(1));

        await expect(encoder.destroy()).rejects.toThrow(
            "Failed to retire WAV encoder resources"
        );
        expect(context.closeCalls).toBe(2);
        expect(context.state).not.toBe("closed");

        await encoder.destroy();
        expect(context.closeCalls).toBe(3);
        expect(context.state).toBe("closed");
    });

    it("awaits and fences an offline producer before re-init", async () => {
        const encoder = new WAVEncoder();
        const oldOnChunk = vi.fn();
        const file = {
            arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(1)),
        } as unknown as File;
        await encoder.init(
            { file, useElement: false },
            { onChunk: oldOnChunk }
        );
        const offlineContext = FakeAudioContext.instances[0];
        await vi.waitFor(() =>
            expect(offlineContext.pendingDecodes).toHaveLength(1)
        );

        const nextElement = document.createElement("audio");
        vi.spyOn(nextElement, "pause").mockImplementation(() => {});
        let reinitialized = false;
        const reinitializing = encoder
            .init({ element: nextElement })
            .then(() => {
                reinitialized = true;
            });
        await Promise.resolve();
        expect(reinitialized).toBe(false);

        offlineContext.pendingDecodes[0].resolve({
            duration: 0,
            length: 0,
            numberOfChannels: 1,
            sampleRate: 48_000,
            getChannelData: () => new Float32Array(),
        } as unknown as AudioBuffer);
        await reinitializing;
        expect(oldOnChunk).not.toHaveBeenCalled();
        expect(FakeAudioWorkletNode.instances).toHaveLength(1);

        await encoder.destroy();
    });

    it("fences retired ports and old media ended listeners on re-init", async () => {
        const encoder = new WAVEncoder();
        const oldElement = document.createElement("audio");
        const newElement = document.createElement("audio");
        vi.spyOn(oldElement, "pause").mockImplementation(() => {});
        vi.spyOn(newElement, "pause").mockImplementation(() => {});
        const oldOnChunk = vi.fn();
        const oldOnEnded = vi.fn();

        await encoder.init(
            { element: oldElement },
            { onChunk: oldOnChunk, onEnded: oldOnEnded }
        );
        const oldPort = FakeAudioWorkletNode.instances[0].port;
        await encoder.init({ element: newElement });
        const newPort = FakeAudioWorkletNode.instances[1].port;
        expect(oldPort.close).toHaveBeenCalledOnce();

        oldPort.dispatchEvent(
            new MessageEvent("message", {
                data: {
                    eventType: "data",
                    audioBuffer: new Uint8Array([1]),
                    last: true,
                },
            })
        );
        oldElement.dispatchEvent(new Event("ended"));
        await Promise.resolve();
        expect(oldOnChunk).not.toHaveBeenCalled();
        expect(oldOnEnded).not.toHaveBeenCalled();
        expect(newPort.postMessage).not.toHaveBeenCalled();

        await encoder.destroy();
    });
});
