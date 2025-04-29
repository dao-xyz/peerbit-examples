import React, { useRef, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FiMaximize, FiX } from "react-icons/fi";
import { StaticImage } from "@giga-app/interface";
import { readFileAsImage } from "./utils";
import { ChangeCallback } from "../types";
import { sha256Base64Sync } from "@peerbit/crypto";

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
    const lastImageHash = useRef<string | null>(null);

    // States for swipe animation.
    const [translateY, setTranslateY] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const touchStartYRef = useRef<number | null>(null);
    const swipeThreshold = 100; // pixels

    // Create a Blob URL from the raw binary data stored in content.data.
    useEffect(() => {
        if (!content.data || !content.mimeType) return;
        let hash = sha256Base64Sync(content.data); // TODO use StaticContent contentId instead
        if (lastImageHash.current === hash) {
            return;
        }
        lastImageHash.current = hash;

        const originalBlob = new Blob([content.data], {
            type: content.mimeType,
        });
        const originalUrl = URL.createObjectURL(originalBlob);

        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            if (ctx) {
                ctx.drawImage(img, 0, 0, img.width, img.height);
                canvas.toBlob(
                    (convertedBlob) => {
                        if (convertedBlob) {
                            const newUrl = URL.createObjectURL(convertedBlob);
                            setImgUrl(newUrl);
                            URL.revokeObjectURL(originalUrl);
                        }
                    },
                    content.mimeType,
                    1
                );
            }
            canvas.remove();
        };
        img.src = originalUrl;

        return () => {
            lastImageHash.current = null;
            URL.revokeObjectURL(originalUrl);
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

    // --- SWIPE HANDLERS WITH UP & DOWN SUPPORT AND BACKGROUND FADE ---
    const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
        touchStartYRef.current = e.touches[0].clientY;
        setIsDragging(true);
    };

    const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
        if (touchStartYRef.current !== null) {
            const deltaY = e.touches[0].clientY - touchStartYRef.current;
            setTranslateY(deltaY);
        }
    };

    const handleTouchEnd = () => {
        setIsDragging(false);
        if (Math.abs(translateY) >= swipeThreshold) {
            // Animate offscreen in the swipe direction.
            if (translateY > 0) {
                setTranslateY(window.innerHeight);
            } else {
                setTranslateY(-window.innerHeight);
            }
        } else {
            // Animate back to original position.
            setTranslateY(0);
        }
        touchStartYRef.current = null;
    };

    const handleTransitionEnd = () => {
        if (Math.abs(translateY) >= window.innerHeight) {
            // If the image has animated offscreen, close the dialog.
            setDialogOpen(false);
            // Reset the position for next time.
            setTranslateY(0);
        }
    };

    // Calculate overlay opacity: fades out as the image is swiped away.
    const overlayOpacity =
        1 * (1 - Math.min(Math.abs(translateY) / window.innerHeight, 1));

    // Fullscreen preview container.
    const FullscreenPreview = (
        <Dialog.Portal>
            <Dialog.Overlay
                onClick={() => setDialogOpen(false)}
                style={{
                    backgroundColor: `rgba(0, 0, 0, ${overlayOpacity})`,
                    transition: isDragging
                        ? "none"
                        : "background-color 0.3s ease",
                }}
                className="fixed inset-0 z-[10000]"
            />
            <Dialog.Content
                className="fixed inset-0 z-[10001] flex items-center justify-center"
                onClick={(e) => e.stopPropagation()}
                onTouchStart={handleTouchStart}
                onTouchMove={handleTouchMove}
                onTouchEnd={handleTouchEnd}
                onTransitionEnd={handleTransitionEnd}
                style={{
                    transform: `translateY(${translateY}px)`,
                    transition: isDragging ? "none" : "transform 0.3s ease",
                }}
            >
                <Dialog.Title className="sr-only">Image Preview</Dialog.Title>
                <div className="w-full h-full flex justify-center max-w-4xl max-h-[100vh]">
                    <img
                        decoding="sync"
                        src={imgUrl}
                        alt={content.alt ?? ""}
                        className="h-full object-contain"
                    />
                </div>
                {translateY === 0 && (
                    <Dialog.Close asChild>
                        <button
                            className="absolute btn top-0 right-0 w-10 h-10 text-white bg-black opacity-60 text-2xl"
                            style={{ borderRadius: "0" }}
                        >
                            <FiX />
                        </button>
                    </Dialog.Close>
                )}
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
                                decoding="sync"
                                src={imgUrl}
                                alt={content.alt ?? ""}
                                className={`w-full h-full ${fitClass}`}
                            />
                        </Dialog.Trigger>
                        {FullscreenPreview}
                    </Dialog.Root>
                ) : (
                    <>
                        <img
                            decoding="sync"
                            src={imgUrl}
                            alt={content.alt ?? ""}
                            className={`w-full h-full ${fitClass}`}
                        />
                        <button
                            onClick={() => setDialogOpen(true)}
                            className="absolute bottom-4 right-4 p-2 bg-black bg-opacity-50 rounded-full text-white"
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
                    decoding="sync"
                    src={imgUrl}
                    alt={content.alt ?? ""}
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
