import { Routes, Route } from "react-router";
import { Canvas } from "./Canvas";
import { Home } from "./Home";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { base64url } from "multiformats/bases/base64";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { NewSpace } from "./NewSpace";
import { Canvas as CanvasDB } from "./dbs/canvas";
import { Address } from '@dao-xyz/peerbit-program'

export const getStreamPath = (node: PublicSignKey) =>
    "/s/" + base64url.encode(serialize(node));

export const getChatPath = (node: PublicSignKey) =>
    "/k/" + base64url.encode(serialize(node));

export const getCanvasPath = (canvas: CanvasDB) => "/k/" + base64url.encode(serialize(canvas.address));

export const getAdressFromKey = (key: string) =>
    deserialize(base64url.decode(key), Address);

export const getNameFromPath = (name: string) => decodeURIComponent(name);

export const USER_BY_KEY_NAME = "/k/:key";
export const NEW_SPACE = "/new";

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={NEW_SPACE} element={<NewSpace />} />
            <Route path={USER_BY_KEY_NAME} element={<Canvas />} />
            <Route path={"/"} element={<Home />} />
        </Routes>
    );
}
export const STREAMING_APP = ["development", "staging"].includes(
    import.meta.env.MODE
)
    ? "https://stream.test.xyz:5801/#"
    : "https://stream.dao.xyz/#";
export const CHAT_APP = ["development", "staging"].includes(
    import.meta.env.MODE
)
    ? "https://chat.test.xyz:5802/#"
    : "https://chat.dao.xyz/#";
