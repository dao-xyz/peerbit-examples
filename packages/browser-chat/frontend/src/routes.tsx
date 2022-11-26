import { Room } from "@dao-xyz/peerbit-example-browser-chat";
import { Routes, Route } from "react-router";
import { Rooms } from "./Rooms";
import { Room as RoomView } from "./Room";
import { serialize } from "@dao-xyz/borsh";
import { toBase64 } from '@dao-xyz/peerbit-crypto';

export const ROOM = "r/:name";
export const getRoomPath = (room: string | Room) => "r/" + (room instanceof Room ? encodeURIComponent(room.name) : room)

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={ROOM} element={<RoomView />} />
            <Route path={"/"} element={<Rooms />} />
        </Routes>
    );
}
