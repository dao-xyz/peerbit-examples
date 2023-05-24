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
                        if (this.bufferLen > 5000) {
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

export class WAVEncoder {
    audioContext: AudioContext;
    node: AudioWorkletNode;
    source: MediaElementAudioSourceNode;
    _prevVideo: HTMLVideoElement;
    async init(video: HTMLVideoElement) {
        if (!video) {
            return;
        }
        const sameVideo = this._prevVideo && video.isSameNode(this._prevVideo);
        this._prevVideo = video;

        if (!this.audioContext) {
            this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
            await this.audioContext.audioWorklet.addModule(url_worklet);
        }

        await this.audioContext.resume();

        if (sameVideo) {
            return;
        }

        this.source = this.audioContext.createMediaElementSource(video);
        this.node = new AudioWorkletNode(
            this.audioContext,
            "convert-bits-processor"
        );
    }

    play() {
        if (!this.source) {
            return;
        }
        this.source.connect(this.node);
        this.node.connect(this.audioContext.destination);
    }
    pause() {
        if (!this.source) {
            return;
        }
        this.source.disconnect();
        this.node.disconnect();
    }
}

/*   interleave2(buffers: Float32Array[]) {
 
            const numberOfChannels = 2;
            const sampleRate = 48000;
            const bytesPerSample = Int16Array.BYTES_PER_ELEMENT
 
            var bufferLength = buffers[0].length;
            var reducedData = new Uint8Array(bufferLength * numberOfChannels * bytesPerSample);
 
            // Interleave
            for (var i = 0; i < bufferLength; i++) {
                for (var channel = 0; channel < numberOfChannels; channel++) {
 
                    var outputIndex = (i * numberOfChannels + channel) * bytesPerSample;
 
                    // clip the signal if it exceeds [-1, 1]
                    var sample = Math.max(-1, Math.min(1, buffers[channel][i]));
 
                    // bit reduce and convert to integer
                    switch (bytesPerSample) {
                        case 4: // 32 bits signed
                            sample = sample * 2147483647.5 - 0.5;
                            reducedData[outputIndex] = sample;
                            reducedData[outputIndex + 1] = sample >> 8;
                            reducedData[outputIndex + 2] = sample >> 16;
                            reducedData[outputIndex + 3] = sample >> 24;
                            break;
 
                        case 3: // 24 bits signed
                            sample = sample * 8388607.5 - 0.5;
                            reducedData[outputIndex] = sample;
                            reducedData[outputIndex + 1] = sample >> 8;
                            reducedData[outputIndex + 2] = sample >> 16;
                            break;
 
                        case 2: // 16 bits signed
                            sample = sample * 32767.5 - 0.5;
                            reducedData[outputIndex] = sample;
                            reducedData[outputIndex + 1] = sample >> 8;
                            break;
 
                        case 1: // 8 bits unsigned
                            reducedData[outputIndex] = (sample + 1) * 127.5;
                            break;
 
                        default:
                            throw new Error("Only 8, 16, 24 and 32 bits per sample are supported");
                    }
                }
            }
 
            return reducedData
 
        } */

/* fto16bit(recordedBuffers: Uint8Array[]) {
    var bufferLength = recordedBuffers[0].length;
    var dataLength = recordedBuffers.length * bufferLength;
    var headerLength = 44;
    var wav = new Uint8Array(headerLength + dataLength);
    var view = new DataView(wav.buffer);
    const numberOfChannels = 2;
    const sampleRate = 48000;
    const bytesPerSample = Int16Array.BYTES_PER_ELEMENT

    view.setUint32(0, 1380533830, false); // RIFF identifier 'RIFF'
    view.setUint32(4, 36 + dataLength, true); // file length minus RIFF identifier length and file description length
    view.setUint32(8, 1463899717, false); // RIFF type 'WAVE'
    view.setUint32(12, 1718449184, false); // format chunk identifier 'fmt '
    view.setUint32(16, 16, true); // format chunk length
    view.setUint16(20, 1, true); // sample format (raw)
    view.setUint16(22, numberOfChannels, true); // channel count
    view.setUint32(24, sampleRate, true); // sample rate
    view.setUint32(28, sampleRate * bytesPerSample * numberOfChannels, true); // byte rate (sample rate * block align)
    view.setUint16(32, bytesPerSample * numberOfChannels, true); // block align (channel count * bytes per sample)
    view.setUint16(34, 16, true); // bits per sample
    view.setUint32(36, 1684108385, false); // data chunk identifier 'data'
    view.setUint32(40, dataLength, true); // data chunk length

    for (var i = 0; i < recordedBuffers.length; i++) {
        wav.set(recordedBuffers[i], i * bufferLength + headerLength);
    }
    return wav;
} */
