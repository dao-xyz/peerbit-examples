import { BaseRoutes } from "./routes";
import { usePeer, inIframe } from "@peerbit/react";
import { useEffect } from "react";
import { FiAlertCircle } from "react-icons/fi"; // For the alert icon

export const Content = () => {
    const { peer, status } = usePeer();

    useEffect(() => {
        if (!peer?.identity.publicKey.hashcode()) {
            return;
        }
    }, [peer?.identity.publicKey.hashcode()]);

    return (
        <div className={`p-0 h-full ${inIframe() ? "" : ""}`}>
            <div className="flex flex-col">
                {status === "failed" && (
                    <div className="fixed top-0 left-1/2 transform -translate-x-1/2 mt-4">
                        <div
                            className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded flex items-center"
                            role="alert"
                        >
                            <FiAlertCircle className="mr-2" size={24} />
                            <div>
                                <strong className="font-bold">Error</strong>
                                <span className="block sm:inline ml-2">
                                    Failed to connect to the network
                                </span>
                            </div>
                        </div>
                    </div>
                )}
                <div className="flex">
                    <div className="flex flex-col">
                        <div className="flex flex-row items-center">
                            <div>
                                <h3 className="text-2xl font-bold"></h3>
                            </div>
                        </div>
                    </div>
                </div>
                <BaseRoutes />
            </div>
        </div>
    );
};
