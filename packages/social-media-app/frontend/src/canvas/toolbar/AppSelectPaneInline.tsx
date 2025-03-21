import React, { useState, useMemo, useEffect } from "react";
import { AiOutlineSearch } from "react-icons/ai";
import { SimpleWebManifest } from "@giga-app/app-service";
import { resolveTrigger, useApps } from "../../content/useApps";
import { useCanvas } from "../CanvasWrapper";
import { DebugGeneratePostButton } from "./DebugGeneratePostButton";

interface AppSelectPaneInlineProps {
    onSelected: (app: SimpleWebManifest) => void;
    className?: string;
}

// Helper to return appropriate icon class names based on file type.
const getIconClassName = (icon: string, baseClasses: string) => {
    // If the icon is an SVG, add a dark mode invert filter so that black lines become white.
    return `${baseClasses} ${icon.endsWith(".svg") ? "dark:invert" : ""}`;
};

export const AppSelectPaneInline: React.FC<AppSelectPaneInlineProps> = ({
    onSelected: _onSelected,
    className,
}) => {
    const { apps, search: appSearch } = useApps();
    const [query, setQuery] = useState("");
    const { insertDefault } = useCanvas();
    const [filteredApps, setFilteredApps] = useState<SimpleWebManifest[]>([]);
    const inputRef = React.useRef<HTMLInputElement>(null);

    // Filter apps based on the search query.
    useEffect(() => {
        (async () => {
            const out = await appSearch(query);
            setFilteredApps(out);
        })();
    }, [apps, query]);

    // Sort so that native apps appear first.
    const nativeApps = useMemo(() => {
        return filteredApps.filter((x) => x.isNative);
    }, [filteredApps]);

    const nonNativeApps = useMemo(() => {
        return filteredApps.filter((x) => !x.isNative);
    }, [filteredApps]);

    const onSelected = (app: SimpleWebManifest) => {
        // Insert a new app post using the Canvas context.
        insertDefault({ app, increment: true });
        _onSelected(app);
        if (inputRef.current) {
            inputRef.current.value = "";
        }
    };

    return (
        <div className={`w-full flex flex-col ${className || ""}`}>
            {/* Search field */}
            <div className="mb-4 flex items-center border-b border-gray-300 pb-2">
                <AiOutlineSearch className="mr-2" />
                <input
                    ref={inputRef}
                    type="text"
                    placeholder="Search for apps"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-full bg-transparent outline-none placeholder-gray-500 dark:placeholder-gray-400"
                />
            </div>
            {/* Gallery view */}
            <div className="flex flex-col h-full">
                {nativeApps.length > 0 && (
                    <>
                        <span className="ganja-font">Native apps</span>
                        <div className="flex gap-2">
                            {import.meta.env.MODE === "development" && (
                                <DebugGeneratePostButton />
                            )}
                            {nativeApps.map((app, ix) => {
                                const Trigger = resolveTrigger(app);
                                if (Trigger) {
                                    return (
                                        <Trigger
                                            key={app.url}
                                            className="btn btn-md"
                                        />
                                    );
                                }
                                return (
                                    <button
                                        key={ix}
                                        onClick={() => onSelected(app)}
                                        className="flex flex-col items-center btn btn-md"
                                    >
                                        <img
                                            src={app.icon}
                                            alt={app.title}
                                            className={getIconClassName(
                                                app.icon,
                                                "w-8 h-8 mb-2"
                                            )}
                                        />
                                    </button>
                                );
                            })}
                        </div>
                    </>
                )}
                {nonNativeApps.length > 0 && (
                    <div className="mt-2">
                        <span className="ganja-font">Web apps</span>
                        <div className="flex flex-wrap gap-2">
                            {nonNativeApps.map((app, ix) => (
                                <button
                                    key={ix}
                                    onClick={() => onSelected(app)}
                                    className="flex flex-col items-center btn btn-md "
                                >
                                    <img
                                        src={app.icon}
                                        alt={app.title}
                                        className={getIconClassName(
                                            app.icon,
                                            "w-auto max-w-8 h-auto mb-2"
                                        )}
                                    />
                                    <span className="text-sm text-center">
                                        {app.title}
                                    </span>
                                </button>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
