import { Canvas as CanvasDB } from "@dao-xyz/social";
import { useEffect, useState } from "react";
import { Header } from "./header/Header";
import { useNavigate } from "react-router-dom";
import { getCanvasPath } from "../routes";
import { usePeer, useProgram } from "@peerbit/react";
import { Canvas } from "./Canvas";
import { CanvasWrapper } from "./CanvasWrapper";

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
            className="btn w-full flex flex-row p-0 border  border-solid max-h-[40vh] overflow-hidden"
            onClick={async () => {
                navigate(getCanvasPath(properties.canvas), {});
            }}
        >
            <Header publicKey={properties.canvas.publicKey} direction="col" />
            <CanvasWrapper canvas={properties.canvas}>
                <div className="w-full flex flex-col items-center relative overflow-hidden">
                    {/* Real image preview */}
                    <Canvas fitHeight />
                    <div className="absolute inset-0 -z-10">
                        <div className="relative blur-xl w-full h-full">
                            <Canvas fitHeight fitWidth />
                        </div>
                    </div>
                </div>
            </CanvasWrapper>
        </button>
    );
};
