import { usePeer, useProgram } from "@peerbit/react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { getStreamPath as getUploadPath } from "./routes";
import { useEffect, useState } from "react";
import {
    MediaStreamDB as AudioContainer,
    MediaStreamDBs,
} from "@peerbit/media-streaming";
import { useLibraries } from "./libraries/LibrariesContext";

export const CreateUpload = () => {
    const { peer } = usePeer();
    const { libraries } = useLibraries();

    /* open a fresh stream */
    const mediaStream = useProgram<AudioContainer>(
        peer,
        peer && new AudioContainer(peer.identity.publicKey),
        {
            existing: "reuse",
            args: {
                replicate: "owned",
            },
        }
    );
    const navigate = useNavigate();
    const location = useLocation();

    // Optional: Store the initial search params so they aren't lost
    const [initialSearch] = useState(location.search);

    useEffect(() => {
        if (!peer?.identity.publicKey) {
            return;
        }
        if (mediaStream.program?.closed !== false) {
            return;
        }
        if (libraries?.closed !== false) {
            return;
        }

        const path = getUploadPath(mediaStream.program);
        const search = location.search;

        navigate(`${path}${search}`, { replace: true });
    }, [
        peer?.identity.publicKey,
        mediaStream.program,
        mediaStream.program?.closed,
        location.search,
        navigate,
        initialSearch,
        libraries?.closed,
        libraries,
    ]);

    return <></>;
};
