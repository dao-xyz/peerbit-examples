import React, { useRef, useEffect, useState, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
    LOWEST_QUALITY,
    StaticContent,
    StaticMarkdownText,
} from "@giga-app/interface";
import { ChangeCallback } from "./types";
import { FaMagic } from "react-icons/fa";
import { sha256Sync } from "@peerbit/crypto";

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

const textHasOneOrMoreLines = (text: string) => {
    return text.split("\n").length > 1;
};

export const MarkdownContent = ({
    content,
    onResize,
    editable = false,
    onChange,
    thumbnail,
    previewLines,
    noPadding,
    inFullscreen,
}: MarkdownContentProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const lastDims = useRef<{ width: number; height: number } | null>(null);
    const threshold = 1;
    const saving = useRef(false);

    // Local state for the markdown text.
    const [text, setText] = useState(content.text);

    // Update text when content changes.
    useEffect(() => {
        setText(content.text);
    }, [content.text]);

    // Start editing automatically if there's no text.
    const [isEditing, setIsEditing] = useState(content.text.length === 0);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

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
            textareaRef.current?.focus();
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

    // Handle key presses in the textarea.
    const handleKeyDown = async (
        e: React.KeyboardEvent<HTMLTextAreaElement>
    ) => {
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

    const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
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
        ? "text-base leading-6"
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
                <div className="flex flex-row">
                    <textarea
                        ref={textareaRef}
                        value={text}
                        onChange={handleTextChange}
                        onBlur={handleBlur}
                        onKeyDown={handleKeyDown}
                        onInput={autoResize}
                        className={`${commonClasses} w-full border-none outline-none resize-none block rounded dark:bg-black`}
                        rows={1}
                        placeholder="Type here..."
                        style={{ overflow: "hidden" }}
                    />
                    {/* 
                    <button disabled className="btn btn-icon ">
                        <FaMagic />
                    </button> */}
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
