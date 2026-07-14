import React, { useEffect } from "react";
import iframeResize from "@iframe-resizer/parent";

export interface IFrameResizerProps {
    license: string;
    /**
     * A ref to the iframe element that will be resized.
     */
    iframeRef: React.RefObject<HTMLIFrameElement | null>;
    children: React.ReactNode;
    onResize: (data: { height: number; width: number }) => void;
}

const IFrameResizer: React.FC<IFrameResizerProps> = ({
    license,
    iframeRef,
    children,
    onResize,
}) => {
    useEffect(() => {
        const iframe = iframeRef.current;
        if (!iframe) return;
        const instances = iframeResize(
            {
                license,
                log: false,
                onResized(data) {
                    onResize({ height: data.height, width: data.width });
                    /*  console.log(
                         `[iframe-resizer/react][${iframe?.id}] Resized to ${data.height}px`
                     ); */
                },
                // The child "close" protocol is only a request. It can be
                // spoofed by another same-origin window, so never let it
                // remove React-owned DOM.
                onBeforeClose: () => {
                    /*  console.warn(
                         `[iframe-resizer/react][${iframe?.id}] Close event ignored. To remove the iframe update your React component.`
                     ); */
                    return false;
                },
            },
            iframe
        );
        return () => {
            instances?.forEach((instance) =>
                instance.iFrameResizer.disconnect()
            );
        };
    }, [iframeRef, license, onResize]);

    return <>{children}</>;
};

export default IFrameResizer;
