/* ───────────────────────── library/LibraryHeader.tsx ───────────────────────── */

import { Share1Icon, TrashIcon, PlayIcon } from "@radix-ui/react-icons";
import { useNavigate, useParams } from "react-router";
import { useNames } from "../NamesProvider";
import { MediaStreamDBs } from "@peerbit/media-streaming";
import { usePeer, useProgram } from "@peerbit/react";
import { useState, useEffect } from "react";
import { useCover } from "../images/useCover";
import { getPicSumLink } from "../images/utils";

type Props = { onDelete(): Promise<void>; onUpload(): void };

export const LibraryHeader: React.FC<Props> = ({ onDelete, onUpload }) => {
    const navigate = useNavigate();
    const params = useParams();
    const { peer } = usePeer();
    const { getName, setName } = useNames();

    /* open the current library so we can read owner & id */
    const lib = useProgram<MediaStreamDBs>(params.address, {
        existing: "reuse",
    });
    const isOwner = peer?.identity.publicKey.equals(lib.program?.owner);

    /* title (editable for owner) */
    const [title, setTitle] = useState<string>();
    const [edit, setEdit] = useState(false);

    useEffect(() => {
        if (lib.program) setTitle(getName(lib.program.id));
    }, [getName, lib.program?.id]);

    const saveTitle = async () => {
        setEdit(false);
        if (isOwner && title?.trim())
            await setName(lib.program!.id, title.trim());
    };

    /* cover helpers */
    const [coverURL, setCover] = useCover(lib.program?.id!);

    /* ─────────────────── UI ─────────────────── */
    return (
        <header className="max-w-5xl mx-auto flex flex-col gap-6 w-full">
            {/* cover */}
            <div className="relative group rounded-2xl overflow-hidden max-h-[300px] aspect-[16/9]">
                {coverURL || lib.program ? (
                    <img
                        src={coverURL ?? getPicSumLink(lib?.program, 960)}
                        className="w-full h-full object-cover"
                    />
                ) : (
                    <div className="h-full"></div>
                )}

                {isOwner && (
                    <>
                        <input
                            id="coverpick"
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) =>
                                e.target.files?.[0] &&
                                setCover(e.target.files[0])
                            }
                        />
                        <label
                            htmlFor="coverpick"
                            className="absolute inset-0 flex items-center justify-center
                           bg-black/40 backdrop-blur-sm opacity-0
                           group-hover:opacity-100 text-white text-sm
                           font-semibold cursor-pointer transition"
                        >
                            Change cover
                        </label>
                    </>
                )}
            </div>

            {/* toolbar */}
            <div className="flex flex-col sm:flex-row sm:items-center gap-4">
                {/* back + title */}
                <div className="flex items-center gap-3 flex-1">
                    <button
                        onClick={() => navigate("/")}
                        className="text-emerald-400 hover:text-emerald-300 transition"
                    >
                        ← Back
                    </button>

                    {edit ? (
                        <input
                            className="bg-transparent border-b border-emerald-500 outline-none
                           text-white text-4xl font-extrabold tracking-tight
                           min-w-[10rem]"
                            style={{
                                width: `${Math.max(title?.length ?? 0, 10)}ch`,
                            }}
                            value={title ?? ""}
                            onChange={(e) => setTitle(e.target.value)}
                            onBlur={saveTitle}
                            onKeyDown={(e) => e.key === "Enter" && saveTitle()}
                            autoFocus
                        />
                    ) : (
                        <h1
                            className={`text-4xl font-extrabold tracking-tight text-white
                            ${isOwner ? "cursor-text hover:underline" : ""}`}
                            onDoubleClick={() => isOwner && setEdit(true)}
                        >
                            {title}
                        </h1>
                    )}

                    {isOwner && (
                        <span
                            className="px-2 py-1 text-xs bg-emerald-600 text-white
                                rounded-full ml-2"
                        >
                            owner
                        </span>
                    )}
                </div>

                {/* actions */}
                <div className="flex gap-2 flex-wrap justify-end">
                    {isOwner && (
                        <button
                            onClick={onUpload}
                            className="px-4 py-2 rounded-full bg-emerald-500
                           hover:bg-emerald-600 text-white shadow-lg transition"
                        >
                            Upload
                        </button>
                    )}

                    <button
                        onClick={() =>
                            navigator.clipboard.writeText(window.location.href)
                        }
                        className="flex items-center gap-2 px-4 py-2 rounded-full
                         bg-neutral-700 hover:bg-neutral-600 text-white
                         shadow-lg transition"
                    >
                        <Share1Icon /> Share
                    </button>

                    {isOwner && (
                        <button
                            onClick={onDelete}
                            className="flex items-center gap-2 px-4 py-2 rounded-full
                           bg-red-600 hover:bg-red-700 text-white shadow-lg transition"
                        >
                            <TrashIcon /> Delete
                        </button>
                    )}
                </div>
            </div>
        </header>
    );
};
