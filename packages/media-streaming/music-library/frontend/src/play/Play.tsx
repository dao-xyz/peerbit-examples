import React, { useEffect, useReducer, useRef, useState } from "react";
import {
    MediaStreamDB,
    Track,
    AudioStreamDB,
    Chunk,
} from "@peerbit/media-streaming";
import { usePeer } from "@peerbit/react";
import {
    createAudioStreamListener,
    createKeyedRetryBackoff,
    createPlaybackGenerationLifecycle,
    createRetryableResourceDrain,
    reconcilePlaybackRequest,
    runProgressCallback,
} from "@peerbit/media-streaming-web";
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

type AudioListener = ReturnType<typeof createAudioStreamListener>;
type PlaybackIterator = Awaited<ReturnType<MediaStreamDB["iterate"]>>;

const MUSIC_ITERATOR_CLEANUP_OWNER = {};
const MUSIC_LISTENER_CLEANUP_OWNER = {};
const reportPlaybackIteratorCleanup = (error: unknown) =>
    console.error("Failed to close media playback", error);
const reportAudioListenerCleanup = (error: unknown) =>
    console.error("Failed to stop audio playback", error);

const throwPlaybackFailures = (failures: unknown[], message: string) => {
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, message);
    }
};

const settlePlaybackOperations = async (
    operations: (() => void | Promise<void>)[],
    message: string
) => {
    const results = await Promise.allSettled(
        operations.map((operation) => Promise.resolve().then(operation))
    );
    throwPlaybackFailures(
        results
            .filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected"
            )
            .map((result) => result.reason),
        message
    );
};

const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

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
    const playingRef = useRef(false);
    const requestedPlaying = useRef(false);
    const setPlaying = (value: boolean) => {
        const changed = playingRef.current !== value;
        playingRef.current = value;
        _setPlaying(value);
        if (value && changed) {
            playedOnce.current = true;
            addPlay({
                duration: 0, // todo
                sourceId: source.id,
            });
        }
    };

    const [volume, setVolume] = useState(1);
    const volumeRef = useRef(volume);

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
        Map<string, { generation: number; listener: AudioListener }>
    >(new Map());
    const listenerCreations = useRef<
        Map<
            string,
            {
                generation: number;
                promise: Promise<AudioListener | undefined>;
            }
        >
    >(new Map());
    const listenerRetryBackoff = useRef(createKeyedRetryBackoff<string>());
    const iteratorRef = useRef<{
        generation: number;
        iterator: PlaybackIterator;
    } | null>(null);
    const retiredIteratorOwnership = useRef(new WeakSet<PlaybackIterator>());
    const iteratorId = useRef<number>(0);
    const activePlayback = useRef<
        | {
              generation: number;
              controller: AbortController;
          }
        | undefined
    >(undefined);
    const controlIntent = useRef(0);
    const controlTail = useRef<Promise<void>>(Promise.resolve());

    const iteratorCleanup = useRef<
        | ReturnType<typeof createRetryableResourceDrain<PlaybackIterator>>
        | undefined
    >(undefined);
    iteratorCleanup.current ??= createRetryableResourceDrain<PlaybackIterator>({
        onError: reportPlaybackIteratorCleanup,
        autoRetry: {},
        durableOwner: MUSIC_ITERATOR_CLEANUP_OWNER,
    });

    const listenerCleanup = useRef<
        | ReturnType<typeof createRetryableResourceDrain<AudioListener>>
        | undefined
    >(undefined);
    listenerCleanup.current ??= createRetryableResourceDrain<AudioListener>({
        onError: reportAudioListenerCleanup,
        autoRetry: {},
        durableOwner: MUSIC_LISTENER_CLEANUP_OWNER,
    });

    const [isLoading, setIsLoading] = useState(false);
    const [playbackError, setPlaybackError] = useState<string>();

    const endedRef = useRef(false);

    useEffect(() => {
        listenerRetryBackoff.current.clear();
    }, [source.idString]);

    const detachListeners = (generation?: number) => {
        const listeners: AudioListener[] = [];
        for (const [trackId, entry] of refs.current) {
            if (generation == null || entry.generation === generation) {
                refs.current.delete(trackId);
                listeners.push(entry.listener);
            }
        }
        return listeners;
    };

    const retirePlayback = async (
        generation?: number,
        iterator?: PlaybackIterator | null
    ) => {
        const iterators = new Set<PlaybackIterator>();
        if (iterator) {
            iterators.add(iterator);
        }
        const currentIterator = iteratorRef.current;
        if (
            currentIterator &&
            (generation == null || currentIterator.generation === generation)
        ) {
            iteratorRef.current = null;
            iterators.add(currentIterator.iterator);
        }

        const newlyRetiredIterators = [...iterators].filter((candidate) => {
            if (retiredIteratorOwnership.current.has(candidate)) {
                return false;
            }
            // The retryable drain owns this exact iterator from here on. This
            // prevents overlapping seek/effect teardown from closing it twice.
            retiredIteratorOwnership.current.add(candidate);
            return true;
        });

        await Promise.all([
            iteratorCleanup.current!.enqueue(newlyRetiredIterators),
            listenerCleanup.current!.enqueue(detachListeners(generation)),
        ]);
    };

    const isCurrentPlayback = (
        generation: number,
        controller: AbortController
    ) =>
        !controller.signal.aborted &&
        iteratorId.current === generation &&
        activePlayback.current?.generation === generation;

    /* send an incoming chunk to one generation-owned listener */
    const push = async (
        track: Track<AudioStreamDB>,
        chunk: Chunk,
        generation: number,
        controller: AbortController
    ): Promise<boolean> => {
        if (!isCurrentPlayback(generation, controller)) {
            return false;
        }

        const trackId = track.idString;
        let entry = refs.current.get(trackId);
        if (entry && entry.generation !== generation) {
            refs.current.delete(trackId);
            await listenerCleanup.current!.enqueue([entry.listener]);
            entry = undefined;
        }

        let listener = entry?.listener;
        if (!listener) {
            let pending = listenerCreations.current.get(trackId);
            if (!pending || pending.generation !== generation) {
                if (!listenerRetryBackoff.current.canAttempt(trackId)) {
                    return false;
                }
                const promise = (async () => {
                    let candidate: AudioListener | undefined;
                    let retirementAttempted = false;
                    const retireCandidate = async () => {
                        if (!candidate || retirementAttempted) {
                            return;
                        }
                        retirementAttempted = true;
                        await listenerCleanup.current!.enqueue([candidate]);
                    };
                    try {
                        // A listener whose close failed is detached from refs,
                        // so it cannot be reused. Drain that debt before
                        // creating another AudioContext-backed listener.
                        await listenerCleanup.current!.retry();
                        if (listenerCleanup.current!.pendingCount() > 0) {
                            throw new Error(
                                "Previous audio playback cleanup is still pending"
                            );
                        }
                        if (!isCurrentPlayback(generation, controller)) {
                            return undefined;
                        }

                        const existing = refs.current.get(trackId);
                        if (existing?.generation === generation) {
                            listenerRetryBackoff.current.recordSuccess(trackId);
                            return existing.listener;
                        }

                        candidate = createAudioStreamListener(
                            track,
                            requestedPlaying.current,
                            {
                                debug: true,
                                minExpectedLatency: 3e2, // keep 3 seconds of buffer before playing
                            }
                        );
                        candidate.setVolume?.(volumeRef.current);

                        await reconcilePlaybackRequest({
                            isCurrent: () =>
                                isCurrentPlayback(generation, controller),
                            readRequest: () => ({
                                request: controlIntent.current,
                                shouldPlay: requestedPlaying.current,
                            }),
                            apply: (intent) =>
                                intent ? candidate!.play() : candidate!.pause(),
                            unstableMessage:
                                "The audio listener playback state changed too often to settle",
                        });

                        if (!isCurrentPlayback(generation, controller)) {
                            await retireCandidate();
                            return undefined;
                        }

                        const racedListener = refs.current.get(trackId);
                        if (racedListener?.generation === generation) {
                            await retireCandidate();
                            listenerRetryBackoff.current.recordSuccess(trackId);
                            return racedListener.listener;
                        }
                        refs.current.set(trackId, {
                            generation,
                            listener: candidate,
                        });
                        listenerRetryBackoff.current.recordSuccess(trackId);
                        return candidate;
                    } catch (error) {
                        if (candidate && !retirementAttempted) {
                            await retireCandidate();
                        }
                        if (isCurrentPlayback(generation, controller)) {
                            listenerRetryBackoff.current.recordFailure(trackId);
                        }
                        throw error;
                    }
                })();
                pending = { generation, promise };
                listenerCreations.current.set(trackId, pending);
                void promise
                    .finally(() => {
                        if (
                            listenerCreations.current.get(trackId) === pending
                        ) {
                            listenerCreations.current.delete(trackId);
                        }
                    })
                    .catch(() => {});
            }
            listener = await pending.promise;
        }

        if (!listener || !isCurrentPlayback(generation, controller)) {
            return false;
        }
        try {
            listener.push(chunk);
            return true;
        } catch (error) {
            const currentEntry = refs.current.get(trackId);
            if (currentEntry?.listener === listener) {
                refs.current.delete(trackId);
            }
            listenerRetryBackoff.current.recordFailure(trackId);
            await listenerCleanup.current!.enqueue([listener]);
            throw error;
        }
    };

    /* ───────── iterate loop ───────── */
    useEffect(() => {
        if (!peer || source.closed) return;

        const generation = ++iteratorId.current;
        const controller = new AbortController();
        activePlayback.current = { generation, controller };
        const generationLifecycle = createPlaybackGenerationLifecycle({
            generation,
            controller,
            currentGeneration: () => iteratorId.current,
            advanceGeneration: () => {
                iteratorId.current += 1;
            },
            activeGeneration: () => activePlayback.current?.generation,
            clearActiveGeneration: () => {
                activePlayback.current = undefined;
            },
        });
        controlIntent.current++;
        requestedPlaying.current = true;
        endedRef.current = false;
        playedOnce.current = false;
        setPlaying(false);
        setIsLoading(true);
        setPlaybackError(undefined);

        let thisIterator: PlaybackIterator | null = null;
        const callbacksCurrent = generationLifecycle.isCurrent;
        (async () => {
            // The previous cleanup may still be draining. Enqueuing an empty
            // retry serializes startup behind it and retries any retained debt.
            await Promise.all([
                iteratorCleanup.current!.retry(),
                listenerCleanup.current!.retry(),
            ]);
            if (
                iteratorCleanup.current!.pendingCount() > 0 ||
                listenerCleanup.current!.pendingCount() > 0
            ) {
                throw new Error(
                    "Previous media playback cleanup is still pending"
                );
            }
            if (!isCurrentPlayback(generation, controller)) {
                return;
            }

            console.log("START PROGRESS", progress);
            thisIterator = await source.iterate(progress, {
                signal: controller.signal,
                keepTracksOpen: true,
                /*  replicate: true, */
                debug: false,
                onProgress: async ({ track, chunk }) => {
                    await runProgressCallback({
                        isCurrent: callbacksCurrent,
                        process: () =>
                            push(
                                track as Track<AudioStreamDB>,
                                chunk,
                                generation,
                                controller
                            ),
                        onProcessed: () => {
                            setIsLoading(false);
                            setPlaybackError(undefined);
                            setNow(
                                Math.round((track.startTime + chunk.time) / 1e3)
                            );
                        },
                        onDeferred: () => {
                            // Retry remains automatic, but a controller
                            // cooldown must not pin the controls to a spinner.
                            setIsLoading(false);
                        },
                        onFailure: (error) => {
                            console.error(
                                "Failed to process audio chunk",
                                error
                            );
                            setIsLoading(false);
                            setPlaybackError(
                                `Playback failed: ${errorMessage(error)}`
                            );
                        },
                    });
                },
                onClose: () => {
                    if (
                        !generationLifecycle.terminate(
                            "Media playback completed"
                        )
                    ) {
                        return;
                    }
                    // Fence synchronously before state or async cleanup. A
                    // listener.play() already in flight must observe staleness
                    // and retire its candidate instead of publishing it.
                    controlIntent.current += 1;
                    requestedPlaying.current = false;
                    setIsLoading(false);
                    setPlaying(false);
                    setPlaybackError(undefined);
                    endedRef.current = true;
                    void retirePlayback(generation, thisIterator);
                },
                onMaxTimeChange: ({ maxTime }) => {
                    if (!callbacksCurrent()) {
                        return;
                    }
                    setMax((currentMax) => Math.max(maxTime / 1e3, currentMax));
                },
            });

            if (!callbacksCurrent()) {
                await retirePlayback(generation, thisIterator);
                return;
            }

            await reconcilePlaybackRequest({
                isCurrent: callbacksCurrent,
                readRequest: () => ({
                    request: controlIntent.current,
                    shouldPlay: requestedPlaying.current,
                }),
                apply: (intent) =>
                    intent ? thisIterator!.play() : thisIterator!.pause(),
                isApplied: (intent) => thisIterator!.paused !== intent,
                notAppliedMessage: (intent) =>
                    `The media iterator failed to ${
                        intent ? "resume" : "pause"
                    }`,
                unstableMessage:
                    "The media iterator playback state changed too often to settle",
            });
            if (!callbacksCurrent()) {
                await retirePlayback(generation, thisIterator);
                return;
            }

            iteratorRef.current = { generation, iterator: thisIterator };
            setPlaying(!thisIterator.paused);
        })().catch(async (error) => {
            let reportedError = error;
            let cleanupFailed = false;
            try {
                await retirePlayback(generation, thisIterator);
            } catch (cleanupError) {
                cleanupFailed = true;
                reportedError = new AggregateError(
                    [error, cleanupError],
                    "Failed to start and retire media playback"
                );
            }
            if (callbacksCurrent()) {
                console.error("Failed to start media playback", reportedError);
                generationLifecycle.terminate("Media playback failed");
                requestedPlaying.current = false;
                endedRef.current = true;
                setIsLoading(false);
                setPlaying(false);
                setPlaybackError(
                    `Unable to start playback: ${errorMessage(reportedError)}`
                );
            } else if (cleanupFailed) {
                console.error(
                    "Failed to retire obsolete media playback",
                    reportedError
                );
            }
        });

        return () => {
            generationLifecycle.terminate("Media playback replaced");
            controlIntent.current++;
            requestedPlaying.current = false;
            void retirePlayback(generation, thisIterator);
        };
    }, [
        peer?.identity.publicKey.hashcode(),
        source.idString,
        source.closed,
        progress,
        reloadKey, // triggers restart
    ]);

    /* ───────── handlers ───────── */
    const setPlaybackState = (next: boolean) => {
        requestedPlaying.current = next;
        const request = ++controlIntent.current;
        const generation = iteratorId.current;
        const operation = controlTail.current
            .catch(() => {})
            .then(async () => {
                if (request !== controlIntent.current) {
                    return;
                }

                const iteratorEntry = iteratorRef.current;
                const iterator =
                    iteratorEntry?.generation === generation
                        ? iteratorEntry.iterator
                        : undefined;
                const listeners = [...refs.current.values()]
                    .filter((entry) => entry.generation === generation)
                    .map((entry) => entry.listener);

                if (next) {
                    try {
                        await settlePlaybackOperations(
                            listeners.map((listener) => () => listener.play()),
                            "Failed to resume audio playback"
                        );
                        if (iterator) {
                            await iterator.play();
                        }
                    } catch (error) {
                        await Promise.allSettled(
                            listeners.map((listener) =>
                                Promise.resolve().then(() => listener.pause())
                            )
                        );
                        throw error;
                    }
                } else {
                    await settlePlaybackOperations(
                        [
                            ...(iterator ? [() => iterator.pause()] : []),
                            ...listeners.map(
                                (listener) => () => listener.pause()
                            ),
                        ],
                        "Failed to pause media playback"
                    );
                }

                if (
                    request === controlIntent.current &&
                    generation === iteratorId.current
                ) {
                    const current = iteratorRef.current;
                    setPlaybackError(undefined);
                    setPlaying(
                        current?.generation === generation
                            ? !current.iterator.paused
                            : false
                    );
                }
            });

        const reconciled = operation.catch((error) => {
            if (
                request === controlIntent.current &&
                generation === iteratorId.current
            ) {
                const current = iteratorRef.current;
                const actual =
                    current?.generation === generation
                        ? !current.iterator.paused
                        : false;
                requestedPlaying.current = actual;
                setPlaying(actual);
            }
            throw error;
        });
        controlTail.current = reconciled.catch(() => {});
        return reconciled;
    };

    const togglePlay = async () => {
        if (endedRef.current) {
            forceReload();
            return;
        }

        const next = !requestedPlaying.current;
        try {
            await setPlaybackState(next);
        } catch (error) {
            console.error("Failed to change media playback state", error);
            setPlaybackError(
                `Unable to change playback: ${errorMessage(error)}`
            );
        }
    };

    /** seek → seconds */
    const seek = (sec: number) => {
        if (maxS === 0) return;
        const ratio = Math.min(Math.max(sec / maxS, 0), 1);
        if (ratio === progress) {
            forceReload(); // replay the same pos
        } else {
            const active = activePlayback.current;
            const generation =
                active?.generation ?? iteratorRef.current?.generation;
            if (active) {
                active.controller.abort("Media playback seeked");
                activePlayback.current = undefined;
            }
            if (iteratorId.current === generation) {
                iteratorId.current++;
            }
            controlIntent.current++;
            requestedPlaying.current = false;
            void retirePlayback(generation);
            setPlaying(false);
            setProgress(ratio);
        }
    };

    const changeVol = (v: number) => {
        volumeRef.current = v;
        setVolume(v);
        refs.current.forEach(({ listener }) => listener.setVolume?.(v));
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

            {playbackError && (
                <div role="alert" className="mb-2 text-xs text-red-300">
                    {playbackError}
                </div>
            )}

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
