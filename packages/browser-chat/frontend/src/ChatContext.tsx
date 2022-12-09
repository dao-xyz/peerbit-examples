import React, { useContext, useEffect, useState } from "react";
import { deserialize } from "@dao-xyz/borsh";
import { fromBase64 } from "@dao-xyz/peerbit-crypto";
import { Room, Rooms } from "@dao-xyz/peerbit-example-browser-chat";
import { DocumentQueryRequest } from "@dao-xyz/peerbit-document";
import { usePeer } from "@dao-xyz/peerbit-react";
import { delay } from "@dao-xyz/peerbit-time";

// This is a serialized version of RoomsDB manifest.
// We could store this on IPFS and load it using a CID but this is "easier"
// For info how to generate this, see https://github.com/dao-xyz/peerbit-examples/blob/63d6923d82d5c496632824e0c0f162b199f1cd37/packages/browser-chat/library/src/__tests__/index.integration.test.ts#L92
const ROOMS_PROGRAM =
    "AAAAACQAAAA4N2M1YWRlZi1iNTQ2LTQ1MjktYTgxOC0yYmJhOTc2MTQxNTQFAAAAcm9vbXMAAQAAAAAAAQkAAABkb2N1bWVudHMAAAAAAAAAAQIAAAAAAQ8AAABkb2N1bWVudHNfaW5kZXgAAQQAAAAAAQMAAABycGMCAAAAaWQAAQMAAAAAAQgAAABsb2dpbmRleAABBQAAAAABAwAAAHJwYwABAQAAAAAAJAAAAGQxZjk5OGU0LTk4NzQtNGE3Mi1iMDljLTZkMTE0YTRkYzBmNgkAAAByZWxhdGlvbnMAAQYAAAAAAQkAAABkb2N1bWVudHMAAQAAAAAAAQcAAAAAAQ8AAABkb2N1bWVudHNfaW5kZXgAAQkAAAAAAQMAAABycGMCAAAAaWQAAQgAAAAAAQgAAABsb2dpbmRleAABCgAAAAABAwAAAHJwYw";

export const TOPIC = "world";

interface IChatContext {
    rooms: Rooms;
    roomsUpdated: bigint;
    loading: boolean;
    loadedLocally: boolean;
}

export const ChatContext = React.createContext<IChatContext>({} as any);
export const useChat = () => useContext(ChatContext);
export const ChatProvider = ({ children }: { children: JSX.Element }) => {
    const [rooms, setRooms] = useState<Rooms>(undefined);
    const [roomsUpdated, setRoomsUpdated] = useState<bigint>();
    const { peer } = usePeer();
    const [loading, setLoading] = useState(false);
    const [loadedLocally, setLoadedLocally] = useState(false);

    useEffect(() => {
        if (!peer?.id) {
            return;
        }
        if (peer._disconnected && peer._disconnected) {
            return;
        }
        setLoading(true);
        setLoadedLocally(false);

        const rooms = deserialize(fromBase64(ROOMS_PROGRAM), Rooms);
        peer.open<Rooms>(rooms, {
            replicate: true,
            topic: TOPIC,
            onUpdate: (oplog, entries) => {
                setRoomsUpdated(oplog._hlc.last.wallTime);
                setLoading(false); // we got 'some' results
            },
        })
            .then(async (db) => {
                setRooms(db);
                await db.load();
                setLoadedLocally(true);
                const peerIdStart = peer?.id;
                while (peerIdStart === peer?.id) {
                    // TODO do event based without while loop
                    try {
                        if (
                            peer.libp2p.pubsub.getSubscribers(TOPIC).length > 0
                        ) {
                            await db.rooms.index
                                .query(
                                    new DocumentQueryRequest({ queries: [] }),
                                    (response, from) => {
                                        setLoading(false);
                                    },
                                    {
                                        local: false,
                                        remote: {
                                            sync: true,
                                            timeout:
                                                db.rooms.index.size === 0
                                                    ? 500
                                                    : 5000,
                                        },
                                    } // will invoke "onUpdate"
                                )
                                .then(() => {
                                    setLoading(false);
                                })
                                .finally(() => {
                                    setLoading(false);
                                });
                        }
                        if (db.rooms.index.size > 0) {
                            await delay(5000);
                        } // only do rapid quires if we dont have any local data
                    } catch (error) {
                        console.error(error);
                    }
                    setLoading(loading && db.rooms.index.size === 0);
                    await delay(100);
                }
            })
            .catch((e) => {
                console.error("Failed to open rooms", e);
                setLoading(false);
            });
    }, [peer?.id, peer?._disconnected, peer?._disconnected]);

    const memo = React.useMemo<IChatContext>(
        () => ({
            loading,
            rooms,
            roomsUpdated,
            loadedLocally,
        }),
        [rooms?.id, loading, loadedLocally, roomsUpdated]
    );

    return <ChatContext.Provider value={memo}>{children}</ChatContext.Provider>;
};
