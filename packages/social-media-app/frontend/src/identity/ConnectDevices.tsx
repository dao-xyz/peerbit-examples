import { useState, useEffect } from "react";
import { usePeer } from "@peerbit/react";
import * as Tooltip from "@radix-ui/react-tooltip";
import { BsCopy } from "react-icons/bs";
import { useIdentities } from "./useIdentities";
import { ListDevices } from "./ListDevices";
import { generateDefaultDeviceName } from "./utils";
import { TbPlugConnected } from "react-icons/tb";

// Helper to extract the encoded token from a deep-link URL.
const extractDataFromUrl = (url) => {
    const parts = url.split("#/connect?data=");
    return parts.length > 1 ? parts[1] : null;
};

export const ConnectDevices = () => {
    const { identities } = useIdentities();

    // State variables.
    const [qrCodeUrl, setQrCodeUrl] = useState("");
    const [deepLinkUrl, setDeepLinkUrl] = useState("");
    const [manualCode, setManualCode] = useState("");
    const [status, setStatus] = useState("Waiting for connection...");
    const [copied, setCopied] = useState(false);
    const [deviceName, setDeviceName] = useState(generateDefaultDeviceName());

    useEffect(() => {
        let deviceNameFromLocalStorage = localStorage.getItem("device-name");
        if (!deviceNameFromLocalStorage) {
            deviceNameFromLocalStorage = generateDefaultDeviceName();
            localStorage.setItem("device-name", deviceNameFromLocalStorage);
        }
        setDeviceName(deviceNameFromLocalStorage);
    }, []);

    // Copy deep link URL to clipboard.
    const handleCopy = () => {
        if (deepLinkUrl) {
            navigator.clipboard.writeText(deepLinkUrl).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
            });
        }
    };

    // Responder flow: Given a token (from URL or manual input), call connectDevicesFlow in responder mode.
    const handleResponderFlow = async (token: string) => {
        try {
            setStatus("Processing incoming connection...");
            const connection = await identities.connectDevicesFlow({
                deviceName,
                deepLinkOrCode: token,
            });
            setStatus(
                "Connected with device: " +
                    (connection.device2
                        ? connection.device2.publicKey.hashcode()
                        : "unknown")
            );
        } catch (error) {
            setStatus("Responder connection error: " + error.message);
        }
    };

    // Manual connection: If the user enters a full URL, extract the token and call responder flow.
    const handleManualConnect = async (code: string) => {
        try {
            let token = code.trim();
            if (token.startsWith("http")) {
                const extracted = extractDataFromUrl(token);
                if (!extracted) {
                    throw new Error("URL does not contain connection data");
                }
                token = extracted.trim();
            }
            await handleResponderFlow(token);
        } catch (error) {
            setStatus("Manual connection error: " + error.message);
        }
    };

    // On mount, check if there's connection data in the URL.
    useEffect(() => {
        if (identities) {
            const params = new URLSearchParams(window.location.search);
            const dataParam =
                params.get("data") || extractDataFromUrl(window.location.href);
            if (dataParam) {
                // Responder mode: process the deep link token.
                handleResponderFlow(dataParam);
            } else {
                // Initiator mode: start connection flow and display deep link & QR code.
                identities
                    .connectDevicesFlow({
                        deviceName,
                        onCode: ({
                            encodedConnection,
                            deepLinkUrl,
                            qrCodeUrl,
                        }) => {
                            setDeepLinkUrl(deepLinkUrl);
                            setQrCodeUrl(qrCodeUrl);
                        },
                    })
                    .then((connection) => {
                        setStatus(
                            "Connected with device: " +
                                (connection.device2
                                    ? connection.device2.publicKey.hashcode()
                                    : "unknown")
                        );
                    })
                    .catch((err) => {
                        setStatus("Error: " + err.message);
                    });
            }
        }
    }, [
        !identities || identities?.closed ? undefined : identities.address,
        deviceName,
    ]); // Do not change effect dependencies

    // Determine whether we are in responder mode by checking for token in the URL.
    const urlHasData = !!extractDataFromUrl(window.location.href);

    return (
        <Tooltip.Provider>
            <div className="p-4 space-y-6">
                <h1>Connect Devices</h1>

                {/* Device Name Input */}
                <div className="bg-gray-50 p-4 rounded shadow">
                    <label className="block text-lg font-medium mb-2">
                        Name this device
                    </label>
                    <input
                        type="text"
                        value={deviceName}
                        onChange={(e) => setDeviceName(e.target.value)}
                        placeholder="Enter your device name"
                        className="w-full p-2 border border-gray-300 rounded"
                    />
                </div>

                {/* List of Trusted Devices */}
                <ListDevices />

                {/* Initiator UI (only if no deep link token is present) */}
                {!urlHasData && (
                    <>
                        {/* QR Code Connection Section */}
                        <div className="p-4 rounded shadow">
                            <h3>QR Code Connection</h3>
                            {qrCodeUrl ? (
                                <>
                                    <img
                                        src={qrCodeUrl}
                                        alt="QR Code"
                                        className="mx-auto mb-4"
                                    />
                                    <div className="flex flex-row items-center space-x-2">
                                        <input
                                            type="text"
                                            readOnly
                                            value={deepLinkUrl}
                                            className="flex-1 p-2 border border-gray-300 rounded"
                                        />
                                        <Tooltip.Root>
                                            <Tooltip.Trigger asChild>
                                                <button
                                                    onClick={handleCopy}
                                                    className="btn-elevated btn-icon"
                                                    aria-label="Copy deep link URL"
                                                >
                                                    <BsCopy />
                                                </button>
                                            </Tooltip.Trigger>
                                            <Tooltip.Portal>
                                                <Tooltip.Content
                                                    className="p-2   rounded"
                                                    side="top"
                                                >
                                                    {copied
                                                        ? "Copied!"
                                                        : "Copy URL"}
                                                </Tooltip.Content>
                                            </Tooltip.Portal>
                                        </Tooltip.Root>
                                    </div>
                                </>
                            ) : (
                                <p className="text-center text-gray-500">
                                    Generating QR code...
                                </p>
                            )}
                        </div>

                        {/* Manual Connection Section */}
                        <div className="p-4 rounded shadow flex flex-col">
                            <h3>Manual Connection</h3>
                            <div className="rounded shadow flex flex-row gap-2">
                                <input
                                    type="text"
                                    value={manualCode}
                                    onChange={(e) =>
                                        setManualCode(e.target.value)
                                    }
                                    placeholder="Paste connection URL or code here"
                                    className="w-full p-2 border border-gray-300 rounded"
                                />
                                <button
                                    onClick={() =>
                                        handleManualConnect(manualCode)
                                    }
                                    className="ml-auto btn-elevated btn-icon "
                                >
                                    <TbPlugConnected />
                                </button>
                            </div>
                        </div>
                    </>
                )}

                {/* Status Message */}
                <div className="text-center text-sm text-gray-600">
                    {status}
                </div>
            </div>
        </Tooltip.Provider>
    );
};
