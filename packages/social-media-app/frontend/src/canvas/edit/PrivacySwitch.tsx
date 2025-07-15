import * as Switch from "@radix-ui/react-switch";
import { useState } from "react";
import { MdLock, MdPublic } from "react-icons/md";

/* ── Privacy toggle component ──────────────────────────────── */
export const PrivacySwitch = (properties: { className?: string }) => {
    const [isPrivate, setIsPrivate] = useState<boolean>(true); // ← default to private

    return (
        <label
            htmlFor="privacy-switch"
            className={
                "flex items-center gap-1 select-none cursor-pointer " +
                properties.className
            }
        >
            {/* Icon + text */}
            {isPrivate ? (
                <>
                    <MdLock className="text-green-500 w-5 h-5" />
                    <span className="text-sm font-medium text-green-600">
                        Private
                    </span>
                </>
            ) : (
                <>
                    <MdPublic className="text-primary-400 dark:text-primary-500 w-5 h-5" />
                    <span className="text-sm font-medium text-primary-400 dark:text-primary-500">
                        Public
                    </span>
                </>
            )}

            {/* Radix Switch */}
            <Switch.Root
                id="privacy-switch"
                checked={isPrivate}
                onCheckedChange={setIsPrivate}
                className={`
        ml-1 relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent
          outline-none transition-colors duration-200
          ${isPrivate ? "bg-green-500" : "bg-primary-400 dark:bg-primary-500"}
        `}
            >
                <Switch.Thumb
                    className={`
            pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg
            transition-transform duration-200
            ${isPrivate ? "translate-x-5" : "translate-x-0"}
          `}
                />
            </Switch.Root>
        </label>
    );
};
