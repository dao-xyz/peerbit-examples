import { Routes, Route } from "react-router";
import { PublicSignKey } from "@peerbit/crypto";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { CreateDrop } from "./CreateDrop";
import { base64url } from "multiformats/bases/base64";
import { Drop } from "./Drop";
import { Files } from "@peerbit/please-lib";
export const STREAM = "s/:address";

export const getDropAreaPath = (files: Files) => "s/" + files.address;

export const getKeyFromDropAreaKey = (key: string) =>
    deserialize(base64url.decode(key), PublicSignKey);

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={STREAM} element={<Drop />} />
            <Route path={"/"} element={<CreateDrop />} />
        </Routes>
    );
}
