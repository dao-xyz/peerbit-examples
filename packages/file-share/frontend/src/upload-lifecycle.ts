/**
 * Snapshot selected files before clearing the input. Clearing releases the
 * element's long-lived Blob references and allows selecting the same file again.
 */
export const takeInputFiles = (
    input: Pick<HTMLInputElement, "files" | "value">
): File[] => {
    const files = input.files ? [...input.files] : [];
    input.value = "";
    return files;
};

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
