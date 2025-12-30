import React, {
    useRef,
    useEffect,
    useState,
    useCallback,
    useLayoutEffect,
    useMemo,
} from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import * as Dialog from "@radix-ui/react-dialog";
import {
    Element,
    LOWEST_QUALITY,
    StaticContent,
    StaticMarkdownText,
} from "@giga-app/interface";
import { ChangeCallback } from "./types";
import { sha256Sync, toBase64URL } from "@peerbit/crypto";
import { useCanvas } from "../../canvas/CanvasWrapper";
import { useAIReply } from "../../ai/AIReployContext";
import { usePeer } from "@peerbit/react";
import { FaCheck } from "react-icons/fa";
import { Spinner } from "../../utils/Spinner";
import debounce from "lodash.debounce";
import { equals } from "uint8arrays";
import {
    rectIsStaticImage,
    rectIsStaticPartialImage,
} from "../../canvas/utils/rect";
import { parseGigaImageRef } from "../../canvas/utils/inlineMarkdownImages";

const GigaMarkdownImage = ({
    src,
    alt,
    title,
    imagesByRef,
}: {
    src?: string;
    alt?: string;
    title?: string;
    imagesByRef: Map<string, Element<any>>;
}) => {
    const ref = typeof src === "string" ? parseGigaImageRef(src) : undefined;
    if (!ref) {
        return (
            <img
                src={src}
                alt={alt ?? ""}
                title={title}
                loading="lazy"
                className="max-w-full h-auto rounded-md"
            />
        );
    }

    const el = imagesByRef.get(ref);
    if (!el || !(rectIsStaticImage(el) || rectIsStaticPartialImage(el))) {
        return (
            <span className="text-sm italic text-neutral-500">
                [missing image]
            </span>
        );
    }
    if (!rectIsStaticImage(el)) {
        return (
            <span className="text-sm italic text-neutral-500">
                [image still loading]
            </span>
        );
    }

    const img = el.content.content;
    const [imgUrl, setImgUrl] = useState<string | null>(null);
    useEffect(() => {
        if (!img.data || !img.mimeType) return;
        const blob = new Blob([img.data as BlobPart], {
            type: img.mimeType,
        });
        const url = URL.createObjectURL(blob);
        setImgUrl(url);
        return () => URL.revokeObjectURL(url);
    }, [img.data, img.mimeType]);

    const altText = alt || img.alt || "";

    return (
        <Dialog.Root>
            <Dialog.Trigger asChild>
                <img
                    src={imgUrl ?? ""}
                    alt={altText}
                    title={title}
                    loading="lazy"
                    width={img.width || undefined}
                    height={img.height || undefined}
                    className="max-w-full max-h-[60vh] object-contain rounded-md cursor-zoom-in"
                    style={
                        img.width && img.height
                            ? { aspectRatio: `${img.width}/${img.height}` }
                            : undefined
                    }
                />
            </Dialog.Trigger>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0 bg-black/70" />
                <Dialog.Content className="fixed inset-0 flex items-center justify-center p-4">
                    <img
                        src={imgUrl ?? ""}
                        alt={altText}
                        className="max-h-[92vh] max-w-[92vw] object-contain rounded-md"
                    />
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
};

export type MarkdownContentProps = {
    element: Element<StaticContent<StaticMarkdownText>>;
    onResize: (dims: { width: number; height: number }) => void;
    editable?: boolean;
    onChange?: ChangeCallback;
    thumbnail?: boolean;
    previewLines?: number;
    noPadding?: boolean;
    inFullscreen?: boolean;
    onLoad?: () => void;
};

export const MarkdownContent = ({
    element,
    onResize,
    editable = false,
    onChange,
    previewLines,
    noPadding,
    inFullscreen,
    onLoad,
}: MarkdownContentProps) => {
    const content = element.content.content;
    const containerRef = useRef<HTMLDivElement>(null);
    const lastDims = useRef<{ width: number; height: number } | null>(null);
    const threshold = 1;
    const saving = useRef(false);

    // Start editing automatically if there's no text.
    const [isEditing, setIsEditing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Local state for the markdown text.
    const [text, setText] = useState(content.text);

    const {
        canvas,
        placeholder,
        classNameContent,
        rects,
        pendingRects,
        reduceElementsForViewing,
    } = useCanvas();
    const { suggest, isReady } = useAIReply();
    const { peer } = usePeer();
    const [loadingSuggestedReply, setLoadingSuggestedReply] = useState(false);
    const [suggestReply, setSuggestedReply] = useState<string | null>(null);

    const suggestedReplyForParent = useRef<Uint8Array | null>(null);

    const debouncedPropChange = useRef(
        debounce(
            (newText: string) => {
                // We call the parent onChange *outside* React’s event loop
                onChange?.(
                    new StaticContent({
                        content: new StaticMarkdownText({ text: newText }),
                        quality: LOWEST_QUALITY,
                        contentId: sha256Sync(
                            new TextEncoder().encode(newText)
                        ),
                    })
                );
            },
            150 // ← tweak the delay (ms) to taste
        )
    ).current;

    useEffect(() => {
        return () => {
            debouncedPropChange.cancel();
        };
    }, [debouncedPropChange]);

    //   Helper: is the caret at the logical end?
    const caretIsAtEnd = () =>
        textareaRef.current &&
        textareaRef.current.selectionStart ===
            textareaRef.current.value.length &&
        textareaRef.current.selectionEnd === textareaRef.current.value.length;

    // Helper: push the scroll container (or window) so the caret line is visible
    const scrollToBottom = () => {
        // If the MarkdownContent itself is scroll-able, use it
        if (containerRef.current) {
            containerRef.current.scrollTop = containerRef.current.scrollHeight;
        }

        // Fallback: if the div isn't scrollable, bump the page instead
        requestAnimationFrame(() => {
            const { bottom } = containerRef.current!.getBoundingClientRect();
            if (bottom > window.innerHeight) {
                window.scrollTo({
                    top: document.body.scrollHeight,
                    behavior: "instant",
                });
            }
        });
    };

    useEffect(() => {
        if (
            !isReady ||
            !isEditing ||
            !canvas ||
            !canvas.__indexed.path ||
            text.length > 0
        ) {
            return;
        }
        let parent = canvas.__indexed.path[canvas.__indexed.path.length - 1];

        let suggestTimeout: ReturnType<typeof setTimeout> | null = null;
        if (parent) {
            if (
                !suggestedReplyForParent.current ||
                !equals(suggestedReplyForParent.current, parent)
            ) {
                suggestedReplyForParent.current = parent;
                /*  let suggestStartRef = parent.id; */
                suggestTimeout = setTimeout(async () => {
                    setLoadingSuggestedReply(true);
                    setSuggestedReply(null);
                    try {
                        /*  const loadedParent = await parent.load(peer);
                         if (loadedParent.publicKey.equals(canvas.publicKey)) {
                             return; // no self reply
                         }
                         // console.log("SUGGEST!");
                          suggest(loadedParent, 2e4).then((reply) => {
                              if (
                                  suggestStartRef !==
                                  canvas.path[canvas.path.length - 1].address
                              ) {
                                  console.log(
                                      "SUGGESTED reply parent change, skipping"
                                  );
                                  return; // the parent has changed, ignore the suggestion
                              }
                              setSuggestedReply(reply);
                          }); */
                    } finally {
                        setLoadingSuggestedReply(false);
                    }
                }, 300);
            }
        }
        return () => {
            suggestedReplyForParent.current = null;
            suggestTimeout && clearTimeout(suggestTimeout);
        };
    }, [
        canvas?.__indexed.path,
        isEditing,
        isReady,
        text,
        suggest,
        peer,
        canvas?.publicKey.hashcode(),
    ]);

    // Update text when content changes.
    useEffect(() => {
        setText(content.text);
    }, [content.text]);

    const loadedOnce = useRef(false);
    useLayoutEffect(() => {
        if (onLoad) {
            onLoad();
            loadedOnce.current = true;
        }
        return () => {
            loadedOnce.current = false;
        };
    }, [content.text]);

    // Observe container's size changes.
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

    // Auto-resize the textarea.
    const autoResize = useCallback(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
            const newHeight = textareaRef.current.scrollHeight;
            textareaRef.current.style.height = `${newHeight}px`;
            const newWidth = containerRef.current
                ? containerRef.current.clientWidth
                : 0;
            onResize({ width: newWidth, height: newHeight });

            if (caretIsAtEnd() && inFullscreen) {
                scrollToBottom();
            }
        }
    }, [onResize]);

    // Auto-resize on text change.
    useEffect(() => {
        if (isEditing) {
            autoResize();
        }
    }, [text, isEditing, autoResize]);

    // When the user clicks the container (and we're editable), start editing.
    const handleStartEditing = (focus: boolean) => {
        setIsEditing(true);
        focus &&
            setTimeout(() => {
                textareaRef.current?.focus({ preventScroll: true });
                // set the cursor to the end of the text
                textareaRef.current?.setSelectionRange(
                    text.length,
                    text.length
                );
            }, 0);
    };

    useEffect(() => {
        if (editable && containerRef.current && canvas) {
            if (!suggestReply && !isEditing) {
                handleStartEditing(true);
            }
        }
    }, [editable, content.text, containerRef.current, canvas?.idString]);

    // New helper to insert the suggested reply
    const handleInsertSuggestion = () => {
        if (suggestReply) {
            handleTextChange({ target: { value: suggestReply } });
            setSuggestedReply(null);
            // Optionally, move the cursor to the end of the inserted text
            setTimeout(() => {
                if (textareaRef.current) {
                    textareaRef.current.focus({ preventScroll: true });
                    textareaRef.current.setSelectionRange(
                        suggestReply.length,
                        suggestReply.length
                    );
                }
            }, 0);
        }
    };

    // Handle key presses in the textarea.
    const handleKeyDown = async (
        e: React.KeyboardEvent<HTMLTextAreaElement>
    ) => {
        // If there's a suggested reply and the user presses Tab, insert it.
        if (e.key === "Tab" && suggestReply) {
            e.preventDefault();
            handleInsertSuggestion();
            return;
        }

        if (!inFullscreen) {
            if (e.key === "Enter" && !e.shiftKey) {
                const currentValue = e.currentTarget.value;
                if (!currentValue.includes("\n")) {
                    e.preventDefault();
                    try {
                        saving.current = true;
                        await onChange?.(
                            new StaticContent({
                                content: new StaticMarkdownText({
                                    text: currentValue,
                                }),
                                quality: LOWEST_QUALITY,
                                contentId: sha256Sync(
                                    new TextEncoder().encode(currentValue)
                                ),
                            }),
                            { save: true }
                        );
                    } catch (error) {
                        console.error("Failed to save", error);
                    } finally {
                        saving.current = false;
                    }
                    setText("");
                    autoResize();
                    containerRef.current?.focus();
                }
            }
        }
    };

    const handleTextChange = (e: { target: { value: string } }) => {
        const newText = e.target.value;
        setText(newText);
        autoResize();
        debouncedPropChange(newText);
    };

    const handleBlur = () => {
        if (text.length > 0) setIsEditing(false);
    };

    // Common Tailwind classes for consistent padding, font size, and line-height.
    // If noPadding is true, we remove the padding.
    const commonClasses = "text-base leading-6";
    const padding = noPadding ? "" : "px-1";

    // Utility function to check if a text selection is present
    const isTextSelected = () => {
        const selection = window.getSelection();
        return (
            selection &&
            selection.type === "Range" &&
            selection.toString().length > 0
        );
    };

    // Click handler that stops propagation only if there's no selection
    const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (editable && !isEditing) {
            handleStartEditing(true);
            return;
        }
        if (isTextSelected()) {
            e.stopPropagation();
        }
    };
    const containerStyle =
        !inFullscreen && editable && isEditing
            ? { maxHeight: "200px", overflowY: "auto" as const }
            : {};

    // Auto-enter editing mode when editable and there is no text content yet.
    useEffect(() => {
        if (editable && (!content?.text || content.text.length === 0)) {
            setIsEditing(true);
        }
    }, [editable, content?.text]);

    const displayText = isEditing ? text : content.text;

    const gigaImagesByRef = useMemo(() => {
        try {
            const grouped = reduceElementsForViewing([
                ...rects,
                ...pendingRects,
            ]);
            const map = new Map<string, Element<any>>();
            for (const el of grouped) {
                if (rectIsStaticImage(el) || rectIsStaticPartialImage(el)) {
                    map.set(toBase64URL(el.content.contentId), el);
                }
            }
            return map;
        } catch {
            return new Map<string, Element<any>>();
        }
    }, [rects, pendingRects, reduceElementsForViewing]);

    return (
        <div
            ref={containerRef}
            className={`${commonClasses} w-full text-left  ${
                editable ? "cursor-text" : ""
            }`}
            style={containerStyle}
            onClick={handleClick}
        >
            {editable && isEditing ? (
                <div className="flex flex-row items-start">
                    <textarea
                        ref={textareaRef}
                        value={displayText}
                        onChange={handleTextChange}
                        onBlur={handleBlur}
                        onKeyDown={handleKeyDown}
                        onInput={autoResize}
                        className={`${commonClasses} ${padding} w-full border-none outline-none resize-none block rounded dark:bg-neutral-800 ${
                            !inFullscreen ? "textarea-truncate" : ""
                        }`}
                        rows={1}
                        placeholder={
                            suggestReply || placeholder || "Type here..."
                        }
                        style={{ overflow: "hidden" }}
                    />
                    {/* Render the "Use suggestion" button if a suggested reply is available.
                        This helps mobile users (or others without a Tab key) easily insert the suggestion. */}
                    {suggestReply && (
                        <button
                            type="button"
                            onClick={handleInsertSuggestion}
                            className="btn btn-icon btn-small"
                        >
                            <FaCheck />
                        </button>
                    )}
                    {!suggestReply && loadingSuggestedReply && (
                        <div className="flex items-center">
                            <Spinner />
                        </div>
                    )}
                </div>
            ) : (
                <div
                    style={{ ["--preview-lines" as any]: previewLines }}
                    className={`${
                        previewLines ? "line-clamp-[var(--preview-lines)]" : ""
                    } ${
                        previewLines > 0 ? "break-all whitespace-pre-wrap" : ""
                    } ${editable ? "" : ""} ${editable ? "p-1 min-h-10" : ""} ${
                        classNameContent
                            ? typeof classNameContent === "function"
                                ? classNameContent(element)
                                : classNameContent
                            : ""
                    }`}
                >
                    <Markdown
                        disallowedElements={
                            previewLines
                                ? ["h1", "h2", "h3", "h4", "h5", "h6", "hr"]
                                : []
                        }
                        unwrapDisallowed
                        remarkPlugins={[remarkGfm]}
                        components={{
                            a: ({ node, ...props }) => (
                                <a
                                    {...props}
                                    className=" wrap-anywhere underline "
                                />
                            ),
                            img: ({ node, ...props }) => (
                                <GigaMarkdownImage
                                    src={props.src}
                                    alt={props.alt}
                                    title={props.title}
                                    imagesByRef={gigaImagesByRef}
                                />
                            ),

                            // the first h1, h2, h3, or h4 should be rendered without top margin
                            /*  h1: ({ node, className, children, ...props }) => {
                                 return <h1
                                     className={`mt-0 mb-2 ${className}`}
                                     {...props}
                                 >
                                     {children}
                                 </h1>
                             }, */

                            code: ({ node, className, children, ...props }) => {
                                // break if previewLines is set
                                if (previewLines) {
                                    return (
                                        <code
                                            className={`break-all whitespace-pre-wrap ${className}`}
                                            {...props}
                                        >
                                            {children}
                                        </code>
                                    );
                                }
                                return (
                                    <code
                                        className={`whitespace-pre-wrap ${className}`}
                                        {...props}
                                    >
                                        {children}
                                    </code>
                                );
                            },
                        }}
                    >
                        {displayText}
                    </Markdown>
                </div>
            )}
        </div>
    );
};
