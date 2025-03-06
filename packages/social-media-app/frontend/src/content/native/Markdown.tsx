import React, { useRef, useEffect, useState } from "react";
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
    // If content.text is empty, start in editing mode.
    const [isEditing, setIsEditing] = useState(content.text.length === 0);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Observe container size and call onResize
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

    // Auto-resize the textarea to fit its content.
    const autoResize = () => {
        if (textareaRef.current) {
            textareaRef.current.style.height = "auto";
            textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
        }
    };

    useEffect(() => {
        if (isEditing && textareaRef.current) {
            textareaRef.current.focus();
            const length = textareaRef.current.value.length;
            textareaRef.current.setSelectionRange(length, length);
            autoResize();
        }
    }, [isEditing]);

    const padding = !thumbnail ? "px-4 py-2" : "p-1";

    // Handle key presses in the textarea.
    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === "Enter" && !e.shiftKey) {
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

    const handleStartEditing = () => {
        setIsEditing(true);
    };

    // Use content.text if not editable; otherwise use the locally maintained text.
    const markdownContent = editable ? text : content.text;

    return (
        <div
            ref={containerRef}
            className={`overflow-auto ${padding} w-full text-left ${
                editable ? "cursor-text" : ""
            }`}
            onClick={editable && !isEditing ? handleStartEditing : undefined}
        >
            {editable && isEditing && (
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
            )}
            <div style={{ display: editable && isEditing ? "none" : "block" }}>
                <Markdown
                    gfm
                    // Hide markdown output when editing.
                >
                    {markdownContent}
                </Markdown>
            </div>
        </div>
    );
};
