import { usePeer } from "@peerbit/react";
import { useElements } from "../useElements.js";
import { useEffect } from "react";
import { CreateRoom } from "./CreateRoom.js";
import { Spinner } from "../utils/Spinner.js";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ViewChat } from "./ViewChat.js";

export const Rooms = () => {
    const { peer } = usePeer();
    const { current, loading } = useElements();

    const location = useLocation();
    const params = useParams();
    const navigate = useNavigate()

    /*     useEffect(() => {
            if (!peer) {
                return;
            }
          
        }, [peer?.identity.publicKey.hashcode()]) */

    useEffect(() => {
        if (!peer || !current) {
            return;
        }
    }, [peer?.identity.publicKey.hashcode(), current]);


    return (
        <>
            {!current && (
                <div className="w-full h-full flex flex-col justify-center">
                    <div className="flex flex-col content-center gap-4 items-center">
                        {loading && (
                            <div className="flex flex-row gap-2">
                                <>Searching</>
                                <Spinner />
                            </div>
                        )}
                        {!loading && (
                            <div className="flex flex-row gap-2">
                                Post not found
                            </div>
                        )}
                        <CreateRoom />
                    </div>
                </div>
            )}
            {current && <ViewChat room={current}></ViewChat>}
            {/*   <SelectView element={current}></SelectView> */}

        </>
    );
};
