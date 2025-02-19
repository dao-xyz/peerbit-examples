import pDefer, { DeferredPromise } from "p-defer";

// Create a persistent worker (adjust the path as needed)
const frameWorker = new Worker(new URL("./frameWorker.js", import.meta.url));

// We'll assign a unique id to each conversion request.
let nextMessageId = 0;
const pendingRequests = new Map<number, DeferredPromise<VideoFrame>>();

// Listen for responses from the worker.
frameWorker.addEventListener("message", (event: MessageEvent) => {
    const { id, cpuFrame, error } = event.data;
    const deferred = pendingRequests.get(id);
    if (!deferred) return;
    if (error) {
        deferred.reject(new Error(error));
    } else {
        deferred.resolve(cpuFrame);
    }
    pendingRequests.delete(id);
});

/**
 * Convert a GPU-backed VideoFrame to a CPU-accessible VideoFrame.
 *
 * This function sends the provided VideoFrame (source) along with the dimensions
 * obtained from the video element (videoRef) to a worker. The worker draws the
 * frame on its offscreen canvas and returns a new VideoFrame.
 *
 * @param videoRef - The HTMLVideoElement (used to obtain dimensions).
 * @param source - The GPU-backed VideoFrame to convert.
 * @returns A promise that resolves to a CPU-accessible VideoFrame.
 */
export const convertGPUFrameToCPUFrame = (
    videoRef: HTMLVideoElement,
    source: VideoFrame
): Promise<VideoFrame> => {
    const deferred = pDefer<VideoFrame>();
    const messageId = nextMessageId++;
    pendingRequests.set(messageId, deferred);

    // Get the desired dimensions from the video element.
    const width = videoRef.videoWidth;
    const height = videoRef.videoHeight;

    // Post the message to the worker.
    // Transfer the VideoFrame (source) to avoid a copy.
    frameWorker.postMessage({ id: messageId, source, width, height }, [source]);

    return deferred.promise;
};
