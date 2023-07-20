import { usePeer } from "@peerbit/react";
import { useRooms } from "../useRooms.js";
import { useLocation } from "react-router-dom";
import { useEffect, useState } from "react";
import { Room } from "@dao-xyz/social";
import { Room as RoomView } from "./Room.js";
export const Rooms = () => {
    const { peer } = usePeer();
    const { root } = useRooms();
    const location = useLocation();

    const [rooms, setRooms] = useState<Room[]>([]);

    useEffect(() => {
        if (!peer || !root) {
            return;
        }

        const path = location.pathname.split("/");
        const roomPath = path.splice(0, 1);

        root.getCreateRoomByPath(roomPath).then((result) => {
            setRooms(result);
        });
    }, [peer?.identity.publicKey.hashcode(), root]);

    return (
        <>
            {rooms.map((room, ix) => (
                <RoomView key={ix} room={room}></RoomView>
            ))}
        </>
    );
};
