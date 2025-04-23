import React, { useRef, useEffect, useState, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    LOWEST_QUALITY,
    StaticContent,
    StaticMarkdownText,
} from "@giga-app/interface";
import { ChangeCallback } from "./types";
import { sha256Sync } from "@peerbit/crypto";
import { useCanvas } from "../../canvas/CanvasWrapper";
import { useAIReply } from "../../ai/AIReployContext";
import { usePeer } from "@peerbit/react";
import { FaCheck } from "react-icons/fa";
import { Spinner } from "../../utils/Spinner";

export type MarkdownContentProps = {
    content: StaticMarkdownText;
    onResize: (dims: { width: number; height: number }) => void;
    editable?: boolean;
    onChange?: ChangeCallback;
    thumbnail?: boolean;
    previewLines?: number;
    noPadding?: boolean;
    inFullscreen?: boolean;
};

export const MarkdownContent = ({
    content,
    onResize,
    editable = false,
    onChange,
    previewLines,
    noPadding,
    inFullscreen,
}: MarkdownContentProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const lastDims = useRef<{ width: number; height: number } | null>(null);
    const threshold = 1;
    const saving = useRef(false);

    // Start editing automatically if there's no text.
    const [isEditing, setIsEditing] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Local state for the markdown text.
    const [text, setText] = useState(content.text);

    const { canvas } = useCanvas();
    const { suggest, isReady } = useAIReply();
    const { peer } = usePeer();
    const [loadingSuggestedReply, setLoadingSuggestedReply] = useState(false);
    const [suggestReply, setSuggestedReply] = useState<string | null>(null);

    const suggestedReplyForParent = useRef<string | null>(null);

    useEffect(() => {
        if (
            !isReady ||
            !isEditing ||
            !canvas ||
            !canvas.path ||
            text.length > 0
        ) {
            return;
        }
        let parent = canvas.path[canvas.path.length - 1];

        let suggestTimeout: ReturnType<typeof setTimeout> | null = null;
        if (parent) {
            if (suggestedReplyForParent.current !== parent.address) {
                suggestedReplyForParent.current = parent.address;
                let suggestStartRef = parent.address;
                suggestTimeout = setTimeout(async () => {
                    setLoadingSuggestedReply(true);
                    setSuggestedReply(null);
                    try {
                        const loadedParent = await parent.load(peer);
                        if (loadedParent.publicKey.equals(canvas.publicKey)) {
                            return; // no self reply
                        }
                        console.log("SUGGEST!");
                        /*   suggest(loadedParent, 2e4).then((reply) => {
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
        canvas?.path,
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
        }
    }, [onResize]);

    // Auto-resize on text change.
    useEffect(() => {
        if (isEditing) {
            autoResize();
        }
    }, [text, isEditing, autoResize]);

    // When the user clicks the container (and we're editable), start editing.
    const handleStartEditing = () => {
        setIsEditing(true);
        setTimeout(() => {
            textareaRef.current?.focus({ preventScroll: true });
            // set the cursor to the end of the text
            textareaRef.current?.setSelectionRange(text.length, text.length);
        }, 0);
    };

    useEffect(() => {
        if (editable && containerRef.current) {
            if (content.text.length === 0) {
                handleStartEditing();
            }
        }
    }, [editable, content.text]);

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
        onChange &&
            onChange(
                new StaticContent({
                    content: new StaticMarkdownText({ text: newText }),
                    quality: LOWEST_QUALITY,
                    contentId: sha256Sync(new TextEncoder().encode(newText)),
                })
            );
    };

    const handleBlur = () => {
        if (text.length > 0) setIsEditing(false);
    };

    // Common Tailwind classes for consistent padding, font size, and line-height.
    // If noPadding is true, we remove the padding.
    const commonClasses = noPadding
        ? "text-base leading-6 "
        : "p-1 pt-0.5 text-base leading-6";

    return (
        <div
            ref={containerRef}
            className={`${commonClasses} w-full text-left ${
                editable ? "cursor-text" : ""
            }`}
            onClick={editable && !isEditing ? handleStartEditing : undefined}
        >
            {editable && isEditing ? (
                <div className="flex flex-row items-start">
                    <textarea
                        ref={textareaRef}
                        value={text}
                        onChange={handleTextChange}
                        onBlur={handleBlur}
                        onKeyDown={handleKeyDown}
                        onInput={autoResize}
                        className={`${commonClasses} w-full border-none outline-none resize-none block rounded dark:bg-neutral-800 ${
                            !inFullscreen ? "textarea-truncate" : ""
                        }`}
                        rows={1}
                        placeholder={suggestReply || "Type here..."}
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
                    className={`${commonClasses} ${
                        previewLines ? "line-clamp-[var(--preview-lines)]" : ""
                    } ${previewLines === 1 ? "break-all" : ""}`}
                >
                    <Markdown
                        disallowedElements={
                            previewLines
                                ? ["h1", "h2", "h3", "h4", "h5", "h6", "hr"]
                                : []
                        }
                        unwrapDisallowed
                        remarkPlugins={[remarkGfm]}
                    >
                        {text}
                    </Markdown>
                </div>
            )}
        </div>
    );
};
