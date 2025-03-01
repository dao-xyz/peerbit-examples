import { Canvas } from "@dao-xyz/social";
import { useEffect, useState } from "react";

export const CanvasPreview = (properties: { canvas: Canvas }) => {
    const [name, setName] = useState<string | null>(null);

    useEffect(() => {
        if (properties.canvas.closed) {
            return;
        }
        properties.canvas.createTitle().then(setName);
    }, [properties.canvas.closed ? undefined : properties.canvas?.address]);

    return <>Canvas summary: {name}</>;
};
