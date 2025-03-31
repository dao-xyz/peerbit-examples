import { StaticImage } from "@giga-app/interface";
import pDefer from "p-defer";

export const readFileAsImage = (file: File): Promise<StaticImage> => {
    if (!file) {
        return Promise.reject(new Error("No file provided"));
    }
    const deferred = pDefer<StaticImage>();
    const reader = new FileReader();
    reader.onload = () => {
        const result = reader.result;
        if (result instanceof ArrayBuffer) {
            const data = new Uint8Array(result);
            deferred.resolve(
                new StaticImage({
                    data,
                    mimeType: file.type,
                    alt: file.name,
                    width: 300, // TODO: get real width and height
                    height: 200, // TODO: get real width and height
                    caption: "",
                })
            );
        } else {
            deferred.reject(new Error("Unexpected result type"));
        }
    };
    reader.onerror = (error) => {
        deferred.reject(error);
    };
    reader.readAsArrayBuffer(file);
    return deferred.promise;
};
