import { Room } from "@peerbit/example-many-chat-rooms";
import { Routes, Route } from "react-router";
import { Lobby } from "./Lobby";
import { Room as RoomView } from "./Room";

export const ROOM = "r/:name";
export const getRoomPath = (room: string | Room) =>
    "r/" + encodeURIComponent(room instanceof Room ? room.name : room);

export const getRoomNameFromPath = (roomName: string) =>
    decodeURIComponent(roomName);

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={ROOM} element={<RoomView />} />
            <Route path={"/"} element={<Lobby />} />
        </Routes>
    );
}
