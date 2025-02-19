// Create a persistent offscreen canvas and its 2D context.
const offscreen = new OffscreenCanvas(1, 1);
const ctx = offscreen.getContext("2d");
if (!ctx) {
    throw new Error("2D context not available on OffscreenCanvas");
}

/**
 * Convert a VideoFrame to a CPU-accessible VideoFrame by drawing it on an offscreen canvas.
 *
 * @param {VideoFrame} source - The source VideoFrame.
 * @param {number} width - The desired canvas width.
 * @param {number} height - The desired canvas height.
 * @returns {Promise<VideoFrame>} A promise that resolves to a new CPU-accessible VideoFrame.
 */
async function convertVideoFrameToCPUFrame(source, width, height) {
    // Resize the canvas if necessary.
    if (offscreen.width !== width || offscreen.height !== height) {
        offscreen.width = width;
        offscreen.height = height;
    }

    // Clear the canvas.
    ctx.clearRect(0, 0, offscreen.width, offscreen.height);

    // Draw the source VideoFrame onto the offscreen canvas.
    ctx.drawImage(source, 0, 0, offscreen.width, offscreen.height);

    // Create an ImageBitmap from the offscreen canvas.
    const bitmap = await createImageBitmap(offscreen);

    // Create a new VideoFrame from the bitmap.
    // We use the timestamp from the source VideoFrame.
    const cpuFrame = new VideoFrame(bitmap, { timestamp: source.timestamp });

    // Clean up temporary resources.
    bitmap.close();
    source.close();

    return cpuFrame;
}

// Listen for messages from the main thread.
self.onmessage = async (event) => {
    const { id, source, width, height } = event.data;
    try {
        const cpuFrame = await convertVideoFrameToCPUFrame(
            source,
            width,
            height
        );
        // Transfer the resulting VideoFrame back to the main thread.
        self.postMessage({ id, cpuFrame }, [cpuFrame]);
    } catch (err) {
        self.postMessage({ id, error: err.message });
    }
};
