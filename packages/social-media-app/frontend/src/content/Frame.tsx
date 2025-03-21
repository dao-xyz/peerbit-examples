import React, { useState } from "react";
import { IFrameContent, Element, StaticContent } from "@dao-xyz/social";
import { useNavigate } from "react-router-dom";
import { EditableStaticContent } from "./native/NativeContent";
import { useApps } from "./useApps";
import { CuratedWebApp } from "@giga-app/app-service";
import { HostProvider as GigaHost } from "@giga-app/sdk";

export const Frame = (properties: {
    pending: boolean;
    element: Element;
    active: boolean;
    setActive: (value: boolean) => void;
    thumbnail?: boolean;
    replace: (url: string) => void;
    onLoad: (event: React.SyntheticEvent<HTMLElement, Event>) => void;
    /**
     * Called when static content is edited.
     * The new static content is provided along with the element index.
     */
    onContentChange?: (
        properties: { content: StaticContent["content"]; id: Uint8Array },
        options?: { save: boolean }
    ) => void;
    key?: number;
    delete(): void;
    fit?: "cover" | "contain";
    previewLines?: number;
    noPadding?: boolean;
    onClick?: () => void;
    // edit related stuff
    inFullscreen?: boolean;
    showEditControls: boolean;
    editControls?: React.ReactNode;
    editMode: boolean;
}) => {
    const navigate = useNavigate();
    const { getCuratedWebApp } = useApps();
    const [newUrl, setNewUrl] = useState("");
    const [inputStatus, setInputStatus] = useState<{
        isReady: boolean;
        info?: string;
    } | null>(null);

    const open = () => {
        const url = (properties.element.content as IFrameContent).src;
        if (new URL(url).host === window.location.host) {
            // Navigate internally by removing the hash symbol.
            navigate(new URL(url).hash.substring(2));
        } else {
            properties.setActive(true);
        }
    };

    // Renders an error card showing the app's icon, title, error message,
    // the current invalid URL, and (if in edit mode) an input field with a Save button.
    const renderErrorUI = (
        status: { info: string },
        curatedWebApp: CuratedWebApp,
        invalidUrl: string
    ) => {
        return (
            <div className="p-4 border rounded-md flex flex-col items-center justify-center">
                {curatedWebApp.manifest && (
                    <div className="flex items-center space-x-2 mb-2">
                        <img
                            src={curatedWebApp.manifest.icon}
                            alt={curatedWebApp.manifest.title}
                            className="w-8 h-8"
                        />
                        <span className="text-xl font-semibold">
                            {curatedWebApp.manifest.title}
                        </span>
                    </div>
                )}
                <p className="font-medium mb-2 text-center">
                    {properties.editMode
                        ? status.info
                        : "The provided URL is invalid."}
                </p>
                <p className="text-sm italic mb-2">Current URL: {invalidUrl}</p>
                {properties.editMode && (
                    <div className="flex flex-col w-full">
                        <div className="flex flex-row space-x-2">
                            <input
                                type="text"
                                className="w-full p-2 rounded"
                                placeholder="Enter a valid URL..."
                                value={newUrl}
                                onChange={(e) => {
                                    const updatedUrl = e.target.value;
                                    const newStatus = curatedWebApp.getStatus(
                                        updatedUrl,
                                        window.location.host
                                    );
                                    setNewUrl(updatedUrl);
                                    setInputStatus(newStatus);
                                }}
                            />
                            <button
                                className="btn btn-secondary"
                                onClick={() => properties.replace(newUrl)}
                            >
                                Save
                            </button>
                        </div>
                        {inputStatus && (
                            <p className="text-sm mt-1">
                                {inputStatus.isReady
                                    ? "URL is valid."
                                    : inputStatus.info}
                            </p>
                        )}
                    </div>
                )}
            </div>
        );
    };

    const renderContent = ({ previewLines }: { previewLines?: number }) => {
        // For iframes, continue to use the iframe as before.
        if (properties.element.content instanceof IFrameContent) {
            const src = (properties.element.content as IFrameContent).src;
            const curatedWebApp = getCuratedWebApp(src);
            if (curatedWebApp) {
                const status = curatedWebApp.getStatus(
                    src,
                    window.location.host
                );
                if (status.isReady === false) {
                    return renderErrorUI(status, curatedWebApp, src);
                }
            }
            return (
                <iframe
                    onLoad={(event) => {
                        console.log("IFRAME LOAD EVENT", event);
                        properties.onLoad(event);
                    }}
                    style={{
                        width: "100%",
                        height: "100%",
                        minHeight: "400px",
                        border: 0,
                    }}
                    src={src}
                    allow="camera; microphone; allowtransparency; display-capture; fullscreen; autoplay; clipboard-write;"
                ></iframe>
            );
        }
        // For static content (markdown or images), use EditableStaticContent.
        if (properties.element.content instanceof StaticContent) {
            const staticContent = properties.element.content.content;
            return (
                <EditableStaticContent
                    staticContent={staticContent}
                    editable={properties.editMode}
                    thumbnail={properties.thumbnail}
                    onResize={() => {}}
                    onChange={(newContent, options) => {
                        if (properties.onContentChange) {
                            properties.onContentChange(
                                {
                                    content: newContent,
                                    id: properties.element.id,
                                },
                                options
                            );
                        }
                    }}
                    fit={properties.fit}
                    previewLines={properties.previewLines}
                    noPadding={properties.noPadding}
                    inFullscreen={properties.inFullscreen}
                />
            );
        }
        return <span>Unsupported content</span>;
    };

    const showCanvasControls = properties.showEditControls;
    return (
        <div
            key={properties.key}
            className="flex flex-row w-full max-h-full h-full max-w-full overflow-hidden group"
        >
            <div className="w-full max-h-full overflow-hidden">
                {renderContent({ previewLines: properties.previewLines })}
            </div>

            {!properties.active && (
                <div
                    className={`ml-auto h-full flex ${
                        showCanvasControls
                            ? "pointer-events-auto"
                            : "pointer-events-none"
                    }`}
                >
                    <div className="flex flex-col h-full">
                        {showCanvasControls && properties.editControls}
                    </div>
                </div>
            )}
        </div>
    );
};
