import React, { SyntheticEvent, useCallback, useEffect, useState } from "react";
import {
    IFrameContent,
    Element,
    StaticContent,
    ElementContent,
} from "@giga-app/interface";
import { useNavigate } from "react-router";
import { EditableStaticContent } from "./native/NativeContent";
import { useApps } from "./useApps";
import { CuratedWebApp } from "@giga-app/app-service";
import { HostProvider as GigaHost, HostProvider, useHost } from "@giga-app/sdk";
import { useCanvas } from "../canvas/CanvasWrapper";
import { useThemeContext } from "../theme/useTheme";

const ThemedIframe = (properties: {
    src: string;
    onLoad: (evt: SyntheticEvent<HTMLIFrameElement, Event>) => void;
    iframeRef: React.RefObject<HTMLIFrameElement>;
}) => {
    const { send, ready } = useHost();
    const { theme } = useThemeContext();

    useEffect(() => {
        if (!ready) {
            return;
        }
        send?.({ type: "theme", theme });
    }, [theme, send, ready]);

    return (
        <iframe
            ref={properties.iframeRef}
            onLoad={(evt) => {
                properties.onLoad(evt);
            }}
            style={{
                width: "100%",
                height: "100%",
                minHeight: "400px",
                border: 0,
            }}
            src={properties.src}
            allow="camera; microphone;  display-capture; fullscreen; autoplay; clipboard-write;"
        ></iframe>
    );
};

/**
 * Frame component for displaying different types of content with controls.
 *
 * @param props - Component props
 * @param props.pending - Whether the frame is in a pending state
 * @param props.element - The element to display
 * @param props.active - Whether the frame is in active state
 * @param props.setActive - Function to set the active state
 * @param props.editMode - Whether the content is in edit mode
 * @param props.showCanvasControls - Whether to show canvas controls
 * @param props.thumbnail - Whether to display as a thumbnail
 * @param props.replace - Function to replace content with a new URL
 * @param props.onLoad - Callback when the content loads
 * @param props.onContentChange - Callback when the content changes
 * @param props.key - React key for the component
 * @param props.delete - Function to delete the frame
 * @param props.fit - How this frame should fit in its container
 * @param props.previewLines - Number of lines (text) to show in preview mode
 * @param props.noPadding - Whether to remove padding from contained apps
 * @param props.onClick - Callback when the frame is clicked
 *
 * @returns Frame component with appropriate content and controls
 */
export const Frame = (properties: {
    element: Element;
    active: boolean;
    setActive: (value: boolean) => void;
    thumbnail?: boolean;
    onLoad?: (event?: React.SyntheticEvent<HTMLElement, Event>) => void;

    key?: number;
    delete(): void;
    fit?: "cover" | "contain";
    previewLines?: number;
    noPadding?: boolean;
    onClick?: (e: Element<ElementContent>) => void;
    // edit related stuff
    inFullscreen?: boolean;
    canOpenFullscreen?: boolean;
    showEditControls: boolean;
    editControls?: React.ReactNode;
    editMode: boolean;
    className?: string;
}) => {
    const navigate = useNavigate();
    const { getCuratedWebApp } = useApps();
    const [newUrl, setNewUrl] = useState("");
    const [inputStatus, setInputStatus] = useState<{
        isReady: boolean;
        info?: string;
    } | null>(null);

    const {
        mutate,
        savePending,
        onContentChange: onContentChangeContextTrigger,
    } = useCanvas();

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
                                onClick={async () => {
                                    await mutate(
                                        (element) => {
                                            (
                                                element.content as IFrameContent
                                            ).src = newUrl;
                                            return true;
                                        },
                                        {
                                            filter(rect) {
                                                return (
                                                    rect.idString ===
                                                    properties.element.idString
                                                );
                                            },
                                        }
                                    );
                                }}
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

    const onResize = useCallback(() => {}, []);

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
                <HostProvider
                    iframeOriginalSource={properties.element.content.orgSrc}
                    onNavigate={async (evt) => {
                        await mutate(
                            (element) => {
                                const currentUrl = (
                                    element.content as IFrameContent
                                ).src;
                                if (currentUrl === evt.to) {
                                    return false;
                                }
                                (element.content as IFrameContent).src = evt.to;
                                return true;
                            },
                            {
                                filter(rect) {
                                    return (
                                        rect.idString ===
                                        properties.element.idString
                                    );
                                },
                            }
                        );
                    }}
                >
                    {(iframeRef) => (
                        <ThemedIframe
                            iframeRef={iframeRef}
                            onLoad={properties.onLoad}
                            src={src}
                        ></ThemedIframe>
                    )}
                </HostProvider>
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
                    canOpenFullscreen={properties.canOpenFullscreen}
                    onResize={onResize}
                    onChange={async (newContent, options) => {
                        if (Array.isArray(newContent)) {
                            throw new Error(
                                "Array of content is not supported"
                            );
                        }

                        await mutate(
                            (element) => {
                                element.content = newContent;
                                onContentChangeContextTrigger(element);
                                return true;
                            },
                            {
                                filter(rect) {
                                    return (
                                        rect.idString ===
                                        properties.element.idString
                                    );
                                },
                            }
                        );
                        if (options?.save /* && properties.draft */) {
                            await savePending();
                        }
                    }}
                    fit={properties.fit}
                    previewLines={properties.previewLines}
                    noPadding={properties.noPadding}
                    inFullscreen={properties.inFullscreen}
                    onLoad={properties.onLoad}
                />
            );
        }
        return <span>Unsupported content</span>;
    };

    const showCanvasControls = properties.showEditControls;
    return (
        <div
            key={properties.key}
            className={`flex flex-row w-full h-full max-w-full group ${
                properties.className || ""
            }`}
        >
            {renderContent({ previewLines: properties.previewLines })}

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
