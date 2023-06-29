import { Routes, Route } from "react-router";
import { PublicSignKey } from "@peerbit/crypto";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { CreateStream } from "./CreateStream";
import { StreamOrView } from "./StreamOrView";
import { base64url } from "multiformats/bases/base64";
export const STREAM = "s/:node";

export const getStreamPath = (node: PublicSignKey) =>
    "s/" + base64url.encode(serialize(node));

export const getKeyFromStreamKey = (key: string) =>
    deserialize(base64url.decode(key), PublicSignKey);

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={STREAM} element={<StreamOrView />} />
            <Route path={"/"} element={<CreateStream />} />
        </Routes>
    );
}
