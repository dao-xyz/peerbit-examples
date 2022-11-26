import React, { useContext, useEffect, useState } from "react";
import { deserialize } from "@dao-xyz/borsh";
import { fromBase64 } from "@dao-xyz/peerbit-crypto";
import { Room, Rooms } from "@dao-xyz/peerbit-example-browser-chat";
import { DocumentQueryRequest } from "@dao-xyz/peerbit-document";
import { usePeer } from "./Peer";

const ROOMS_PROGRAM =
    "AAAAACQAAAAwY2ZiMTExMy03ZTM3LTQ4NTctYmNlYy1iMTY1MWU2NWU4YmQFAAAAcm9vbXMAAQAAAAAAAQkAAABkb2N1bWVudHMAAAAAAAAAAQIAAAAAAQ8AAABkb2N1bWVudHNfaW5kZXgAAQQAAAAAAQMAAABycGMCAAAAaWQAAQMAAAAAAQgAAABsb2dpbmRleAABBQAAAAABAwAAAHJwYwABAQAAAAAAJAAAADQ3YmRkNzU0LWEzNGQtNDY2Yy05YTE2LWMyMjAyYTZhMzkyNgkAAAByZWxhdGlvbnMAAQYAAAAAAQkAAABkb2N1bWVudHMAAQAAAAAAAQcAAAAAAQ8AAABkb2N1bWVudHNfaW5kZXgAAQkAAAAAAQMAAABycGMCAAAAaWQAAQgAAAAAAQgAAABsb2dpbmRleAABCgAAAAABAwAAAHJwYw==";
const TOPIC = "world";

interface IChatContext {
    rooms: Rooms;
    roomsUpdated: bigint;
}

export const ChatContext = React.createContext<IChatContext>({} as any);
export const useChat = () => useContext(ChatContext);
export const ChatProvider = ({ children }: { children: JSX.Element }) => {
    const [rooms, setRooms] = useState<Rooms>(undefined);
    const [roomsUpdated, setRoomsUpdated] = useState<bigint>();
    const { peer } = usePeer();

    useEffect(() => {
        if (!peer?.id) {
            return;
        }

        const rooms = deserialize(fromBase64(ROOMS_PROGRAM), Rooms);
        peer.open(rooms, {
            replicate: true,
            topic: TOPIC,
            onUpdate: (oplog, entries) => {
                setRoomsUpdated(oplog._hlc.last.wallTime);
            },
        }).then((db) => {
            setRooms(db);

            // Sync heads
            console.log('find room?')
            db.rooms.index.query(
                new DocumentQueryRequest({ queries: [] }),
                (response, from) => {
                    console.log('Found ROOMS', response)
                    // (response.results.map(x => x.value))
                },
                { sync: true, maxAggregationTime: 5000 } // will invoke "onUpdate"
            ).then(() => {
                console.log('Query rooms done')
            });
        });
    }, [peer?.id]);

    const memo = React.useMemo<IChatContext>(
        () => ({
            rooms,
            roomsUpdated,
        }),
        [rooms?.id, roomsUpdated]
    );

    return <ChatContext.Provider value={memo}>{children}</ChatContext.Provider>;
};
