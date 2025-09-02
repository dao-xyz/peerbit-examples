import { useEffect, useMemo, useState } from "react";
import { useCanvases } from "./useCanvas";
import { Spinner } from "../utils/Spinner";
import { Canvas } from "./render/detailed/Canvas";
import { CanvasWrapper } from "./CanvasWrapper";
import { SaveButton } from "./edit/SaveCanvasButton";
import { usePeer } from "@peerbit/react";
import {
    AddressReference,
    Canvas as CanvasDB,
    IndexableCanvas,
    Scope,
} from "@giga-app/interface";
import { useNavigate } from "react-router";
import { LuSprout } from "react-icons/lu";
import { deserialize, serialize } from "@dao-xyz/borsh";
import { fromBase64, toBase64 } from "@peerbit/crypto";
import { BsCopy } from "react-icons/bs";
import { IoArrowForward } from "react-icons/io5";
import { PublicScope, PrivateScope } from "./useScope";
import { WithIndexedContext } from "@peerbit/document";

export const CreateRoot = () => {
    const { setRoot } = useCanvases();
    const { peer } = usePeer();
    const publicScope = PublicScope.useScope();
    const privateScope = PrivateScope.useScope();

    const mounted = useMemo(
        () => [publicScope, privateScope].filter(Boolean) as Scope[],
        [publicScope?.address, privateScope?.address]
    );

    const [isLoading] = useState(false);

    // we keep a raw, serializable draft and an opened+indexed draft for UI
    const [draftRaw, setDraftRaw] = useState<CanvasDB | undefined>();
    const [draftIndexed, setDraftIndexed] = useState<
        WithIndexedContext<CanvasDB, IndexableCanvas> | undefined
    >();

    const [base64, setBase64] = useState<string | undefined>();
    const [importError, setImportError] = useState<string | false>(false);
    const [copySuccess, setCopySuccess] = useState(false);

    const navigate = useNavigate();

    const exportBase64 = (c: CanvasDB | undefined = draftRaw) => {
        if (!c) return;
        const b64 = toBase64(serialize(c));
        setBase64(b64);
        return b64;
    };

    // create a PRIVATE draft once peer + private scope exist
    useEffect(() => {
        (async () => {
            if (!peer || !privateScope) return;
            if (draftRaw) return;

            // make draft private by giving it a private home
            const raw = new CanvasDB({
                publicKey: peer.identity.publicKey,
                selfScope: new AddressReference({
                    address: privateScope.address,
                }),
            });

            // open + register top-level in its home so queries work during drafting
            const opened = await privateScope.openWithSameSettings(raw);
            await privateScope.getOrCreateReply(undefined, opened); // discoverable as root in private
            const indexed = await opened.getSelfIndexedCoerced();

            setDraftRaw(raw);
            setDraftIndexed(indexed);
            exportBase64(raw);
        })().catch(console.error);
    }, [peer?.identity.publicKey.hashcode(), privateScope?.address]);

    // Save: publish to PUBLIC scope (preserve id, set home to public, visible in both)
    const savePending = async () => {
        if (!draftRaw) return;
        if (!publicScope) {
            setImportError(
                "Public scope is not mounted. Open/mount public scope first."
            );
            return;
        }

        // publish as a top-level canvas in the public scope
        // - sync: copies data, preserves id
        // - updateHome:set: changes selfScope to the public scope
        // - visibility:both: mirror link so it’s discoverable from both scopes
        const [, published] = await publicScope.getOrCreateReply(
            undefined,
            draftRaw
        );

        const indexed = await published.getSelfIndexedCoerced();
        setRoot(indexed);
        navigate("/");
    };

    // Import flow: trust selfScope that comes in; do not mutate it here
    const verifyAndImport = () => {
        setImportError(false);
        try {
            if (!base64) return false;
            const imported = deserialize(fromBase64(base64), CanvasDB);
            setDraftRaw(imported);
            // if privateScope matches, open and index for preview
            const home = mounted.find(
                (s) => s.address === imported.selfScope!.address
            );
            if (home) {
                home.openWithSameSettings(imported)
                    .then((o) => o.getSelfIndexedCoerced())
                    .then(setDraftIndexed)
                    .catch(console.error);
            }
            return true;
        } catch (e) {
            console.error("Failed to import", e);
            setImportError("Invalid base64 or Canvas payload");
            setTimeout(() => setImportError(false), 1800);
            return false;
        }
    };

    const handleCopy = () => {
        let b = base64;
        if (!verifyAndImport()) b = exportBase64();
        if (b) {
            navigator.clipboard.writeText(b);
            setCopySuccess(true);
            setTimeout(() => setCopySuccess(false), 1500);
        }
    };

    return (
        <div
            className="relative p-4 w-screen overflow-hidden"
            style={{ height: "calc(100vh - 50px)" }}
        >
            <video
                className="absolute top-0 left-0 w-full h-full object-cover dark:invert"
                src="/turtle720.mp4"
                autoPlay
                muted
                loop
                playsInline
            />
            <div className="relative z-10 p-4 flex justify-center overflow-auto">
                {!isLoading ? (
                    <div
                        className="flex flex-col max-w-[600px] w-full space-y-6 p-10 rounded bg-[#87bbc4b5] dark:bg-[#222627b5]"
                        style={{ backdropFilter: "blur(10px)" }}
                    >
                        <div className="flex flex-row gap-4 items-center justify-center">
                            <h2>
                                Create a new Root (draft privately, publish on
                                save)
                            </h2>
                            <LuSprout size={40} className="text-green-500" />
                        </div>

                        <CanvasWrapper
                            canvas={draftIndexed}
                            draft
                            multiCanvas
                            onSave={savePending}
                        >
                            <div className="flex flex-row gap-4">
                                <Canvas fitWidth draft />
                                <SaveButton icon={IoArrowForward} />
                            </div>
                        </CanvasWrapper>

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
                                    onChange={(e) => setBase64(e.target.value)}
                                    className="p-2 flex-grow border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                    placeholder="Enter or view base64 string"
                                />
                                <button
                                    onClick={() => verifyAndImport()}
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

                        {importError && (
                            <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
                                <div className="text-red-800 px-6 py-3 rounded shadow-lg bg-white dark:bg-black">
                                    {importError}
                                </div>
                            </div>
                        )}
                        {copySuccess && (
                            <div className="fixed inset-0 flex items-center justify-center z-50 pointer-events-none">
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
