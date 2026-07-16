import { Routes, Route } from "react-router";
import { CreateStream } from "./CreateStream";
import { StreamOrView } from "./StreamOrView";
import { STREAM } from "./streamRoutes";
import { StreamProgramOwner } from "./StreamProgramOwner";

export { getMediaStreamAddress, getStreamPath, STREAM } from "./streamRoutes";

export function BaseRoutes() {
    return (
        <StreamProgramOwner>
            <Routes>
                <Route path={STREAM} element={<StreamOrView />} />
                <Route path={"/"} element={<CreateStream />} />
            </Routes>
        </StreamProgramOwner>
    );
}
