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
        console.log("SEUTP!", canvas);
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

const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);

const renderer = isSafari
    ? new VideoNonWorkerRenderer()
    : new VideoWorkerRenderer();
export { renderer };
