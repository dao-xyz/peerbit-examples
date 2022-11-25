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

    /* const [rootIdentity, setRootIdentity] = React.useState<Identity>(undefined); */
    const [loading, setLoading] = React.useState<boolean>(false);

    useEffect(() => {
        if (!peer?.id) {
            return;
        }

        peer.open(deserialize(fromBase64(ROOMS_PROGRAM), Rooms), {
            replicate: true,
            replicationTopic: TOPIC,
            onUpdate: (oplog, entries) => {
                setRoomsUpdated(oplog._hlc.last.wallTime);
            },
        }).then((db) => {
            setRooms(db);

            // Sync heads
            db.rooms.index.query(
                new DocumentQueryRequest({ queries: [] }),
                (response, from) => {
                    // (response.results.map(x => x.value))
                },
                { sync: true } // will invoke "onReplicationComplete"
            );
        });
    }, [peer?.id]);

    /* const wallet = useWallet() */
    const memo = React.useMemo<IChatContext>(
        () => ({
            rooms,
            roomsUpdated,
        }),
        [rooms?.id, roomsUpdated]
    );

    return <ChatContext.Provider value={memo}>{children}</ChatContext.Provider>;
};
