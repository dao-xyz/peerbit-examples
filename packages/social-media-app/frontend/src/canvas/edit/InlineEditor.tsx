import { useEffect, useMemo, useRef } from "react";
import { Canvas } from "../Canvas";
import { usePendingCanvas } from "./PendingCanvasContext";

type InlineEditorProps = {
    className?: string; // Optional class name for the container
};

// Array of 30 casual, everyday titles.

export const InlineEditor = ({ className }: InlineEditorProps) => {
    const ref = useRef(null);

    // Use the ref to focus the title input if needed
    /*  useEffect(() => {
         ref.current?.scrollIntoView({
             // scroll to the top of the page
             behavior: "instant",
             block: "start",
             inline: "nearest",
         });
     }, [ref]);
  */
    const { publish } = usePendingCanvas()
    return (
        <div className={` flex flex-col h-full ${className}`} ref={ref}>
            {" "}
            {/* mb-12 does not work here */}
            <Canvas requestPublish={publish} className="px-4" fitWidth draft={true} inFullScreen />
        </div>
    );
};
