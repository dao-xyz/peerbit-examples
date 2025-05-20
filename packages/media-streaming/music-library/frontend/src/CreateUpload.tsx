import { usePeer, useProgram } from "@peerbit/react";
import { useLocation, useNavigate, useSearchParams } from "react-router";
import { getStreamPath as getUploadPath } from "./routes";
import { useEffect, useState } from "react";
import { MediaStreamDB, MediaStreamDBs } from "@peerbit/media-streaming";
import { useLibraries } from "./libraries/LibrariesContext";

export const CreateUpload = () => {
    const { peer } = usePeer();
    const { libraries } = useLibraries();

    /* open a fresh stream */
    const mediaStream = useProgram<MediaStreamDB>(
        peer && new MediaStreamDB(peer.identity.publicKey),
        {
            existing: "reuse",
            args: {
                replicate: "owned",
            },
        }
    );
    const navigate = useNavigate();
    const location = useLocation();
    const [search] = useSearchParams();
    const libAddr = search.get("lib"); // may be null

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
        if (!libAddr) {
            throw new Error("Library address is required");
        }

        peer.open<MediaStreamDBs>(libAddr, {
            args: {
                replicate: "owned",
            },
            existing: "reuse",
        }).then((library) => {
            library.mediaStreams.put(mediaStream.program);
            const path = getUploadPath(mediaStream.program);
            const search = location.search;

            navigate(`${path}${search}`, { replace: true });
        });
    }, [
        peer?.identity.publicKey,
        mediaStream.program,
        mediaStream.program?.closed,
        libAddr,
        location.search,
        navigate,
        initialSearch,
        libraries?.closed,
        libraries,
    ]);

    return <></>;
};
