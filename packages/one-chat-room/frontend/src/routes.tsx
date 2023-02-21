import { Room } from "@dao-xyz/peerbit-example-browser-chat";
import { Routes, Route } from "react-router";
import { Room as RoomView } from "./Room";
export const ROOM = "r/:name";
export const getRoomPath = (room: string | Room) =>
    "r/" + (room instanceof Room ? room.name : room);

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={ROOM} element={<RoomView />} />
            <Route path={"/"} element={<>404</>} />
        </Routes>
    );
}
