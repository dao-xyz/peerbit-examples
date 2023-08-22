import { IFrameContent, Element } from "@dao-xyz/social";
import { Fragment, useState } from "react";
import { Combobox, Transition } from "@headlessui/react";

import { MdCheck, MdClear, MdOpenWith } from "react-icons/md";
import { AppSelect } from "./AppSelect";

export const Frame = (properties: {
    pending: boolean;
    element: Element;
    index: number;
    editMode: boolean;
    replace: (url: string) => void;
    onLoad: (event: React.SyntheticEvent<HTMLIFrameElement, Event>) => void;
    delete(): void;
}) => {
    const [focused, setFocused] = useState(false);

    return (
        <div
            onClick={(e) => {
                setFocused(true);
                e.stopPropagation();
            }}
            // border-4 border-solid border-primary-300
            className={
                "flex flex-col  w-full h-full max-w-full" /*  +
        (!properties.editMode
            ? "react-resizable-hide "
            : "") + (pendingRef.current.find(p => equals(p.id, x.id)) ? "pending" : "") */
            }
        >
            {((properties.editMode && focused) || properties.pending) && (
                <div
                    id={"header-" + properties.index}
                    className="flex w-full justify-end opacity-100"
                >
                    <AppSelect
                        onSelected={(app) => {
                            properties.replace(app.url);
                        }}
                    />

                    <button
                        className="btn-icon btn-icon-sx"
                        onClick={() => {
                            properties.delete();
                            /* myCanvas.current.then(
                            (canvas) => {
                                canvas.elements.del(
                                    x.id
                                );
                            }
                        ); */
                        }}
                    >
                        <MdClear className="h-4 w-4" />
                    </button>

                    <button className="btn-icon btn-icon-sx drag-handle-element">
                        <MdOpenWith className="h-4 w-4" />
                    </button>
                </div>
            )}
            <div id={"frame-" + properties.index} className="w-full h-full">
                {properties.element.content instanceof IFrameContent ? (
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
                ) : (
                    <>UNSUPPORTED</>
                )}
            </div>
        </div>
    );
};
