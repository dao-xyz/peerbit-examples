import { Canvas } from "@dao-xyz/social";
import { useEffect, useState } from "react";
import { FrameHeader } from "./FrameHeader";
import { useNavigate } from "react-router-dom";
import { getCanvasByPath } from "../routes";
import { getCanvasPathFromURL } from "../useSpaces";

export const CanvasPreview = (properties: { canvas: Canvas }) => {
    const [name, setName] = useState<string | null>(null);
    const navigate = useNavigate();

    useEffect(() => {
        if (properties.canvas.closed) {
            return;
        }
        properties.canvas.createTitle().then(setName);
    }, [properties.canvas.closed ? undefined : properties.canvas?.address]);

    return (
        <button
            className="btn"
            onClick={async () => {
                // navigate to the canvas
                console.log(
                    "NAME?",
                    name,
                    await properties.canvas.createTitle()
                );
                navigate(
                    getCanvasByPath([...getCanvasPathFromURL(), name]),
                    {}
                );
            }}
        >
            <FrameHeader publicKey={properties.canvas.publicKey} />
            <div>PREVIEW {name}</div>
        </button>
    );
};
