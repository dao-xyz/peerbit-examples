import { usePeer } from "@peerbit/react";
import { useRooms } from "../useRooms.js";
import { useEffect, useState } from "react";
import { Room as RoomView } from "./Room.js";
import { Header } from "./Header.js";
import { CreateRoom } from "./CreateRoom.js";
import { Spinner } from "../utils/Spinner.js";
import { inIframe } from "@peerbit/react";

export const Rooms = () => {
    const { peer } = usePeer();
    const { root, location, loading, path } = useRooms();

    useEffect(() => {
        if (!peer || !root) {
            return;
        }
    }, [peer?.identity.publicKey.hashcode(), root]);

    if (inIframe()) {
        console.log("???", location, path, root);
    }
    return (
        <>
            {location.length === 0 && (
                <div className="w-full h-full flex flex-col justify-center">
                    <div className="flex flex-col content-center gap-4 items-center">
                        {loading && (
                            <div className="flex flex-row gap-2">
                                <>Looking for spaces</>
                                <Spinner />
                            </div>
                        )}
                        {!loading && (
                            <div className="flex flex-row gap-2">
                                Space not found
                            </div>
                        )}
                        <CreateRoom />
                    </div>
                </div>
            )}
            {location.length > 0 &&
                location.map((room, ix) => (
                    <RoomView key={ix} room={room}></RoomView>
                ))}
        </>
    );
};
