import React, { useRef, useEffect, useState, useCallback } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StaticMarkdownText } from "@dao-xyz/social";
import { ChangeCallback } from "./types";

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

/**
 * Component for rendering markdown content with various display options.
 *
 * @param props - Component props
 * @param props.content - The markdown content to display
 * @param props.onResize - Callback when the content resizes, provides dimensions {width, height}
 * @param props.editable - Whether the content can be edited by the user (default: false)
 * @param props.onChange - Callback when content is changed during editing
 * @param props.thumbnail - Whether the content is displayed as a thumbnail
 * @param props.previewLines - Number of lines to show in preview mode, content will be truncated
 * @param props.noPadding - Whether to remove padding from the container
 *
 * @returns Rendered markdown content
 */
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

    // this statement is used to update the text when the content changes
    // without this, the text will not update when the content changes, for example if we are emitting a change with the "save" flag
    // which will make content.text to be set to ''
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

    // Auto-resize the textarea and emit its scrollHeight as the new height.
    const autoResize = useCallback(() => {
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
            const padding = 0;
            const newHeight = textareaRef.current.scrollHeight + padding;
            if (textHasOneOrMoreLines(textareaRef.current.value) === false) {
                textareaRef.current.style.lineHeight = "40px";
            } else {
                textareaRef.current.style.lineHeight = "unset";
            }
            textareaRef.current.style.height = `${newHeight}px`;
            const newWidth = containerRef.current
                ? containerRef.current.clientWidth
                : 0;
            onResize({ width: newWidth, height: newHeight });
        }
    }, [onResize]);

    // Whenever text changes in editing mode, trigger autoResize.
    useEffect(() => {
        if (isEditing) {
            autoResize();
        }
    }, [text, isEditing, autoResize]);

    // When the user clicks the container (and we're editable), start editing.
    const handleStartEditing = () => {
        setIsEditing(true);
        // Focus the textarea after a short delay.
        setTimeout(() => {
            textareaRef.current?.focus();
        }, 0);
    };

    useEffect(handleStartEditing, [textareaRef.current]);

    // Handle key presses in the textarea.
    const handleKeyDown = async (
        e: React.KeyboardEvent<HTMLTextAreaElement>
    ) => {
        if (!inFullscreen) {
            if (e.key === "Enter" && !e.shiftKey) {
                const currentValue = e.currentTarget.value;
                if (!currentValue.includes("\n")) {
                    e.preventDefault();
                    // Send the current text
                    try {
                        saving.current = true;
                        await onChange?.(
                            new StaticMarkdownText({ text: currentValue }),
                            { save: true }
                        );
                    } catch (error) {
                        console.error("Failed to save", error);
                    } finally {
                        saving.current = false;
                    }

                    setText("");
                    autoResize();

                    // focus the container
                    containerRef.current?.focus();
                }
            }
        }
    };

    const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newText = e.target.value;
        setText(newText);
        autoResize();
        onChange && onChange(new StaticMarkdownText({ text: newText }));
    };

    const handleBlur = () => {
        if (text.length > 0) setIsEditing(false);
    };

    return (
        <div
            ref={containerRef}
            className={`${noPadding ? "" : "px-2.5"} w-full text-left ${
                editable ? "cursor-text" : ""
            }`}
            onClick={editable && !isEditing ? handleStartEditing : undefined}
        >
            {editable && isEditing ? (
                <textarea
                    ref={textareaRef}
                    value={text}
                    onChange={handleTextChange}
                    onBlur={handleBlur}
                    onKeyDown={handleKeyDown}
                    onInput={autoResize}
                    className="w-full border-none outline-none resize-none block dark:bg-black px-2"
                    rows={1}
                    placeholder="Type here..."
                    style={{ overflow: "hidden" }}
                />
            ) : (
                <div
                    style={{ ["--preview-lines" as any]: previewLines }}
                    className={`${
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
