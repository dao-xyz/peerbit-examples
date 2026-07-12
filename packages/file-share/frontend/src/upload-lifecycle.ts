/**
 * Reports the first failed upload but waits for the rest of the batch before
 * allowing shared UI state to be cleared.
 */
export const settleUploadBatch = async (
    uploads: Promise<unknown>[],
    onError: (error: unknown) => void
) => {
    try {
        await Promise.all(uploads);
    } catch (error) {
        try {
            onError(error);
        } finally {
            await Promise.allSettled(uploads);
        }
    }
};
