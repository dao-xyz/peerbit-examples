// library/Library.tsx
import { MediaStreamDBs, MediaStreamDB } from "@peerbit/media-streaming";
import { useProgram, useQuery, usePeer } from "@peerbit/react";
import { useEffect, useMemo, useReducer, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { PlayIcon, Share1Icon, TrashIcon } from "@radix-ui/react-icons";
import { useNames } from "../NamesProvider";
import { Play } from "../play/Play";
import { SpinnerSong } from "../Spinner";
import { usePlayCount } from "../play/PlayStatsContext";
import { useLibraries } from "../libraries/LibrariesContext";

type Props = {
    /** The actual media-stream document */
    db: MediaStreamDB;
    /** True if this track is the one currently playing */
    selected: boolean;
    /** Are we the owner of the library? */
    isOwner: boolean;
    /** (click) start / resume playback */
    onPlay: React.MouseEventHandler<HTMLButtonElement>;
    /** (click) delete track – only shown for owner */
    onDelete: () => void;
    /** order # in the list – purely cosmetic */
    index: number;
    /** optional: show spinner overlay while (re)buffering */
    buffering?: boolean;
};

export const TrackPreview: React.FC<Props> = ({
    db,
    selected,
    isOwner,
    onPlay,
    onDelete,
    index,
    buffering,
}) => {
    const plays = usePlayCount(db.id); // live counter ⏲️
    return (
        <li
            className={`group relative rounded-xl p-4 shadow-lg transform transition
                    bg-neutral-800/60 backdrop-blur-sm
                    hover:-translate-y-1 hover:bg-neutral-700/60
                    ${selected ? "ring-2 ring-emerald-500" : ""}`}
        >
            {/* album-art style cover */}
            <div className="aspect-square rounded-lg bg-neutral-700 mb-4 relative overflow-hidden">
                <img
                    src={`https://picsum.photos/seed/${db.idString.slice(
                        0,
                        6
                    )}/400`}
                    className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition"
                />

                {/* play overlay */}
                <button
                    onClick={onPlay}
                    className="absolute inset-0 flex items-center justify-center
                       bg-black/40 opacity-0 group-hover:opacity-100 transition hover:cursor-pointer"
                    title="Play"
                >
                    <PlayIcon className="w-10 h-10 text-white" />
                </button>

                {/* buffering spinner while starting / seeking */}
                {buffering && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                        <SpinnerSong />
                    </div>
                )}

                {/* delete (owner only) */}
                {isOwner && (
                    <button
                        onClick={onDelete}
                        className="absolute top-2 right-2 p-1 bg-red-600/80 hover:bg-red-700
                         rounded-full text-white opacity-0 group-hover:opacity-100 transition"
                        title="Delete track"
                    >
                        <TrashIcon className="w-4 h-4" />
                    </button>
                )}

                {/* play-counter badge */}
                <span
                    className="absolute bottom-2 left-2 px-2 py-0.5 rounded-full text-[10px] font-semibold
                           bg-black/70 text-white backdrop-blur-sm"
                >
                    {plays} plays
                </span>
            </div>

            {/* title & ID */}
            <h3 className="text-lg font-semibold text-white">
                Track {index + 1}
            </h3>
            <p className="text-xs text-neutral-400">
                {db.idString.slice(0, 10)}…
            </p>
        </li>
    );
};

export const Library = () => {
    const nav = useNavigate();
    const { address } = useParams();
    const { peer } = usePeer();
    const { getName, setName } = useNames();
    const libraries = useLibraries();

    /* open db --------------------------------------------------------------- */
    const lib = useProgram<MediaStreamDBs>(address, { existing: "reuse" });

    /* tracks ---------------------------------------------------------------- */
    const { items: tracks, isLoading: isLoadingQuery } = useQuery(
        lib.program?.mediaStreams,
        {
            query: useMemo(() => ({ query: {} }), []),
            prefetch: true,
            batchSize: 100,
        }
    );

    /* owner + title --------------------------------------------------------- */
    const isOwner = peer?.identity.publicKey.equals(lib.program?.owner);
    const [title, setT] = useState<string>();
    const [editing, setE] = useState(false);
    const [reloadKey, forceReload] = useReducer((n) => n + 1, 0); // ← NB: reloadKey, not the dispatch fn

    useEffect(() => {
        if (lib.program) setT(getName(lib.program.id));
    }, [lib.program?.id, getName]);

    const save = async () => {
        setE(false);
        if (isOwner && title?.trim())
            await setName(lib.program.id, title.trim());
    };

    /* selected track → inline player --------------------------------------- */
    const [current, setCurrent] = useState<MediaStreamDB | null>(null);
    const playTrack = (db: MediaStreamDB) => {
        peer.open(db, { existing: "reuse" }).then((db) => setCurrent(db));
    };

    /* deletions ------------------------------------------------------------- */
    const dropTrack = async (db: MediaStreamDB) => {
        await lib.program.mediaStreams.del(db.id);
        await db.drop();
        if (current?.address === db.address) {
            setCurrent(null);
        }
    };
    const dropLibrary = async () => {
        if (!isOwner) return;
        await lib.program.drop();
        await libraries.remove(lib.program.id);
        nav("/");
    };

    /* helpers --------------------------------------------------------------- */
    const toUpload = () => nav(`/upload?lib=${address}`);
    const toShare = () => navigator.clipboard.writeText(window.location.href);

    const isLoading = lib.loading || isLoadingQuery;

    /* ----------------------------- UI ------------------------------------- */
    return (
        <div className="px-6 pt-6 pb-32">
            {" "}
            {/* pb for bottom player */}
            {/* header */}
            <header className="max-w-5xl mx-auto mb-8 flex flex-col sm:flex-row sm:items-center gap-4">
                {/* ← back + title */}
                <div className="flex items-center gap-3 flex-1">
                    <button
                        onClick={() => nav("/")}
                        className="text-emerald-400 hover:text-emerald-300 transition"
                    >
                        ← Back
                    </button>

                    {editing ? (
                        <input
                            className="bg-transparent border-b border-emerald-500 outline-none
                           text-white text-4xl font-extrabold tracking-tight
                           min-w-[10rem]"
                            style={{
                                width: `${Math.max(title?.length ?? 0, 10)}ch`,
                            }}
                            value={title ?? ""}
                            onChange={(e) => setT(e.target.value)}
                            onBlur={save}
                            onKeyDown={(e) => e.key === "Enter" && save()}
                            autoFocus
                        />
                    ) : (
                        <h1
                            className={`text-4xl font-extrabold tracking-tight text-white ${
                                isOwner ? "cursor-text hover:underline" : ""
                            }`}
                            onDoubleClick={() => isOwner && setE(true)}
                        >
                            {title}
                        </h1>
                    )}

                    {isOwner && (
                        <span className="px-2 py-1 text-xs bg-emerald-600 text-white rounded-full">
                            owner
                        </span>
                    )}
                </div>

                {/* actions */}
                <div className="flex gap-2 flex-wrap justify-end">
                    {isOwner && (
                        <button
                            onClick={toUpload}
                            className="px-4 py-2 rounded-full bg-emerald-500 hover:bg-emerald-600
                           text-white shadow-lg transition"
                        >
                            Upload
                        </button>
                    )}

                    <button
                        onClick={toShare}
                        className="flex items-center gap-2 px-4 py-2 rounded-full
                         bg-neutral-700 hover:bg-neutral-600 text-white shadow-lg transition"
                    >
                        <Share1Icon /> Share
                    </button>

                    {isOwner && (
                        <button
                            onClick={dropLibrary}
                            className="flex items-center gap-2 px-4 py-2 rounded-full
                           bg-red-600 hover:bg-red-700 text-white shadow-lg transition"
                        >
                            <TrashIcon /> Delete
                        </button>
                    )}
                </div>
            </header>
            {/* grid of tracks */}
            {isLoading ? (
                <div className="w-full flex justify-center items-center ">
                    <SpinnerSong />
                </div>
            ) : tracks.length === 0 ? (
                <div className="w-full flex justify-center items-center">
                    <span>Library is empty :(</span>
                </div>
            ) : (
                <ul className="grid gap-6 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 max-w-5xl mx-auto">
                    {tracks.map((db, i) => {
                        const selected = current?.idString === db.idString;
                        return (
                            <TrackPreview
                                index={i}
                                key={db.idString}
                                db={db}
                                selected={selected}
                                isOwner={isOwner}
                                onPlay={(e) => {
                                    if (e.metaKey || e.ctrlKey)
                                        nav(`/s/${db.address}`);
                                    else {
                                        if (selected) {
                                            forceReload();
                                        } else {
                                            playTrack(db);
                                        }
                                    }
                                }}
                                onDelete={() => dropTrack(db)}
                            />
                        );
                    })}
                </ul>
            )}
            {/* sticky bottom player */}
            {current && (
                <div className="fixed inset-x-0 bottom-0">
                    <Play
                        key={current.idString}
                        source={current}
                        reloadKey={reloadKey}
                    />
                </div>
            )}
        </div>
    );
};
