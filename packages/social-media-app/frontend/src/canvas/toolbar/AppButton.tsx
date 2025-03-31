import React from "react";
import { SimpleWebManifest } from "@giga-app/interface";
import { resolveTrigger } from "../../content/useApps";

interface AppButtonProps {
    app: SimpleWebManifest;
    onClick?: () => void;
    className?: string;
    showTitle?: boolean;
    orientation?: "horizontal" | "vertical";
    // any additional props if needed
}

// Helper to return appropriate icon class names based on file type.
const getIconClassName = (icon: string, baseClasses: string) =>
    `${baseClasses} ${icon.endsWith(".svg") ? "dark:invert" : ""}`;

export const AppButton: React.FC<AppButtonProps> = ({
    app,
    onClick,
    className,
    orientation = "vertical",
    showTitle = false,
}) => {
    const Trigger = resolveTrigger(app);

    if (Trigger) {
        return (
            // You can also wrap the Trigger if needed for consistency.
            <Trigger className={`btn ${className || ""}`} />
        );
    }

    return (
        <button
            onClick={onClick}
            className={`flex ${
                orientation === "vertical" ? "flex-col" : "flex-row"
            } items-center btn ${className || ""}`}
        >
            {/* Fixed container for the icon */}
            <div className="w-8 h-8">
                <img
                    src={app.icon}
                    alt={app.title}
                    className={`w-full h-full object-contain ${getIconClassName(
                        app.icon,
                        ""
                    )}`}
                />
            </div>
            {showTitle && (
                <span
                    className={`text-sm text-center ${
                        orientation === "vertical" ? "mt-2" : "ml-2"
                    }`}
                >
                    {app.title}
                </span>
            )}
        </button>
    );
};
