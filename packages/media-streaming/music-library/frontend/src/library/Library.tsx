import { MediaStreamDBs, MediaStreamDB } from "@peerbit/media-streaming";
import { useProgram, useQuery, usePeer } from "@peerbit/react";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Pencil1Icon, PlayIcon, TrashIcon } from "@radix-ui/react-icons";
import { Play } from "../play/Play";
import { SpinnerSong } from "../Spinner";
import { usePlayCount } from "../play/PlayStatsContext";
import { useLibraries } from "../libraries/LibrariesContext";
import { useCover } from "../images/useCover";
import { LibraryHeader } from "./LibraryHeader";
import { useNames } from "../NamesProvider";

type Props = {
    db: MediaStreamDB;
    index: number;
    selected: boolean;
    isOwner: boolean;
    buffering?: boolean;
    onPlay: React.MouseEventHandler<HTMLButtonElement>;
    onDelete: () => void;
};

export const TrackPreview: React.FC<Props> = ({
    db,
    index,
    selected,
    isOwner,
    buffering,
    onPlay,
    onDelete,
}) => {
    // cover image hook
    const [coverURL, setCover] = useCover(db.id);

    // play count
    const plays = usePlayCount(db.id);

    // name editing
    const { getName, setName } = useNames();
    const [title, setTitle] = useState(
        () => getName(db.id) || `Track ${index + 1}`
    );
    const [editing, setEditing] = useState(false);

    // keep title in sync when not editing
    useEffect(() => {
        if (!editing) {
            setTitle(getName(db.id) || `Track ${index + 1}`);
        }
    }, [getName, db.id, index, editing]);

    const saveTitle = async () => {
        setEditing(false);
        let trimmed = title.trim();
        if (isOwner && trimmed) {
            await setName(db.id, trimmed);
            setTitle(trimmed);
        }
    };

    // cover‐picker
    const fileInput = useRef<HTMLInputElement>(null);
    const pickImage = () => fileInput.current?.click();
    const onFile = async (ev: React.ChangeEvent<HTMLInputElement>) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        await setCover(file);
        ev.target.value = "";
    };

    return (
        <li
            className={`group relative p-4 rounded-xl shadow-lg transform transition
          bg-neutral-800/60 backdrop-blur-sm
          hover:-translate-y-1 hover:bg-neutral-700/60
          ${selected ? "ring-2 ring-emerald-500" : ""}`}
        >
            {/* cover */}
            <div className="aspect-square rounded-lg bg-neutral-700 mb-4 relative overflow-hidden">
                <img
                    src={
                        coverURL ??
                        `https://picsum.photos/seed/${db.idString.slice(
                            0,
                            6
                        )}/400`
                    }
                    className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition"
                    alt="Track cover"
                />

                {/* play overlay */}
                <button
                    onClick={onPlay}
                    className="absolute inset-0 flex items-center justify-center
              bg-black/40 opacity-0 group-hover:opacity-100 transition"
                    title="Play"
                >
                    <PlayIcon className="w-10 h-10 text-white" />
                </button>

                {/* buffering */}
                {buffering && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                        <SpinnerSong />
                    </div>
                )}

                {/* change cover (owner) */}
                {isOwner && (
                    <>
                        <button
                            onClick={pickImage}
                            title="Change cover"
                            className="absolute top-2 left-2 p-1 bg-black/60 backdrop-blur-sm rounded-full
                  text-white opacity-0 group-hover:opacity-100 transition"
                        >
                            <Pencil1Icon className="w-4 h-4" />
                        </button>
                        <input
                            ref={fileInput}
                            type="file"
                            accept="image/*"
                            onChange={onFile}
                            className="hidden"
                        />
                    </>
                )}

                {/* delete */}
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

                {/* play count */}
                <span
                    className="absolute bottom-2 left-2 px-2 py-0.5 rounded-full
              text-[10px] font-semibold bg-black/70 text-white backdrop-blur-sm"
                >
                    {plays} plays
                </span>
            </div>

            {/* title / ID */}
            <div className="flex items-center gap-2">
                {editing ? (
                    <input
                        className="bg-transparent border-b border-emerald-500 outline-none text-white text-lg font-semibold flex-1"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        onBlur={saveTitle}
                        onKeyDown={(e) => e.key === "Enter" && saveTitle()}
                        autoFocus
                    />
                ) : (
                    <h3
                        className={`text-lg font-semibold text-white truncate flex-1 ${
                            isOwner ? "cursor-text hover:underline" : ""
                        }`}
                        onDoubleClick={() => isOwner && setEditing(true)}
                    >
                        {title}
                    </h3>
                )}

                {/* pencil icon to enter edit mode */}
                {isOwner && !editing && (
                    <button
                        onClick={() => setEditing(true)}
                        className="p-1 text-neutral-400 hover:text-white transition"
                        title="Edit name"
                    >
                        <Pencil1Icon className="w-4 h-4" />
                    </button>
                )}
            </div>

            <p className="text-xs text-neutral-400 mt-1">
                {db.idString.slice(0, 10)}…
            </p>
        </li>
    );
};

export const Library: React.FC = () => {
    const nav = useNavigate();
    const { address } = useParams();
    const { peer } = usePeer();
    const libraries = useLibraries();

    /* open library DB ------------------------------------------------------- */
    const lib = useProgram<MediaStreamDBs>(address, { existing: "reuse" });

    /* load track list ------------------------------------------------------- */
    const { items: tracks, isLoading: tracksLoading } = useQuery(
        lib.program?.mediaStreams,
        {
            query: useMemo(() => ({ query: {} }), []),
            prefetch: true,
            batchSize: 100,
            onChange: {
                merge: true,
            },
            remote: {
                eager: true,
            },
        }
    );

    /* owner? ---------------------------------------------------------------- */
    const isOwner = peer?.identity.publicKey.equals(lib.program?.owner);

    /* currently-selected track (inline player) ------------------------------ */
    const [current, setCurrent] = useState<MediaStreamDB | null>(null);
    const [reloadKey, forceReload] = useReducer((n) => n + 1, 0);

    const playTrack = (db: MediaStreamDB) => {
        peer.open(db, { existing: "reuse" }).then(setCurrent);
    };

    /* deletions ------------------------------------------------------------- */
    const dropTrack = async (db: MediaStreamDB) => {
        await lib.program.mediaStreams.del(db.id);
        await db.drop();
        if (current?.idString === db.idString) setCurrent(null);
    };

    const dropLibrary = async () => {
        if (!isOwner) return;
        await lib.program.drop();
        await libraries.remove(lib.program.id);
        nav("/");
    };

    /* helpers --------------------------------------------------------------- */
    const toUpload = () => nav(`/upload?lib=${address}`);

    /* ------------------------------- render ------------------------------- */
    return (
        <div className="px-6 pt-6 pb-32 flex flex-col gap-6">
            {/* library header (title, cover, actions) */}
            <LibraryHeader onDelete={dropLibrary} onUpload={toUpload} />

            {/* tracks ----------------------------------------------------------- */}
            {lib.loading ? (
                <div className="flex justify-center mt-24">
                    <SpinnerSong />
                </div>
            ) : tracks.length === 0 ? (
                <p className="text-center text-neutral-300 mt-24">
                    Library is empty 🙁
                </p>
            ) : (
                <ul
                    className="grid gap-6 max-w-5xl mx-auto
                     sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
                >
                    {tracks.map((db, i) => {
                        const selected = current?.idString === db.idString;

                        return (
                            <TrackPreview
                                key={db.idString}
                                db={db}
                                index={i}
                                selected={selected}
                                isOwner={isOwner}
                                buffering={false}
                                onPlay={(evt) => {
                                    if (evt.metaKey || evt.ctrlKey) {
                                        nav(`/s/${db.address}`);
                                    } else {
                                        selected
                                            ? forceReload()
                                            : playTrack(db);
                                    }
                                }}
                                onDelete={() => dropTrack(db)}
                            />
                        );
                    })}

                    {tracksLoading && <SpinnerSong />}
                </ul>
            )}

            {/* sticky bottom player ------------------------------------------- */}
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
