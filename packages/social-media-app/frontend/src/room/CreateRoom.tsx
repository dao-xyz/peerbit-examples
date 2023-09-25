import { useState } from "react";
import { useElements } from "../useElements";
import { Spinner } from "../utils/Spinner";
export const CreateRoom = () => {
    const { } = useElements();
    const [isLoading, setIsLoading] = useState(false);
    return (
        <>
            {!isLoading ? (
                <button
                    className="btn btn-elevated"
                    onClick={() => {
                        /*   setIsLoading(true);
                          create().finally(() => {
                              setIsLoading(false);
                          }); */
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
