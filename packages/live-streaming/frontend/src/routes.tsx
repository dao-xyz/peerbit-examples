import { Routes, Route } from "react-router";
import { Stream } from "./Stream";
import { PublicSignKey, toBase64, fromBase64 } from '@dao-xyz/peerbit-crypto';
import { serialize, deserialize } from '@dao-xyz/borsh';
import { CreateStream } from "./CreateStream";

export const STREAM = "s/:key";
export const getStreamPath = (key: PublicSignKey) => "s/" + toBase64(serialize(key))
export const getKeyFromStreamKey = (key: string) => deserialize(fromBase64(key), PublicSignKey);

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={STREAM} element={<Stream />} />
            <Route path={"/"} element={<CreateStream />} />
        </Routes>
    );
}
