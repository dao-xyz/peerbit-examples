import type { MediaStreamDB } from "@peerbit/media-streaming";
import type { Params } from "react-router";

export const STREAM = "s/:address";

export const getMediaStreamAddress = (params: Readonly<Params<string>>) =>
    params.address;

export const getStreamPath = (db: MediaStreamDB) => `s/${db.address}`;
