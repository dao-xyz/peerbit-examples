import { Routes, Route } from "react-router";
import { Room } from "./Room";
import { Rooms } from "./Rooms";

export const ROOM = "r/:room";

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={ROOM} element={<Room />} />
            <Route path={"/"} element={<Rooms />} />
        </Routes>
    );
}
