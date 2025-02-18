import React from "react";
import { FaShare } from "react-icons/fa";
import * as Toast from "@radix-ui/react-toast";

export const Share = (props: { size?: number }) => {
    const [open, setOpen] = React.useState(false);

    const onShare = async () => {
        try {
            await navigator.clipboard.writeText(window.location.href);
            setOpen(true);
        } catch (error) {
            console.error("Failed to copy to clipboard:", error);
        }
    };

    return (
        <div className="relative inline-block">
            <Toast.Provider swipeDirection="down">
                {/* Toast Notification positioned above the share button */}
                <Toast.Root
                    open={open}
                    onOpenChange={setOpen}
                    className="bg-gray-800 text-white p-3 rounded shadow-lg"
                >
                    <Toast.Title>
                        <span className="text-nowrap">Link Copied!</span>
                    </Toast.Title>
                </Toast.Root>
                <Toast.Viewport className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2" />
            </Toast.Provider>

            {/* Share Button */}
            <div
                className="flex items-center btn-icon cursor-pointer"
                onClick={onShare}
            >
                <span className="pr-2">Share</span> {/* hidden sm:inline */}
                <FaShare size={props.size || 20} />
            </div>
        </div>
    );
};
