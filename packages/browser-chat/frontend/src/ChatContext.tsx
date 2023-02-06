import React, { useContext, useEffect, useState } from "react";
import { deserialize } from "@dao-xyz/borsh";
import { fromBase64 } from "@dao-xyz/peerbit-crypto";
import { Lobby } from "@dao-xyz/peerbit-example-browser-chat";
import { usePeer } from "@dao-xyz/peerbit-react";
import { delay } from "@dao-xyz/peerbit-time";
import { DocumentQueryRequest } from "@dao-xyz/peerbit-document";
import { ReplicatorType } from "@dao-xyz/peerbit-program";

// This is a serialized version of RoomsDB manifest.
// We could store this on IPFS and load it using a CID but this is "easier"
// For info how to generate this, see https://github.com/dao-xyz/peerbit-examples/blob/bf90c516115d07f838c3dcc8206cbee7567f4827/packages/browser-chat/library/src/__tests__/index.integration.test.ts#L100
const LOBBYS_PROGRAM =
    "AAAAJAAAADYyMWQ4MTVkLWYxZGMtNDE2ZS1hYzU1LTM0N2VlYjMzYzhmNwUAAABsb2JieQABAAAAAAEJAAAAZG9jdW1lbnRzAAAAAAAAAAEBAAAAAQ8AAABkb2N1bWVudHNfaW5kZXgAAQMAAAABAwAAAHJwYwIAAABpZAABAgAAAAEIAAAAbG9naW5kZXgAAQQAAAABAwAAAHJwYw==";

interface IChatContext {
    lobby: Lobby;
    roomsUpdated: bigint;
    loading: boolean;
    loadedLocally: boolean;
}

export const ChatContext = React.createContext<IChatContext>({} as any);
export const useChat = () => useContext(ChatContext);
export const ChatProvider = ({ children }: { children: JSX.Element }) => {
    const [rooms, setRooms] = useState<Lobby>(undefined);
    const [roomsUpdated, setRoomsUpdated] = useState<bigint>();
    const { peer } = usePeer();
    const [loading, setLoading] = useState(false);
    const [loadedLocally, setLoadedLocally] = useState(false);

    useEffect(() => {
        if (!peer?.id) {
            return;
        }
        /*  if (peer._disconnected && peer._disconnected) {
             return;
         } */

        setLoading(true);
        setLoadedLocally(false);

        const lobby = deserialize(fromBase64(LOBBYS_PROGRAM), Lobby);
        peer.open<Lobby>(lobby, {
            role: new ReplicatorType(),
        })
            .then(async (db) => {
                db.rooms.events.addEventListener("change", () => {
                    setRoomsUpdated(lobby.rooms.store.oplog.hlc.last.wallTime);
                    setLoading(false); // we got 'some' results
                });
                setRooms(db);
                await db.load();
                setLoadedLocally(true);
                const peerIdStart = peer?.id;
                while (peerIdStart === peer?.id) {
                    // TODO do event based without while loop
                    try {
                        if (
                            peer.libp2p.directsub.getSubscribers(
                                db.address.toString()
                            ).size > 0
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
    }, [peer?.id /* peer?._disconnected, peer?._disconnected */]);

    const memo = React.useMemo<IChatContext>(
        () => ({
            loading,
            lobby: rooms,
            roomsUpdated,
            loadedLocally,
        }),
        [rooms?.id, loading, loadedLocally, roomsUpdated]
    );

    return <ChatContext.Provider value={memo}>{children}</ChatContext.Provider>;
};
