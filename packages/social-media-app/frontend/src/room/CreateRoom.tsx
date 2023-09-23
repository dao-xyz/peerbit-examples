import { useState } from "react";
import { useRooms } from "../useRooms";
import { Room } from "@dao-xyz/social";
import { Spinner } from "../utils/Spinner";
export const CreateRoom = () => {
    const { create } = useRooms();
    const [isLoading, setIsLoading] = useState(false);
    return (
        <>
            {!isLoading ? (
                <button
                    className="btn btn-elevated"
                    onClick={() => {
                        setIsLoading(true);
                        create().finally(() => {
                            setIsLoading(false);
                        });
                    }}
                >
                    Create space
                </button>
            ) : (
                <Spinner />
            )}
        </>
    );
};
