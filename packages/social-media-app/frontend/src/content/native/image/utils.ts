import { StaticImage } from "@dao-xyz/social";

export const readFileAsImage = (onChange: (image: StaticImage) => void) => {
    return (file: File) => {
        if (!file || !onChange) return;
        const reader = new FileReader();
        reader.onload = () => {
            const result = reader.result;
            if (typeof result === "string") {
                onChange(
                    new StaticImage({
                        base64: result.split(",")[1],
                        mimeType: file.type,
                        alt: file.name,
                        width: 300, // adjust as needed
                        height: 200,
                    })
                );
            }
        };
        reader.readAsDataURL(file);
    };
};
