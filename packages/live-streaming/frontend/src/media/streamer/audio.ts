export class WAVEncoder {
    timeout = null;

    _audioContext: AudioContext;
    _source: MediaElementAudioSourceNode;
    context: BaseAudioContext;
    node: ScriptProcessorNode;
    numChannels = 2;
    constructor() {
        this._audioContext = new (window.AudioContext ||
            globalThis["webkitAudioContext"])();
    }

    async init(video: HTMLVideoElement): Promise<void> {
        // Create a MediaElementAudioSourceNode from the video element
        const prev = this._source;
        if (prev) {
            try {
                // this._source = this._audioContext.createMediaElementSource(video)
                // prev.disconnect()
            } catch {
                // reuse this._source = this._source
            }
        } else {
            this._source = this._audioContext.createMediaElementSource(video);
        }

        if (this.node) {
            return;
        }
        /*     this.node?.disconnect() */

        // Create a ScriptProcessorNode to process the audio
        this.context = this._source.context;
        this.node = this.context.createScriptProcessor(
            4096,
            this.numChannels,
            this.numChannels
        );
        this.node.onaudioprocess = (e) => {
            console.log("GOT AUDIO!");
            const recBuffers: [Float32Array, Float32Array] = [
                undefined,
                undefined,
            ];
            for (let i = 0; i < this.numChannels; i++) {
                recBuffers[i] = e.inputBuffer.getChannelData(i);
            }

            console.log(this.encode(recBuffers));
        };
        this._source.connect(this.node);
        this.node.connect(this.context.destination);
    }

    /*  mergeBuffers(buffers: [Float32Array, Float32Array]) {
         let result = new Float32Array(buffers[0][0].length);
         let offset = 0;
         for (var i = 0; i < buffers.length; i++) {
             result.set(buffers[i], offset);
             offset += buffers[i].length;
         }
         return result;
     } */

    interleave(inputL, inputR) {
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

    floatTo16BitPCM(output: DataView, offset, input) {
        for (let i = 0; i < input.length; i++, offset += 2) {
            const s = Math.max(-1, Math.min(1, input[i]));
            output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }
    }

    writeString(view, offset, string) {
        for (let i = 0; i < string.length; i++) {
            view.setUint8(offset + i, string.charCodeAt(i));
        }
    }

    private _header: Uint8Array;
    getHeader(): Uint8Array {
        if (this._header) {
            return this._header;
        }

        const view = new DataView(new ArrayBuffer(44));

        /* RIFF identifier */
        this.writeString(view, 0, "RIFF");
        /* file length */
        view.setUint32(4, 0xffffffff, true); // is stream so we do 0xFFFFFFFF -> max value
        /* RIFF type */
        this.writeString(view, 8, "WAVE");
        /* format chunk identifier */
        this.writeString(view, 12, "fmt ");
        /* format chunk length */
        view.setUint32(16, 16, true);
        /* sample format (raw) */
        view.setUint16(20, 1, true);
        /* channel count */
        view.setUint16(22, this.numChannels, true);
        /* sample rate */
        view.setUint32(24, this.context.sampleRate, true);
        /* byte rate (sample rate * block align) */
        view.setUint32(28, this.context.sampleRate * 4, true);
        /* block align (channel count * bytes per sample) */
        view.setUint16(32, this.numChannels * 2, true);
        /* bits per sample */
        view.setUint16(34, 16, true);
        /* data chunk identifier */
        this.writeString(view, 36, "data");
        return (this._header = new Uint8Array(view.buffer));
    }

    encode(recBuffers: [Float32Array, Float32Array]) {
        /*  let buffers = [];
         for (var i = 0; i < this.numChannels; i++) {
             buffers.push(this.mergeBuffers(recBuffers[i]));
         } */
        const interleaved =
            this.numChannels == 2
                ? this.interleave(recBuffers[0], recBuffers[1])
                : recBuffers[0];
        const buffer = new Uint8Array(44 + interleaved.length * 2);
        buffer.set(this.getHeader(), 0);
        const view = new DataView(
            buffer.buffer,
            buffer.byteOffset,
            buffer.byteLength
        );
        this.floatTo16BitPCM(view, 44, interleaved);
        return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
    }
}
