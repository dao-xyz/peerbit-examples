import { Routes, Route } from "react-router";
import { Canvas } from "./Canvas";
import { Home } from "./Home";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { base64url } from "multiformats/bases/base64";
import { serialize, deserialize } from "@dao-xyz/borsh";

export const getStreamPath = (node: PublicSignKey) =>
    "s/" + base64url.encode(serialize(node));

export const getPathFromKey = (node: PublicSignKey) =>
    "k/" + base64url.encode(serialize(node));

export const getKeyFromPath = (key: string) =>
    deserialize(base64url.decode(key), PublicSignKey);

export const USER_BY_KEY = "/k/:key";

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={USER_BY_KEY} element={<Canvas />} />
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
