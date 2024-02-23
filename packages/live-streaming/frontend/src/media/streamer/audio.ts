/**
 * Wave encoder that can run inside in a worklet
 */

const SAMPLE_RATE = 48000;
const url_worklet = URL.createObjectURL(
    new Blob(
        [
            "(",
            function () {
                const SAMPLE_RATE = 48000;

                class ConvertBitsProcessor extends AudioWorkletProcessor {
                    audioBuffer: Float32Array[][] = [];
                    bufferLen = 0;

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
                    }

                    mergeBuffers(channel: number): Float32Array {
                        const result = new Float32Array(
                            this.audioBuffer.length * 128
                        );
                        let offset = 0;
                        for (let i = 0; i < this.audioBuffer.length; i++) {
                            result.set(this.audioBuffer[i][channel], offset);
                            offset += this.audioBuffer[i][channel].length;
                        }
                        // console.log(channel, result, this.audioBuffer[0][channel])
                        return result;
                    }

                    interleave(inputL: Float32Array, inputR: Float32Array) {
                        const len = inputL.length + inputR.length;
                        const result = new Float32Array(len);

                        let index = 0;
                        let inputIndex = 0;

                        while (index < len) {
                            result[index++] = inputL[inputIndex];
                            result[index++] = inputR[inputIndex];
                            inputIndex++;
                        }

                        return result;
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
                            this._header = undefined;
                        }

                        if (this._header) {
                            return this._header;
                        }

                        const view = new DataView(new ArrayBuffer(44));

                        const BYTES_PER_SAMPLE = Int16Array.BYTES_PER_ELEMENT;
                        const fileLength = dataLength + 16;

                        /* RIFF identifier */
                        view.setUint32(0, 1380533830, false);
                        /* file length */
                        view.setUint32(4, fileLength, true); // is stream so we do 0xFFFFFFFF -> max value
                        /* RIFF type */
                        view.setUint32(8, 1463899717, false);
                        /* format chunk identifier */
                        view.setUint32(12, 1718449184, false);
                        /* format chunk length */
                        view.setUint32(16, 16, true);
                        /* sample format (raw) */
                        view.setUint16(20, 1, true);
                        /* channel count */
                        view.setUint16(22, channels, true);
                        /* sample rate */
                        view.setUint32(24, SAMPLE_RATE, true);
                        /* byte rate (sample rate * block align) */
                        view.setUint32(
                            28,
                            SAMPLE_RATE * BYTES_PER_SAMPLE * channels,
                            true
                        );
                        /* block align (channel count * bytes per sample) */
                        view.setUint16(32, BYTES_PER_SAMPLE * channels, true);
                        /* bits per sample */
                        view.setUint16(34, 16, true);
                        /* data chunk identifier */
                        view.setUint32(36, 1684108385, false);

                        view.setUint32(40, dataLength, true);

                        return (this._header = new Uint8Array(view.buffer));
                    }

                    processInput(inputs: Float32Array[]) {
                        this.audioBuffer.push(
                            inputs.map((x) => new Float32Array(x))
                        ); // Copy is necessary (why (?)) the output becomes malformed without it
                        this.bufferLen += 128 * inputs.length;
                        if (this.bufferLen > this.MIN_CHUNK_SIZE) {
                            // merge data within channels
                            const merged: Float32Array[] = [];
                            const channels = this.audioBuffer[0].length;
                            for (
                                let channel = 0;
                                channel < channels;
                                channel++
                            ) {
                                merged.push(this.mergeBuffers(channel));
                            }

                            const interleaved =
                                channels == 2
                                    ? this.interleave(merged[0], merged[1])
                                    : merged[0];

                            // add header so we can start playback at any time
                            const dataOutLength = interleaved.length * 2;
                            const buffer = new Uint8Array(44 + dataOutLength);
                            buffer.set(
                                this.getHeader(channels, dataOutLength),
                                0
                            );
                            this._floatTo16BitPCM(buffer, 44, interleaved);
                            this.port.postMessage({
                                eventType: "data",
                                audioBuffer: buffer,
                            });

                            this.audioBuffer = [];
                            this.bufferLen = 0;
                        }
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

                    process(
                        inputs: Float32Array[][],
                        outputs: Float32Array[][],
                        parameters: Record<string, Float32Array>
                    ): boolean {
                        const sourceIndex = 0;
                        if (inputs[sourceIndex].length === 0) {
                            return true;
                        }

                        this.processInput(inputs[sourceIndex]);

                        const input = inputs[sourceIndex];
                        const output = outputs[sourceIndex];

                        for (
                            let channel = 0;
                            channel < output.length;
                            ++channel
                        ) {
                            output[channel].set(input[channel]);
                        }

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

import PDefer, { DeferredPromise } from "p-defer";
export class WAVEncoder {
    audioContext: AudioContext;
    node: AudioWorkletNode;
    source: MediaElementAudioSourceNode;
    _prevVideo: HTMLVideoElement;
    initializing: DeferredPromise<void>;
    async init(video: HTMLVideoElement) {
        if (!video) {
            return;
        }

        if (video.muted) {
            return; // TODO this line seems necessary, else once we change the video source to a source with audio, there will just be a black screen
        }

        const sameVideo = this._prevVideo && video.isSameNode(this._prevVideo);
        this._prevVideo = video;

        if (sameVideo) {
            return;
        }
        this.initializing = PDefer<void>();
        try {
            if (!this.source) {
                console.log("INIT AUDIO CONTEXT?");
                this.audioContext = new AudioContext({
                    sampleRate: SAMPLE_RATE,
                });
                await this.audioContext.audioWorklet.addModule(url_worklet);
                this.source = this.audioContext.createMediaElementSource(video);
                this.node = new AudioWorkletNode(
                    this.audioContext,
                    "convert-bits-processor"
                );
                this.source.connect(this.node);
                this.node.connect(this.audioContext.destination);
            }
            this.node.port.start();
            this.initializing.resolve();
        } catch (e) {
            this.initializing.reject(e);
        }
    }
    async destroy() {
        if (this.source) {
            this.source.disconnect();
            this.node.disconnect();
            this.audioContext.close();
            this.source = null;
            this.node = null;
            this.audioContext = null;
        }
    }
    async play() {
        await this.initializing.promise;
        if (!this.source) {
            return;
        }
        await this.audioContext.resume();
    }
    async pause() {
        if (!this.source) {
            return;
        }
        await this.audioContext.suspend();
    }
}
