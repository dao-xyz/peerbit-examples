import React, { useRef, useEffect, useState, useCallback } from "react";
import { StaticImage } from "@dao-xyz/social";
import { readFileAsImage } from "./utils";

export type ImageContentProps = {
    content: StaticImage;
    onResize: (dims: { width: number; height: number }) => void;
    editable?: boolean;
    onChange?: (newContent: StaticImage) => void;
    thumbnail?: boolean;
    coverParent?: boolean;
};

export const ImageContent = ({
    content,
    onResize,
    editable = false,
    onChange,
    coverParent,
}: ImageContentProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const lastDims = useRef<{ width: number; height: number } | null>(null);
    const threshold = 1;
    const [isDragOver, setIsDragOver] = useState(false);

    // ResizeObserver to trigger onResize callback
    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                const newDims = { width, height };
                if (
                    lastDims.current &&
                    Math.abs(lastDims.current.width - newDims.width) <
                        threshold &&
                    Math.abs(lastDims.current.height - newDims.height) <
                        threshold
                ) {
                    continue;
                }
                lastDims.current = newDims;
                onResize(newDims);
            }
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, [onResize, threshold]);

    // Common file handling logic.
    const handleFile = useCallback(readFileAsImage(onChange), [onChange]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files && e.target.files[0];
        handleFile(file);
    };

    // Drag and drop handlers
    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragOver(true);
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragOver(false);
    };

    const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragOver(false);
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        handleFile(file);
    };

    return (
        <div
            ref={containerRef}
            onDragOver={editable ? handleDragOver : undefined}
            onDragLeave={editable ? handleDragLeave : undefined}
            onDrop={editable ? handleDrop : undefined}
            className={`relative min-h-[100px] w-full h-full ${
                coverParent ? "object-cover" : "min-w-max"
            } ${
                editable
                    ? "cursor-pointer border-2 border-dashed p-4 transition-colors duration-150 bg-gray-50 dark:bg-gray-800"
                    : ""
            } ${
                editable && isDragOver
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-900"
                    : ""
            }`}
        >
            <img
                src={`data:${content.mimeType};base64,${content.base64}`}
                alt={content.alt}
                className="object-contain w-full "
                style={{ maxHeight: "400px" }}
            />
            {editable && (
                <>
                    {/* Overlay message */}
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <span className="text-sm text-gray-500 dark:text-gray-300 bg-white dark:bg-gray-900 bg-opacity-75 px-2 py-1 rounded">
                            Click to upload or drop an image
                        </span>
                    </div>
                    {/* Transparent input covering the entire area */}
                    <input
                        type="file"
                        accept="image/*"
                        onChange={handleFileChange}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                    />
                </>
            )}
        </div>
    );
};
