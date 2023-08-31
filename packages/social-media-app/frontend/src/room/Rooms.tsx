import { usePeer } from "@peerbit/react";
import { useRooms } from "../useRooms.js";
import { useEffect, useState } from "react";
import { Room as RoomView } from "./Room.js";
import { Toolbar } from "./Toolbar.js";

export const Rooms = () => {
    const { peer } = usePeer();
    const { root, location } = useRooms();

    useEffect(() => {
        if (!peer || !root) {
            return;
        }
    }, [peer?.identity.publicKey.hashcode(), root]);

    return (
        <>
            {location.map((room, ix) => (
                <RoomView key={ix} room={room}></RoomView>
            ))}
        </>
    );
};
