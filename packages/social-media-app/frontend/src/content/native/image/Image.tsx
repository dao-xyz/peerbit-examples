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
};

export const ImageContent = ({
    content,
    onResize,
    editable = false,
    onChange,
    fit,
}: ImageContentProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const lastDims = useRef<{ width: number; height: number } | null>(null);
    const threshold = 1;
    const [isDragOver, setIsDragOver] = useState(false);
    const [imgUrl, setImgUrl] = useState("");
    const [dialogOpen, setDialogOpen] = useState(false);

    // Create a Blob URL from the raw binary data (Uint8Array) stored in content.data.
    useEffect(() => {
        if (!content.data || !content.mimeType) return;
        const blob = new Blob([content.data], { type: content.mimeType });
        const url = URL.createObjectURL(blob);
        setImgUrl(url);
        return () => {
            URL.revokeObjectURL(url);
        };
    }, [content.data, content.mimeType]);

    // Resize observer to call onResize
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
            {/* For non‑editable images, wrap image with Dialog.Trigger so that tapping opens preview */}
            {!editable ? (
                <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
                    <Dialog.Trigger asChild>
                        <img
                            src={imgUrl}
                            alt={content.alt}
                            className={`w-full h-full ${fitClass}`}
                        />
                    </Dialog.Trigger>
                    <Dialog.Portal>
                        <Dialog.Overlay className="fixed inset-0 bg-black bg-opacity-50 z-50" />
                        <Dialog.Content className="fixed inset-0 flex items-center justify-center z-50 ">
                            <img
                                src={imgUrl}
                                alt={content.alt}
                                className="max-h-full max-w-full object-contain"
                            />
                            <Dialog.Close asChild>
                                <button className="absolute top-4 right-4 p-2 text-white text-2xl">
                                    <FiX />
                                </button>
                            </Dialog.Close>
                        </Dialog.Content>
                    </Dialog.Portal>
                </Dialog.Root>
            ) : (
                <>
                    {/* Editable image: keep file input behavior and add a preview button */}
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
                    <Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
                        <Dialog.Portal>
                            <Dialog.Overlay className="fixed inset-0 bg-black bg-opacity-50 z-50" />
                            <Dialog.Content className="fixed inset-0 flex items-center justify-center z-50 p-4">
                                <img
                                    src={imgUrl}
                                    alt={content.alt}
                                    className="max-h-full max-w-full object-contain"
                                />
                                <Dialog.Close asChild>
                                    <button className="absolute top-4 right-4 p-2 text-white text-2xl">
                                        <FiX />
                                    </button>
                                </Dialog.Close>
                            </Dialog.Content>
                        </Dialog.Portal>
                    </Dialog.Root>
                </>
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
