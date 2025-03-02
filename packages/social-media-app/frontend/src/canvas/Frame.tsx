import React from "react";
import {
    IFrameContent,
    Element,
    StaticContent,
    StaticMarkdownText,
    StaticImage,
} from "@dao-xyz/social";
import {
    MdClear,
    MdOpenWith,
    MdAddReaction,
    MdOpenInBrowser,
    MdSave,
} from "react-icons/md";
import { AppSelect } from "./AppSelect";
import { useNavigate } from "react-router-dom";
import Markdown from "marked-react";
import { FrameHeader } from "./FrameHeader";
import { AutoSizedStaticContent } from "./AutoSizedStaticContent";

export const Frame = (properties: {
    pending: boolean;
    hideHeader?: boolean;
    element: Element;
    index: number;
    active: boolean;
    setActive: (value: boolean) => void;
    editMode: boolean;
    replace: (url: string) => void;
    onLoad: (event: React.SyntheticEvent<HTMLElement, Event>) => void;
    onStaticResize?: (
        dims: { width: number; height: number },
        index: number
    ) => void;
    delete(): void;
}) => {
    const navigate = useNavigate();

    const open = () => {
        const url = (properties.element.content as IFrameContent).src;
        if (new URL(url).host === window.location.host) {
            // navigate internally by removing the hash symbol
            navigate(new URL(url).hash.substring(2));
        } else {
            properties.setActive(true);
        }
    };

    const renderContent = () => {
        if (properties.element.content instanceof IFrameContent) {
            return (
                <iframe
                    onLoad={(event) => properties.onLoad(event)}
                    onBlur={() => {}}
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
        if (properties.element.content instanceof StaticContent) {
            const staticContent = properties.element.content.content;
            return (
                <AutoSizedStaticContent
                    staticContent={staticContent}
                    onResize={(dims) => {
                        console.log("Static content resized", dims);
                        if (properties.onStaticResize) {
                            properties.onStaticResize(dims, properties.index);
                        }
                        // Optionally, if you wish to trigger onLoad logic here:
                        properties.onLoad?.(
                            {} as React.SyntheticEvent<HTMLElement, Event>
                        );
                    }}
                />
            );
        }
        return <span>Unsupported content</span>;
    };

    const isApp = properties.element.content instanceof IFrameContent;
    const shouldShowControls = properties.editMode || properties.pending;
    return (
        <div className="">
            {!properties.hideHeader && (
                <FrameHeader publicKey={properties.element.publicKey} />
            )}

            <div
                onBlur={() => {
                    console.log("BLUR!");
                }}
                className={`outline-auto outline-neutral-900 dark:outline-neutral-300 flex flex-col w-full h-full max-w-full bg-neutral-100 dark:bg-neutral-900 group ${
                    properties.pending
                        ? "border-solid border-2 border-primary-400"
                        : ""
                }`}
            >
                {!properties.active && (
                    <div
                        className={`absolute w-full h-full flex pointer-events-none ${
                            shouldShowControls
                                ? "pointer-events-auto opacity-0 group-hover:opacity-100 backdrop-blur-sm group-hover:bg-primary-200/40 group-hover:dark:bg-primary-600/40"
                                : ""
                        }`}
                    >
                        <div className="flex flex-col w-full h-full">
                            {shouldShowControls && (
                                <div
                                    id={"header-" + properties.index}
                                    className={`w-full justify-end z-10 hidden group-hover:flex`}
                                >
                                    <div className="m-1 w-full">
                                        <AppSelect
                                            onSelected={(app) => {
                                                properties.replace(app.url);
                                            }}
                                        />
                                    </div>

                                    <button
                                        className="btn-icon btn-icon-sx"
                                        onClick={() => {
                                            properties.delete();
                                        }}
                                    >
                                        <MdClear className="h-4 w-4" />
                                    </button>

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
                                        <span className="mr-2 text-xl">
                                            Open
                                        </span>{" "}
                                        <MdOpenInBrowser size={30} />
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                <div id={"frame-" + properties.index} className="w-full h-full">
                    {renderContent()}
                </div>
            </div>
        </div>
    );
};
