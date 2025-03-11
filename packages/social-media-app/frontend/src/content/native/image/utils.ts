import { StaticImage } from "@dao-xyz/social";
import pDefer from "p-defer";

export const readFileAsImage = (file: File): Promise<StaticImage> => {
    if (!file) {
        return;
    }
    const deferred = pDefer();
    const reader = new FileReader();
    reader.onload = () => {
        const result = reader.result;
        if (typeof result === "string") {
            deferred.resolve(
                new StaticImage({
                    base64: result.split(",")[1],
                    mimeType: file.type,
                    alt: file.name,
                    width: 300, // TODO: get real width and height
                    height: 200, // TODO: get real width and height
                })
            );
        }
    };
    reader.onerror = (error) => {
        deferred.reject(error);
    };
    reader.readAsDataURL(file);
};
