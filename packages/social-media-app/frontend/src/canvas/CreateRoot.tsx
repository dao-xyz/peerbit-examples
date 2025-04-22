import { useEffect, useState } from "react";
import { useCanvases } from "./useCanvas";
import { Spinner } from "../utils/Spinner";
import { Canvas } from "./Canvas";
import { CanvasWrapper } from "./CanvasWrapper";
import { SaveButton } from "./SaveCanvasButton";
import { usePeer, useProgram } from "@peerbit/react";
import { Canvas as CanvasDB } from "@giga-app/interface";
import { useNavigate } from "react-router";
import { LuSprout } from "react-icons/lu";
import { deserialize, serialize } from "@dao-xyz/borsh";
import { fromBase64, toBase64 } from "@peerbit/crypto";
import { BsCopy } from "react-icons/bs";
import { IoArrowForward } from "react-icons/io5";

export const CreateRoot = () => {
    const { setRoot } = useCanvases();
    const [isLoading, setIsLoading] = useState(false);
    const { peer } = usePeer();
    const [base64, setBase64] = useState<string | undefined>(undefined);
    const [importError, setImportError] = useState(false);
    const [copySuccess, setCopySuccess] = useState(false);

    const [pendingCanvasState, setPendingCanvasState] = useState<
        CanvasDB | undefined
    >(undefined);
    const pendingCanvas = useProgram(pendingCanvasState, {
        id: pendingCanvasState?.idString,
        keepOpenOnUnmount: true,
        existing: "reuse",
        args: {
            replicate: true,
        },
    });

    const createSetBase64 = (canvas: CanvasDB = pendingCanvas.program) => {
        const newBase64 = toBase64(serialize(canvas));
        setBase64(newBase64);
        return newBase64;
    };

    // Update base64 string when pending canvas is available and open.
    useEffect(() => {
        if (!pendingCanvas.program || pendingCanvas.program.closed) return;
        if (!base64) {
            createSetBase64();
        }
    }, [
        pendingCanvas.program && !pendingCanvas.program.closed
            ? pendingCanvas.program.address
            : undefined,
    ]);

    const navigate = useNavigate();

    // Initialize a new pending canvas if one doesn't exist.
    useEffect(() => {
        if (peer && !pendingCanvasState) {
            const newCanvas = new CanvasDB({
                publicKey: peer.identity.publicKey,
                path: [], // root canvas
            });
            setPendingCanvasState(newCanvas);
            createSetBase64(newCanvas);
        }
    }, [peer?.identity.publicKey.hashcode()]);

    const savePending = () => {
        setRoot(pendingCanvas.program);
        navigate(`/`);
    };

    // Handle copy action and show feedback.
    const handleCopy = () => {
        let base64ToCopy = base64;
        let hasError = importError || !verifyBase64();
        if (hasError) {
            base64ToCopy = createSetBase64();
        }

        if (base64ToCopy) {
            navigator.clipboard.writeText(base64ToCopy);
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 2000);
        }
    };

    // Update the base64 state as the user types.
    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        setBase64(e.target.value);
    };

    const verifyBase64 = () => {
        setImportError(false);
        try {
            const importedCanvas = deserialize(fromBase64(base64), CanvasDB);
            setPendingCanvasState(importedCanvas);
            return true;
        } catch (error) {
            console.error("Failed to import", error);
            setImportError(true);
            setTimeout(() => setImportError(false), 2000);
            return false;
        }
    };

    // Handle import action.
    const handleImport = () => {
        if (!base64) return;
        verifyBase64();
    };

    return (
        // Outer container for full screen background video
        <div
            className="relative p-4 w-screen overflow-hidden"
            style={{ height: "calc(100vh - 50px)" }}
        >
            {/* Background video */}
            <video
                className="absolute top-0 left-0 w-full h-full object-cover dark:invert"
                src="/turtle720.mp4"
                autoPlay
                muted
                loop
                playsInline
            />
            {/* Main content over the video */}
            <div className="relative z-10 p-4  flex justify-center  overflow-auto">
                {!isLoading ? (
                    <div
                        className="flex flex-col  max-w-[600px] w-full space-y-6 p-10 rounded bg-[#87bbc4b5] dark:bg-[#222627b5]"
                        style={{
                            backdropFilter: "blur(10px)",
                        }}
                    >
                        <div className="flex flex-row gap-4 items-center justify-center">
                            <h2>Create a new Root</h2>
                            <LuSprout size={40} className="text-green-500" />
                        </div>
                        <CanvasWrapper
                            canvas={pendingCanvas.program}
                            draft={true}
                            multiCanvas
                            onSave={savePending}
                        >
                            <div className="flex flex-row gap-4">
                                <Canvas fitWidth draft={true} />
                                <SaveButton icon={IoArrowForward} />
                            </div>
                        </CanvasWrapper>
                        {/* Labeled input field for base64 string with Import and Copy buttons */}
                        <div className="flex flex-col">
                            <label
                                htmlFor="base64-input"
                                className="mb-1 font-semibold"
                            >
                                Root Base64 source (paste to import an existing
                                one)
                            </label>
                            <div className="flex flex-row gap-2 w-full">
                                <input
                                    id="base64-input"
                                    type="text"
                                    value={base64 || ""}
                                    onChange={handleInputChange}
                                    className="p-2 flex-grow border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="Enter or view base64 string"
                                />
                                <button
                                    onClick={handleImport}
                                    className="btn-elevated btn-icon btn-icon-md"
                                    aria-label="Import Base64"
                                >
                                    <IoArrowForward />
                                </button>
                                <button
                                    onClick={handleCopy}
                                    className="btn-elevated btn-icon btn-icon-md"
                                    aria-label="Copy Base64"
                                >
                                    <BsCopy />
                                </button>
                            </div>
                        </div>
                        {/* Global overlay messages in the center of the screen */}
                        {importError && (
                            <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none ">
                                <div className=" text-red-800 px-6 py-3 rounded shadow-lg bg-white dark:bg-black">
                                    Invalid base64!
                                </div>
                            </div>
                        )}
                        {copySuccess && (
                            <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none ">
                                <div className="text-gray-800 px-6 py-3 rounded shadow-lg bg-white dark:bg-black">
                                    Copied to clipboard!
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    <Spinner />
                )}
            </div>
        </div>
    );
};
