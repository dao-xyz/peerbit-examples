import { useState } from "react";
import { useCanvases } from "./useCanvas";
import { Spinner } from "../utils/Spinner";
export const CreateNew = () => {
    const { createCanvasAtPath: create } = useCanvases();
    const [isLoading, setIsLoading] = useState(false);
    return (
        <>
            {!isLoading ? (
                <button
                    className="btn btn-elevated btn-secondary btn-md"
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
