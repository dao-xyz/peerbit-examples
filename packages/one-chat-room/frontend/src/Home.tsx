import { usePeer } from "@dao-xyz/peerbit-react";
import { Button } from "@mui/material";
import { useNavigate } from "react-router-dom";
import { getPathFromKey } from "./routes";

export const Home = () => {
    const navigate = useNavigate();
    const { peer } = usePeer();
    return (
        <>
            <Button
                disabled={!peer}
                onClick={() => {
                    navigate(getPathFromKey(peer.idKey.publicKey));
                }}
            >
                Open room
            </Button>
        </>
    );
};
