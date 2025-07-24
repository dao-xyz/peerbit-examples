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
import { PrivateCanvasScope } from "../useCanvas";
import { usePendingCanvas } from "./PendingCanvasContext";

export const TEMPATE_ICON_MAP: Record<string, JSX.Element> = {
    "Photo album": <BiPhotoAlbum />,
    "Personal profile": <CgProfile />,
    "Community": <HiOutlineUserGroup />
};

const TemplateButton: React.FC<{
    tpl: Template;
    onClick: () => void;
}> = ({ tpl, onClick }) => {

    let icon = TEMPATE_ICON_MAP[tpl.name]
    return <button
        className="btn btn-md  hover:bg-gray-100 dark:hover:bg-gray-700"
        onClick={onClick}
        title={tpl.description}
    >
        {icon && (
            <span className="mr-2">{icon}</span>
        )}
        {tpl.name}
    </button>
}



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
    const { insertDefault } = useCanvas();   // ← make sure `useCanvas` exposes the active canvas
    const { viewRoot: privateViewRoot } = PrivateCanvasScope.useCanvases()
    const { saveDraft } = usePendingCanvas()

    /* ---------- local state ---------------------------- */
    const [query, setQuery] = useState("");
    const [appsFiltered, setAppsFiltered] = useState<SimpleWebManifest[]>([]);
    const [templatesFiltered, setTemplatesFiltered] = useState<Template[]>([]);

    /* search debounced ---------------------------------- */
    useEffect(() => {
        (async () => {
            setAppsFiltered(await searchApps(query));
            console.log("Search query", query)
            setTemplatesFiltered(await searchTpls(query));
        })();
    }, [query, searchApps, searchTpls, templates]);



    /* split native / web apps --------------------------- */
    const nativeApps = useMemo(() => appsFiltered.filter((x) => x.isNative), [appsFiltered]);
    const nonNativeApps = useMemo(() => appsFiltered.filter((x) => !x.isNative), [appsFiltered]);

    /* handlers ------------------------------------------ */
    const onAppSelected = (app: SimpleWebManifest, insertDefaultValue: boolean) => {
        setQuery("");
        insertDefaultValue && insertDefault({ app, increment: true });
        _onSelected(app);
    };

    const onTemplateSelected = async (tpl: Template) => {
        if (!privateViewRoot) return;
        await insertTpl(tpl, privateViewRoot);
        await saveDraft();
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
                    ref={React.useRef<HTMLInputElement>(null)}
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
                                    onClick={(insertDefault) =>
                                        onAppSelected(app, insertDefault)
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
                                    onClick={(insertDefault) =>
                                        onAppSelected(app, insertDefault)
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