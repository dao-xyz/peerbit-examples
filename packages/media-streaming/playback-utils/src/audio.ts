/**
 * Wave encoder that can run inside in a worklet
 */

const SAMPLE_RATE = 48000;
// self contained worklet for encoding
const url_worklet = URL.createObjectURL(
    new Blob(
        [
            "(",
            function () {
                const SAMPLE_RATE = 48000;

                class ConvertBitsProcessor extends AudioWorkletProcessor {
                    audioBuffer: Float32Array[][] = [];
                    bufferLen = 0;
                    written = 0; // total samples emitted

                    // This variable describe how much audio data we need to buffer before
                    // we sent it back into an array
                    // making this tooo small can have performanc overheads
                    // making this too big i will make will increase latency for listeners
                    MIN_CHUNK_SIZE = 5000; // TODO  make this as option

                    static get parameterDescriptors() {
                        return [];
                    }

                    constructor() {
                        super();
                        this.audioBuffer = [];

                        this.port.onmessage = (ev) => {
                            if (ev.data === "flush") {
                                this.emitChunk(true); // force
                            }
                        };
                    }

                    mergeBuffers(channel: number): Float32Array {
                        const res = new Float32Array(
                            this.audioBuffer.length * 128
                        );
                        let offset = 0;
                        for (const frame of this.audioBuffer) {
                            res.set(frame[channel], offset);
                            offset += frame[channel].length;
                        }
                        return res;
                    }

                    interleave(l: Float32Array, r: Float32Array) {
                        const len = l.length + r.length;
                        const out = new Float32Array(len);
                        for (let i = 0, j = 0; i < l.length; i++) {
                            out[j++] = l[i];
                            out[j++] = r[i];
                        }
                        return out;
                    }

                    private _header: Uint8Array;
                    private _lastChannelCount: number;
                    private _lastDataLength: number;

                    getHeader(
                        channels: number,
                        dataLength = 0xffffffff - 16
                    ): Uint8Array {
                        if (
                            channels != this._lastChannelCount ||
                            this._lastDataLength !== dataLength
                        ) {
                            this._lastChannelCount = channels;
                            this._lastDataLength = dataLength;
                            this._header = undefined as any; // TODO typyes
                        }

                        if (this._header) {
                            return this._header;
                        }

                        const view = new DataView(new ArrayBuffer(44));

                        const BYTES_PER_SAMPLE = Int16Array.BYTES_PER_ELEMENT;
                        const fileLength = dataLength + 36;

                        view.setUint32(0, 0x52494646, false); // "RIFF"
                        view.setUint32(4, fileLength, true);
                        view.setUint32(8, 0x57415645, false); // "WAVE"
                        view.setUint32(12, 0x666d7420, false); // "fmt "
                        view.setUint32(16, 16, true); // fmt length
                        view.setUint16(20, 1, true); // PCM
                        view.setUint16(22, channels, true);
                        view.setUint32(24, SAMPLE_RATE, true);
                        view.setUint32(
                            28,
                            SAMPLE_RATE * BYTES_PER_SAMPLE * channels,
                            true
                        );
                        view.setUint16(32, BYTES_PER_SAMPLE * channels, true);
                        view.setUint16(34, 16, true); // bits
                        view.setUint32(36, 0x64617461, false); // "data"
                        view.setUint32(40, dataLength, true);

                        return (this._header = new Uint8Array(view.buffer));
                    }

                    _floatTo16BitPCM(
                        output: Uint8Array,
                        offset: number,
                        input: Float32Array
                    ) {
                        for (let i = 0; i < input.length; i++, offset += 2) {
                            let s = input[i];

                            // Check for clipping
                            if (s > 1) {
                                s = 1;
                            } else if (s < -1) {
                                s = -1;
                            }

                            //output.setInt16(offset, s < 0 ? s * 0x8000 : s *    , true)
                            s = s * 32768;
                            output[offset] = s;
                            output[offset + 1] = s >> 8;
                        }
                    }

                    /**
                     * Emit a chunk if:
                     *   • `force` = true  OR
                     *   • bufferLen > MIN_CHUNK_SIZE
                     * After emitting, the local buffer resets.
                     */
                    private emitChunk(last = false) {
                        if (!last && this.bufferLen <= this.MIN_CHUNK_SIZE)
                            return;

                        const channels = this.audioBuffer[0].length;
                        const merged: Float32Array[] = [];
                        for (let ch = 0; ch < channels; ch++)
                            merged.push(this.mergeBuffers(ch));

                        const interleaved =
                            channels === 2
                                ? this.interleave(merged[0], merged[1])
                                : merged[0];

                        const dataLen = interleaved.length * 2;
                        const buf = new Uint8Array(44 + dataLen);
                        buf.set(this.getHeader(channels, dataLen), 0);
                        const timestamp = Math.round(
                            (this.written / SAMPLE_RATE) * 1e6
                        ); // µs
                        this.written +=
                            (buf.length - 44) / 2 /* bytes → samples */;

                        this._floatTo16BitPCM(buf, 44, interleaved);

                        this.port.postMessage({
                            eventType: "data",
                            audioBuffer: buf,
                            timestamp,
                            last,
                        });

                        this.audioBuffer = [];
                        this.bufferLen = 0;
                    }

                    process(
                        inputs: Float32Array[][],
                        outputs: Float32Array[][],
                        parameters: Record<string, Float32Array>
                    ): boolean {
                        const inp = inputs[0]; // first node
                        /* silent quantum  → flush once, then ignore the rest */
                        if (inp.length === 0) {
                            return true;
                        }

                        /* accumulate */
                        this.audioBuffer.push(
                            inp.map((c) => new Float32Array(c))
                        );
                        this.bufferLen += 128 * inp.length;
                        this.emitChunk(false);

                        /* pass-through to outputs (mirrors input) */
                        const output = arguments[1][0] as Float32Array[]; // outputs[0]
                        for (let ch = 0; ch < output.length; ch++)
                            output[ch].set(inp[ch]);
                        return true;
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

/* —————————————————————————————————————————— */
/*  TYPE HELPERS                                                               */
/* —————————————————————————————————————————— */
type WAVEncoderSource =
    | { element: HTMLMediaElement; file?: never }
    | { file: File; element?: never };

export interface WAVEncoderEvents {
    /** every ≈100 ms */
    onChunk?(payload: {
        audioBuffer: Uint8Array;
        timestamp: number;
        last?: boolean;
    }): void;

    /** media element reached “ended” (real-time only) */
    onEnded?(): void;
}

/* —————————————————————————————————————————— */
/*  ENCODING HELPERS                                          
/* —————————————————————————————————————————— */

const pcm16Header = (channels: number): Uint8Array => {
    const hdr = new Uint8Array(44);
    const v = new DataView(hdr.buffer);
    const BPS = 2; // 16-bit

    v.setUint32(0, 0x52494646, false); // "RIFF"
    v.setUint32(8, 0x57415645, false); // "WAVE"
    v.setUint32(12, 0x666d7420, false);
    v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); // PCM
    v.setUint16(22, channels, true);
    v.setUint32(24, SAMPLE_RATE, true);
    v.setUint32(28, SAMPLE_RATE * BPS * channels, true);
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
        console.log("DESTORY PREV");
        await this.destroy(); // clean slate
        this.initializing = PDefer<void>(); // reset gate

        const forward = (ev: MessageEvent<any>) => {
            if (ev.data?.audioBuffer) handlers.onChunk?.(ev.data);
        };
        try {
            /* ── real-time branch ───────────────────────────────────────── */
            if ("element" in src) {
                this.mediaEl = src.element;
                this.ownsMedia = false;

                this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
                await this.ctx.audioWorklet.addModule(url_worklet);

                this.srcNode = this.ctx.createMediaElementSource(this.mediaEl!);
                this.node = new AudioWorkletNode(
                    this.ctx,
                    "convert-bits-processor"
                );

                this.srcNode.connect(this.node);
                this.node.connect(this.ctx.destination);

                this.port = this.node.port;
                this.port.start();
                this.port.addEventListener("message", forward);
                if (handlers.onEnded)
                    this.mediaEl!.addEventListener("ended", handlers.onEnded);

                this.initializing.resolve();
                return;
            }

            /* ── offline / file branch ──────────────────────────────────── */
            const { port1, port2 } = new MessageChannel();
            this.port = port1;
            this.port.start();
            this.port.addEventListener("message", forward);

            const buf = await (
                await new AudioContext()
            ).decodeAudioData(await src.file.arrayBuffer());
            const hdr = pcm16Header(buf.numberOfChannels);
            const CHUNK = Math.floor(0.1 * SAMPLE_RATE); // 100 ms of audio

            for (let p = 0; p < buf.length; p += CHUNK) {
                const len = Math.min(CHUNK, buf.length - p);
                const slice = new AudioBuffer({
                    length: len,
                    numberOfChannels: buf.numberOfChannels,
                    sampleRate: SAMPLE_RATE,
                });
                for (let ch = 0; ch < buf.numberOfChannels; ch++)
                    slice.copyToChannel(
                        buf.getChannelData(ch).subarray(p, p + len),
                        ch
                    );

                const timestamp = Math.round((p / SAMPLE_RATE) * 1e6); // µs

                port2.postMessage({
                    eventType: "data",
                    audioBuffer: floatBufToWav(slice, hdr),
                    timestamp,
                    last: p + len >= buf.length,
                });
            }

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
        if (this.mediaEl) {
            await this.ctx!.resume();
            await this.mediaEl.play();
        }
    }

    async pause() {
        await this.initializing.promise;
        if (this.mediaEl) {
            await this.ctx!.suspend();
            this.mediaEl.pause();
        }
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
            play = false;
        }
    };
    const stop = async () => {
        options?.debug && console.log("STOP AUDIO LISTENER");
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
    let currentExpectedLatency = 3;
    let succesfullFrameCount = 0;
    const isUnderflow = () => 0; /* pendingFrames.length < 30 */

    const updateExpectedLatency = (latency: number) => {
        options?.debug && console.log("UPDATE EXPECTED LATENCY", latency);
        currentExpectedLatency = latency;
        bufferedAudioTime = Math.max(
            currentExpectedLatency + audioContext!.currentTime,
            0
        );
    };

    const renderFrame = async () => {
        options?.debug &&
            console.log(
                "RENDER AUDIO CHUNK",
                bufferedAudioTime,
                pendingFrames.length,
                audioContext?.currentTime,
                audioContext?.state,
                play,
                audioContext?.state === "running" && play,
                pendingFrames.length > 0,
                isUnderflow()
            );

        if (!bufferedAudioTime) {
            // we've not yet started the queue - just queue this up,
            // leaving a "latency gap" so we're not desperately trying
            // to keep up.  Note if the network is slow, this is going
            // to fail.  Latency gap here is 100 ms.
            updateExpectedLatency(MIN_EXPECTED_LATENCY);
        }

        if (!play) return;
        if (pendingFrames.length === 0) return;
        if (audioContext!.state !== "running") {
            return;
        }

        /**
         *  Take one element from the queue
         */
        const frame = pendingFrames.shift();

        const audioSource = audioContext!.createBufferSource();
        audioSource.buffer = frame!.buffer;
        audioSource.connect(gainNode!);

        const isBehindSeconds = Math.max(
            audioContext!.currentTime - bufferedAudioTime!,
            0
        );

        let skipframe = false;
        if (isBehindSeconds > 0) {
            // we are not catching up, i.e. the player is going faster than we get new chunks
            if (isBehindSeconds > audioSource.buffer.duration) {
                skipframe = true;
            }
            succesfullFrameCount = 0;
            // here we want to do something about the expectedLatency, because if we also end up here
            // it means we are trying to watch in "too" much realtime
            updateExpectedLatency(currentExpectedLatency * 2);
        } else if (currentExpectedLatency > MIN_EXPECTED_LATENCY) {
            succesfullFrameCount++;

            // we have been succesfully able to play audio for some time
            // lets try to reduce the latency
            if (succesfullFrameCount > 1000) {
                const newLatency = currentExpectedLatency / 2;
                if (newLatency >= MIN_EXPECTED_LATENCY) {
                    updateExpectedLatency(newLatency);
                }
                succesfullFrameCount = 0;
            }
        }

        !skipframe && audioSource.start(bufferedAudioTime, isBehindSeconds);
        bufferedAudioTime! += audioSource.buffer.duration;

        setTimeout(() => renderFrame(), bufferedAudioTime); // requestAnimationFrame will not run in background. delay here is 1 ms, its fine as if weunderflow we will stop this loop
        //requestAnimationFrame(renderFrame);
    };

    const decodeAudioDataQueue = new PQueue({ concurrency: 1 });
    let resuming = false;

    let push = (chunk: Chunk) => {
        if (decodeAudioDataQueue.size > 10) {
            decodeAudioDataQueue.clear(); // We can't keep up, clear the queue
        }

        decodeAudioDataQueue.add(async () => {
            let zeroOffsetBuffer = new Uint8Array(chunk.chunk.length);
            zeroOffsetBuffer.set(chunk.chunk, 0);
            options?.debug &&
                console.log(
                    "DECODE AUDIO CHUNK",
                    chunk.time,
                    zeroOffsetBuffer.length,
                    audioContext?.state
                );
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
        play: async () => {
            play = true;
            setupAudioContext().then(() => {
                audioContext!.resume().then(() => renderFrame());
            });
        },
        pause: () => {
            cleanup();
            play = false;
            stop();
        },
    };
};
