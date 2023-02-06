import { Routes, Route } from "react-router";
import { Stream } from "./Stream";
import {
    PublicSignKey,
    toHexString,
    fromHexString,
} from "@dao-xyz/peerbit-crypto";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { CreateStream } from "./CreateStream";
import { StreamOrView } from "./StreamOrView";

export const STREAM = "s/:key";
export const getStreamPath = (key: PublicSignKey) =>
    "s/" + toHexString(serialize(key));
export const getKeyFromStreamKey = (key: string) =>
    deserialize(fromHexString(key), PublicSignKey);

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={STREAM} element={<StreamOrView />} />
            <Route path={"/"} element={<CreateStream />} />
        </Routes>
    );
}
