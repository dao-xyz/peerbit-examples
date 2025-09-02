import React, { useState, useMemo, useEffect, JSX } from "react";
import { AiOutlineSearch } from "react-icons/ai";
import { SimpleWebManifest, Template } from "@giga-app/interface";
import { useCanvas } from "../CanvasWrapper";
import { DebugGeneratePostButton } from "./DebugGeneratePostButton";
import { useApps } from "../../content/useApps";
import { AppButton } from "./AppButton";
import { useTemplates } from "../template/useTemplates";
import { BiPhotoAlbum } from "react-icons/bi";
import { CgProfile } from "react-icons/cg";
import { HiOutlineUserGroup } from "react-icons/hi2";
import { GrArticle } from "react-icons/gr";
import { PrivateScope } from "../useScope";
import { useCanvases } from "../useCanvas";
import { useDraftSession } from "./draft/DraftSession";

export const TEMPATE_ICON_MAP: Record<string, JSX.Element> = {
    "Photo album": <BiPhotoAlbum />,
    "Personal profile": <CgProfile />,
    Community: <HiOutlineUserGroup />,
    Article: <GrArticle />,
};

const TemplateButton: React.FC<{ tpl: Template; onClick: () => void }> = ({
    tpl,
    onClick,
}) => {
    const icon = TEMPATE_ICON_MAP[tpl.name];
    return (
        <button
            className="btn btn-sm"
            onClick={onClick}
            title={tpl.description}
        >
            {icon && <span className="mr-2">{icon}</span>}
            {tpl.name}
        </button>
    );
};

interface Props {
    onSelected: (app: SimpleWebManifest) => void;
    className?: string;
}

export const AppSelectPaneInline: React.FC<Props> = ({
    onSelected: _onSelected,
    className,
}) => {
    /* ---------- data sources --------------------------- */
    const { apps, search: searchApps } = useApps();
    const { templates, search: searchTpls, insert: insertTpl } = useTemplates();
    const { insertDefault } = useCanvas(); // active draft canvas via CanvasWrapper
    const privateScope = PrivateScope.useScope();
    const { leaf } = useCanvases();

    // Draft manager (use the current leaf as the sharing key)
    const { publish, saveDebounced } = useDraftSession();
    const canvasId = leaf?.idString;

    /* ---------- local state ---------------------------- */
    const [query, setQuery] = useState("");
    const [appsFiltered, setAppsFiltered] = useState<SimpleWebManifest[]>([]);
    const [templatesFiltered, setTemplatesFiltered] = useState<Template[]>([]);

    /* search debounced ---------------------------------- */
    useEffect(() => {
        (async () => {
            setAppsFiltered(await searchApps(query));
            setTemplatesFiltered(await searchTpls(query));
        })();
    }, [query, searchApps, searchTpls, templates]);

    /* split native / web apps --------------------------- */
    const nativeApps = useMemo(
        () => appsFiltered.filter((x) => x.isNative),
        [appsFiltered]
    );
    const nonNativeApps = useMemo(
        () => appsFiltered.filter((x) => !x.isNative),
        [appsFiltered]
    );

    /* handlers ------------------------------------------ */
    const onAppSelected = async (
        app: SimpleWebManifest,
        insertDefaultValue: boolean
    ) => {
        setQuery("");
        if (insertDefaultValue) {
            // Prefer inserting into the private scope if present
            insertDefault({ app, increment: true, scope: privateScope });
        }
        // Debounced save for the shared draft of this view, if available
        saveDebounced();
        _onSelected(app);
    };

    const onTemplateSelected = async (tpl: Template) => {
        if (!privateScope) return;
        await insertTpl(tpl, leaf); // insert relative to current leaf
        await saveDebounced();
        setQuery("");
    };

    /* render -------------------------------------------- */
    return (
        <div className={`w-full flex flex-col ${className ?? ""}`}>
            {/* Search field */}
            <div className="mb-4 flex items-center border-b border-gray-300 pb-2">
                <AiOutlineSearch className="mr-2" />
                <input
                    type="text"
                    placeholder="Search templates or apps"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="w-full bg-transparent outline-none placeholder-gray-500 dark:placeholder-gray-400"
                />
            </div>

            {/* Gallery view */}
            <div className="flex flex-col h-full gap-4 overflow-y-auto">
                {/* ============ TEMPLATES ============ */}
                {templatesFiltered.length > 0 && (
                    <>
                        <span className="font-ganja">Templates</span>
                        <div className="flex flex-wrap gap-2">
                            {templatesFiltered.map((tpl) => (
                                <TemplateButton
                                    key={tpl.id.toString()}
                                    tpl={tpl}
                                    onClick={() => onTemplateSelected(tpl)}
                                />
                            ))}
                        </div>
                    </>
                )}

                {/* ============ NATIVE APPS =========== */}
                {nativeApps.length > 0 && (
                    <>
                        <span className="font-ganja">Native apps</span>
                        <div className="flex gap-2">
                            {window.location.hostname !== "giga.place" && (
                                <DebugGeneratePostButton />
                            )}
                            {nativeApps.map((app) => (
                                <AppButton
                                    key={app.url}
                                    app={app}
                                    className="btn btn-md"
                                    onClick={(insertDefaultValue) =>
                                        onAppSelected(app, insertDefaultValue)
                                    }
                                />
                            ))}
                        </div>
                    </>
                )}

                {/* ============ WEB APPS ============= */}
                {nonNativeApps.length > 0 && (
                    <>
                        <span className="font-ganja">Web apps</span>
                        <div className="flex flex-wrap gap-2">
                            {nonNativeApps.map((app, ix) => (
                                <AppButton
                                    key={ix}
                                    app={app}
                                    showTitle
                                    className="btn btn-md"
                                    onClick={(insertDefaultValue) =>
                                        onAppSelected(app, insertDefaultValue)
                                    }
                                />
                            ))}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
