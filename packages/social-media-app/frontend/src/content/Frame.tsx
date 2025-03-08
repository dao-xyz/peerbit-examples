import React from "react";
import { IFrameContent, Element, StaticContent } from "@dao-xyz/social";
import {
    MdClear,
    MdOpenWith,
    MdAddReaction,
    MdOpenInBrowser,
    MdSave,
} from "react-icons/md";
import { useNavigate } from "react-router-dom";
import { EditableStaticContent } from "./native/NativeContent";

export const Frame = (properties: {
    pending: boolean;
    element: Element;
    active: boolean;
    setActive: (value: boolean) => void;
    editMode: boolean;
    showCanvasControls: boolean;
    thumbnail?: boolean;
    replace: (url: string) => void;
    onLoad: (event: React.SyntheticEvent<HTMLElement, Event>) => void;
    /**
     * Called when static content is edited.
     * The new static content is provided along with the element index.
     */
    onContentChange?: (
        newContent: StaticContent["content"],
        id: Uint8Array
    ) => void;
    key?: number;
    delete(): void;
    coverParent?: boolean;
    fit?: "cover" | "contain";
}) => {
    const navigate = useNavigate();

    const open = () => {
        const url = (properties.element.content as IFrameContent).src;
        if (new URL(url).host === window.location.host) {
            // Navigate internally by removing the hash symbol.
            navigate(new URL(url).hash.substring(2));
        } else {
            properties.setActive(true);
        }
    };

    const renderContent = ({ coverParent }: { coverParent?: boolean }) => {
        // For iframes, continue to use the iframe as before.
        if (properties.element.content instanceof IFrameContent) {
            return (
                <iframe
                    onLoad={(event) => properties.onLoad(event)}
                    style={{
                        width: "100%",
                        height: "100%",
                        border: 0,
                    }}
                    src={(properties.element.content as IFrameContent).src}
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
                    onChange={(newContent) => {
                        if (properties.onContentChange) {
                            properties.onContentChange(
                                newContent,
                                properties.element.id
                            );
                        }
                    }}
                    coverParent={coverParent}
                    fit={properties.fit}
                />
            );
        }
        return <span>Unsupported content</span>;
    };

    const isApp = properties.element.content instanceof IFrameContent;
    const showCanvasControls = properties.showCanvasControls;
    return (
        <div
            key={properties.key}
            className={`flex flex-row  w-full h-full max-w-full ${
                !properties.thumbnail
                    ? "" /* TODO bg? "bg-neutral-100 dark:bg-neutral-900" */
                    : ""
            } group`} /* ${properties.pending ? "border-solid border-2 border-primary-400" : ""} outline-auto outline-neutral-900 dark:outline-neutral-300  */
        >
            <div className="w-full h-full flex flex-row overflow-hidden">
                {renderContent({ coverParent: properties.coverParent })}
            </div>

            {!properties.active && (
                <div
                    className={`ml-auto h-full flex pointer-events-none ${
                        showCanvasControls ? "pointer-events-auto " : ""
                    }`}
                >
                    {" "}
                    {/* // opacity-0 group-hover:opacity-100 backdrop-blur-sm group-hover:bg-primary-200/40 group-hover:dark:bg-primary-600/40 */}
                    <div className="flex flex-col  h-full">
                        {showCanvasControls && (
                            <div
                                className="w-full justify-end  flex flex-col " // hidden group-hover:flex
                            >
                                {/*  <div className="m-1 w-full">
                                <AppSelect
                                    onSelected={(app) => {
                                        properties.replace(app.url);
                                    }}
                                />
                            </div> */}

                                {/*  <button
                                className="btn-icon btn-icon-sx"
                                onClick={() => {
                                    properties.delete();
                                }}
                            >
                                <MdClear className="h-4 w-4" />
                            </button> */}

                                <button className="btn-icon btn-icon-sx drag-handle-element">
                                    <MdOpenWith className="h-4 w-4" />
                                </button>
                            </div>
                        )}
                        {isApp && (
                            <div className="flex flex-row h-full w-full">
                                {properties.pending ? (
                                    <button className="w-6/12 h-full flex justify-center items-center btn">
                                        <span className="mr-2 text-xl">
                                            Save
                                        </span>{" "}
                                        <MdSave size={30} />
                                    </button>
                                ) : (
                                    <button className="w-6/12 h-full flex justify-center items-center btn">
                                        <span className="mr-2 text-xl">
                                            Relate
                                        </span>{" "}
                                        <MdAddReaction size={30} />
                                    </button>
                                )}

                                <button
                                    className="w-6/12 h-full flex justify-center items-center btn"
                                    onClick={open}
                                >
                                    <span className="mr-2 text-xl">Open</span>{" "}
                                    <MdOpenInBrowser size={30} />
                                </button>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};
