import React, { useState, useRef } from "react";

// A default tag renderer if no custom renderTag prop is provided.
const DefaultTag = ({ tag, onRemove }) => (
    <div className="flex items-center bg-gray-200 rounded px-2 py-1 text-sm">
        <span>{tag}</span>
        <button
            type="button"
            className="ml-1 text-lg hover:text-red-600"
            onClick={onRemove}
        >
            &times;
        </button>
    </div>
);

/**
 * TagInput Component
 *
 * Props:
 * - tags: array of any type – each tag can be any object/value.
 * - onTagsChange: function(newTags) – called whenever tags change.
 * - renderTag (optional): function({ tag, onRemove }) => JSX element, custom renderer for each tag.
 *
 * Behavior:
 * - Pressing Enter with nonempty input adds a tag.
 * - Pressing Backspace when input is empty removes the last tag.
 */
const TagInput = ({ tags, onTagsChange, renderTag }) => {
    const [inputValue, setInputValue] = useState("");
    const inputRef = useRef(null);

    const handleKeyDown = (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            const trimmed = inputValue.trim();
            if (trimmed) {
                // Add a new tag (here you can also create an object if needed)
                onTagsChange([...tags, trimmed]);
                setInputValue("");
            }
        } else if (e.key === "Backspace" && inputValue === "") {
            // Remove the last tag if the input is empty and Backspace is pressed
            onTagsChange(tags.slice(0, -1));
        }
    };

    const removeTag = (indexToRemove) => {
        onTagsChange(tags.filter((_, i) => i !== indexToRemove));
    };

    const renderTagContent = (tag, index) => {
        return renderTag ? (
            renderTag({ tag, onRemove: () => removeTag(index) })
        ) : (
            <DefaultTag tag={tag} onRemove={() => removeTag(index)} />
        );
    };

    return (
        <div
            className="flex items-center gap-1 px-2 py-1 border border-gray-300 rounded h-full cursor-text"
            onClick={() => inputRef.current.focus()}
        >
            <div className="h-full flex items-center max-w-[50%] overflow-x-scroll overflow-y-hidden no-scrollbar">
                {tags.map((tag, index) => (
                    <React.Fragment key={index}>
                        {index > 0 ? (
                            <span className="text-gray-400 ml-1 mr-1">/</span>
                        ) : null}
                        <>{renderTagContent(tag, index)}</>
                    </React.Fragment>
                ))}
            </div>

            <input
                ref={inputRef}
                type="text"
                className="flex-1 min-w-[100px] outline-none p-1 text-sm"
                placeholder="Go somewhere..."
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyDown={handleKeyDown}
            />
        </div>
    );
};

export default TagInput;
