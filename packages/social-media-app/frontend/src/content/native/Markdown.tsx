import React, { useRef, useEffect, useState, useCallback } from "react";
import Markdown from "marked-react";
import { StaticMarkdownText } from "@dao-xyz/social";

export type MarkdownContentProps = {
    content: StaticMarkdownText;
    onResize: (dims: { width: number; height: number }) => void;
    editable?: boolean;
    onChange?: (newContent: StaticMarkdownText) => void;
    thumbnail?: boolean;
};

export const MarkdownContent = ({
    content,
    onResize,
    editable = false,
    onChange,
    thumbnail,
}: MarkdownContentProps) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const lastDims = useRef<{ width: number; height: number } | null>(null);
    const threshold = 1;

    // Local state for the markdown text.
    const [text, setText] = useState(content.text);
    // Start editing automatically if there's no text.
    const [isEditing, setIsEditing] = useState(content.text.length === 0);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Observe container's size changes.
    useEffect(() => {
        if (!containerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            for (let entry of entries) {
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
            const newHeight = textareaRef.current.scrollHeight;
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

    const padding = !thumbnail ? "" : "p-1";

    // When the user clicks the container (and we're editable), start editing.
    const handleStartEditing = () => {
        setIsEditing(true);
        // Focus the textarea after a short delay.
        setTimeout(() => {
            textareaRef.current?.focus();
        }, 0);
    };

    // Handle key presses in the textarea.
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
            // If there's no newline (i.e. single row), send/save the text.
            if (!text.includes("\n")) {
                e.preventDefault();
                onChange && onChange(new StaticMarkdownText({ text }));
                setIsEditing(false);
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

    // Use local text if editable, otherwise use content.text.
    const markdownContent = editable ? text : content.text;

    return (
        <div
            ref={containerRef}
            className={`${padding} w-full text-left ${
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
                    className="w-full border-none outline-none resize-none block dark:bg-black"
                    rows={1}
                    placeholder="Type here..."
                    style={{ overflow: "hidden" }}
                />
            ) : (
                <div>
                    <Markdown gfm>{markdownContent}</Markdown>
                </div>
            )}
        </div>
    );
};
