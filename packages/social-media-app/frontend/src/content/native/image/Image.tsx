/**
 * @fileoverview React component for displaying and editing images with drag-and-drop functionality.
 */

import React, { useRef, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FiMaximize, FiX } from "react-icons/fi";
import { StaticImage } from "@dao-xyz/social";
import { readFileAsImage } from "./utils";
import { ChangeCallback } from "../types";

export type ImageContentProps = {
    content: StaticImage;
    onResize: (dims: { width: number; height: number }) => void;
    editable?: boolean;
    onChange?: ChangeCallback;
    thumbnail?: boolean;
    fit?: "cover" | "contain";
    canOpenFullscreen?: boolean;
};

export const ImageContent = ({
    content,
    onResize,
    editable = false,
    onChange,
    fit,
    canOpenFullscreen = true,
}: ImageContentProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const lastDims = useRef<{ width: number; height: number } | null>(null);
    const threshold = 1;
    const [isDragOver, setIsDragOver] = useState(false);
    const [imgUrl, setImgUrl] = useState("");
    const [dialogOpen, setDialogOpen] = useState(false);

    // Create a Blob URL from the raw binary data stored in content.data.
    useEffect(() => {
        if (!content.data || !content.mimeType) return;
        const blob = new Blob([content.data], { type: content.mimeType });
        const url = URL.createObjectURL(blob);
        setImgUrl(url);
        return () => {
            URL.revokeObjectURL(url);
        };
    }, [content.data, content.mimeType]);

    // Resize observer to trigger onResize.
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

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files && e.target.files[0];
        const image = await readFileAsImage(file);
        onChange && onChange(image);
    };

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

    // Determine object-fit class based on the `fit` prop.
    const fitClass =
        fit === "cover"
            ? "object-cover"
            : fit === "contain"
            ? "object-contain"
            : "";

    // Fullscreen preview container.
    // Clicking on the overlay (outside the content) closes the dialog.
    const FullscreenPreview = (
        <Dialog.Portal>
            <Dialog.Overlay
                className="fixed inset-0 z-[10000] bg-black bg-opacity-80"
                onClick={() => {
                    console.log("CLOSE!");
                    setDialogOpen(false);
                }}
            />
            <Dialog.Content
                className="fixed inset-0 z-[10001] flex items-center justify-center"
                onClick={(e) => e.stopPropagation()} // prevent clicks inside content from bubbling to overlay
            >
                <Dialog.Title className="sr-only">Image Preview</Dialog.Title>
                <div className="w-full h-full max-w-4xl max-h-[100vh]">
                    <img
                        src={imgUrl}
                        alt={content.alt}
                        className="w-full h-full object-contain"
                    />
                </div>
                <Dialog.Close asChild>
                    <button
                        className="absolute btn top-0 right-0 w-10 h-10  text-white bg-black opacity-60 text-2xl"
                        style={{ borderRadius: "0 0 0 0" }}
                    >
                        <FiX />
                    </button>
                </Dialog.Close>
            </Dialog.Content>
        </Dialog.Portal>
    );

    return (
        <div
            ref={containerRef}
            onDragOver={editable ? handleDragOver : undefined}
            onDragLeave={editable ? handleDragLeave : undefined}
            onDrop={editable ? handleDrop : undefined}
            className={`relative w-full h-full ${
                editable
                    ? "cursor-pointer border-2 border-dashed p-4 transition-colors duration-150 bg-neutral-50 dark:bg-neutral-800"
                    : ""
            } ${
                editable && isDragOver
                    ? "border-primary-500 bg-primary-50 dark:bg-primary-900"
                    : ""
            }`}
        >
            {canOpenFullscreen ? (
                !editable ? (
                    <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
                        <Dialog.Trigger asChild>
                            <img
                                src={imgUrl}
                                alt={content.alt}
                                className={`w-full h-full ${fitClass}`}
                            />
                        </Dialog.Trigger>
                        {FullscreenPreview}
                    </Dialog.Root>
                ) : (
                    <>
                        <img
                            src={imgUrl}
                            alt={content.alt}
                            className={`w-full h-full ${fitClass}`}
                        />
                        <button
                            onClick={() => setDialogOpen(true)}
                            className="absolute bottom-4 right-4 z-10 p-2 bg-black bg-opacity-50 rounded-full text-white"
                        >
                            <FiMaximize />
                        </button>
                        <Dialog.Root
                            open={dialogOpen}
                            onOpenChange={setDialogOpen}
                        >
                            {FullscreenPreview}
                        </Dialog.Root>
                    </>
                )
            ) : (
                <img
                    src={imgUrl}
                    alt={content.alt}
                    className={`w-full h-full ${fitClass}`}
                />
            )}
            {editable && (
                <>
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                        <span className="text-sm text-neutral-500 dark:text-neutral-300 bg-white dark:bg-neutral-900 bg-opacity-75 px-2 py-1 rounded">
                            Click to upload or drop an image
                        </span>
                    </div>
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
