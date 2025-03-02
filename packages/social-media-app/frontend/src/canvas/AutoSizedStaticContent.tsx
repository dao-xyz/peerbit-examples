import { useRef, useEffect } from "react";
import Markdown from "marked-react";
import {
    StaticContent,
    StaticMarkdownText,
    StaticImage,
} from "@dao-xyz/social";

type AutoSizedStaticContentProps = {
    staticContent: StaticContent["content"];
    onResize: (dims: { width: number; height: number }) => void;
};

export const AutoSizedStaticContent = ({
    staticContent,
    onResize,
}: AutoSizedStaticContentProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    // Store the last dimensions to avoid duplicate events.
    const lastDims = useRef<{ width: number; height: number } | null>(null);
    // Define a minimal threshold to avoid triggering on minor changes.
    const threshold = 1;

    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            for (let entry of entries) {
                const { width, height } = entry.contentRect;
                const newDims = { width, height };
                // If we have stored dimensions, compare with the new ones.
                if (
                    lastDims.current &&
                    Math.abs(lastDims.current.width - newDims.width) <
                        threshold &&
                    Math.abs(lastDims.current.height - newDims.height) <
                        threshold
                ) {
                    // No significant change, so skip notification.
                    continue;
                }
                lastDims.current = newDims;
                onResize(newDims);
            }
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, [onResize, threshold]);

    if (staticContent instanceof StaticMarkdownText) {
        return (
            <div ref={containerRef} className="p-2 h-full overflow-auto">
                <Markdown gfm>{staticContent.text}</Markdown>
            </div>
        );
    }
    if (staticContent instanceof StaticImage) {
        return (
            <div ref={containerRef}>
                <img
                    src={`data:${staticContent.mimeType};base64,${staticContent.base64}`}
                    alt={staticContent.alt}
                    width={staticContent.width}
                    height={staticContent.height}
                />
            </div>
        );
    }
    return <span ref={containerRef}>Unsupported static content</span>;
};
