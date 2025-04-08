import {
    StaticImage,
    StaticPartialImage,
    LOWEST_QUALITY,
    HIGHEST_QUALITY,
    MEDIUM_QUALITY,
    StaticContent,
    Quality,
    HIGH_QUALITY,
} from "@giga-app/interface";
import { sha256Sync } from "@peerbit/crypto";

const qualityToTargetWidth: Record<Quality, number> = {
    [LOWEST_QUALITY]: 256,
    [MEDIUM_QUALITY]: 640,
    [HIGH_QUALITY]: 1280,
    [HIGHEST_QUALITY]: null, // Full-size image
};
/**
 * Reads an image File and returns a blended array of images.
 * For each quality, the file is resized using a reusable canvas according to target widths:
 *   - LOWEST_QUALITY: suitable for thumbnails (max width 256px)
 *   - MEDIUM_QUALITY: suitable for feeds (max width 640px), generated only if original width ≥ 640px
 *   - HIGHEST_QUALITY: raw full-size image.
 * If the generated image data exceeds 3MB, it is split into partial images.
 *
 * @param file – The input File object.
 * @param qualities – Array of quality markers; defaults to [LOWEST_QUALITY, HIGHEST_QUALITY].
 *                   Note: LOWEST_QUALITY must be included.
 * @returns A Promise resolving to a flat array of StaticContent objects containing either full images or partial images.
 */

export const readFileAsImage = async (
    file: File,
    qualities: Quality[] = [
        LOWEST_QUALITY,
        MEDIUM_QUALITY,
        HIGH_QUALITY,
        HIGHEST_QUALITY,
    ]
): Promise<StaticContent<StaticImage | StaticPartialImage>[]> => {
    if (!file) {
        throw new Error("No file provided");
    }

    if (!qualities.includes(LOWEST_QUALITY)) {
        throw new Error(
            "LOWEST_QUALITY must be included in the qualities array"
        );
    }

    // Read the file as an ArrayBuffer.
    const arrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            if (reader.result instanceof ArrayBuffer) {
                resolve(reader.result);
            } else {
                reject(new Error("Unexpected result type"));
            }
        };
        reader.onerror = (err) => reject(err);
        reader.readAsArrayBuffer(file);
    });

    // Create a Blob and an object URL for loading the image.
    const uint8arrayRaw = new Uint8Array(arrayBuffer);
    const blob = new Blob([uint8arrayRaw], { type: file.type });
    const url = URL.createObjectURL(blob);

    // Load the image to access its natural dimensions.
    const imgElement = await new Promise<HTMLImageElement>(
        (resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                resolve(img);
            };
            img.onerror = (err) => {
                URL.revokeObjectURL(url);
                reject(err);
            };
            img.src = url;
        }
    );

    const groupKey = sha256Sync(uint8arrayRaw);

    const originalWidth = imgElement.naturalWidth;
    const originalHeight = imgElement.naturalHeight;

    // Create a single reusable canvas.
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) {
        throw new Error("Could not get canvas context");
    }

    // Set the size threshold for splitting image data.
    const threshold = 3 * 1024 * 1024; // 3 MB

    const results: StaticContent<StaticImage | StaticPartialImage>[] = [];

    // Process each quality sequentially.
    let maxQualityFound = false;
    for (const quality of qualities) {
        let scale = 1.0;
        if (maxQualityFound) {
            continue;
        }
        const targetWidth = qualityToTargetWidth[quality];
        if (targetWidth === null) {
            // HIGHEST_QUALITY: raw full-size image.
            maxQualityFound = true;
            scale = 1.0;
            continue;
        } else {
            // If the original image is smaller than the target width, skip this quality.
            if (originalWidth <= targetWidth) {
                maxQualityFound = true;
            }

            scale =
                originalWidth > targetWidth ? targetWidth / originalWidth : 1.0;
        }

        const scaledWidth = Math.round(originalWidth * scale);
        const scaledHeight = Math.round(originalHeight * scale);

        // Reset the canvas dimensions and clear previous content.
        canvas.width = scaledWidth;
        canvas.height = scaledHeight;
        ctx.clearRect(0, 0, scaledWidth, scaledHeight);

        // Draw the image into the canvas.
        ctx.drawImage(imgElement, 0, 0, scaledWidth, scaledHeight);

        // Convert the canvas content into a Blob.
        const scaledBlob: Blob = await new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (blob) resolve(blob);
                else reject(new Error("Canvas toBlob conversion failed"));
            }, file.type);
        });
        const scaledArrayBuffer = await scaledBlob.arrayBuffer();
        const imageData = new Uint8Array(scaledArrayBuffer);

        // Create a StaticImage instance.
        const staticImage = new StaticImage({
            data: imageData,
            mimeType: file.type,
            alt: file.name,
            width: scaledWidth,
            height: scaledHeight,
            caption: "",
        });

        // If the image data exceeds the threshold, split into partial images.
        if (staticImage.data.length > threshold) {
            const parts: Uint8Array[] = [];
            for (let i = 0; i < staticImage.data.length; i += threshold) {
                parts.push(staticImage.data.slice(i, i + threshold));
            }
            const totalParts = parts.length;

            // Add each partial image to the results.
            for (let index = 0; index < parts.length; index++) {
                const partialImage = new StaticPartialImage({
                    partialData: parts[index],
                    partIndex: index,
                    totalParts,
                    mimeType: file.type,
                    width: scaledWidth,
                    height: scaledHeight,
                    alt: file.name,
                    caption: "",
                });
                results.push(
                    new StaticContent({
                        quality,
                        content: partialImage,
                        contentId: groupKey,
                    })
                );
            }
        } else {
            // Otherwise, add the full static image.
            results.push(
                new StaticContent({
                    quality,
                    content: staticImage,
                    contentId: groupKey,
                })
            );
        }
    }

    // Clean up the canvas.
    canvas.remove();

    return results;
};
