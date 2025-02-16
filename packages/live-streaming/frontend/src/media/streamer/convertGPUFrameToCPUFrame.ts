// Create a persistent offscreen canvas and its context
const offscreen = new OffscreenCanvas(1, 1);
const ctx = offscreen.getContext("2d");

/**
 * Convert a GPU-backed frame to a CPU-accessible one using the reusable offscreen canvas.
 * The canvas is resized if needed.
 */
export const convertGPUFrameToCPUFrame = (
    videoRef: HTMLVideoElement,
    source: VideoFrame
) => {
    // Resize canvas if dimensions don't match
    if (
        offscreen.width !== videoRef.videoWidth ||
        offscreen.height !== videoRef.videoHeight
    ) {
        offscreen.width = videoRef.videoWidth;
        offscreen.height = videoRef.videoHeight;
    }

    // Draw the source (video element or VideoFrame) onto the offscreen canvas
    ctx.drawImage(source, 0, 0, offscreen.width, offscreen.height);

    // Get an ImageBitmap from the canvas
    const bitmap = offscreen.transferToImageBitmap();

    // Create a new VideoFrame from the ImageBitmap
    const cpuFrame = new VideoFrame(bitmap, { timestamp: source.timestamp });

    // Clean up the bitmap (it's no longer needed)
    bitmap.close();

    source.close();
    return cpuFrame;
};
