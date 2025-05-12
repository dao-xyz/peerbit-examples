import { Routes, Route } from "react-router";
import { Home } from "./Home";
import { PublicSignKey } from "@peerbit/crypto";
import { base64url } from "multiformats/bases/base64";
import { serialize } from "@dao-xyz/borsh";
import { Canvas as CanvasDB } from "@giga-app/interface";
import { CreateRoot } from "./canvas/CreateRoot";
import { MissingProfile } from "./profile/MissingProfile";
import { ConnectDevices } from "./identity/ConnectDevices";
import { ViewType } from "./view/ViewContex";
import { NavigationEffects } from "./NavigationEffects";
import { useRecordLocation } from "./useNavHistory";

const textDecoder = new TextDecoder();
export const getStreamPath = (node: PublicSignKey) =>
    "/s/" + base64url.encode(serialize(node));

export const getChatPath = (node: PublicSignKey) =>
    "/k/" + base64url.encode(serialize(node));

export const getAdressFromKey = (key: string) =>
    textDecoder.decode(base64url.decode(key));

export const getNameFromPath = (name: string) => decodeURIComponent(name);

export const getCanvasPath = (canvas: CanvasDB, view?: ViewType) => {
    const base = "/c/" + canvas.address;
    let searchParams = "";
    if (view) {
        searchParams = `?view=${view}`;
    }
    return base + searchParams;
};
export const getCanvasAddressByPath = (path: string) => path.split("/")[2];

export const USER_BY_KEY_NAME = "/k/:key";
export const NEW_SPACE = "/new";

export function BaseRoutes() {
    useRecordLocation();
    return (
        <>
            <NavigationEffects />
            <Routes>
                {/* <Route path={USER_BY_KEY_NAME} element={<Canvas />} /> */}
                <Route path={CONNECT_DEVICES} element={<ConnectDevices />} />
                <Route path={MISSING_PROFILE} element={<MissingProfile />} />
                <Route path={NEW_ROOT} element={<CreateRoot />} />
                <Route path="/path/*" element={<Home />} />
                <Route path="/*" element={<Home />} />
            </Routes>
        </>
    );
}

export const MISSING_PROFILE = "/missing-profile";
export const NEW_ROOT = "/new-root";
export const CONNECT_DEVICES = "/connect";
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
