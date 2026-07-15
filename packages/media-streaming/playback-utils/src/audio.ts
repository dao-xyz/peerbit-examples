/**
 * Wave encoder that can run inside in a worklet
 */

// self contained worklet for encoding
const url_worklet = URL.createObjectURL(
    new Blob(
        [
            "(",
            function () {
                class ConvertBitsProcessor extends AudioWorkletProcessor {
                    // ──────────────────────────────────────────────
                    //                                                state
                    // ──────────────────────────────────────────────
                    private readonly SR = sampleRate; // device sample-rate
                    private readonly MIN_CHUNK = 5_000; // ~100 ms @ 48 kHz

                    private buf: Float32Array[][] = []; // gathered frames
                    private bufLen = 0; // samples in `buf`
                    private written = 0; // total PCM16 samples sent

                    // cached WAV header (invalid once channel-count changes)
                    private hdrCache?: { ch: number; data: Uint8Array };

                    // ──────────────────────────────────────────────
                    constructor() {
                        super();

                        // external drain/terminal flush
                        this.port.onmessage = (ev: MessageEvent<any>) => {
                            const legacyFlush = ev.data === "flush";
                            const taggedFlush = ev.data?.eventType === "flush";
                            if (legacyFlush || taggedFlush) {
                                const terminal =
                                    legacyFlush || ev.data.terminal === true;
                                this.emit(true, terminal);
                                if (legacyFlush) return;
                                this.port.postMessage({
                                    eventType: "flush-ack",
                                    requestId: ev.data.requestId,
                                    terminal,
                                });
                            }
                        };
                    }

                    // ──────────────────────────────────────────────
                    //                                               helpers
                    // ──────────────────────────────────────────────
                    private merge(ch: number): Float32Array {
                        const out = new Float32Array(this.buf.length * 128);
                        let off = 0;
                        for (const frame of this.buf) {
                            out.set(frame[ch], off);
                            off += frame[ch].length;
                        }
                        return out;
                    }

                    private interleave(
                        l: Float32Array,
                        r: Float32Array
                    ): Float32Array {
                        const res = new Float32Array(l.length + r.length);
                        for (let i = 0, j = 0; i < l.length; i++) {
                            res[j++] = l[i];
                            res[j++] = r[i];
                        }
                        return res;
                    }

                    /** WAV pcm-16 header for *dataLength* bytes */
                    private header(
                        channels: number,
                        dataBytes: number
                    ): Uint8Array {
                        if (this.hdrCache?.ch !== channels) {
                            const h = new DataView(new ArrayBuffer(44));
                            const BPS = 2;
                            h.setUint32(0, 0x52494646, false); // RIFF
                            h.setUint32(8, 0x57415645, false); // WAVE
                            h.setUint32(12, 0x666d7420, false);
                            h.setUint32(16, 16, true);
                            h.setUint16(20, 1, true); // PCM
                            h.setUint16(22, channels, true);
                            h.setUint32(24, sampleRate, true);
                            h.setUint32(28, sampleRate * BPS * channels, true);
                            h.setUint16(32, BPS * channels, true);
                            h.setUint16(34, 16, true);
                            h.setUint32(36, 0x64617461, false); // data
                            this.hdrCache = {
                                ch: channels,
                                data: new Uint8Array(h.buffer),
                            };
                        }

                        // clone & patch sizes
                        const hdr = new Uint8Array(this.hdrCache.data); // copy!
                        const v = new DataView(hdr.buffer);
                        v.setUint32(4, dataBytes + 36, true); // file size
                        v.setUint32(40, dataBytes, true); // data size
                        return hdr;
                    }

                    /** PCM32 → PCM16 and post Message */
                    private emit(force = false, last = false): void {
                        if (this.buf.length === 0) return;
                        if (!force && this.bufLen < this.MIN_CHUNK) return;

                        const ch = this.buf[0].length;
                        const merged =
                            ch === 2
                                ? this.interleave(this.merge(0), this.merge(1))
                                : this.merge(0);

                        const pcm16 = new Int16Array(merged.length);
                        for (let i = 0; i < merged.length; i++) {
                            const s = Math.max(-1, Math.min(1, merged[i]));
                            pcm16[i] = s * 0x7fff;
                        }

                        const pcmBytes = new Uint8Array(pcm16.buffer);
                        const msg = {
                            eventType: "data",
                            audioBuffer: new Uint8Array(44 + pcmBytes.length),
                            timestamp: Math.round(
                                (this.written / this.SR) * 1e6
                            ),
                            last,
                        };

                        // copy header + payload
                        msg.audioBuffer.set(
                            this.header(ch, pcmBytes.length),
                            0
                        );
                        msg.audioBuffer.set(pcmBytes, 44);

                        this.written += merged.length / ch;
                        this.port.postMessage(msg, [msg.audioBuffer.buffer]);

                        // reset buffer
                        this.buf = [];
                        this.bufLen = 0;
                    }

                    // ──────────────────────────────────────────────
                    //                                                main callback
                    // ──────────────────────────────────────────────
                    process(inputs: Float32Array[][]): boolean {
                        const inp = inputs[0];
                        if (inp.length === 0) return true; // silent quantum

                        this.buf.push(inp.map((c) => new Float32Array(c)));
                        this.bufLen += 128 * inp.length;
                        this.emit(false, false);

                        return true; // keep processor alive
                    }
                }

                registerProcessor(
                    "convert-bits-processor",
                    ConvertBitsProcessor
                );
            }.toString(),
            ")()",
        ],
        { type: "application/javascript" }
    )
);

import type { AudioStreamDB, Chunk, Track } from "@peerbit/media-streaming";

type DeferredPromise<T> = {
    promise: Promise<T>;
    resolve: (value?: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
};

const createDeferred = <T>(): DeferredPromise<T> => {
    let resolve!: (value?: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = (value) => promiseResolve(value as T | PromiseLike<T>);
        reject = promiseReject;
    });
    return { promise, resolve, reject };
};

const delay = (milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/* —————————————————————————————————————————— */
/*  TYPE HELPERS                                                               */
/* —————————————————————————————————————————— */
type WAVEncoderSource =
    | { element: HTMLMediaElement; file?: never; useElement?: true }
    | { file: File; useElement?: boolean };

export interface WAVEncoderEvents {
    /** every ≈100 ms */
    onChunk?(payload: {
        audioBuffer: Uint8Array;
        timestamp: number;
        last?: boolean;
        index: number;
        length: number;
    }): void;

    /** source reached its terminal end after final chunk delivery */
    onEnded?(): void;
}

/* —————————————————————————————————————————— */
/*  ENCODING HELPERS                                          
/* —————————————————————————————————————————— */

const pcm16Header = (channels: number, sampleRate: number): Uint8Array => {
    const hdr = new Uint8Array(44);
    const v = new DataView(hdr.buffer);
    const BPS = 2; // 16-bit

    v.setUint32(0, 0x52494646, false); // "RIFF"
    v.setUint32(8, 0x57415645, false); // "WAVE"
    v.setUint32(12, 0x666d7420, false);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, channels, true);
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * BPS * channels, true);
    v.setUint16(32, BPS * channels, true);
    v.setUint16(34, 16, true);
    v.setUint32(36, 0x64617461, false); // "data"
    return hdr;
};

const floatBufToWav = (buf: AudioBuffer, hdr: Uint8Array) => {
    const samples = buf.length * buf.numberOfChannels;
    const out = new Uint8Array(44 + samples * 2);
    const v = new DataView(out.buffer);

    /* copy + patch header */
    out.set(hdr, 0);
    v.setUint32(4, 36 + samples * 2, true); // file size
    v.setUint32(40, samples * 2, true); // data chunk size

    const tmp = new Int16Array(samples);
    for (let i = 0, o = 0; i < buf.length; i++) {
        for (let ch = 0; ch < buf.numberOfChannels; ch++, o++) {
            let s = buf.getChannelData(ch)[i];
            s = Math.max(-1, Math.min(1, s));
            tmp[o] = s * 32767;
        }
    }
    out.set(new Uint8Array(tmp.buffer), 44);
    return out;
};

/* —————————————————————————————————————————— */
/*  CLASS                                                                      */
/* —————————————————————————————————————————— */

export class WAVEncoder {
    /** always valid – either Worklet port (real-time) or a MessageChannel port */
    public port!: MessagePort;

    /** lets callers `await wav.initializing.promise` */
    public initializing: DeferredPromise<void>;

    /* internal refs */
    public ctx?: AudioContext; // public to access current time
    private node?: AudioWorkletNode;
    private srcNode?: MediaElementAudioSourceNode;
    private mediaEl?: HTMLMediaElement;
    private ownsMedia = false;
    private objURL?: string;
    private nextFlushRequestId = 0;
    private lifecycleGeneration = 0;
    private activePort?: MessagePort;
    private activePortListener?: (event: MessageEvent) => void;
    private endedElement?: HTMLMediaElement;
    private endedListener?: () => void;
    private offlineAbortController?: AbortController;
    private offlineProducer?: Promise<void>;
    private offlineDelivery?: DeferredPromise<void>;
    private offlineProducerPort?: MessagePort;
    private elementPreparationAbortController?: AbortController;
    private pendingFlushes = new Set<{
        port: MessagePort;
        listener: (event: MessageEvent) => void;
        requestId: number;
        terminal: boolean;
        resolve: (value?: void | PromiseLike<void>) => void;
        reject: (reason?: unknown) => void;
    }>();
    private terminalFlush?: {
        port: MessagePort;
        generation: number;
        promise: Promise<void>;
    };
    private retirementDrain: Promise<void> = Promise.resolve();
    private retiredContexts = new Set<AudioContext>();
    private retiredProducers = new Set<Promise<void>>();

    private isGenerationActive(generation: number) {
        return generation === this.lifecycleGeneration;
    }

    private hasPendingTerminalFlush(port: MessagePort) {
        for (const pending of this.pendingFlushes) {
            if (pending.port === port && pending.terminal) return true;
        }
        return false;
    }

    private settlePendingFlush(port: MessagePort, requestId: number) {
        for (const pending of this.pendingFlushes) {
            if (pending.port !== port || pending.requestId !== requestId) {
                continue;
            }
            pending.port.removeEventListener("message", pending.listener);
            this.pendingFlushes.delete(pending);
            pending.resolve(undefined);
            return true;
        }
        return false;
    }

    private settlePendingTerminalFlushes(port: MessagePort) {
        let settled = false;
        for (const pending of [...this.pendingFlushes]) {
            if (pending.port !== port || !pending.terminal) continue;
            pending.port.removeEventListener("message", pending.listener);
            this.pendingFlushes.delete(pending);
            pending.resolve(undefined);
            settled = true;
        }
        return settled;
    }

    private installPortListener(
        port: MessagePort,
        generation: number,
        handlers: WAVEncoderEvents,
        offlineDelivery?: DeferredPromise<void>
    ) {
        let terminalNotified = false;
        const notifyTerminal = () => {
            if (terminalNotified) return;
            terminalNotified = true;
            handlers.onEnded?.();
        };
        const forward = (event: MessageEvent) => {
            if (
                !this.isGenerationActive(generation) ||
                this.activePort !== port
            ) {
                return;
            }
            if (event.data?.audioBuffer) {
                if (event.data.last === true) {
                    // The worklet posts terminal data before its acknowledgement.
                    // Completing the terminal request now lets onChunk safely
                    // destroy or re-initialize the encoder without turning an
                    // already-delivered finish into a rejection.
                    this.settlePendingTerminalFlushes(port);
                }
                handlers.onChunk?.(event.data);
                if (
                    event.data.last === true &&
                    !this.hasPendingTerminalFlush(port)
                ) {
                    notifyTerminal();
                }
            }
            if (event.data?.eventType === "offline-complete") {
                offlineDelivery?.resolve(undefined);
                notifyTerminal();
            }
            if (
                event.data?.eventType === "flush-ack" &&
                event.data?.terminal === true
            ) {
                // Settle the terminal request before notifying user code. The
                // callback is allowed to destroy or re-initialize the encoder
                // without invalidating an acknowledgement already delivered by
                // the worklet.
                this.settlePendingFlush(port, event.data.requestId);
                // A terminal flush can have no residual buffered data. In that
                // case the acknowledgement is the only terminal notification.
                // Ignore an old/mismatched acknowledgement while a newer
                // terminal request still owns completion.
                if (!this.hasPendingTerminalFlush(port)) {
                    notifyTerminal();
                }
            }
        };
        this.activePort = port;
        this.activePortListener = forward;
        this.port = port;
        port.start();
        port.addEventListener("message", forward);
    }

    private async requestWorkletFlush(options: {
        port: MessagePort;
        generation: number;
        terminal: boolean;
        timeout?: number;
    }) {
        const { port, generation, terminal } = options;
        if (
            !this.isGenerationActive(generation) ||
            this.activePort !== port ||
            !this.node
        ) {
            throw new Error("Audio worklet is no longer active");
        }

        const flushed = createDeferred<void>();
        const requestId = ++this.nextFlushRequestId;
        const listener = (event: MessageEvent) => {
            if (
                event.data?.eventType === "flush-ack" &&
                event.data?.requestId === requestId
            ) {
                flushed.resolve(undefined);
            }
        };
        const pending = {
            port,
            listener,
            requestId,
            terminal,
            resolve: flushed.resolve,
            reject: flushed.reject,
        };
        this.pendingFlushes.add(pending);
        port.addEventListener("message", listener);

        const requestedTimeout = options.timeout;
        const timeout =
            requestedTimeout == null
                ? 2_000
                : Number.isFinite(requestedTimeout)
                  ? Math.max(0, requestedTimeout)
                  : 2_000;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
            port.postMessage({
                eventType: "flush",
                requestId,
                terminal,
            });
            await Promise.race([
                flushed.promise,
                new Promise<never>((_resolve, reject) => {
                    timeoutHandle = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `Timed out waiting for audio worklet flush after ${timeout} ms`
                                )
                            ),
                        timeout
                    );
                }),
            ]);
        } finally {
            if (timeoutHandle !== undefined) {
                clearTimeout(timeoutHandle);
            }
            port.removeEventListener("message", listener);
            this.pendingFlushes.delete(pending);
        }
    }

    private requestTerminalWorkletFlush(options: {
        port: MessagePort;
        generation: number;
        timeout?: number;
    }) {
        const current = this.terminalFlush;
        if (
            current?.port === options.port &&
            current.generation === options.generation
        ) {
            return current.promise;
        }

        const promise = this.requestWorkletFlush({
            ...options,
            terminal: true,
        }).finally(() => {
            if (this.terminalFlush?.promise === promise) {
                this.terminalFlush = undefined;
            }
        });
        this.terminalFlush = {
            port: options.port,
            generation: options.generation,
            promise,
        };
        return promise;
    }

    private async drainRetiredResources() {
        const failures: unknown[] = [];
        const producers = [...this.retiredProducers];
        const producerResults = await Promise.allSettled(producers);
        for (let i = 0; i < producerResults.length; i++) {
            const result = producerResults[i];
            // A producer promise is terminal and cannot be rerun. Any
            // retryable AudioContext cleanup it owns is retained separately.
            this.retiredProducers.delete(producers[i]);
            if (result.status === "rejected") {
                failures.push(result.reason);
            }
        }

        // Snapshot after producers settle: an offline producer can discover a
        // failed temporary-context close while it is draining.
        const contexts = [...this.retiredContexts];
        const contextResults = await Promise.allSettled(
            contexts.map((context) =>
                context.state === "closed"
                    ? Promise.resolve()
                    : Promise.resolve().then(() => context.close())
            )
        );
        for (let i = 0; i < contextResults.length; i++) {
            const result = contextResults[i];
            if (result.status === "fulfilled") {
                this.retiredContexts.delete(contexts[i]);
            } else {
                failures.push(result.reason);
            }
        }

        if (failures.length === 1) {
            throw failures[0];
        }
        if (failures.length > 1) {
            throw new AggregateError(
                failures,
                "Failed to retire WAV encoder resources"
            );
        }
    }

    private retireCurrentResources() {
        const activePort = this.activePort;
        const activePortListener = this.activePortListener;
        const endedElement = this.endedElement;
        const endedListener = this.endedListener;
        const offlineAbortController = this.offlineAbortController;
        const offlineProducer = this.offlineProducer;
        const offlineDelivery = this.offlineDelivery;
        const offlineProducerPort = this.offlineProducerPort;
        const elementPreparationAbortController =
            this.elementPreparationAbortController;
        const context = this.ctx;
        const sourceNode = this.srcNode;
        const workletNode = this.node;
        const mediaElement = this.mediaEl;
        const ownsMedia = this.ownsMedia;
        const objectUrl = this.objURL;

        if (context) {
            this.retiredContexts.add(context);
        }
        if (offlineProducer) {
            this.retiredProducers.add(offlineProducer);
        }

        this.activePort = undefined;
        this.activePortListener = undefined;
        this.endedElement = undefined;
        this.endedListener = undefined;
        this.offlineAbortController = undefined;
        this.offlineProducer = undefined;
        this.offlineDelivery = undefined;
        this.offlineProducerPort = undefined;
        this.elementPreparationAbortController = undefined;
        this.terminalFlush = undefined;
        this.ctx = undefined;
        this.srcNode = undefined;
        this.node = undefined;
        this.mediaEl = undefined;
        this.ownsMedia = false;
        this.objURL = undefined;

        elementPreparationAbortController?.abort();
        offlineAbortController?.abort();
        offlineDelivery?.resolve(undefined);
        if (activePort && activePortListener) {
            activePort.removeEventListener("message", activePortListener);
        }
        if (endedElement && endedListener) {
            endedElement.removeEventListener("ended", endedListener);
        }
        for (const pending of [...this.pendingFlushes]) {
            pending.port.removeEventListener("message", pending.listener);
            pending.reject(
                new Error("WAVEncoder was retired before its flush completed")
            );
            this.pendingFlushes.delete(pending);
        }

        try {
            mediaElement?.pause();
        } catch {
            // A detached media element can already be unable to pause.
        }
        try {
            sourceNode?.disconnect();
        } catch {
            // The source can already be disconnected by finish.
        }
        try {
            workletNode?.disconnect();
        } catch {
            // The worklet can already be disconnected.
        }
        activePort?.close();
        if (offlineProducerPort !== activePort) {
            offlineProducerPort?.close();
        }
        if (ownsMedia && mediaElement) {
            mediaElement.remove();
        }
        if (objectUrl) {
            URL.revokeObjectURL(objectUrl);
        }

        const previousDrain = this.retirementDrain;
        const nextDrain = previousDrain
            .catch(() => {})
            .then(() => this.drainRetiredResources());
        // Keep ignored lifecycle calls from becoming unhandled rejections while
        // preserving the rejecting promise for callers that await it.
        void nextDrain.catch(() => {});
        this.retirementDrain = nextDrain;
        return nextDrain;
    }

    /* ---------------------------------- init ------------------------ */

    async init(src: WAVEncoderSource, handlers: WAVEncoderEvents = {}) {
        const generation = ++this.lifecycleGeneration;
        this.initializing?.reject(new Error("Reset"));
        await this.retireCurrentResources();
        if (!this.isGenerationActive(generation)) {
            throw new Error("WAVEncoder initialization was superseded");
        }
        const initializing = createDeferred<void>();
        // Consumers may choose not to await the public initialization handle;
        // lifecycle supersession must not become an unhandled rejection.
        void initializing.promise.catch(() => {});
        this.initializing = initializing;

        try {
            /* ── real-time branch ───────────────────────────────────────── */
            if ("element" in src || src.useElement) {
                if ("element" in src) {
                    this.mediaEl = src.element;
                    this.ownsMedia = false;
                } else {
                    const preparationAbortController = new AbortController();
                    this.elementPreparationAbortController =
                        preparationAbortController;
                    let prepared: {
                        element: HTMLAudioElement;
                        url: string;
                    };
                    try {
                        prepared = await this._prepareElementFromFile(
                            src.file,
                            preparationAbortController.signal
                        );
                    } finally {
                        if (
                            this.elementPreparationAbortController ===
                            preparationAbortController
                        ) {
                            this.elementPreparationAbortController = undefined;
                        }
                    }
                    if (!this.isGenerationActive(generation)) {
                        try {
                            prepared.element.pause();
                        } catch {
                            // A superseded provisional element can already be
                            // unable to pause.
                        }
                        prepared.element.remove();
                        URL.revokeObjectURL(prepared.url);
                        throw new Error(
                            "WAVEncoder initialization was superseded"
                        );
                    }
                    this.mediaEl = prepared.element;
                    this.objURL = prepared.url;
                    this.ownsMedia = true;
                }

                this.ctx = new AudioContext();
                await this.ctx.audioWorklet.addModule(url_worklet);
                if (!this.isGenerationActive(generation)) {
                    throw new Error("WAVEncoder initialization was superseded");
                }

                this.srcNode = this.ctx.createMediaElementSource(this.mediaEl!);
                this.node = new AudioWorkletNode(
                    this.ctx,
                    "convert-bits-processor"
                );
                const port = this.node.port;
                this.installPortListener(port, generation, handlers);
                const element = this.mediaEl;
                const flushOnEnded = () => {
                    element.removeEventListener("ended", flushOnEnded);
                    if (
                        !this.isGenerationActive(generation) ||
                        this.activePort !== port
                    ) {
                        return;
                    }
                    void this.requestTerminalWorkletFlush({
                        port,
                        generation,
                    }).catch((error) => {
                        if (this.isGenerationActive(generation)) {
                            console.error(
                                "Failed to flush an ended audio stream",
                                error
                            );
                        }
                    });
                };
                this.endedElement = element;
                this.endedListener = flushOnEnded;
                element.addEventListener("ended", flushOnEnded);

                this.srcNode.connect(this.node);
                this.node.connect(this.ctx.destination);

                initializing.resolve(undefined);
                return;
            }

            /* ── offline / file branch  without using element (fastest) ──────────────────────────────────── */
            // this path seems to be glitchy broken when we deploy our site and might lead to issues when decoding wierd file formats
            const { port1, port2 } = new MessageChannel();
            const offlineDelivery = createDeferred<void>();
            const offlineAbortController = new AbortController();
            this.offlineDelivery = offlineDelivery;
            this.offlineAbortController = offlineAbortController;
            this.offlineProducerPort = port2;
            this.installPortListener(
                port1,
                generation,
                handlers,
                offlineDelivery
            );

            const producer = (async () => {
                /* 1️⃣  Decode with a short-lived context */
                const tmpCtx = new AudioContext();
                const DEVICE_SR = tmpCtx.sampleRate; // device sample-rate
                let srcBuf!: AudioBuffer;
                let decodeFailure: unknown;
                try {
                    const encoded = await src.file.arrayBuffer();
                    if (
                        !offlineAbortController.signal.aborted &&
                        this.isGenerationActive(generation)
                    ) {
                        srcBuf = await tmpCtx.decodeAudioData(encoded);
                    }
                } catch (error) {
                    decodeFailure = error;
                }
                try {
                    if (tmpCtx.state !== "closed") {
                        await tmpCtx.close();
                    }
                } catch (error) {
                    // decodeAudioData cannot be aborted. If its temporary
                    // context fails to close, transfer ownership to the
                    // serialized retirement drain for a later retry.
                    this.retiredContexts.add(tmpCtx);
                    if (!offlineAbortController.signal.aborted) {
                        decodeFailure = decodeFailure
                            ? new AggregateError(
                                  [decodeFailure, error],
                                  "Failed to decode and close offline audio"
                              )
                            : error;
                    }
                }
                if (
                    offlineAbortController.signal.aborted ||
                    !this.isGenerationActive(generation)
                ) {
                    return;
                }
                if (decodeFailure) throw decodeFailure;
                const inSR = srcBuf.sampleRate;
                const channels = srcBuf.numberOfChannels;

                const TARGET_SR = inSR === DEVICE_SR ? inSR : 48_000;
                let pcmBuf: AudioBuffer;
                if (inSR === TARGET_SR) {
                    /* already at our target - no resampling needed */
                    pcmBuf = srcBuf;
                } else {
                    /* 2️⃣b  Resample in one shot */

                    const frames = Math.ceil(srcBuf.duration * TARGET_SR);
                    console.log("RESAMPLE", { inSR, TARGET_SR, frames });

                    const offCtx = new OfflineAudioContext(
                        channels,
                        frames,
                        TARGET_SR
                    );

                    const srcNode = offCtx.createBufferSource();
                    srcNode.buffer = srcBuf;
                    srcNode.connect(offCtx.destination);
                    srcNode.start();

                    pcmBuf = await offCtx.startRendering(); // resampled buffer
                    /* OfflineAudioContext needs no close(); GC will collect it */
                }
                if (
                    offlineAbortController.signal.aborted ||
                    !this.isGenerationActive(generation)
                ) {
                    return;
                }

                /* 3️⃣  Chunk & stream */
                const CHUNK_FRAMES = Math.floor(0.1 * TARGET_SR); // 100 ms
                const STEP_US = 1e6 / TARGET_SR; // frames → µs
                const header = pcm16Header(channels, TARGET_SR);

                let tsUS = 0; // µ-seconds since start
                let yieldC = 0; // macro-task back-pressure

                for (let p = 0; p < pcmBuf.length; p += CHUNK_FRAMES) {
                    if (
                        offlineAbortController.signal.aborted ||
                        !this.isGenerationActive(generation)
                    ) {
                        return;
                    }
                    const len = Math.min(CHUNK_FRAMES, pcmBuf.length - p);

                    /* zero-copy view into original channel data -------------------- */
                    const slice = new AudioBuffer({
                        length: len,
                        numberOfChannels: channels,
                        sampleRate: TARGET_SR,
                    });
                    for (let ch = 0; ch < channels; ch++) {
                        slice.copyToChannel(
                            pcmBuf.getChannelData(ch).subarray(p, p + len),
                            ch
                        );
                    }

                    const payload = floatBufToWav(slice, header);

                    port2.postMessage(
                        {
                            eventType: "data",
                            audioBuffer: payload, // Uint8Array
                            timestamp: Math.round(tsUS), // μs
                            last: p + len >= pcmBuf.length,
                            index: p,
                            length: pcmBuf.length,
                        },
                        [payload.buffer] // transfer ownership
                    );

                    tsUS += len * STEP_US;
                    if (++yieldC === 5) {
                        // ~1.5 s of audio / task
                        yieldC = 0;
                        /* eslint-disable no-await-in-loop */
                        await delay(0); // let UI breathe
                    }
                }
                if (
                    offlineAbortController.signal.aborted ||
                    !this.isGenerationActive(generation)
                ) {
                    return;
                }
                port2.postMessage({
                    eventType: "offline-complete",
                    generation,
                });
                await offlineDelivery.promise;
            })().finally(() => {
                port2.close();
            });
            // Retain the producer error for finish/destroy while preventing a
            // fire-and-forget rejection when callers only observe onChunk.
            void producer.catch(() => {});
            this.offlineProducer = producer;

            initializing.resolve(undefined); // producer completion is awaited by finish
        } catch (e) {
            initializing.reject(e as Error);
            if (this.isGenerationActive(generation)) {
                await this.retireCurrentResources().catch(() => {});
            }
            throw e;
        }
    }

    /* ------------------------------- play / pause ------------------- */
    /* Real-time mode = forward to <audio>; offline mode = no-op        */

    async play() {
        await this.initializing.promise;
        await this.ctx?.resume();
        await this.mediaEl?.play();
    }

    async pause() {
        await this.initializing.promise;
        await this.ctx?.suspend();
        this.mediaEl?.pause();
    }

    async flush(options?: { timeout?: number }) {
        if (!this.initializing) return;
        await this.initializing.promise;
        const offlineProducer = this.offlineProducer;
        if (offlineProducer) {
            await offlineProducer;
            return;
        }
        const port = this.activePort;
        if (!this.node || !port) return;
        await this.requestWorkletFlush({
            port,
            generation: this.lifecycleGeneration,
            terminal: false,
            timeout: options?.timeout,
        });
    }

    async finish() {
        if (!this.initializing) return;
        await this.initializing.promise;
        const offlineProducer = this.offlineProducer;
        if (offlineProducer) {
            await offlineProducer;
            return;
        }

        const generation = this.lifecycleGeneration;
        const context = this.ctx;
        const mediaElement = this.mediaEl;
        const sourceNode = this.srcNode;
        const workletNode = this.node;
        const port = this.activePort;
        let failure: unknown;
        try {
            await context?.resume();
            // Disconnect input without suspending the worklet first. This
            // creates a stable producer boundary while the tagged terminal
            // flush is processed and acknowledged.
            if (sourceNode && workletNode) {
                try {
                    sourceNode.disconnect(workletNode);
                } catch {
                    // Already disconnected by an earlier idempotent finish.
                }
            }
            if (workletNode && port) {
                await this.requestTerminalWorkletFlush({
                    port,
                    generation,
                });
            }
        } catch (error) {
            failure = error;
        } finally {
            // A terminal callback may synchronously hand cleanup to destroy or
            // re-init. Do not let stale finish cleanup touch the successor or
            // report failures for resources now owned by retirement.
            if (this.isGenerationActive(generation)) {
                try {
                    await context?.suspend();
                } catch (error) {
                    failure = failure
                        ? new AggregateError(
                              [failure, error],
                              "Failed to finish and suspend the WAV encoder"
                          )
                        : error;
                }
                try {
                    mediaElement?.pause();
                } catch (error) {
                    failure = failure
                        ? new AggregateError(
                              [failure, error],
                              "Failed to finish and pause the WAV encoder"
                          )
                        : error;
                }
            }
        }
        if (failure) throw failure;
    }

    private _prepareElementFromFile(
        file: File,
        signal: AbortSignal
    ): Promise<{ element: HTMLAudioElement; url: string }> {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            let audio: HTMLAudioElement | undefined;
            let settled = false;
            let released = false;
            const cleanup = () => {
                audio?.removeEventListener("loadedmetadata", onLoaded);
                audio?.removeEventListener("error", onError);
                signal.removeEventListener("abort", onAbort);
            };
            const release = () => {
                if (released) return;
                released = true;
                try {
                    audio?.pause();
                } catch {
                    // A provisional element can already be unable to pause.
                }
                try {
                    audio?.remove();
                } catch {
                    // A partially constructed element can already be detached.
                }
                try {
                    URL.revokeObjectURL(url);
                } catch {
                    // Preserve the setup error when best-effort URL release fails.
                }
            };
            const onLoaded = () => {
                if (settled || !audio) return;
                settled = true;
                cleanup();
                resolve({ element: audio, url });
            };
            const onError = () => {
                if (settled) return;
                settled = true;
                cleanup();
                release();
                reject(new Error("Unable to load audio file"));
            };
            const onAbort = () => {
                if (settled) return;
                settled = true;
                cleanup();
                release();
                reject(new Error("WAVEncoder element preparation was retired"));
            };
            try {
                audio = new Audio(url);
                audio.crossOrigin = "anonymous";
                audio.preload = "auto";
                audio.addEventListener("loadedmetadata", onLoaded);
                audio.addEventListener("error", onError);
                signal.addEventListener("abort", onAbort, { once: true });
                if (signal.aborted) onAbort();
            } catch (error) {
                if (!settled) {
                    settled = true;
                    cleanup();
                    release();
                    reject(error);
                }
            }
        });
    }

    /* ------------------------------ destroy ------------------------- */

    async destroy() {
        this.lifecycleGeneration += 1;
        this.initializing?.reject(new Error("Destroyed"));
        await this.retireCurrentResources();
    }
}

export const createAudioStreamListener = (
    streamDB: Track<AudioStreamDB>,
    play: boolean,
    options?: {
        debug?: boolean;
        minExpectedLatency?: number;
        recoverLag?: boolean;
    }
) => {
    console.log("ADD AUDIO STREAM LISTENER");
    let pendingFrames: { buffer: AudioBuffer; timestamp: number }[] = [];
    let audioContext: AudioContext | undefined = undefined;
    let gainNode: GainNode | undefined = undefined;
    let audioContextListener: (() => void) | undefined;
    let playbackGeneration = 0;
    let lifecycleRequest = 0;
    let decodeGeneration = 0;
    let closed = false;
    let animationFrameHandle: number | undefined;
    let timerHandle: ReturnType<typeof setTimeout> | undefined;
    let resumingGeneration: number | undefined;
    let suspended = false;
    type DecodeJob = {
        chunk: Chunk;
        context: AudioContext;
        playbackGeneration: number;
        decodeGeneration: number;
    };
    type DecodePump = {
        queue: DecodeJob[];
        running: boolean;
        retired: boolean;
    };
    const createDecodePump = (): DecodePump => ({
        queue: [],
        running: false,
        retired: false,
    });
    let decodePump = createDecodePump();
    const contextsToClose = new Set<AudioContext>();
    let teardownDrain = Promise.resolve();

    const cancelScheduledRender = () => {
        if (animationFrameHandle !== undefined) {
            cancelAnimationFrame(animationFrameHandle);
            animationFrameHandle = undefined;
        }
        if (timerHandle !== undefined) {
            clearTimeout(timerHandle);
            timerHandle = undefined;
        }
    };

    const invalidatePlayback = () => {
        playbackGeneration += 1;
        decodeGeneration += 1;
        pendingFrames = [];
        bufferedAudioTime = undefined;
        resumingGeneration = undefined;
        suspended = false;
        // A decode cannot be aborted. Retire this context's pump so its one
        // in-flight decode cannot feed a later playback generation, while the
        // next context gets an independent single-concurrency pump.
        decodePump.retired = true;
        decodePump.queue = [];
        decodePump = createDecodePump();
        cancelScheduledRender();
    };

    const stop = () => {
        options?.debug && console.trace("STOP AUDIO LISTENER");
        invalidatePlayback();
        const contextToClose = audioContext;
        const listenerToRemove = audioContextListener;
        const gainToDisconnect = gainNode;
        audioContext = undefined;
        audioContextListener = undefined;
        gainNode = undefined;
        if (contextToClose) {
            contextsToClose.add(contextToClose);
            if (listenerToRemove) {
                contextToClose.removeEventListener(
                    "statechange",
                    listenerToRemove
                );
            }
            try {
                contextToClose.destination.disconnect();
            } catch {
                // The destination can already be disconnected during teardown.
            }
            try {
                gainToDisconnect?.disconnect();
            } catch {
                // The gain can already be disconnected during teardown.
            }
        }

        const previousDrain = teardownDrain;
        teardownDrain = previousDrain
            .catch(() => {})
            .then(async () => {
                const contexts = [...contextsToClose];
                const results = await Promise.allSettled(
                    contexts.map((context) =>
                        context.state === "closed"
                            ? Promise.resolve()
                            : context.close()
                    )
                );
                const failures: unknown[] = [];
                for (let i = 0; i < results.length; i++) {
                    const result = results[i];
                    if (result.status === "fulfilled") {
                        contextsToClose.delete(contexts[i]);
                    } else {
                        failures.push(result.reason);
                    }
                }
                if (failures.length === 1) {
                    throw failures[0];
                }
                if (failures.length > 1) {
                    throw new AggregateError(
                        failures,
                        "Failed to close one or more audio contexts"
                    );
                }
            });
        return teardownDrain;
    };
    const setVolume = (volume: number) => {
        if (gainNode) gainNode.gain.value = volume;
    };

    const setupAudioContext = async (request: number) => {
        await stop();
        if (closed || !play || request !== lifecycleRequest) {
            return;
        }
        options?.debug && console.log("SETUP AUDIO CONTEXT");
        const context = new AudioContext({
            sampleRate: streamDB.source.sampleRate,
        });
        const generation = ++playbackGeneration;
        const contextListener = () => {
            if (generation !== playbackGeneration || context !== audioContext) {
                return;
            }
            if (context.state === "suspended" || context.state === "closed") {
                console.log("AUDIO CONTEXT SUSPENDED OR CLOSED", context.state);
                // A suspended context may be an intentional buffering pause.
                // Explicit pause/close synchronously fence this generation.
                if (context.state === "closed") {
                    play = false;
                }
            }
        };
        audioContext = context;
        audioContextListener = contextListener;
        try {
            context.addEventListener("statechange", contextListener);
            gainNode = context.createGain();
            gainNode.connect(context.destination);
            bufferedAudioTime = 0;
            return { context, generation };
        } catch (setupError) {
            try {
                // Transfer partially initialized resources through the same
                // retryable teardown path as pause/close. If close also fails,
                // stop retains the context so a later play/close retries it.
                await stop();
            } catch (cleanupError) {
                throw new AggregateError(
                    [setupError, cleanupError],
                    "Failed to set up and retire the audio context"
                );
            }
            throw setupError;
        }
    };

    const mute = () => {}; // we don't do anything with the source, we let the controller set volume to 0
    const unmute = () => {}; // we don't do anything with the source, we let the controller set volume back to previous volume before mute

    let bufferedAudioTime: number | undefined = undefined;
    const MIN_EXPECTED_LATENCY = 0.01; // seconds
    const defaultMinExpectedLatency =
        options?.minExpectedLatency != null
            ? options?.minExpectedLatency / 1e3
            : MIN_EXPECTED_LATENCY;
    let targetLatency = defaultMinExpectedLatency;
    let succesfullFrameCount = 0;

    const isUnderflow = () => pendingFrames.length < 0;

    const updateTargetLatency = (latency: number) => {
        options?.debug && console.log("UPDATE EXPECTED LATENCY", latency);
        targetLatency = latency;
        /*  bufferedAudioTime = Math.max(
             currentExpectedLatency + audioContext!.currentTime,
             0
         ); */
    };

    const getBufferLag = () =>
        bufferedAudioTime && audioContext
            ? audioContext.currentTime - bufferedAudioTime
            : 0;

    const isCurrentPlayback = (generation: number, context: AudioContext) =>
        !closed &&
        play &&
        generation === playbackGeneration &&
        context === audioContext &&
        context.state !== "closed";

    const renderFrame = async (generation = playbackGeneration) => {
        const context = audioContext;
        if (!context || !isCurrentPlayback(generation, context)) {
            return;
        }
        if (!bufferedAudioTime) {
            // we've not yet started the queue - just queue this up,
            // leaving a "latency gap" so we're not desperately trying
            // to keep up.  Note if the network is slow, this is going
            // to fail.  Latency gap here is 100 ms.
            updateTargetLatency(defaultMinExpectedLatency);
        }

        /* if (!play) {
            return;
        } */
        if (pendingFrames.length === 0) {
            return;
        }
        if (!isCurrentPlayback(generation, context)) {
            return;
        }

        /**
         *  Take one element from the queue
         */
        const frame = pendingFrames.shift();

        const audioSource = context.createBufferSource();
        audioSource.buffer = frame!.buffer;
        audioSource.connect(gainNode!);

        const isBehindSeconds = Math.max(getBufferLag(), 0);

        let skipframe = false;
        if (isBehindSeconds > 0) {
            // we are not catching up, i.e. the player is going faster than we get new chunks
            if (isBehindSeconds > audioSource.buffer.duration) {
                skipframe = true;
            }
            succesfullFrameCount = 0;
            // here we want to do something about the expectedLatency, because if we also end up here
            // it means we are trying to watch in "too" much realtime
            updateTargetLatency(targetLatency * 2);
        } else if (targetLatency > defaultMinExpectedLatency) {
            succesfullFrameCount++;

            // we have been succesfully able to play audio for some time
            // lets try to reduce the latency
            if (succesfullFrameCount > 1000 && options?.recoverLag) {
                const newLatency = targetLatency / 2;
                if (newLatency >= MIN_EXPECTED_LATENCY) {
                    updateTargetLatency(newLatency);
                }
                succesfullFrameCount = 0;
            }
        }

        /* options?.debug &&
            console.log("RENDER AUDIO CHUNK", {
                bufferedAudioTime,
                currentTIme: audioContext?.currentTime,
                state: audioContext?.state,
                play,
                running: audioContext?.state === "running" && play,
                pending: pendingFrames.length,
                underflow: isUnderflow(),
                duration: audioSource.buffer.duration,
                start: frame!.timestamp / 1e6,
            }); */

        const catchUpStep = options?.recoverLag
            ? Math.max(isBehindSeconds, 0)
            : 0;

        !skipframe &&
            audioSource.start(
                /* options?.recoverLag
                    ? (frame!.timestamp / 1e6 + targetLatency)
                    : TODO this strategy can also be better? */
                bufferedAudioTime!,
                catchUpStep
            );

        /* console.log({
            skipframe,
            targetLatency,
            scheduleAt: options?.recoverLag ? frame!.timestamp / 1e6 : bufferedAudioTime,
        }) */
        bufferedAudioTime! += audioSource.buffer.duration; // this feels wrong
        scheduleNextTick(generation);
    };

    function scheduleNextTick(generation: number) {
        if (
            closed ||
            !play ||
            generation !== playbackGeneration ||
            animationFrameHandle !== undefined ||
            timerHandle !== undefined
        ) {
            return;
        }
        if (document.visibilityState === "visible") {
            animationFrameHandle = requestAnimationFrame(() => {
                animationFrameHandle = undefined;
                void renderFrame(generation);
            }); // requestAnimationFrame will not run in background. delay here is 1 ms, its fine as if weunderflow we will stop this loop
        } else {
            timerHandle = setTimeout(() => {
                timerHandle = undefined;
                void renderFrame(generation);
            }, 0);
        }
    }

    const processDecodeJob = async (pump: DecodePump, job: DecodeJob) => {
        const {
            chunk,
            context,
            playbackGeneration: generation,
            decodeGeneration: queuedDecodeGeneration,
        } = job;
        const isCurrentJob = () =>
            !pump.retired &&
            queuedDecodeGeneration === decodeGeneration &&
            isCurrentPlayback(generation, context);
        if (!isCurrentJob()) return;

        const zeroOffsetBuffer = new Uint8Array(chunk.chunk.length);
        zeroOffsetBuffer.set(chunk.chunk, 0);
        let data: AudioBuffer;
        try {
            data = await context.decodeAudioData(zeroOffsetBuffer.buffer);
        } catch (error) {
            if (isCurrentJob()) {
                console.error("Failed to decode error", error);
            }
            return;
        }
        if (!isCurrentJob()) return;

        const frame = {
            buffer: data,
            timestamp: chunk.time,
        };
        if (context.state !== "running") {
            pendingFrames = [frame];
            if (resumingGeneration !== generation) {
                resumingGeneration = generation;
                try {
                    await context.resume();
                } catch {
                    return;
                } finally {
                    if (resumingGeneration === generation) {
                        resumingGeneration = undefined;
                    }
                }
                if (isCurrentJob()) {
                    await renderFrame(generation);
                }
            }
        } else {
            pendingFrames.push(frame);
            if (!isUnderflow()) {
                await renderFrame(generation);
            }
        }
    };

    const runDecodePump = (pump: DecodePump) => {
        if (pump.running || pump.retired) return;
        pump.running = true;
        void (async () => {
            try {
                while (!pump.retired) {
                    const job = pump.queue.shift();
                    if (!job) return;
                    try {
                        await processDecodeJob(pump, job);
                    } catch (error) {
                        if (
                            !pump.retired &&
                            isCurrentPlayback(
                                job.playbackGeneration,
                                job.context
                            )
                        ) {
                            console.error(
                                "Failed to process decoded audio",
                                error
                            );
                        }
                    }
                }
            } finally {
                pump.running = false;
                if (!pump.retired && pump.queue.length > 0) {
                    runDecodePump(pump);
                }
            }
        })();
    };

    const push = (chunk: Chunk) => {
        const context = audioContext;
        if (!context || !isCurrentPlayback(playbackGeneration, context)) {
            return;
        }

        const pump = decodePump;
        if (pump.queue.length > 10) {
            options?.debug &&
                console.log(
                    "CLEARING AUDIO QUEUE CAN NOT KEEP UP",
                    pump.queue.length
                );
            // Keep the one in-flight decode, invalidate and drop the queued
            // generation, then enqueue only the newest backlog on this same
            // single-concurrency pump.
            decodeGeneration += 1;
            pendingFrames = [];
            pump.queue = [];
        }

        pump.queue.push({
            chunk,
            context,
            playbackGeneration,
            decodeGeneration,
        });
        runDecodePump(pump);
    };
    /*   const listener = (change: CustomEvent<DocumentsChange<Chunk>>) => {
  
          if (play) {
              for (const added of change.detail.added) {
                  // seems like 'decodeAudioData' requires a cloned, 0 offset buffer,
                  // additionally, if we reuse the same array we seem to run into issues where decodeAudioData mutates the original array in someway (?)
                  push(added)
              }
          }
      };
     
      let setLive = async () => {
          if (!audioContext) {
              await setupAudioContext();
          }
          streamDB.source.chunks.events.removeEventListener("change", listener);
          streamDB.source.chunks.events.addEventListener("change", listener);
      }; */

    const playPauseToKeepBufferHappy = async (
        generation: number,
        context: AudioContext
    ) => {
        if (options?.recoverLag) {
            return; // this method works against recoverLag, so we don't use it. TODO find a good balance
        }

        // if buffer ahead goes to a low value, we suspend the audio context
        // until we have enough buffer again (high threshold)
        while (isCurrentPlayback(generation, context)) {
            const lowThreshold = 100; // 100 ms
            const highThreshold = targetLatency * 1e3;
            const bufferAhead = -1 * getBufferLag() * 1000; // convert to ms
            //  console.log("BUFFER LAG", { state: audioContext?.state, bufferAhead, currentExpectedLatency, mediaTime: audioContext?.currentTime, bufferedAudioTime, lowThreshold, highThreshold });
            if (bufferAhead < lowThreshold && !suspended) {
                console.log("SUSPENDING AUDIO CONTEXT", {
                    bufferAhead,
                    lowThreshold,
                    highThreshold,
                    suspended,
                });
                await context.suspend();
                if (!isCurrentPlayback(generation, context)) {
                    return;
                }
                suspended = true;
            } else if (bufferAhead > highThreshold && suspended) {
                console.log("RESUMING AUDIO CONTEXT", {
                    bufferAhead,
                    lowThreshold,
                    highThreshold,
                    suspended,
                });
                await context.resume();
                if (!isCurrentPlayback(generation, context)) {
                    return;
                }
                suspended = false;
            }
            await delay(5);
        }

        console.log("stopped keeping buffer happy");
    };

    async function maybePlay() {
        if (closed) {
            return;
        }
        const request = ++lifecycleRequest;
        play = true;
        const playback = await setupAudioContext(request);
        if (!playback || request !== lifecycleRequest) {
            return;
        }
        await renderFrame(playback.generation);
        void playPauseToKeepBufferHappy(
            playback.generation,
            playback.context
        ).catch((error) => {
            if (isCurrentPlayback(playback.generation, playback.context)) {
                console.error("Failed to manage the audio buffer", error);
            }
        });
    }

    return {
        close: async () => {
            lifecycleRequest += 1;
            closed = true;
            play = false;
            invalidatePlayback();
            await stop();
        },
        /*     setProgress: (progress: number) => {
                cleanup?.();
                setLive();
            },
            setSpeed: (value: number) => { }, */
        push,
        setVolume,
        mute,
        unmute,
        play: maybePlay,
        pause: async () => {
            lifecycleRequest += 1;
            play = false;
            invalidatePlayback();
            await stop();
        },
    };
};
