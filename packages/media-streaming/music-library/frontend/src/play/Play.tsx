import React, { useEffect, useReducer, useRef, useState } from "react";
import {
    MediaStreamDB,
    Track,
    AudioStreamDB,
    Chunk,
} from "@peerbit/media-streaming";
import { usePeer } from "@peerbit/react";
import { createAudioStreamListener } from "@peerbit/media-streaming-web";
import { useNames } from "../NamesProvider";
import {
    ReloadIcon,
    SpeakerLoudIcon,
    SpeakerOffIcon,
} from "@radix-ui/react-icons";
import * as Popover from "@radix-ui/react-popover";
import { SpinnerCircle } from "../Spinner";
import { usePlayStats } from "./PlayStatsContext";

type Props = {
    autoPlay?: boolean;
    source: MediaStreamDB;
    start?: number /* seconds */;
    reloadKey?: number;
};

export const Play: React.FC<Props> = ({
    reloadKey: outerReloadKey,
    source,
    start = 0,
}) => {
    const { peer } = usePeer();
    const { getName, setName } = useNames();

    /* ───────── title ───────── */
    const isOwner = peer?.identity.publicKey.equals(source.owner);
    const [title, setTitle] = useState(() => getName(source.id));
    const [edit, setE] = useState(false);

    useEffect(() => {
        if (!edit) {
            setTitle(getName(source.id));
        }
    }, [edit, getName, source.idString]);

    const save = async () => {
        setE(false);
        if (isOwner && title.trim()) await setName(source.id, title.trim());
    };

    /* ───────── player state ───────── */
    const [playing, _setPlaying] = useState(false);
    const { addPlay } = usePlayStats();
    const playedOnce = useRef(false);
    const setPlaying = (value: boolean) => {
        console.log(value);
        _setPlaying(value);
        if (value) {
            playedOnce.current = true;
            addPlay({
                duration: 0, // todo
                sourceId: source.id,
            });
        }
    };

    const [volume, setVolume] = useState(1);

    /** ratio 0–1 (👉 iterate progress) */
    const [progress, setProgress] = useState(0);
    const [currentS, setNow] = useState(start);
    const [maxS, setMax] = useState(0);

    /* force reload helper */
    const [reloadKey, forceReload] = useReducer((n) => n + 1, 0);
    useEffect(() => {
        if (!playedOnce.current) return;
        forceReload();
    }, [outerReloadKey]);

    /* listeners map */
    const refs = useRef<
        Map<string, ReturnType<typeof createAudioStreamListener>>
    >(new Map());
    const iteratorRef = useRef<Awaited<
        ReturnType<typeof source.iterate>
    > | null>(null);
    const iteratorId = useRef<number>(0);

    const [isLoading, setIsLoading] = useState(false);

    const endedRef = useRef(false);

    /* ───────── iterate loop ───────── */
    useEffect(() => {
        if (!peer || source.closed) return;
        let stop = false;

        const id = ++iteratorId.current; // unique for this invocation
        let cancelled = false;

        iteratorRef.current?.close();
        iteratorRef.current = null;
        endedRef.current = false;
        playedOnce.current = false;
        setIsLoading(true);

        let thisIterator: Awaited<ReturnType<typeof source.iterate>> | null =
            null;
        (async () => {
            console.log("START PROGRESS", progress);
            thisIterator = await source.iterate(progress, {
                keepTracksOpen: true,
                replicate: false,
                debug: false,
                onTrackOptionsChange: (track) => {
                    console.log("TRACK OPTIONS CHANGED", track);
                },
                onTracksChange: (tracks) => {
                    console.log("TRACKS CHANGED", tracks);
                },
                onProgress: ({ track, chunk }) => {
                    setIsLoading(false);
                    if (cancelled || id !== iteratorId.current) {
                        return; // obsolete
                    }
                    if (stop) {
                        return;
                    }

                    push(track as Track<AudioStreamDB>, chunk);
                    setNow(Math.round((track.startTime + chunk.time) / 1e3));
                },
                onClose: () => {
                    if (cancelled || id !== iteratorId.current) {
                        return; // obsolete
                    }
                    setIsLoading(false);
                    setPlaying(false);
                    endedRef.current = true;
                },
                onMaxTimeChange: ({ maxTime }) =>
                    setMax(Math.max(maxTime / 1e3, maxS)),
                closeOnEnd: true,
            });

            if (id !== iteratorId.current) {
                await thisIterator.close();
                return;
            }

            iteratorRef.current = thisIterator;
            iteratorRef.current.play();
            setPlaying(true);
        })().finally(() => {
            if (id !== iteratorId.current) {
                return;
            }
        });

        return () => {
            stop = true;
            cancelled = true;
            thisIterator?.close();
            iteratorRef.current?.close();
            iteratorRef.current = null;
            refs.current.forEach((l) => l.close());
            refs.current.clear();
        };
    }, [
        peer?.identity.publicKey.hashcode(),
        source.idString,
        source.closed,
        progress,
        reloadKey, // triggers restart
    ]);

    /* send incoming chunk to listener */
    const push = async (track: Track<AudioStreamDB>, chunk: Chunk) => {
        let l = refs.current.get(track.idString);
        if (!l) {
            l = createAudioStreamListener(track, playing, {
                debug: true,
            });
            l.setVolume?.(volume);
            await l.play();
            refs.current.set(track.idString, l);
        }
        l.push(chunk);
    };

    /* ───────── handlers ───────── */
    const togglePlay = () => {
        if (endedRef.current) {
            forceReload();
            return;
        }

        const next = !playing;
        refs.current.forEach((l) => (next ? l.play() : l.pause()));
        setPlaying(next);
    };

    /** seek → seconds */
    const seek = (sec: number) => {
        if (maxS === 0) return;
        const ratio = Math.min(Math.max(sec / maxS, 0), 1);
        if (ratio === progress) {
            forceReload(); // replay the same pos
        } else {
            refs.current.forEach((l) => l.close());
            setPlaying(false);
            setProgress(ratio);
        }
    };

    const changeVol = (v: number) => {
        setVolume(v);
        refs.current.forEach((l) => l.setVolume?.(v));
    };

    /* ───────── UI ───────── */
    return (
        <div className="rounded-t-xl bg-neutral-900/90 backdrop-blur-md px-4 py-3">
            {/* progress */}
            <div className="flex items-center gap-3 mb-2">
                <span className="text-xs text-neutral-400 w-10 text-right">
                    {Math.floor(currentS / 1e3)}s
                </span>
                <input
                    type="range"
                    min={0}
                    max={maxS || 0}
                    step={0.1}
                    value={currentS}
                    onChange={(e) => seek(parseFloat(e.target.value))}
                    className="flex-1 accent-emerald-500"
                />
                <span className="text-xs text-neutral-400 w-10">
                    {Math.round(maxS / 1e3)}s
                </span>
            </div>

            {/* controls */}
            <div className="flex items-center gap-4">
                {/* ▶ / ⏸ */}

                <button
                    onClick={togglePlay}
                    className="w-10 h-10 flex justify-center items-center bg-white text-neutral-900 rounded-full hover:scale-105 transition"
                >
                    {isLoading ? (
                        <SpinnerCircle />
                    ) : playing ? (
                        <svg
                            viewBox="0 0 24 24"
                            className="w-4 h-4 fill-neutral-900"
                        >
                            <path d="M5 4h4v16H5zm10 0h4v16h-4z" />
                        </svg>
                    ) : (
                        <svg
                            viewBox="0 0 24 24"
                            className="w-4 h-4 fill-neutral-900"
                        >
                            <path d="M5 3l14 9-14 9V3z" />
                        </svg>
                    )}
                </button>

                {/* ↻ */}
                <button
                    onClick={() => seek(0)}
                    className="p-2 text-neutral-300 hover:text-white transition"
                    title="Replay"
                >
                    <ReloadIcon className="w-5 h-5" />
                </button>

                {/* volume popover */}
                <Popover.Root>
                    <Popover.Trigger asChild>
                        <button
                            className="p-2 text-neutral-300 hover:text-white transition"
                            title="Volume"
                        >
                            {volume === 0 ? (
                                <SpeakerOffIcon className="w-5 h-5" />
                            ) : (
                                <SpeakerLoudIcon className="w-5 h-5" />
                            )}
                        </button>
                    </Popover.Trigger>
                    <Popover.Content
                        side="top"
                        align="start"
                        sideOffset={6}
                        className="rounded-md bg-neutral-800 p-4 shadow-lg"
                    >
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={volume}
                            onChange={(e) =>
                                changeVol(parseFloat(e.target.value))
                            }
                            className="w-40 accent-emerald-500"
                        />
                    </Popover.Content>
                </Popover.Root>

                {/* title */}
                <div className="min-w-0 flex-1">
                    {edit ? (
                        <input
                            className="bg-transparent border-b border-emerald-500 outline-none text-white w-full max-w-xs"
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            onBlur={save}
                            onKeyDown={(e) => e.key === "Enter" && save()}
                            autoFocus
                        />
                    ) : (
                        <span
                            className={`text-white font-semibold truncate block ${
                                isOwner ? "cursor-text hover:underline" : ""
                            }`}
                            onDoubleClick={() => isOwner && setE(true)}
                        >
                            {title}
                        </span>
                    )}
                </div>
            </div>
        </div>
    );
};
