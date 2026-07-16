import { useLocation, useNavigate } from "react-router";
import { getStreamPath } from "./streamRoutes";
import { useEffect, useState } from "react";
import { useOwnedStreamProgram } from "./StreamProgramOwner";

export const CreateStream = () => {
    const mediaStream = useOwnedStreamProgram();
    const navigate = useNavigate();
    const location = useLocation();

    // Optional: Store the initial search params so they aren't lost
    const [initialSearch] = useState(location.search);

    useEffect(() => {
        if (!mediaStream?.address) {
            return;
        }

        const pathToNavigateTo = getStreamPath(mediaStream);
        // Navigate while preserving the original query parameters
        navigate(
            {
                pathname: pathToNavigateTo,
                search: initialSearch, // or use location.search if you want the most current query
            },
            { replace: true }
        );
    }, [mediaStream?.address, navigate, initialSearch]);

    return <></>;
};
