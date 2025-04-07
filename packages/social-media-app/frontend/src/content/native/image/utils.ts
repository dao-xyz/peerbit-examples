import { StaticImage } from "@giga-app/interface";

export const readFileAsImage = async (file: File): Promise<StaticImage> => {
    if (!file) {
        throw new Error("No file provided");
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
        reader.onerror = (error) => reject(error);
        reader.readAsArrayBuffer(file);
    });

    // Create a Blob and an object URL to load the image.
    const blob = new Blob([arrayBuffer], { type: file.type });
    const url = URL.createObjectURL(blob);

    // Load the image to get its natural dimensions.
    const { width, height } = await new Promise<{
        width: number;
        height: number;
    }>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            resolve({ width: img.naturalWidth, height: img.naturalHeight });
            URL.revokeObjectURL(url);
        };
        img.onerror = (error) => {
            reject(error);
            URL.revokeObjectURL(url);
        };
        img.src = url;
    });

    // Return a new StaticImage with the accurate dimensions.
    return new StaticImage({
        data: new Uint8Array(arrayBuffer),
        mimeType: file.type,
        alt: file.name,
        width,
        height,
        caption: "",
    });
};
