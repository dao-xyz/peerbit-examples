import { usePeer, useQuery } from "@peerbit/react";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { PlayIcon, PlusIcon, Pencil1Icon } from "@radix-ui/react-icons";
import { useLibraries } from "./LibrariesContext";
import { useNames } from "../NamesProvider";
import { MediaStreamDBs } from "@peerbit/media-streaming";
import { SpinnerSong } from "../Spinner";

export const Libraries = () => {
    const navigate = useNavigate();
    const { peer } = usePeer();

    /* global stores */
    const { libraries, create, loading: isLoadingLibraries } = useLibraries();
    const { getName } = useNames();

    /* live list of library docs */
    const { items: libraryItems, isLoading: isLoadingQUery } = useQuery(
        libraries?.libraries,
        {
            query: useMemo(() => ({}), []),
            prefetch: true,
            batchSize: 200,
            onChange: {
                merge: true,
            },
        }
    );

    const goToLibrary = async (lib: MediaStreamDBs) => {
        return peer
            .open(lib, {
                existing: "reuse",
                args: {
                    replicate: false,
                },
            })
            .then(() => {
                navigate(`/l/${lib.address}`);
            });
    };
    /* -------- render -------- */
    return (
        <div className="min-h-screen px-6 py-10 bg-gradient-to-bl from-neutral-950 via-neutral-900 to-neutral-800">
            {/* header */}
            <div className="flex items-center justify-between max-w-3xl mx-auto mb-10">
                <h1 className="text-4xl font-extrabold text-white">
                    All Libraries
                </h1>

                {/* create-new button */}
                {isLoadingLibraries ? (
                    <SpinnerSong />
                ) : (
                    <button
                        onClick={async () => {
                            const lib = await create();
                            console.log("NAVIGATE", lib.address);
                            navigate(`/l/${lib.address}`);
                        }}
                        className="flex items-center gap-2 px-4 py-2 rounded-full bg-emerald-500 hover:bg-emerald-600 text-white shadow-lg transition"
                    >
                        <PlusIcon className="w-4 h-4" />
                        {<span className="font-semibold">New Library</span>}
                    </button>
                )}
            </div>

            {/* empty-state  */}
            {!isLoadingQUery && libraryItems.length === 0 && (
                <div className="flex flex-col items-center justify-center h-[60vh] text-neutral-400">
                    No libraries yet
                </div>
            )}

            {isLoadingQUery && (
                <div className="flex flex-col items-center justify-center h-[60vh] text-neutral-400">
                    <SpinnerSong />
                </div>
            )}

            {/* libraries list */}
            <ul className="space-y-3 max-w-3xl mx-auto">
                {libraryItems.map((lib) => {
                    const isOwner = peer?.identity.publicKey.equals(lib.owner);

                    return (
                        <li
                            key={lib.idString}
                            onClick={() => goToLibrary(lib)}
                            className="flex items-center gap-4 p-4 rounded-lg hover:cursor-pointer bg-neutral-800/50 hover:bg-neutral-700/50 transition"
                        >
                            {/* open */}
                            <button className="shrink-0 p-3 bg-white text-neutral-900 rounded-full hover:scale-105 transition">
                                <PlayIcon className="w-4 h-4" />
                            </button>

                            {/* title */}
                            <div className="min-w-0 flex-1">
                                <span className="text-lg font-semibold text-white truncate block">
                                    {getName(lib.id)}
                                </span>
                                <p className="text-xs text-neutral-400">
                                    {lib.idString?.slice(0, 12)}…
                                </p>
                            </div>

                            {isOwner && (
                                <>
                                    <span className="px-2 py-1 text-xs bg-emerald-600 text-white rounded-full">
                                        owner
                                    </span>

                                    {/* placeholder pencil (disabled) */}
                                    <button
                                        disabled
                                        title="edit coming soon"
                                        className="shrink-0 p-2 rounded-full bg-neutral-700 text-neutral-400 cursor-not-allowed"
                                    >
                                        <Pencil1Icon className="w-4 h-4" />
                                    </button>
                                </>
                            )}
                        </li>
                    );
                })}
            </ul>
        </div>
    );
};
