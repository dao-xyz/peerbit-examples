import { usePeer } from "@peerbit/react";
import { useRooms } from "../useRooms.js";
import { useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { Room } from "@dao-xyz/social";
import { Room as RoomView } from "./Room.js";
import { Toolbar } from "./Toolbar.js";
export const Rooms = () => {
    const { peer } = usePeer();
    const { root, location } = useRooms();
    const [editMode, setEditMode] = useState(false);

    useEffect(() => {
        if (!peer || !root) {
            return;
        }
    }, [peer?.identity.publicKey.hashcode(), root]);

    return (
        <>
            <Toolbar
                onEditModeChange={(edit) => {
                    setEditMode(edit);
                }}
            />
            {location.map((room, ix) => (
                <RoomView key={ix} room={room} editMode={editMode}></RoomView>
            ))}
        </>
    );
};
