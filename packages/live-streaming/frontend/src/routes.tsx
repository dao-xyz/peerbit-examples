import { Routes, Route } from "react-router";
import { CreateStream } from "./CreateStream";
import { StreamOrView } from "./StreamOrView";
import { MediaStreamDB } from "@peerbit/video-lib";
import { Params } from "react-router-dom";
export const STREAM = "s/:address";

export const getMediaStreamAddress = (params: Readonly<Params<string>>) =>
    params.address;
export const getStreamPath = (db: MediaStreamDB) => {
    return "s/" + db.address;
};

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={STREAM} element={<StreamOrView />} />
            <Route path={"/"} element={<CreateStream />} />
        </Routes>
    );
}
