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
    ElementContent
} from "@dao-xyz/social";
import { SearchRequest } from "@peerbit/document";
import { equals } from "uint8arrays";
import "./Canvas.css";
import { Frame } from "./Frame.js";
import { ToolbarVertical } from "./ToolbarVertical.js";


export const ViewChat = (properties: { room: Element }) => {

    const { peer } = usePeer();
    const pendingRef = useRef<Element[]>([]);
    const elementsRef = useRef<Element[]>();
    const [active, setActive] = useState<Set<number>>(new Set());
    const [_, forceUpdate] = useReducer((x) => x + 1, 0);
    const insertedPending = useRef(false)


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
            properties.room.replies.elements.put(element);
        }
        return element

    };

    const savePending = async () => {
        if (!pendingRef.current) {
            throw new Error("Missing pending element");
        }
        await Promise.all(
            pendingRef.current.map((x) => properties.room.replies.elements.put(x))

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

    const updateRects = async (mergePending: boolean = false) => {
        elementsRef.current = await properties.room.replies.elements.index.search(new SearchRequest({ query: [] }), { local: true, remote: false })

        mergePending && pendingRef.current.forEach((element) => {
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
        if (!peer || !properties.room) {
            return;
        }

        if (!insertedPending.current) { // we cant do pendingref.current === 0 here because insertDefault is async and useEffect will be called twice in dev mode
            insertedPending.current = true
            insertDefault()
        }
        if (properties.room.closed) {
            throw new Error("Expecting room to be open");
        }

        const room = properties.room;

        room.replies.elements.events.addEventListener("change", async (change) => {
            updateRects();
        });


        updateRects().then(() => {
           /*  if (isOwner) {
                //addRect();
                // const { key: keypair2 } = await getFreeKeypair('canvas')
                // canvas.elements.put(new Rect({ keypair: keypair2, position: new Position({ x: 0, y: 0, z: 0 }), size: new Size({ height: 100, width: 100 }), src: STREAMING_APP + "/" + getStreamPath(keypair2.publicKey) }))
            } else */ {
                setTimeout(async () => {
                    await room.replies.elements.index.search(
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

    console.log(elementsRef.current, pendingRef.current)
    return (
        <div className="w-[100%] h-full">
            <div className="overflow-y-scroll h-[100%]  pl-2 pr-2">
                <div
                    className={`flex flex-col w-full gap-2`}

                >
                    {elementsRef.current?.map((x, ix) => {
                        return (
                            <div key={ix} className="w-full ">
                                <Frame
                                    active={active.has(ix)}
                                    showAuthor={true}
                                    overlay={true}
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
                                            properties.room.replies.elements
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
                <div className="bg-neutral-300 dark:bg-neutral-700 w-full flex flex-row absolute bottom-0 pt-4">
                    {pendingRef.current?.map((x, ix) => {
                        return (
                            <div key={ix} className="flex-1">
                                <Frame
                                    active={active.has(ix)}
                                    showAuthor={false}
                                    overlay={false}
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
                                            properties.room.replies.elements
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
