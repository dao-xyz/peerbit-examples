import { IFrameContent, Element, Navigation } from "@dao-xyz/social";
import {
    MdClear,
    MdAddReaction,
    MdOpenInBrowser,
    MdSave,
} from "react-icons/md";
import { AppSelect } from "./AppSelect";
import { useNavigate } from "react-router-dom";
import { useNames } from "../names/useNames";
import { useEffect, useRef, useState } from "react";
import { AppHost } from '@dao-xyz/app-sdk'
import { usePeer } from "@peerbit/react";
import { TEXT_APP } from "../routes";

export const Frame = (properties: {
    pending: boolean;
    element: Element;
    preview?: boolean;
    overlay?: boolean
    index: number;
    showAuthor?: boolean
    active: boolean;
    setActive: (value: boolean) => void;
    editMode?: boolean;
    onLoad?: (event: React.SyntheticEvent<HTMLIFrameElement, Event>) => void;
    delete(): void;
}) => {

    const navigate = useNavigate();
    const { names } = useNames()
    const [author, setAuthor] = useState<string | undefined>(undefined);
    const [src, setSrc] = useState<string | undefined>(undefined);
    const { peer } = usePeer()
    const frame = useRef<HTMLIFrameElement>();
    const host = useRef<AppHost | undefined>(new AppHost({
        onNavigate: () => {
            // the iframe has navigated to some meaningful path for state
            // update the element for this


        },
        onResize: (e) => {
            console.log("GOT RESIZE MESSAGE", e.height, e.width)
            frame.current["style"].height = e.height + "px"
        }
    }))
    useEffect(() => {
        if (!properties.element.content || properties.element.content.history.closed) {
            return
        }

        const iframeContent = properties.element.content as IFrameContent;
        const updateLatestSrc = () => iframeContent.getLatest().then((url) => {
            if (!url && properties.element.publicKey?.equals(peer.identity.publicKey)) {
                iframeContent.history.put(new Navigation(TEXT_APP)).then(() => {
                    updateLatestSrc()
                })
            }
            setSrc(url)
        })
        updateLatestSrc()
        iframeContent.history.events.addEventListener('change', updateLatestSrc)
        return iframeContent.history.events.removeEventListener('change', updateLatestSrc)
    }, [properties.element.content?.history.closed || properties.element.content?.history.address])

    useEffect(() => {
        if (properties.element.publicKey) {
            const updateName = () => names.getName(properties.element.publicKey).then((name) => {
                setAuthor(name?.name)
            })

            updateName();
            names.names.events.addEventListener('change', updateName)

            return () => names.names.events.removeEventListener('change', updateName)
        }

    }, [properties.element?.publicKey?.hashcode()])

    const open = async () => {
        const url = await (properties.element.content as IFrameContent).getLatest();
        if (new URL(url).host === window.location.host) {
            // navigate!
            navigate(new URL(url).hash.substring(2)); // #/path, remove hash symbol
        } else {
            properties.setActive(true);
        }
    };

    const drawName = () => {
        if (!author) {
            return 'Anonymous'
        }
        try {
            new URL(author)
            // iframeable?
            return <iframe src={author} className="w-max-[100px] h-max-[100px]"></iframe>
        } catch (error) {
            return author
        }
    }
    return (
        <div className="w-full h-full max-w-full flex flex-col">
            {properties.showAuthor && <div className="w-full">
                {drawName()}
            </div>}
            <div
                onBlur={() => {
                    console.log("BLUR!");
                    //setFocused(false)
                }}
                // border-4 border-solid border-primary-300
                className={
                    ` relative flex flex-col w-full h-full max-w-full bg-neutral-100 dark:bg-neutral-800 group ${properties.pending
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
                {!properties.overlay && <div className="w-full">
                    <AppSelect
                        currentUrl={src}
                        onSelected={(app) => {
                            (properties.element.content as IFrameContent).history.put(new Navigation(app.url));
                        }}
                    />
                </div>}
                {!properties.active && !properties.preview && properties.overlay && (
                    <div
                        className={`absolute w-full h-full flex opacity-0 group-hover:opacity-100  backdrop-blur-sm group-hover:bg-primary-200/40 group-hover:dark:bg-primary-600/40`}
                    >
                        <div className="flex flex-col w-full h-full">
                            <div
                                id={"header-" + properties.index}
                                className={`w-full justify-end z-10 hidden group-hover:flex`}
                            >
                                <div className="m-1 w-full">
                                    <AppSelect
                                        currentUrl={src}
                                        onSelected={(app) => {
                                            (properties.element.content as IFrameContent).history.put(new Navigation(app.url));
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

                                {/*   <button className="btn-icon btn-icon-sx  drag-handle-element">
                                <MdOpenWith className="h-4 w-4" />
                            </button> */}
                            </div>
                            <div className="flex flex-row h-full w-full">
                                {properties.pending ? (
                                    <button className="w-6/12 h-full flex justify-center items-center  btn">
                                        <span className="mr-2 text-xl">Save</span>{" "}
                                        <MdSave size={30} />
                                    </button>
                                ) : (
                                    <button className="w-6/12 h-full flex justify-center items-center  btn">
                                        <span className="mr-2 text-xl">Reply</span>{" "}
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
                        </div>
                    </div>
                )}

                <div id={"frame-" + properties.index} className="w-full h-full">
                    {properties.element.content instanceof IFrameContent ? (
                        <iframe
                            ref={frame}
                            onBlur={() => { }}
                            style={{
                                width: "100%",
                                height: "100%",
                                border: 0,
                            }}
                            src={src ? host.current.transformClientUrl(src) : undefined}
                            allow="camera; microphone; allowtransparency; display-capture; fullscreen; autoplay; clipboard-write;"
                        ></iframe>
                    ) : (
                        <>UNEXPECTED</>
                        /*  <RoomPreview
                             room={(properties.element.content as RoomContent).room}
                         ></RoomPreview> */
                    )}
                </div>
            </div>
        </div>
    );
};
