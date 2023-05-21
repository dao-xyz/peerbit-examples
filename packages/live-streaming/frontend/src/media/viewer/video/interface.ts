export interface Renderer {
    draw(frame: VideoFrame);
    resize(properties: { width?: number; height?: number });
    setup(canvas: HTMLCanvasElement | OffscreenCanvas);
}
