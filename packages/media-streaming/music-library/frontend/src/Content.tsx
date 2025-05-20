import { BaseRoutes } from "./routes";
import { usePeer, inIframe, ClientBusyError } from "@peerbit/react";
import { useEffect } from "react";
import { FiAlertCircle } from "react-icons/fi"; // For the alert icon
import { useErrorDialog } from "./dialogs/useErrorDialog";

export const Content = () => {
    const { peer, status, error: peerError } = usePeer();
    const { showError } = useErrorDialog();

    useEffect(() => {
        if (peerError) {
            if (peerError instanceof ClientBusyError) {
                showError({
                    title: "Session already open",
                    message:
                        "You already have a session open in another tab. Please close this tab and use the other one.",
                    deadend: true,
                    severity: "info",
                });
            } else {
                console.error("Unexpected error", typeof peerError);
                showError({
                    message:
                        typeof peerError === "string"
                            ? peerError
                            : peerError?.message,
                    error: peerError,
                    severity: "error",
                });
            }
        }
    }, [peerError, showError]);

    useEffect(() => {
        if (!peer?.identity.publicKey.hashcode()) {
            return;
        }
    }, [peer?.identity.publicKey.hashcode()]);

    return (
        <div className={`p-0 h-full ${inIframe() ? "" : ""}`}>
            <div className="flex flex-col min-h-screen bg-gradient-to-bl from-neutral-950 via-neutral-900 to-neutral-800 ">
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
                <BaseRoutes />
            </div>
        </div>
    );
};
