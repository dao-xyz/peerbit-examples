import { useRef } from "react";
import { Canvas } from "../render/detailed/Canvas";
import { useDraftSession } from "./draft/DraftSession";

type InlineEditorProps = {
    className?: string;
};

export const InlineEditor = ({ className }: InlineEditorProps) => {
    const ref = useRef<HTMLDivElement | null>(null);
    const { publish } = useDraftSession()
    return (
        <div className={`flex flex-col h-full ${className || ""}`} ref={ref}>
            <Canvas requestPublish={publish} className="px-4" fitWidth draft /* inFullScreen */ />
        </div>
    );
};