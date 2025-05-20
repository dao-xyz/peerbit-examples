import { usePeer, useProgram } from "@peerbit/react";
import { useLocation, useNavigate } from "react-router";
import { getStreamPath } from "./routes";
import { useEffect, useState } from "react";
import { MediaStreamDB } from "@peerbit/media-streaming";

export const CreateStream = () => {
    const { peer } = usePeer();
    const mediaStream = useProgram<MediaStreamDB>(
        peer && new MediaStreamDB(peer.identity.publicKey),
        {
            existing: "reuse",
            args: {
                replicate: "all",
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
        if (!mediaStream.program?.address) {
            return;
        }

        const pathToNavigateTo = getStreamPath(mediaStream.program);
        // Navigate while preserving the original query parameters
        navigate({
            pathname: pathToNavigateTo,
            search: initialSearch, // or use location.search if you want the most current query
        });
    }, [
        peer?.identity.publicKey,
        mediaStream.program?.address,
        navigate,
        initialSearch,
    ]);

    return <></>;
};
