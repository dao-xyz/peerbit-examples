import { Routes, Route } from "react-router";
import { Home } from "./Home";
import { PublicSignKey } from "@peerbit/crypto";
import { base64url } from "multiformats/bases/base64";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { Canvas as CanvasDB } from "@dao-xyz/social";
import { CreateRoot } from "./canvas/CreateRoot";

const textDecoder = new TextDecoder();
export const getStreamPath = (node: PublicSignKey) =>
    "/s/" + base64url.encode(serialize(node));

export const getChatPath = (node: PublicSignKey) =>
    "/k/" + base64url.encode(serialize(node));

export const getAdressFromKey = (key: string) =>
    textDecoder.decode(base64url.decode(key));

export const getNameFromPath = (name: string) => decodeURIComponent(name);

export const getCanvasPath = (canvas: CanvasDB) => "/c/" + canvas.address;
export const getCanvasAddressByPath = (path: string) => path.split("/")[2];

export const USER_BY_KEY_NAME = "/k/:key";
export const NEW_SPACE = "/new";

export function BaseRoutes() {
    return (
        <Routes>
            {/* <Route path={USER_BY_KEY_NAME} element={<Canvas />} /> */}
            <Route path="/new-root" element={<CreateRoot />} />
            <Route path="/path/*" element={<Home />} />
            <Route path="/*" element={<Home />} />
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

export const TEXT_APP = ["development", "staging"].includes(
    import.meta.env.MODE
)
    ? "https://text.test.xyz:5803/#"
    : "https://text.dao.xyz/#";
