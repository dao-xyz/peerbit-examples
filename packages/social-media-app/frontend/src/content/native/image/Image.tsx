/**
 * @fileoverview React component for displaying and editing images with drag-and-drop functionality.
 */

import React, { useRef, useEffect, useState, useCallback } from "react";
import { StaticImage } from "@dao-xyz/social";
import { readFileAsImage } from "./utils";

/**
 * Props interface for the ImageContent component
 * ImageContentProps
 * content - The image data to display
 * onResize - Callback when image dimensions change
 * [editable] - Whether the image can be edited/replaced
 * [onChange] - Callback when image content changes
 * [thumbnail] - Display as thumbnail
 * [fit] - How image should fit container. If not given, scales to parent on width and height
 */
export type ImageContentProps = {
    content: StaticImage;
    onResize: (dims: { width: number; height: number }) => void;
    editable?: boolean;
    onChange?: (newContent: StaticImage) => void;
    thumbnail?: boolean;
    fit?: "cover" | "contain";
};

/**
 * Component for displaying and editing image content
 * Supports drag-and-drop uploads and dimension monitoring
 */
export const ImageContent = ({
    content,
    onResize,
    editable = false,
    onChange,
    fit,
}: ImageContentProps) => {
    // References for container element and dimension tracking
    const containerRef = useRef<HTMLDivElement>(null);
    const lastDims = useRef<{ width: number; height: number } | null>(null);
    const threshold = 1;
    const [isDragOver, setIsDragOver] = useState(false);

    /**
     * ResizeObserver setup to monitor container dimensions
     * Triggers onResize callback when dimensions change beyond threshold
     */
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

    /**
     * Handles file input change events
     */
    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files && e.target.files[0];
        const image = await readFileAsImage(file);
        onChange && onChange(image);
    };

    /**
     * Drag and drop event handlers
     */
    const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragOver(true);
    };

    const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragOver(false);
    };

    const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragOver(false);
        const file = e.dataTransfer.files && e.dataTransfer.files[0];
        const image = await readFileAsImage(file);
        onChange && onChange(image);
    };

    return (
        <div
            ref={containerRef}
            onDragOver={editable ? handleDragOver : undefined}
            onDragLeave={editable ? handleDragLeave : undefined}
            onDrop={editable ? handleDrop : undefined}
            className={`relative w-full h-full ${
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
                className={`w-full h-full ${
                    {
                        cover: "object-cover",
                        contain: "object-contain",
                        default: "",
                    }[fit ?? "default"]
                }`}
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
