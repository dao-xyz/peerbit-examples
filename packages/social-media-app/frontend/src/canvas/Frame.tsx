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

export const Frame = (properties: {
    pending: boolean;
    hideHeader?: boolean;
    element: Element;
    index: number;
    active: boolean;
    setActive: (value: boolean) => void;
    editMode: boolean;
    replace: (url: string) => void;
    onLoad: (event: React.SyntheticEvent<HTMLIFrameElement, Event>) => void;
    delete(): void;
}) => {
    const navigate = useNavigate();

    const open = () => {
        const url = (properties.element.content as IFrameContent).src;
        if (new URL(url).host === window.location.host) {
            // navigate!
            navigate(new URL(url).hash.substring(2)); // #/path, remove hash symbol
        } else {
            properties.setActive(true);
        }
    };

    const renderContent = () => {
        if (properties.element.content instanceof IFrameContent) {
            return (
                <iframe
                    onLoad={(event) =>
                        /*   onIframe(event, x, ix) */
                        properties.onLoad(event)
                    }
                    onBlur={() => {}}
                    style={{
                        width: "100%",
                        height: "100%",
                        border: 0,
                    }}
                    src={properties.element.content.src}
                    allow="camera; microphone; allowtransparency; display-capture; fullscreen; autoplay; clipboard-write;"
                ></iframe>
            );
        }

        /*  if (properties.element.content instanceof SubCanvas) {
             return <CanvasPreview
                 canvas={properties.element.content}
             ></CanvasPreview >
         } */

        if (properties.element.content instanceof StaticContent) {
            const staticContent = properties.element.content.content;
            if (staticContent instanceof StaticMarkdownText) {
                /*   const html = marked(staticContent.text, { async: false });
                  return <div className="markdown" dangerouslySetInnerHTML={{ __html: html }} />; */

                return (
                    <div className="p-2 h-full overflow-auto">
                        <Markdown gfm>{staticContent.text}</Markdown>
                    </div>
                );
            }
            if (staticContent instanceof StaticImage) {
                return `<img src="data:${staticContent.mimeType};base64,${staticContent.base64}" alt="${staticContent.alt}" width="${staticContent.width}" height="${staticContent.height}" />`;
            }
            return <span>Unsupported static content</span>;
        }

        return <span>Unsupported content</span>;
    };
    const isApp = properties.element.content instanceof IFrameContent;
    const shouldShowControls = properties.editMode || properties.pending;
    return (
        <div className="">
            {!properties.hideHeader && (
                <FrameHeader element={properties.element} />
            )}

            <div
                onBlur={() => {
                    console.log("BLUR!");
                    //setFocused(false)
                }}
                // border-4 border-solid border-primary-300
                className={
                    `outline-auto outline-neutral-900 dark:outline-neutral-300 flex flex-col w-full h-full max-w-full bg-neutral-100 dark:bg-neutral-900 group ${
                        properties.pending
                            ? "border-solid border-2 border-primary-400"
                            : ""
                    }` /*  +
(!properties.editMode
    ? "react-resizable-hide "
    : "") + (pendingRef.current.find(p => equals(p.id, x.id)) ? "pending" : "") */
                }
            >
                {/* {properties.editMode || properties.pending ? (
        <div
            id={"header-" + properties.index}
            className={` w-full justify-end z-10 hidden group-hover:flex`}
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
                     myCanvas.current.then(
                    (canvas) => {
                        canvas.elements.del(
                            x.id
                        );
                    }
                ); 
                }}
            >
                <MdClear className="h-4 w-4" />
            </button>

            <button className="btn-icon btn-icon-sx drag-handle-element">
                <MdOpenWith className="h-4 w-4" />
            </button>
        </div>
    ) : (
        <div> </div>
    )} */}
                {!properties.active && (
                    <div
                        className={`absolute w-full h-full flex pointer-events-none ${
                            shouldShowControls
                                ? "pointer-events-auto opacity-0 group-hover:opacity-100  backdrop-blur-sm group-hover:bg-primary-200/40 group-hover:dark:bg-primary-600/40"
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

                                    <button className="btn-icon btn-icon-sx  drag-handle-element">
                                        <MdOpenWith className="h-4 w-4" />
                                    </button>
                                </div>
                            )}
                            {isApp && (
                                <div className="flex flex-row h-full w-full">
                                    {properties.pending ? (
                                        <button className="w-6/12 h-full flex justify-center items-center  btn">
                                            <span className="mr-2 text-xl">
                                                Save
                                            </span>{" "}
                                            <MdSave size={30} />
                                        </button>
                                    ) : (
                                        <button className="w-6/12 h-full flex justify-center items-center  btn">
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
