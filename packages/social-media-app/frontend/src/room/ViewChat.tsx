import {
    useState,
    useEffect,
    useRef,
    useReducer,
} from "react";

import { inIframe, usePeer } from "@peerbit/react";
import {
    Element,
    IFrameContent,
    ElementContent,
    ChatView
} from "@dao-xyz/social";
import { SearchRequest } from "@peerbit/document";
import { equals } from "uint8arrays";
import "./Canvas.css";
import { Frame } from "./Frame.js";
import { ToolbarVertical } from "./ToolbarVertical.js";


export const ViewChat = (properties: { room: ChatView }) => {

    const { peer } = usePeer();
    const pendingRef = useRef<Element[]>([]);
    const elementsRef = useRef<Element[]>();
    const resizeSizes = useRef<Map<number, { width: number; height: number }>>(
        new Map()
    );



    /*   const [isOwner, setIsOwner] = useState<boolean | undefined>(undefined); */
    const [active, setActive] = useState<Set<number>>(new Set());
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);


    const addRect = async <T extends ElementContent>(
        content: T,
        options: {
            pending: boolean;
        } = { pending: false }
    ) => {
        // await setName(name); // Reinitialize names, so that all keypairs get associated with the name

        let element = new Element({
            publicKey: peer.identity.publicKey,
            content, //generator({ keypair: peer.identity }),
        });

        element = await peer.open(element, { existing: 'reuse' })

        if (options.pending) {
            /* if (
                pendingRef.current &&
                pendingRef.current.find((x) => equals(x.id, element.id))
            ) {
                throw new Error("Already have an pending element");
            }
            if (pendingRef.current.length > 0) {
                throw new Error("Unpexted dangling rect");
            } */
            pendingRef.current.push(element);
            console.log("PUSH PENDING", pendingRef.current.length);
        } else {
            properties.room.elements.put(element);
        }
        return element

    };

    const savePending = async () => {
        if (!pendingRef.current) {
            throw new Error("Missing pending element");
        }
        await Promise.all(
            pendingRef.current.map((x) => properties.room.elements.put(x))

        );
        forceUpdate();
        pendingRef.current = [];
        return pendingRef.current;
    };


    const insertDefault = () => {
        return addRect(new IFrameContent(), {
            pending: true,
        }).then((result) => {
            /*   result.content.history.put(new Navigation(TEXT_APP)) */
            updateRects();
        });
    };

    const removePending = (ix: number) => {
        const spliced = pendingRef.current.splice(ix, 1);
        if (spliced.length > 0) {
            elementsRef.current.splice(
                elementsRef.current.findIndex((x) => x === spliced[0]),
                1
            );
        }
    };

    const updateRects = async () => {
        elementsRef.current = await properties.room.elements.index.search(new SearchRequest({ query: [] }), { local: true, remote: false })

        pendingRef.current.forEach((element) => {
            elementsRef.current.push(element)
        })

        forceUpdate()
    }

    useEffect(() => {
        function handleClickOutside(event) {
            setActive(new Set());
        }
        // Bind the event listener
        document.addEventListener("mousedown", handleClickOutside);
        return () => {
            // Unbind the event listener on clean up
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, []);

    useEffect(() => {
        console.log("RESET?");
        if (!peer || !properties.room) {
            return;
        }

        if (properties.room.closed) {
            throw new Error("Expecting room to be open");
        }

        const room = properties.room;

        room.elements.events.addEventListener("change", async (change) => {
            updateRects();
        });


        updateRects().then(() => {
           /*  if (isOwner) {
                //addRect();
                // const { key: keypair2 } = await getFreeKeypair('canvas')
                // canvas.elements.put(new Rect({ keypair: keypair2, position: new Position({ x: 0, y: 0, z: 0 }), size: new Size({ height: 100, width: 100 }), src: STREAMING_APP + "/" + getStreamPath(keypair2.publicKey) }))
            } else */ {
                setTimeout(async () => {
                    await room.elements.index.search(
                        new SearchRequest({ query: [] }),
                        { remote: { sync: true } }
                    )
                }, 2000);
            }
        });
    }, [
        peer?.identity.publicKey.hashcode(),
        properties?.room.closed || properties?.room?.address,
    ]);

    return (
        <div className="w-[100%] h-full pl-2 pr-2">
            <div className="overflow-y-scroll h-[100%]">
                <div
                    className={`flex flex-col w-full gap-2`}

                >
                    {elementsRef.current?.map((x, ix) => {
                        return (
                            <div key={ix} className="w-full ">
                                <Frame
                                    active={active.has(ix)}
                                    showAuthor={true}
                                    setActive={(v) => {
                                        if (v) {
                                            setActive(
                                                (previousState) =>
                                                    new Set(
                                                        previousState.add(
                                                            ix
                                                        )
                                                    )
                                            );
                                        } else {
                                            setActive(
                                                (prev) =>
                                                    new Set(
                                                        [
                                                            ...prev,
                                                        ].filter(
                                                            (x) =>
                                                                x !== ix
                                                        )
                                                    )
                                            );
                                        }
                                    }}
                                    delete={() => {
                                        const pendingIndex =
                                            pendingRef.current.findIndex((pending) => pending == x
                                            );
                                        if (pendingIndex != -1) {
                                            removePending(ix);
                                            if (
                                                pendingRef.current
                                                    .length === 0
                                            ) {
                                                // insertDefault()
                                                updateRects();
                                            } else {
                                                updateRects();
                                            }
                                        } else {
                                            properties.room.elements
                                                .del(x.id)
                                                .then(() => {
                                                    updateRects();
                                                });
                                        }
                                    }}
                                    element={x}
                                    index={ix}
                                    pending={
                                        !!pendingRef.current.find((p) =>
                                            equals(p.id, x.id)
                                        )
                                    }
                                ></Frame>
                            </div>
                        );
                    })}
                </div>
            </div>

            {!inIframe() && (
                <div className="absolute right-5 bottom-5">
                    <ToolbarVertical
                        onSave={() => {
                            savePending();
                        }}
                        onNew={() => {
                            insertDefault();
                        }}
                        unsavedCount={pendingRef.current.length}
                    /*  onEditModeChange={(edit) => {
                         setEditMode(edit);
                     }} */
                    />
                </div>
            )}
        </div>
    );
};
