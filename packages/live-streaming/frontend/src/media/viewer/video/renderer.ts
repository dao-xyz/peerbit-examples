import { isSafari } from "../../utils.js";
import { Renderer } from "./interface.js";
import {
    FrameMessage,
    ResizeMessage,
    CanvasMessage,
    WebGLRenderer,
} from "./worker.js";
import VideoWorker from "./worker.js?worker";

class VideoWorkerRenderer implements Renderer {
    #webworker: Worker;
    constructor() {
        this.#webworker = new VideoWorker();
    }
    draw(frame: VideoFrame) {
        this.#webworker.postMessage({ type: "frame", frame } as FrameMessage, [
            frame as any as Transferable,
        ]); //
    }

    resize(data: { width: number; height: number }) {
        this.#webworker.postMessage({
            type: "size",
            ...data,
        } as ResizeMessage);
    }
    setup(canvas: HTMLCanvasElement) {
        const offscreenCanvas = canvas.transferControlToOffscreen();
        this.#webworker.postMessage(
            {
                type: "canvas",
                canvas: offscreenCanvas,
            } as CanvasMessage,
            [offscreenCanvas]
        );
    }
}

class VideoNonWorkerRenderer implements Renderer {
    #render: WebGLRenderer;
    constructor() {
        this.#render = new WebGLRenderer();
    }
    draw(frame: VideoFrame) {
        this.#render.draw(frame);
    }

    resize(data: { width: number; height: number }) {
        this.#render.resize(data);
    }
    setup(canvas: HTMLCanvasElement) {
        this.#render.setup(canvas);
    }
}

// In the future when webcodecs-webgpu enable by default do import { WebGPUVideoRenderer } from "./webgpu/webgpu.js";
const renderer = isSafari
    ? new VideoNonWorkerRenderer()
    : new VideoWorkerRenderer();
export { renderer };
