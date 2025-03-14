import React from "react";
import * as Popover from "@radix-ui/react-popover";

// Helper function to convert a Date to a relative time string.
function getRelativeTime(date: Date): string {
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const seconds = diff / 1000;
    const minutes = seconds / 60;
    const hours = minutes / 60;
    const days = hours / 24;

    if (seconds < 60) {
        return "just now";
    } else if (minutes < 60) {
        const m = Math.floor(minutes);
        return `${m} minute${m !== 1 ? "s" : ""} ago`;
    } else if (hours < 24) {
        const h = Math.floor(hours);
        return `${h} hour${h !== 1 ? "s" : ""} ago`;
    } else if (days < 2) {
        return "Yesterday";
    } else if (days < 7) {
        const d = Math.floor(days);
        return `${d} days ago`;
    } else {
        return date.toLocaleDateString();
    }
}

interface RelativeTimestampProps {
    timestamp: Date | number;
    className?: string;
}

const RelativeTimestamp: React.FC<RelativeTimestampProps> = ({
    timestamp,
    className = "",
}) => {
    const date =
        typeof timestamp === "number" ? new Date(timestamp) : timestamp;
    const relativeText = getRelativeTime(date);
    const exactText = date.toLocaleString();

    return (
        <Popover.Root>
            <Popover.Trigger asChild>
                <button
                    className={`cursor-pointer hover:underline focus:outline-none ${className}`}
                >
                    {relativeText}
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content className="bg-white dark:bg-black p-2 rounded shadow-md border border-gray-200">
                    <span className="text-sm text-gray-800">{exactText}</span>
                    <Popover.Arrow className="fill-curren" />
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    );
};

export default RelativeTimestamp;
