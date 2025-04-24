import React, { useState, useMemo, useEffect } from "react";
import { AiOutlineSearch } from "react-icons/ai";
import { SimpleWebManifest } from "@giga-app/interface";
import { useCanvas } from "../CanvasWrapper";
import { DebugGeneratePostButton } from "./DebugGeneratePostButton";
import { useApps } from "../../content/useApps";
import { AppButton } from "./AppButton";
import { useToolbar } from "./ToolbarContext";

interface AppSelectPaneInlineProps {
    onSelected: (app: SimpleWebManifest) => void;
    className?: string;
}

export const AppSelectPaneInline: React.FC<AppSelectPaneInlineProps> = ({
    onSelected: _onSelected,
    className,
}) => {
    const { apps, search } = useApps();
    const [query, setQuery] = useState("");
    const { insertDefault } = useCanvas();
    const [filteredApps, setFilteredApps] = useState<SimpleWebManifest[]>([]);
    const inputRef = React.useRef<HTMLInputElement>(null);
    const { setFullscreenEditorActive } = useToolbar();

    // Filter apps based on the search query.
    useEffect(() => {
        (async () => {
            const out = await search(query);
            setFilteredApps(out);
        })();
    }, [apps, query, search]);

    const nativeApps = useMemo(
        () => filteredApps.filter((x) => x.isNative),
        [filteredApps]
    );
    const nonNativeApps = useMemo(
        () => filteredApps.filter((x) => !x.isNative),
        [filteredApps]
    );

    const onSelected = (
        app: SimpleWebManifest,
        insertDefaultValue: boolean
    ) => {
        setQuery("");
        insertDefaultValue && insertDefault({ app, increment: true });
        _onSelected(app);
        if (app.url !== "native:image") {
            // TODO only do for images?
            setFullscreenEditorActive(true);
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
                            {window.location.hostname !== "giga.place" && (
                                <DebugGeneratePostButton />
                            )}
                            {nativeApps.map((app) => (
                                <AppButton
                                    key={app.url}
                                    app={app}
                                    className="btn btn-md"
                                    onClick={(insertDefault) =>
                                        onSelected(app, insertDefault)
                                    }
                                />
                            ))}
                        </div>
                    </>
                )}
                {nonNativeApps.length > 0 && (
                    <div className="mt-2">
                        <span className="ganja-font">Web apps</span>
                        <div className="flex flex-wrap gap-2">
                            {nonNativeApps.map((app, ix) => (
                                <AppButton
                                    key={ix}
                                    app={app}
                                    onClick={(insertDefault) =>
                                        onSelected(app, insertDefault)
                                    }
                                    showTitle
                                    className="btn btn-md"
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

export default AppSelectPaneInline;
