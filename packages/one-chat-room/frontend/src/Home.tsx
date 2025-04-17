import { usePeer } from "@peerbit/react";
import { Button } from "@mui/material";
import { useNavigate } from "react-router";
import { getPathFromKey } from "./routes";

export const Home = () => {
    const navigate = useNavigate();
    const { peer } = usePeer();
    return (
        <>
            <Button
                disabled={!peer}
                onClick={() => {
                    navigate(getPathFromKey(peer.identity.publicKey));
                }}
            >
                Open room
            </Button>
        </>
    );
};
