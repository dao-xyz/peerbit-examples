import { Room } from "./database.js";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { Routes, Route } from "react-router";
import { Room as RoomView } from "./Room";
import { base64url } from "multiformats/bases/base64";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { Home } from "./Home.js";

export const ROOM = "k/:key";

export const getPathFromKey = (node: PublicSignKey) =>
    "k/" + base64url.encode(serialize(node));

export const getKeyFromPath = (key: string) =>
    deserialize(base64url.decode(key), PublicSignKey);

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={ROOM} element={<RoomView />} />
            <Route path={"/"} element={<Home />} />
        </Routes>
    );
}
