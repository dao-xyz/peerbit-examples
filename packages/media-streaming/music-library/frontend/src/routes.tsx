import { Routes, Route } from "react-router";
import { CreateUpload } from "./CreateUpload";
import { UploadOrPlay } from "./UploadOrPlay";
import { MediaStreamDB, MediaStreamDBs } from "@peerbit/media-streaming";
import { Params } from "react-router";
import { Library } from "./library/Library";
import { Libraries } from "./libraries/Libraries";

export const STREAM = "/s/:address";
export const UPLOAD = "/upload";
export const LIBRARY = "/l/:address";
export const HOME = "/";

export const getMediaStreamAddress = (params: Readonly<Params<string>>) =>
    params.address;
export const getStreamPath = (db: MediaStreamDB) => {
    return "/s/" + db.address;
};

export const getLibraryPath = (db: MediaStreamDBs) => {
    return "/l/" + db.address;
};

export function BaseRoutes() {
    return (
        <Routes>
            <Route path={STREAM} element={<UploadOrPlay />} />
            <Route path={LIBRARY} element={<Library />} />
            <Route path={UPLOAD} element={<CreateUpload />} />
            <Route path={HOME} element={<Libraries />} />
        </Routes>
    );
}
