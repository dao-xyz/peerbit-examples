import React, {
    useEffect,
    useRef,
    useState,
    memo,
    ChangeEvent,
    DragEvent,
    TouchEvent,
} from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FiMaximize, FiX } from "react-icons/fi";
import { StaticImage } from "@giga-app/interface";
import { sha256Base64Sync } from "@peerbit/crypto";
import { readFileAsImage } from "./utils";
import { ChangeCallback } from "../types";
/* -------------------------------------------------------------------------
 * ImageContent – stable‑height version
 * -------------------------------------------------------------------------
 * ➤ Reserves the final block size immediately via CSS `aspect-ratio`, so the
 *   row height that react‑virtuoso measures never changes.
 * ➤ Shows a lightweight, animated skeleton until the actual image blob is
 *   decoded, preventing layout shifts.
 * ---------------------------------------------------------------------- */

export type ImageContentProps = {
    content: StaticImage & {
        /** Intrinsic bitmap width */
        width?: number;
        /** Intrinsic bitmap height */
        height?: number;
    };
    onResize: (dims: { width: number; height: number }) => void;
    editable?: boolean;
    onChange?: ChangeCallback;
    thumbnail?: boolean;
    fit?: "cover" | "contain";
    canOpenFullscreen?: boolean;
    /** If width/height are missing, fall back to this ratio (w / h). */
    fallbackRatio?: number;
    onLoad?: () => void;
};

export const ImageContent = memo(function ImageContent({
    content,
    onResize,
    editable = false,
    onChange,
    fit,
    canOpenFullscreen = true,
    fallbackRatio = 4 / 3,
    onLoad,
}: ImageContentProps) {
    /* ------------------------------------------------------------------- */
    /* Internal state                                                      */
    /* ------------------------------------------------------------------- */
    const containerRef = useRef<HTMLDivElement>(null);
    const [imgUrl, setImgUrl] = useState<string | null>(null);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [isDragOver, setIsDragOver] = useState(false);

    /* ------------------------------------------------------------------- */
    /* Pre‑decode image & emit resize                                      */
    /* ------------------------------------------------------------------- */
    const lastHashRef = useRef<string | null>(null);

    useEffect(() => {
        if (!content.data || !content.mimeType) return;

        const hash = sha256Base64Sync(content.data);

        /* ❶ skip if we already kicked off a load for this hash */
        if (lastHashRef.current === hash) return;
        lastHashRef.current = hash;

        const blob = new Blob([content.data], { type: content.mimeType });
        const objectUrl = URL.createObjectURL(blob);

        const img = new Image();
        img.onload = () => {
            onResize({ width: img.width, height: img.height });
            setImgUrl(`${objectUrl}#${hash}`);
        };

        img.src = objectUrl;

        /*  This kind of rendering might lead to better colors (TODO investigate)
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
        */

        /* ❷ cleanup: clear the ref only if *this* load is being abandoned */
        return () => {
            URL.revokeObjectURL(objectUrl);
            if (imgUrl) URL.revokeObjectURL(imgUrl);
            if (lastHashRef.current === hash) lastHashRef.current = null;
        };
    }, [content.data, content.mimeType, onResize]);

    /* ------------------------------------------------------------------- */
    /* File‑drop / picker handlers                                         */
    /* ------------------------------------------------------------------- */
    const handleFile = async (file?: File | null) => {
        if (!file || !onChange) return;
        const image = await readFileAsImage(file);
        onChange(image);
    };

    const onInputChange = (e: ChangeEvent<HTMLInputElement>) =>
        handleFile(e.target.files?.[0]);

    const onDrop = (e: DragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setIsDragOver(false);
        handleFile(e.dataTransfer.files?.[0]);
    };

    /* ------------------------------------------------------------------- */
    /* Touch/swipe to dismiss full‑screen                                  */
    /* ------------------------------------------------------------------- */
    const [translateY, setTranslateY] = useState(0);
    const [isDragging, setIsDragging] = useState(false);
    const touchStartY = useRef<number | null>(null);
    const swipeThreshold = 100;

    const start = (e: TouchEvent<HTMLDivElement>) => {
        touchStartY.current = e.touches[0].clientY;
        setIsDragging(true);
    };
    const move = (e: TouchEvent<HTMLDivElement>) => {
        if (touchStartY.current == null) return;
        setTranslateY(e.touches[0].clientY - touchStartY.current);
    };
    const end = () => {
        setIsDragging(false);
        if (Math.abs(translateY) >= swipeThreshold) {
            setTranslateY(
                translateY > 0 ? window.innerHeight : -window.innerHeight
            );
        } else {
            setTranslateY(0);
        }
        touchStartY.current = null;
    };
    const resetAfterTransition = () => {
        if (Math.abs(translateY) >= window.innerHeight) {
            setDialogOpen(false);
            setTranslateY(0);
        }
    };

    /* ------------------------------------------------------------------- */
    /* Derived values                                                      */
    /* ------------------------------------------------------------------- */
    const ratio =
        content.width && content.height
            ? content.width / content.height
            : fallbackRatio;
    const fitClass =
        fit === "cover"
            ? "object-cover"
            : fit === "contain"
            ? "object-contain"
            : "";
    const overlayOpacityHidden = 0.6;
    const overlayOpacity =
        overlayOpacityHidden -
        Math.min(
            Math.abs(translateY) / window.innerHeight,
            overlayOpacityHidden
        );

    let imageRef = useRef<HTMLImageElement | undefined>(undefined);

    const closeIfClickedLetterboxInsideImg = (
        e: React.MouseEvent<HTMLImageElement, MouseEvent>
    ) => {
        const img = e.currentTarget;
        const { offsetX, offsetY } = e.nativeEvent as MouseEvent;
        const scale = Math.min(
            img.clientWidth / imageRef.current.naturalWidth, // img.naturalHeight seem to return undefined so we use imageRef
            img.clientHeight / imageRef.current.naturalHeight // img.naturalHeight seem to return undefined so we use imageRef
        );
        const realW = imageRef.current.naturalWidth * scale; // img.naturalWidth seem to return undefined so we use imageRef
        const realH = imageRef.current.naturalHeight * scale; // img.naturalHeight seem to return undefined so we use imageRef
        const left = (img.clientWidth - realW) / 2;
        const top = (img.clientHeight - realH) / 2;

        const clickedInsidePicture =
            offsetX >= left &&
            offsetX <= left + realW &&
            offsetY >= top &&
            offsetY <= top + realH;

        if (!clickedInsidePicture) {
            setDialogOpen(false);
        }
        e.stopPropagation();
    };

    /* ------------------------------------------------------------------- */
    /* Full‑screen portal                                                 */
    /* ------------------------------------------------------------------- */
    const fullScreen = (
        <Dialog.Portal>
            <Dialog.Overlay
                onClick={closeIfClickedLetterboxInsideImg}
                style={{
                    backgroundColor: `rgba(0,0,0,${overlayOpacity})`,
                    transition: isDragging
                        ? "none"
                        : "background-color .3s ease",
                    backdropFilter: `blur(${overlayOpacity * 10}px)`,
                }}
                className="fixed inset-0 z-[10000]"
            />
            <Dialog.Content
                className="fixed inset-0 z-[10001] flex items-center justify-center"
                onClick={closeIfClickedLetterboxInsideImg}
                onTouchStart={start}
                onTouchMove={move}
                onTouchEnd={end}
                onTransitionEnd={resetAfterTransition}
                style={{
                    transform: `translateY(${translateY}px)`,
                    transition: isDragging ? "none" : "transform .3s ease",
                }}
            >
                <Dialog.Title className="sr-only">Image Preview</Dialog.Title>
                <Dialog.Description className="w-fit h-full flex justify-center max-w-4xl max-h-[100vh]">
                    {imgUrl && (
                        <img
                            src={imgUrl}
                            alt={content.alt ?? ""}
                            className="h-full object-contain max-w-screen"
                            onLoad={(e) => {
                                imageRef.current = e.currentTarget;
                                onLoad?.();
                            }}
                        />
                    )}
                </Dialog.Description>
                {translateY === 0 && (
                    <Dialog.Close asChild>
                        <button className="absolute btn top-0 right-0 w-10 h-10 text-black bg-white dark:text-white dark:bg-black opacity-60 text-2xl rounded-none">
                            <FiX />
                        </button>
                    </Dialog.Close>
                )}
            </Dialog.Content>
        </Dialog.Portal>
    );

    /* ------------------------------------------------------------------- */
    /* Render                                                              */
    /* ------------------------------------------------------------------- */
    return (
        <div
            ref={containerRef}
            className={`relative w-full h-full ${
                editable ? "cursor-pointer  transition-colors duration-150" : ""
            } ${
                editable && isDragOver
                    ? "border-primary-500 bg-primary-50 dark:bg-primary-900"
                    : ""
            }`}
            onDragOver={
                editable
                    ? (e) => {
                          e.preventDefault();
                          setIsDragOver(true);
                      }
                    : undefined
            }
            onDragLeave={
                editable
                    ? (e) => {
                          e.preventDefault();
                          setIsDragOver(false);
                      }
                    : undefined
            }
            onDrop={editable ? onDrop : undefined}
        >
            {/* skeleton while loading */}
            {/* If image loads fast this will just look like a flicker so we disabled this for now
                We might want to be able to load image size before image data so we can show this in advance in a better way
              {!imgUrl && (
                <div
                    className="w-full animate-pulse bg-neutral-300 dark:bg-neutral-700 rounded"
                    style={{ aspectRatio: ratio }}
                />
            )} */}

            {/* actual image */}
            {imgUrl &&
                (canOpenFullscreen ? (
                    !editable ? (
                        <Dialog.Root
                            open={dialogOpen}
                            onOpenChange={setDialogOpen}
                        >
                            <Dialog.Trigger asChild>
                                <img
                                    src={imgUrl}
                                    alt={content.alt ?? ""}
                                    className={`w-full h-full ${fitClass}`}
                                    onLoad={onLoad}
                                />
                            </Dialog.Trigger>
                            {fullScreen}
                        </Dialog.Root>
                    ) : (
                        <>
                            <img
                                src={imgUrl}
                                alt={content.alt ?? ""}
                                style={{ aspectRatio: ratio }}
                                className={`w-full h-full ${fitClass}`}
                                onLoad={onLoad}
                            />

                            <Dialog.Root
                                open={dialogOpen}
                                onOpenChange={setDialogOpen}
                            >
                                {fullScreen}
                            </Dialog.Root>
                        </>
                    )
                ) : (
                    <img
                        src={imgUrl}
                        alt={content.alt ?? ""}
                        className={`w-full h-full ${fitClass}`}
                        onLoad={onLoad}
                    />
                ))}

            {editable && (
                <>
                    <div className="absolute  m-2 bottom-0 left-0  ">
                        <span className="text-sm text-neutral-500 dark:text-neutral-300 bg-white dark:bg-neutral-900 bg-opacity-75 px-2 py-1 rounded">
                            Click to upload or drop an image
                        </span>
                    </div>
                    <input
                        type="file"
                        accept="image/*"
                        onChange={onInputChange}
                        className="absolute inset-0 opacity-0 cursor-pointer"
                    />
                </>
            )}
        </div>
    );
});

ImageContent.displayName = "ImageContent";
