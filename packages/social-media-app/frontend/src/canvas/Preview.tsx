import { Canvas as CanvasDB } from "@dao-xyz/social";
import { useEffect, useState } from "react";
import { Header } from "./header/Header";
import { useNavigate } from "react-router-dom";
import { getCanvasPath } from "../routes";
import { usePeer, useProgram } from "@peerbit/react";
import { Canvas } from "./Canvas";

export const CanvasPreview = (properties: { canvas: CanvasDB }) => {
    /* const [name, setName] = useState<string | null>(null); */
    const navigate = useNavigate();
    /*     const peer = usePeer(); */

    /*     useEffect(() => {
            if (properties.canvas.closed) {
                return;
            }
            properties.canvas.createTitle().then(setName);
        }, [properties.canvas.closed ? undefined : properties.canvas?.address]); */

    /*  const canvas = useProgram(properties.canvas, { existing: 'reuse' }); */

    return (
        <button
            className="btn w-full flex flex-row p-0 border  border-solid"
            onClick={async () => {
                navigate(getCanvasPath(properties.canvas), {});
            }}
        >
            <Header publicKey={properties.canvas.publicKey} direction="col" />
            <div className="w-full flex">
                {/*  {name != null ? (
                    <div className="truncate whitespace-pre-line">{name}</div>
                ) : (
                    <div>Failed to create preview</div>
                )} */}
                <Canvas canvas={properties.canvas} />
            </div>
        </button>
    );
};
