import React, { useContext, useEffect, useState } from "react";
import { deserialize } from "@dao-xyz/borsh";
import { fromBase64 } from "@dao-xyz/peerbit-crypto";
import { Room, Rooms } from "@dao-xyz/peerbit-example-browser-chat";
import { DocumentQueryRequest } from "@dao-xyz/peerbit-document";
import { usePeer } from "./Peer";
import { delay } from "@dao-xyz/peerbit-time";

// This is a serialized version of RoomsDB manifest.
// We could store this on IPFS and load it using a CID but this is "easier"
// For info how to generate this, see https://github.com/dao-xyz/peerbit-examples/blob/63d6923d82d5c496632824e0c0f162b199f1cd37/packages/browser-chat/library/src/__tests__/index.integration.test.ts#L92
const ROOMS_PROGRAM =
    "AAAAACQAAAAwY2ZiMTExMy03ZTM3LTQ4NTctYmNlYy1iMTY1MWU2NWU4YmQFAAAAcm9vbXMAAQAAAAAAAQkAAABkb2N1bWVudHMAAAAAAAAAAQIAAAAAAQ8AAABkb2N1bWVudHNfaW5kZXgAAQQAAAAAAQMAAABycGMCAAAAaWQAAQMAAAAAAQgAAABsb2dpbmRleAABBQAAAAABAwAAAHJwYwABAQAAAAAAJAAAADQ3YmRkNzU0LWEzNGQtNDY2Yy05YTE2LWMyMjAyYTZhMzkyNgkAAAByZWxhdGlvbnMAAQYAAAAAAQkAAABkb2N1bWVudHMAAQAAAAAAAQcAAAAAAQ8AAABkb2N1bWVudHNfaW5kZXgAAQkAAAAAAQMAAABycGMCAAAAaWQAAQgAAAAAAQgAAABsb2dpbmRleAABCgAAAAABAwAAAHJwYw==";

export const TOPIC = "world";

interface IChatContext {
    rooms: Rooms;
    roomsUpdated: bigint;
    loading: boolean
}

export const ChatContext = React.createContext<IChatContext>({} as any);
export const useChat = () => useContext(ChatContext);
export const ChatProvider = ({ children }: { children: JSX.Element }) => {
    const [rooms, setRooms] = useState<Rooms>(undefined);
    const [roomsUpdated, setRoomsUpdated] = useState<bigint>();
    const { peer } = usePeer();
    const [date, setDate] = useState<number>(+new Date);
    const [loading, setLoading] = useState(false);

    useEffect(() => {

        if (!peer?.id) {
            return;
        }
        setLoading(true)

        const rooms = deserialize(fromBase64(ROOMS_PROGRAM), Rooms);
        peer.open(rooms, {
            replicate: true,
            topic: TOPIC,
            onUpdate: (oplog, entries) => {
                setRoomsUpdated(oplog._hlc.last.wallTime);
            },
        }).then(async (db) => {
            console.log('open rooms!')
            setRooms(db);
            const peerIdStart = peer?.id;
            while (peerIdStart === peer?.id) {
                db.rooms.index
                    .query(
                        new DocumentQueryRequest({ queries: [] }),
                        (response, from) => {
                            console.log("Found rooms", response);
                            setLoading(false);
                            // (response.results.map(x => x.value))
                        },
                        { sync: true, maxAggregationTime: 5000 } // will invoke "onUpdate"
                    )
                    .then(() => {
                        setLoading(false);
                        console.log("Query rooms done" + date);
                    });
                await delay(5000);
            }
        }).catch((e) => {
            console.error("Failed to open rooms", e)
            setLoading(false)
        });
    }, [peer?.id]);

    const memo = React.useMemo<IChatContext>(
        () => ({
            loading,
            rooms,
            roomsUpdated,
        }),
        [rooms?.id, loading, roomsUpdated]
    );

    return <ChatContext.Provider value={memo}>{children}</ChatContext.Provider>;
};
