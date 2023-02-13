import { Routes, Route } from "react-router";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { serialize, deserialize } from "@dao-xyz/borsh";
import { Canvas } from "./Stream";
import { base58btc } from "multiformats/bases/base58";
export const STREAM = "s/:identity/:node";

export const getStreamPath = (identity: PublicSignKey, node: PublicSignKey) =>
    "s/" +
    base58btc.encode(serialize(identity)) +
    "/" +
    base58btc.encode(serialize(node));
export const getKeyFromStreamKey = (key: string) =>
    deserialize(base58btc.decode(key), PublicSignKey);

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={"/"} element={<Canvas />} />
        </Routes>
    );
}
