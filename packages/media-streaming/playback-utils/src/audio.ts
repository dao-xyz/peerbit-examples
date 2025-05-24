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

                        // external “flush”
                        this.port.onmessage = (ev: MessageEvent<any>) => {
                            if (ev.data === "flush") this.emit(true);
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
                    private emit(forceLast = false): void {
                        if (!forceLast && this.bufLen < this.MIN_CHUNK) return;

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
                            last: forceLast,
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
                        this.emit(false);

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

import { AudioStreamDB, Chunk, Track } from "@peerbit/media-streaming";
import PDefer, { DeferredPromise } from "p-defer";
import PQueue from "p-queue";
import { delay } from "@peerbit/time";

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

    /** media element reached “ended” (real-time only) */
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

    /* ---------------------------------- init ------------------------ */

    async init(src: WAVEncoderSource, handlers: WAVEncoderEvents = {}) {
        console.log("DESTORY PREV?");
        this.initializing?.reject(new Error("Reset"));
        await this.destroy(); // clean slate
        this.initializing = PDefer<void>();
        console.log("READY!");

        const forward = (ev: MessageEvent) => {
            if (ev.data?.audioBuffer) handlers.onChunk?.(ev.data);
            if (ev.data?.last) handlers.onEnded?.();
        };

        try {
            /* ── real-time branch ───────────────────────────────────────── */
            if ("element" in src || src.useElement) {
                if ("element" in src) {
                    this.mediaEl = src.element;
                    this.ownsMedia = false;
                } else {
                    this.mediaEl = await this._prepareElementFromFile(src.file);
                    this.ownsMedia = true;
                }

                this.ctx = new AudioContext();
                await this.ctx.audioWorklet.addModule(url_worklet);

                this.srcNode = this.ctx.createMediaElementSource(this.mediaEl!);
                this.node = new AudioWorkletNode(
                    this.ctx,
                    "convert-bits-processor"
                );
                const flushOnEnded = () => {
                    /* the worklet listens for "flush" and calls emitChunk(true) */
                    this.port.postMessage("flush");
                    this.mediaEl!.removeEventListener("ended", flushOnEnded);
                };
                this.mediaEl.addEventListener("ended", flushOnEnded);

                this.srcNode.connect(this.node);
                this.node.connect(this.ctx.destination);

                this.port = this.node.port;
                this.port.start();
                this.port.addEventListener("message", forward);

                this.initializing.resolve();
                return;
            }

            /* ── offline / file branch  without using element (fastest) ──────────────────────────────────── */
            // this path seems to be glitchy broken when we deploy our site and might lead to issues when decoding wierd file formats
            const { port1, port2 } = new MessageChannel();
            this.port = port1;
            this.port.start();
            this.port.addEventListener("message", forward);

            (async () => {
                /* 1️⃣  Decode with a short-lived context */
                const tmpCtx = new AudioContext();
                const DEVICE_SR = tmpCtx.sampleRate; // device sample-rate
                const srcBuf = await tmpCtx.decodeAudioData(
                    await src.file.arrayBuffer()
                );
                const inSR = srcBuf.sampleRate;
                const channels = srcBuf.numberOfChannels;
                await tmpCtx.close();

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

                /* 3️⃣  Chunk & stream */
                const CHUNK_FRAMES = Math.floor(0.1 * TARGET_SR); // 100 ms
                const STEP_US = 1e6 / TARGET_SR; // frames → µs
                const header = pcm16Header(channels, TARGET_SR);

                let tsUS = 0; // µ-seconds since start
                let yieldC = 0; // macro-task back-pressure

                for (let p = 0; p < pcmBuf.length; p += CHUNK_FRAMES) {
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
            })(); // fire-and-forget – encoder keeps running

            this.initializing.resolve(); // nothing else to wait for
        } catch (e) {
            this.initializing.reject(e as Error);
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

    private _prepareElementFromFile(file: File): Promise<HTMLAudioElement> {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const audio = new Audio(url);
            audio.crossOrigin = "anonymous";
            audio.preload = "auto";
            audio.addEventListener("loadedmetadata", () => {
                this.objURL = url;
                resolve(audio);
            });
            audio.addEventListener("error", () =>
                reject(new Error("Unable to load audio file"))
            );
        });
    }

    /* ------------------------------ destroy ------------------------- */

    async destroy() {
        try {
            await this.pause();
        } catch {}
        this.srcNode?.disconnect();
        this.node?.disconnect();
        await this.ctx?.close();

        if (this.ownsMedia && this.mediaEl) {
            this.mediaEl.remove();
            if (this.objURL) URL.revokeObjectURL(this.objURL);
        }
        /* clear refs */
        this.ctx = this.node = this.srcNode = this.mediaEl = undefined;
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
    let setVolume: ((value: number) => void) | undefined = undefined;
    let gainNode: GainNode | undefined = undefined;

    const audioContextListener = () => {
        if (
            audioContext!.state === "suspended" ||
            audioContext!.state === "closed"
        ) {
            console.log(
                "AUDIO CONTEXT SUSPENDED OR CLOSED",
                audioContext!.state
            );
            play = false;
        }
    };
    const stop = async () => {
        options?.debug && console.trace("STOP AUDIO LISTENER");
        if (audioContext) {
            audioContext.removeEventListener(
                "statechange",
                audioContextListener
            );
            audioContext.destination.disconnect();
            audioContext.state !== "closed" && (await audioContext.close());
            gainNode?.disconnect();
        }
        audioContext = undefined;
        setVolume = undefined;
        gainNode = undefined;
    };
    setVolume = (volume: number) => {
        if (gainNode) gainNode.gain.value = volume;
    };

    const setupAudioContext = async () => {
        await stop();
        bufferedAudioTime = 0;
        options?.debug && console.log("SETUP AUDIO CONTEXT");
        audioContext = new AudioContext({
            sampleRate: streamDB.source.sampleRate,
        });
        audioContext.addEventListener("statechange", audioContextListener);
        gainNode = audioContext.createGain();
        gainNode.connect(audioContext.destination);
    };

    const mute = () => {}; // we don't do anything with the source, we let the controller set volume to 0
    const unmute = () => {}; // we don't do anything with the source, we let the controller set volume back to previous volume before mute

    let bufferedAudioTime: number | undefined = undefined;
    const MIN_EXPECTED_LATENCY = 0.01; // seconds
    let defaultMinExpectedLatency =
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

    const renderFrame = async () => {
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
        if (!audioContext || audioContext!.state === "closed") {
            return;
        }

        /**
         *  Take one element from the queue
         */
        const frame = pendingFrames.shift();

        const audioSource = audioContext!.createBufferSource();
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
        scheduleNextTick();
    };

    function scheduleNextTick() {
        if (document.visibilityState === "visible") {
            requestAnimationFrame(() => renderFrame()); // requestAnimationFrame will not run in background. delay here is 1 ms, its fine as if weunderflow we will stop this loop
        } else {
            setTimeout(() => renderFrame(), 0);
        }
    }

    const decodeAudioDataQueue = new PQueue({ concurrency: 1 });
    let resuming = false;

    let push = (chunk: Chunk) => {
        if (decodeAudioDataQueue.size > 10) {
            options?.debug &&
                console.log(
                    "CLEARING AUDIO QUEUE CAN NOT KEEP UP",
                    decodeAudioDataQueue.size
                );
            decodeAudioDataQueue.clear(); // We can't keep up, clear the queue
        }

        decodeAudioDataQueue.add(async () => {
            let zeroOffsetBuffer = new Uint8Array(chunk.chunk.length);
            zeroOffsetBuffer.set(chunk.chunk, 0);
            /*    options?.debug &&
                   console.log(
                       "DECODE AUDIO CHUNK",
                       chunk.time,
                       zeroOffsetBuffer.length,
                       audioContext?.state
                   ); */
            audioContext?.decodeAudioData(
                zeroOffsetBuffer.buffer,
                (data) => {
                    const frame = {
                        buffer: data,
                        timestamp: chunk.time,
                    };

                    if (audioContext?.state !== "running" && play) {
                        pendingFrames = [];
                        pendingFrames.push(frame);
                        if (!resuming) {
                            resuming = true;
                            audioContext
                                ?.resume()
                                .then((r) => {
                                    resuming = false;
                                    renderFrame();
                                })
                                .catch((e) => {});
                        }
                    } else {
                        /*   const wasEmpty = pendingFrames.length; */
                        pendingFrames.push(frame);
                        if (!isUnderflow()) {
                            renderFrame();
                        }
                    }
                },
                (e) => {
                    console.error("Failed to decode error", e);
                }
            );
        });
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

    let cleanup: (() => void) | undefined = () => {
        decodeAudioDataQueue.clear();
        /*    streamDB.source.chunks.events.removeEventListener("change", listener); */
    };

    let suspended = false;

    const playPauseToKeepBufferHappy = async () => {
        if (options?.recoverLag) {
            return; // this method works against recoverLag, so we don't use it. TODO find a good balance
        }

        // if buffer ahead goes to a low value, we suspend the audio context
        // until we have enough buffer again (high threshold)
        while (audioContext?.state !== "closed") {
            let lowThreshold = 100; // 100 ms
            let highThreshold = targetLatency * 1e3;
            let bufferAhead = -1 * getBufferLag() * 1000; // convert to ms
            //  console.log("BUFFER LAG", { state: audioContext?.state, bufferAhead, currentExpectedLatency, mediaTime: audioContext?.currentTime, bufferedAudioTime, lowThreshold, highThreshold });
            if (bufferAhead < lowThreshold && !suspended) {
                console.log("SUSPENDING AUDIO CONTEXT", {
                    bufferAhead,
                    lowThreshold,
                    highThreshold,
                    suspended,
                });
                audioContext?.suspend();
                suspended = true;
            } else if (bufferAhead > highThreshold && suspended) {
                console.log("RESUMING AUDIO CONTEXT", {
                    bufferAhead,
                    lowThreshold,
                    highThreshold,
                    suspended,
                });
                audioContext?.resume();
                suspended = false;
            }
            await delay(5);
        }

        console.log("stopped keeping buffer happy");
    };

    async function maybePlay() {
        play = true;
        await setupAudioContext();
        renderFrame();
        playPauseToKeepBufferHappy();
    }

    return {
        close: async () => {
            cleanup?.();
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
        pause: () => {
            cleanup();
            play = false;
            stop();
        },
    };
};
