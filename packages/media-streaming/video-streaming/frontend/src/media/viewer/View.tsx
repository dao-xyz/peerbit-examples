import { usePeer } from "@peerbit/react";
import { useRef, useState, useEffect } from "react";
import {
    Chunk,
    WebcodecsStreamDB,
    MediaStreamDB,
    Track,
    AudioStreamDB,
    TracksIterator,
} from "@peerbit/media-streaming";
import { Alert, Grid } from "@mui/material";

import "./View.css";
import CatOffline from "/catbye64.png";
import { Controls } from "./controller/Control.js";
import { ControlFunctions } from "./controller/controls.js";
import { Resolution } from "../controls/settings.js";
import { renderer } from "./video/renderer.js";
import PQueue from "p-queue";
import { getKeepAspectRatioBoundedSize } from "../MaintainAspectRatio.js";
import ClickOnceForAudio from "./ClickOnceForAudio.js";
import { Spinner } from "../../utils/Spinner.js";
import {
    adoptDurableCleanup,
    createAudioStreamListener,
    createBoundedRetryBudget,
    createKeyedRetryBackoff,
    durableCleanupPendingCount,
    reconcilePlaybackRequest,
    retryDurableCleanup,
    runProgressCallback,
} from "@peerbit/media-streaming-web";

let inBackground = false;
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        inBackground = true;
    } else {
        inBackground = false;
    }
});

const addVideoStreamListener = (
    streamDB: Track<WebcodecsStreamDB>,
    play: boolean
) => {
    let currentTime = 0;

    let decoder: VideoDecoder | undefined;
    let waitForKeyFrame = true;
    let disposed = false;

    const configureDecoder = () => {
        if (disposed) {
            return;
        }
        if (decoder?.state === "configured") {
            return;
        }
        if (decoder?.state === "unconfigured") {
            decoder.close();
        }

        decoder = new VideoDecoder({
            error: () => {},
            output: (frame) => {
                if (disposed || !play) {
                    frame.close();
                    return;
                }
                /* handleFrame(frame); */
                if (document.visibilityState === "hidden") {
                    // is the app hidden?
                    console.log("HIDDEN");

                    frame.close();
                } else {
                    // this is the step where the rendering  happens
                    renderer.draw(frame);
                }
            },
        });
        decoder.configure(streamDB.source.decoderDescription);
        waitForKeyFrame = true;
    };

    const processChunk = (chunk: Chunk) => {
        if (disposed || !play) {
            return;
        }
        /* console.log(
            "got chunk",
            streamDB.startTime,
            chunk.time,
            chunk.chunk.length
        ); */
        const encodedChunk = new EncodedVideoChunk({
            timestamp: Number(chunk.time),
            type: chunk.type as "key" | "delta",
            data: chunk.chunk,
        });

        if (decoder) {
            if (decoder.state === "closed") {
                // For some reason the decoder can close if not recieving more frames (?)
                configureDecoder();
            }

            if (decoder.state !== "closed") {
                if (waitForKeyFrame) {
                    if (encodedChunk.type !== "key") {
                        return;
                    }
                    waitForKeyFrame = false;
                }
                decoder.decode(encodedChunk);
            }
        }
    };

    const cleanup = async () => {
        /*    console.log("CLEANUP ");
           abortController.abort();
           underflow = true;
           await clearPending(); */
        const decoderToClose = decoder;
        if (decoderToClose && decoderToClose.state !== "closed") {
            decoderToClose.close();
        }
        decoder = undefined;
    };

    return {
        close: async () => {
            if (!disposed) {
                // Fence first: VideoDecoder callbacks and late chunks can run
                // while close is in progress, but may never recreate a
                // finalised decoder.
                disposed = true;
                play = false;
            }
            // A failed decoder close remains retryable without lifting the
            // permanent disposal fence.
            await cleanup();
        },
        /*  setProgress: async (progress: number | "live") => {
             console.log("SET PROGRESS", progress);
             session++;
             await cleanup?.();
             renderLoop();
             abortController = new AbortController();
             if (progress === "live") {
                 setLive();
             } else {
                 setAtProgress(progress);
             }
         },
         setSpeed: (number) => {
             // TODO
         }, */
        push: processChunk,
        play: () => {
            if (disposed) {
                return;
            }
            play = true;
            configureDecoder();
            /* setLive(); */
            /*       renderFrame();
                  renderLoop(); */
        },
        pause: async () => {
            play = false;
            // Iterator pause and decoder pause are not atomic. If a chunk was
            // dropped while the iterator drained, resume only from a frame
            // that does not depend on that missing decoder history.
            waitForKeyFrame = true;
        },
        currentTime: () => currentTime,
    };
};

const errorMessage = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

const throwFailures = (failures: unknown[], message: string) => {
    if (failures.length === 1) {
        throw failures[0];
    }
    if (failures.length > 1) {
        throw new AggregateError(failures, message);
    }
};

type DBArgs = { stream: MediaStreamDB };

type StreamControlFunction = Omit<ControlFunctions, "setProgress"> & {
    close: () => void | Promise<void>;
    /*   track: Track<any>; */
    push: (data: Chunk) => void;
};
type PlaybackControl = StreamControlFunction & { track: Track<any> };

const CLEANUP_RETRY_BACKOFF = {
    initialDelayMs: 100,
    maximumDelayMs: 5_000,
    factor: 2,
};
const MAXIMUM_AUTOMATIC_CLEANUP_RETRIES = 8;
const VIEWER_DURABLE_CLEANUP_OWNER = {};
const reportViewerDurableCleanup = (error: unknown) =>
    console.error("Failed to release durable viewer cleanup", error);

const retryViewerDurableCleanup = async () => {
    await retryDurableCleanup(VIEWER_DURABLE_CLEANUP_OWNER);
    if (durableCleanupPendingCount(VIEWER_DURABLE_CLEANUP_OWNER) > 0) {
        throw new Error("Previous viewer cleanup is still pending");
    }
};

let videoHeight = () => window.innerHeight;
let videoWidth = () => window.innerWidth;

export const View = (properties: DBArgs) => {
    const canvasRef = useRef<HTMLCanvasElement>(undefined);
    const lastCanvasRef = useRef<HTMLCanvasElement>(undefined);
    const [resolutionOptions, setResolutionOptions] = useState<Resolution[]>(
        []
    );

    const [currentTime, setCurrentTime] = useState(0);
    const [maxTime, setMaxTime] = useState(0);

    const [selectedResolutions, setSelectedResolutions] = useState<
        Resolution[]
    >([]);

    const containerRef = useRef<HTMLDivElement>(null);
    const [streamerOnline, setStreamerOnline] = useState(false);
    const { peer } = usePeer();
    const controls = useRef<PlaybackControl[]>([]);
    const [isPlaying, setIsPlaying] = useState(true);
    const playbackIntent = useRef(true);
    const playbackStateRequest = useRef(0);
    const [isBuffering, setIsBuffering] = useState(true);
    const [playbackError, setPlaybackError] = useState<string>();

    const [cursor, setCursor] = useState<number | "live">(0);

    /* 
        const [styleHeight, setStyleHeight] = useState<'100dvh' | 'fit-content'>("fit-content");
        const [styleWidth, setStyleWidth] = useState<'100dvw' | 'fit-content'>("100dvw");
     */

    const { height: styleHeight, width: styleWidth } =
        getKeepAspectRatioBoundedSize({
            height: videoHeight(),
            width: videoWidth(),
        });

    const streamListener = useRef<TracksIterator | undefined>(undefined);
    const updateProgressQueue = useRef<PQueue>(new PQueue({ concurrency: 1 }));
    const playbackRequest = useRef<{
        generation: number;
        controller?: AbortController;
    }>({ generation: 0 });
    const playbackStreamAddress = useRef<string | undefined>(undefined);
    const pendingIteratorClosures = useRef(new Set<TracksIterator>());
    const iteratorCloseAttempts = useRef(
        new Map<TracksIterator, Promise<void>>()
    );
    const controlCloseAttempts = useRef(
        new Map<PlaybackControl, Promise<void>>()
    );
    const pendingControlClosures = useRef(new Set<PlaybackControl>());
    const controlCreations = useRef(
        new Map<string, Promise<PlaybackControl | undefined>>()
    );
    const controllerRetryBackoff = useRef(createKeyedRetryBackoff<string>());
    const cleanupRetryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
        undefined
    );
    const cleanupRetryBudget = useRef(
        createBoundedRetryBudget({
            ...CLEANUP_RETRY_BACKOFF,
            maximumAttempts: MAXIMUM_AUTOMATIC_CLEANUP_RETRIES,
        })
    );
    const [liveStreamAvailable, setLiveStreamAvailable] = useState(false);

    const isPlaybackRequestCurrent = (
        generation: number,
        controller: AbortController
    ) =>
        playbackRequest.current.generation === generation &&
        playbackRequest.current.controller === controller &&
        !controller.signal.aborted;

    const hasPendingPlaybackCleanup = () =>
        pendingIteratorClosures.current.size > 0 ||
        pendingControlClosures.current.size > 0;

    const resetCleanupRetryStateIfSettled = () => {
        if (hasPendingPlaybackCleanup()) {
            return;
        }
        if (cleanupRetryTimer.current != null) {
            clearTimeout(cleanupRetryTimer.current);
            cleanupRetryTimer.current = undefined;
        }
        cleanupRetryBudget.current.reset();
    };

    const reopenCleanupRetryBudget = () => {
        if (
            cleanupRetryTimer.current == null &&
            cleanupRetryBudget.current.exhausted()
        ) {
            // A new user/lifecycle action is allowed a fresh, bounded cleanup
            // window. Automatic retries alone never reset their own budget.
            cleanupRetryBudget.current.reset();
        }
    };

    const closePlaybackControl = (control: PlaybackControl) => {
        controls.current = controls.current.filter(
            (candidate) => candidate !== control
        );
        const newlyPending = !pendingControlClosures.current.has(control);
        if (newlyPending) {
            reopenCleanupRetryBudget();
        }
        pendingControlClosures.current.add(control);
        const existingAttempt = controlCloseAttempts.current.get(control);
        if (existingAttempt) {
            return existingAttempt;
        }
        const attempt = Promise.resolve()
            .then(() => control.close())
            .then(() => {
                pendingControlClosures.current.delete(control);
            })
            .finally(() => {
                if (controlCloseAttempts.current.get(control) === attempt) {
                    controlCloseAttempts.current.delete(control);
                }
                if (hasPendingPlaybackCleanup()) {
                    schedulePendingCleanupRetry();
                } else {
                    resetCleanupRetryStateIfSettled();
                }
            });
        controlCloseAttempts.current.set(control, attempt);
        return attempt;
    };

    const closePlaybackControls = async () => {
        // Controller initialisation can be awaiting an AudioContext or decoder
        // transition when a seek/unmount fences its generation. Let that
        // promise observe the fence and retire its candidate before deciding
        // that all controls are closed.
        await Promise.allSettled([...controlCreations.current.values()]);
        const toClose = new Set([
            ...pendingControlClosures.current,
            ...controls.current,
        ]);
        const results = await Promise.allSettled(
            [...toClose].map((control) => closePlaybackControl(control))
        );
        const failures = results
            .filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected"
            )
            .map((result) => result.reason);
        throwFailures(failures, "Failed to close media playback controls");
    };

    const closePlaybackIterator = (iterator: TracksIterator) => {
        const newlyPending = !pendingIteratorClosures.current.has(iterator);
        if (newlyPending) {
            reopenCleanupRetryBudget();
        }
        pendingIteratorClosures.current.add(iterator);
        const existingAttempt = iteratorCloseAttempts.current.get(iterator);
        if (existingAttempt) {
            return existingAttempt;
        }
        const attempt = Promise.resolve()
            .then(() => iterator.close())
            .then(() => {
                pendingIteratorClosures.current.delete(iterator);
                if (streamListener.current === iterator) {
                    streamListener.current = undefined;
                }
            })
            .finally(() => {
                if (iteratorCloseAttempts.current.get(iterator) === attempt) {
                    iteratorCloseAttempts.current.delete(iterator);
                }
                if (hasPendingPlaybackCleanup()) {
                    schedulePendingCleanupRetry();
                } else {
                    resetCleanupRetryStateIfSettled();
                }
            });
        iteratorCloseAttempts.current.set(iterator, attempt);
        return attempt;
    };

    const retryPendingPlaybackResources = async () => {
        const results = await Promise.allSettled([
            ...[...pendingIteratorClosures.current].map((iterator) =>
                closePlaybackIterator(iterator)
            ),
            ...[...pendingControlClosures.current].map((control) =>
                closePlaybackControl(control)
            ),
        ]);
        const failures = results
            .filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected"
            )
            .map((result) => result.reason);
        if (failures.length > 0) {
            console.error(
                "Failed to retry retired media playback cleanup",
                failures.length === 1
                    ? failures[0]
                    : new AggregateError(
                          failures,
                          "Failed to retry retired media playback cleanup"
                      )
            );
        }
    };

    const adoptExhaustedPlaybackCleanup = () => {
        const iterators = [...pendingIteratorClosures.current].filter(
            (iterator) => !iteratorCloseAttempts.current.has(iterator)
        );
        const retiredControls = [...pendingControlClosures.current].filter(
            (control) => !controlCloseAttempts.current.has(control)
        );
        if (iterators.length === 0 && retiredControls.length === 0) {
            return;
        }

        adoptDurableCleanup([...iterators, ...retiredControls], {
            owner: VIEWER_DURABLE_CLEANUP_OWNER,
            onError: reportViewerDurableCleanup,
        });
        for (const iterator of iterators) {
            pendingIteratorClosures.current.delete(iterator);
            if (streamListener.current === iterator) {
                streamListener.current = undefined;
            }
        }
        for (const control of retiredControls) {
            pendingControlClosures.current.delete(control);
        }
        resetCleanupRetryStateIfSettled();
    };

    const schedulePendingCleanupRetry = () => {
        if (cleanupRetryTimer.current != null || !hasPendingPlaybackCleanup()) {
            return;
        }
        const delay = cleanupRetryBudget.current.nextDelay();
        if (delay == null) {
            // Transfer ownership out of the component closure. The shared
            // registry is dormant until a later lifecycle/online/visible wake.
            adoptExhaustedPlaybackCleanup();
            return;
        }
        cleanupRetryTimer.current = setTimeout(() => {
            cleanupRetryTimer.current = undefined;
            void retryPendingPlaybackResources().finally(() => {
                if (!hasPendingPlaybackCleanup()) {
                    resetCleanupRetryStateIfSettled();
                    return;
                }
                schedulePendingCleanupRetry();
            });
        }, delay);
        (
            cleanupRetryTimer.current as ReturnType<typeof setTimeout> & {
                unref?: () => void;
            }
        ).unref?.();
    };

    const closePendingControlsForTrack = async (trackId: string) => {
        await retryViewerDurableCleanup();
        reopenCleanupRetryBudget();
        const matching = [...pendingControlClosures.current].filter(
            (control) => control.track.idString === trackId
        );
        const results = await Promise.allSettled(
            matching.map((control) => closePlaybackControl(control))
        );
        const failures = results
            .filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected"
            )
            .map((result) => result.reason);
        throwFailures(
            failures,
            "Previous media controller cleanup is still pending"
        );
    };

    const closePlaybackIterators = async () => {
        const toClose = new Set(pendingIteratorClosures.current);
        if (streamListener.current) {
            toClose.add(streamListener.current);
        }
        const results = await Promise.allSettled(
            [...toClose].map((iterator) => closePlaybackIterator(iterator))
        );
        const failures = results
            .filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected"
            )
            .map((result) => result.reason);
        throwFailures(failures, "Failed to close media playback iterators");
    };

    const closePlaybackResources = async () => {
        reopenCleanupRetryBudget();
        const results = await Promise.allSettled([
            retryViewerDurableCleanup(),
            closePlaybackIterators(),
            closePlaybackControls(),
        ]);
        const failures = results
            .filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected"
            )
            .map((result) => result.reason);
        throwFailures(failures, "Failed to close media playback resources");
    };

    const closeOpenedPlayback = async (iterator?: TracksIterator) => {
        reopenCleanupRetryBudget();
        const results = await Promise.allSettled([
            retryViewerDurableCleanup(),
            iterator ? closePlaybackIterator(iterator) : Promise.resolve(),
            closePlaybackControls(),
        ]);
        const failures = results
            .filter(
                (result): result is PromiseRejectedResult =>
                    result.status === "rejected"
            )
            .map((result) => result.reason);
        throwFailures(failures, "Failed to retire media playback resources");
    };

    const reconcileIteratorPlayback = async (
        iterator: TracksIterator,
        isCurrent: () => boolean
    ) => {
        await reconcilePlaybackRequest({
            isCurrent,
            readRequest: () => ({
                request: playbackStateRequest.current,
                shouldPlay: playbackIntent.current,
            }),
            apply: (shouldPlay) =>
                shouldPlay ? iterator.play() : iterator.pause(),
            isApplied: (shouldPlay) => iterator.paused !== shouldPlay,
            notAppliedMessage: (shouldPlay) =>
                `The media iterator failed to ${
                    shouldPlay ? "resume" : "pause"
                }`,
            unstableMessage:
                "The media iterator playback state changed too often to settle",
        });
    };

    const setProgress = (progress: number | "live") => {
        setCursor(progress);
        setIsBuffering(true);
        setPlaybackError(undefined);
        const generation = playbackRequest.current.generation + 1;
        playbackRequest.current.controller?.abort("Playback request replaced");
        const controller = new AbortController();
        playbackRequest.current = { generation, controller };
        const isCurrent = () =>
            isPlaybackRequestCurrent(generation, controller);
        void updateProgressQueue.current
            .add(async () => {
                if (!isCurrent()) {
                    return;
                }
                console.log("CLOSE PREV!", progress, streamListener.current);
                /*     if (progress !== "live") {
                        return;
                    } */
                await closePlaybackResources();

                if (!isCurrent()) {
                    return;
                }

                console.log(
                    "ITERATE WITH PROGRESS",
                    progress,
                    typeof progress === "number" ? progress * maxTime : progress
                );
                let nextListener: TracksIterator | undefined;
                let closeObserved = false;
                let closeScheduled = false;
                let openedPlaybackRetired = false;
                let openedPlaybackRetirementAttempted = false;
                let openedPlaybackRetirement: Promise<void> | undefined;
                const callbacksCurrent = () => isCurrent() && !closeObserved;
                const retireOpenedPlayback = () => {
                    if (openedPlaybackRetired) {
                        return Promise.resolve();
                    }
                    if (openedPlaybackRetirement) {
                        return openedPlaybackRetirement;
                    }
                    openedPlaybackRetirementAttempted = true;
                    const attempt = closeOpenedPlayback(nextListener)
                        .then(() => {
                            openedPlaybackRetired = true;
                        })
                        .finally(() => {
                            if (openedPlaybackRetirement === attempt) {
                                openedPlaybackRetirement = undefined;
                            }
                        });
                    openedPlaybackRetirement = attempt;
                    return attempt;
                };
                const scheduleClose = () => {
                    closeObserved = true;
                    if (!isCurrent() || closeScheduled) {
                        return;
                    }
                    closeScheduled = true;
                    void updateProgressQueue.current
                        .add(async () => {
                            if (!isCurrent() || !nextListener) {
                                return;
                            }
                            await retireOpenedPlayback();
                            if (!isCurrent()) {
                                return;
                            }
                            playbackIntent.current = false;
                            playbackStateRequest.current += 1;
                            setIsBuffering(false);
                            setIsPlaying(false);
                        })
                        .catch((error) => {
                            if (!isCurrent()) {
                                return;
                            }
                            console.error(
                                "Failed to close completed media playback",
                                error
                            );
                            setPlaybackError(
                                `Unable to close playback: ${errorMessage(error)}`
                            );
                        });
                };

                try {
                    nextListener = await properties.stream.iterate(progress, {
                        signal: controller.signal,
                        keepTracksOpen: true,
                        /*     debug: true, */
                        replicate: false,
                        onUnderflow: () => {
                            if (!callbacksCurrent()) {
                                return;
                            }
                            console.log("underflow");
                            setIsBuffering(true);
                        },
                        onProgress: async (ev) => {
                            await runProgressCallback({
                                isCurrent: callbacksCurrent,
                                process: () =>
                                    processChunk(
                                        {
                                            track: ev.track,
                                            chunk: ev.chunk,
                                        },
                                        callbacksCurrent
                                    ),
                                onProcessed: () => {
                                    setCurrentTime(
                                        Math.round(
                                            (ev.track.startTime +
                                                ev.chunk.time) /
                                                1e3
                                        )
                                    );
                                    setIsBuffering(false);
                                    setPlaybackError(undefined);
                                },
                                onDeferred: () => {
                                    // A controller in cooldown has not consumed
                                    // this chunk. The visible error explains the
                                    // pause; do not pin the UI behind a spinner.
                                    setIsBuffering(false);
                                },
                                onFailure: (error) => {
                                    setIsBuffering(false);
                                    console.error(
                                        "Failed to process media chunk",
                                        error
                                    );
                                    setPlaybackError(
                                        `Playback failed: ${errorMessage(error)}`
                                    );
                                },
                            });
                        },
                        onMaxTimeChange: (ev) => {
                            if (!callbacksCurrent()) {
                                return;
                            }
                            setMaxTime((current) =>
                                Math.max(ev.maxTime / 1e3, current)
                            );
                        },
                        onTracksChange: (ev) => {
                            if (!callbacksCurrent()) {
                                return;
                            }
                            let canLiveStream = false;
                            for (const track of ev) {
                                if (track.endTime == null) {
                                    // TODO this is actually not expected behaviour because we should be able to watch a video while uploading?
                                    canLiveStream = true;
                                }
                            }
                            setLiveStreamAvailable(canLiveStream);
                            setSelectedResolutions(
                                [
                                    ...ev
                                        .filter(
                                            (
                                                x
                                            ): x is Track<WebcodecsStreamDB> =>
                                                x.source instanceof
                                                WebcodecsStreamDB
                                        )
                                        .map(
                                            (x) =>
                                                x.source.decoderDescription
                                                    .codedHeight
                                        ),
                                ].sort() as Resolution[]
                            );
                        },
                        onTrackOptionsChange: (ev) => {
                            if (!callbacksCurrent()) {
                                return;
                            }
                            setResolutionOptions(
                                [
                                    ...ev
                                        .filter(
                                            (
                                                x
                                            ): x is Track<WebcodecsStreamDB> =>
                                                x.source instanceof
                                                WebcodecsStreamDB
                                        )
                                        .map(
                                            (x) =>
                                                x.source.decoderDescription
                                                    .codedHeight
                                        ),
                                ].sort() as Resolution[]
                            );
                        },
                        onClose: scheduleClose,
                    });
                    if (!isCurrent() || closeObserved) {
                        await retireOpenedPlayback();
                        return;
                    }
                    await reconcileIteratorPlayback(
                        nextListener,
                        callbacksCurrent
                    );
                    if (!isCurrent() || closeObserved) {
                        await retireOpenedPlayback();
                        return;
                    }
                    streamListener.current = nextListener;
                    setIsPlaying(!nextListener.paused);
                } catch (error) {
                    const cleanup = openedPlaybackRetirementAttempted
                        ? []
                        : await Promise.allSettled([retireOpenedPlayback()]);
                    const cleanupFailures = cleanup
                        .filter(
                            (result): result is PromiseRejectedResult =>
                                result.status === "rejected"
                        )
                        .map((result) => result.reason);
                    if (cleanupFailures.length > 0) {
                        throw new AggregateError(
                            [error, ...cleanupFailures],
                            "Failed to start and retire media playback"
                        );
                    }
                    throw error;
                }
            })
            .catch((error) => {
                if (!isCurrent()) {
                    return;
                }
                console.error("Failed to update media playback", error);
                setIsBuffering(false);
                setIsPlaying(
                    streamListener.current
                        ? !streamListener.current.paused
                        : false
                );
                setPlaybackError(
                    `Unable to update playback: ${errorMessage(error)}`
                );
            });
    };

    useEffect(() => {
        if (!peer || !properties.stream || properties.stream.closed) {
            return;
        }
        const streamChanged =
            playbackStreamAddress.current !== properties.stream.address;
        playbackStreamAddress.current = properties.stream.address;
        if (streamChanged) {
            controllerRetryBackoff.current.clear();
            playbackIntent.current = true;
            playbackStateRequest.current += 1;
            setCurrentTime(0);
            setMaxTime(0);
            setResolutionOptions([]);
            setSelectedResolutions([]);
            setLiveStreamAvailable(false);
            setStreamerOnline(false);
            setIsPlaying(true);
        }
        // iterate owns max-time discovery and releases that subscription with
        // the iterator. A second subscription here outlived seeks and raced its
        // callbacks.
        setProgress(streamChanged ? 0 : cursor);

        return () => {
            playbackRequest.current.generation++;
            playbackRequest.current.controller?.abort("Viewer unmounted");
            playbackRequest.current.controller = undefined;
            void updateProgressQueue.current
                .add(async () => {
                    reopenCleanupRetryBudget();
                    const results = await Promise.allSettled([
                        retryDurableCleanup(VIEWER_DURABLE_CLEANUP_OWNER),
                        closePlaybackIterators(),
                        closePlaybackControls(),
                    ]);
                    for (const result of results) {
                        if (result.status === "rejected") {
                            console.error(
                                "Failed to close viewer playback",
                                result.reason
                            );
                        }
                    }
                })
                .catch((error) =>
                    console.error("Failed to queue viewer cleanup", error)
                );
        };
    }, [peer?.identity.publicKey.hashcode(), properties.stream?.address]);

    useEffect(() => {
        if (
            !peer ||
            !properties.stream ||
            properties.stream.closed ||
            cursor !== "live"
        ) {
            return;
        }
        let active = true;
        const controller = new AbortController();
        setStreamerOnline(false);
        void properties.stream
            .waitFor(properties.stream.owner, { signal: controller.signal })
            .then(() => {
                if (!active || controller.signal.aborted) {
                    return;
                }
                setStreamerOnline(true);
            })
            .catch((error) => {
                if (!active || controller.signal.aborted) {
                    return;
                }
                setStreamerOnline(false); /* 
                console.error("Failed to find streamer");
                console.error(error); */
            });

        return () => {
            active = false;
            controller.abort("Presence check replaced");
        };
    }, [
        cursor === "live",
        peer?.identity.publicKey.hashcode(),
        properties.stream?.address,
    ]);

    const processChunk = async (
        event: {
            track: Track<any>;
            chunk: Chunk;
        },
        isCurrent: () => boolean
    ): Promise<boolean> => {
        if (!isCurrent()) {
            return false;
        }
        const trackId = event.track.idString;
        let fn = controls.current.find(
            (control) => control.track.idString === trackId
        );
        if (!fn) {
            let creation = controlCreations.current.get(trackId);
            if (!creation) {
                if (!controllerRetryBackoff.current.canAttempt(trackId)) {
                    return false;
                }
                creation = (async () => {
                    let newController: PlaybackControl | undefined;
                    let retirementAttempted = false;
                    const retireCandidate = async () => {
                        if (!newController || retirementAttempted) {
                            return;
                        }
                        retirementAttempted = true;
                        await closePlaybackControl(newController);
                    };
                    try {
                        // A controller is removed from the active list before
                        // it closes. Gate replacement on the retired controller
                        // for this track actually closing, so failed cleanup
                        // cannot accumulate one controller per incoming chunk.
                        await closePendingControlsForTrack(trackId);
                        if (!isCurrent()) {
                            return undefined;
                        }

                        const existing = controls.current.find(
                            (control) => control.track.idString === trackId
                        );
                        if (existing) {
                            controllerRetryBackoff.current.recordSuccess(
                                trackId
                            );
                            return existing;
                        }

                        const controllerResolver: (
                            x: Track<WebcodecsStreamDB | AudioStreamDB>,
                            isPlaying: boolean
                        ) => StreamControlFunction =
                            event.track.source instanceof AudioStreamDB
                                ? (x, isPlaying) =>
                                      createAudioStreamListener(
                                          x as Track<AudioStreamDB>,
                                          isPlaying,
                                          { recoverLag: true }
                                      ) // make audio catch up with video (assume video is always realtime and audio is not)
                                : addVideoStreamListener;

                        newController = {
                            track: event.track,
                            ...controllerResolver(
                                event.track,
                                playbackIntent.current
                            ),
                        };

                        await reconcilePlaybackRequest({
                            isCurrent,
                            readRequest: () => ({
                                request: playbackStateRequest.current,
                                shouldPlay: playbackIntent.current,
                            }),
                            apply: (shouldPlay) =>
                                shouldPlay
                                    ? newController!.play()
                                    : newController!.pause(),
                            unstableMessage:
                                "The media controller playback state changed too often to settle",
                        });

                        if (!isCurrent()) {
                            await retireCandidate();
                            return undefined;
                        }

                        const racedController = controls.current.find(
                            (control) => control.track.idString === trackId
                        );
                        if (racedController) {
                            await retireCandidate();
                            controllerRetryBackoff.current.recordSuccess(
                                trackId
                            );
                            return racedController;
                        }

                        if (event.track.source instanceof WebcodecsStreamDB) {
                            const ratio = Math.ceil(window.devicePixelRatio); // for dense displays, like mobile we need to scale canvas to not make it look blurry
                            videoHeight = () =>
                                event.track.source.decoderDescription
                                    .codedHeight * ratio;
                            videoWidth = () =>
                                event.track.source.decoderDescription
                                    .codedWidth * ratio;
                            setVideoSize();
                        }
                        controls.current.push(newController);
                        controllerRetryBackoff.current.recordSuccess(trackId);
                        return newController;
                    } catch (error) {
                        let failure = error;
                        if (newController && !retirementAttempted) {
                            try {
                                await retireCandidate();
                            } catch (cleanupError) {
                                failure = new AggregateError(
                                    [error, cleanupError],
                                    "Failed to initialise and retire a media controller"
                                );
                            }
                        }
                        if (isCurrent()) {
                            controllerRetryBackoff.current.recordFailure(
                                trackId
                            );
                        }
                        throw failure;
                    }
                })();
                controlCreations.current.set(trackId, creation);
                void creation
                    .finally(() => {
                        if (
                            controlCreations.current.get(trackId) === creation
                        ) {
                            controlCreations.current.delete(trackId);
                        }
                    })
                    .catch(() => {});
            }
            fn = await creation;
            if (!fn) {
                return false;
            }
        }

        if (!isCurrent()) {
            return false;
        }
        try {
            fn.push(event.chunk);
            return true;
        } catch (error) {
            controllerRetryBackoff.current.recordFailure(trackId);
            try {
                await closePlaybackControl(fn);
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Failed to process a media chunk and retire its controller"
                );
            }
            throw error;
        }
    };

    const setPlaybackState = async (play: boolean) => {
        const request = ++playbackStateRequest.current;
        const generation = playbackRequest.current.generation;
        playbackIntent.current = play;

        try {
            await updateProgressQueue.current.add(async () => {
                if (
                    request !== playbackStateRequest.current ||
                    generation !== playbackRequest.current.generation
                ) {
                    return;
                }
                const iterator = streamListener.current;
                if (!iterator) {
                    throw new Error("The media stream is not ready");
                }

                const previousPlaying = !iterator.paused;
                const transitionControls = [...controls.current];
                const transitionResults = await Promise.allSettled([
                    play ? iterator.play() : iterator.pause(),
                    ...transitionControls.map((control) =>
                        play ? control.play() : control.pause()
                    ),
                ]);
                if (generation !== playbackRequest.current.generation) {
                    return;
                }
                const transitionFailures = transitionResults
                    .filter(
                        (result): result is PromiseRejectedResult =>
                            result.status === "rejected"
                    )
                    .map((result) => result.reason);
                if (iterator.paused === play) {
                    transitionFailures.push(
                        new Error(
                            `The media iterator failed to ${
                                play ? "resume" : "pause"
                            }`
                        )
                    );
                }

                if (transitionFailures.length > 0) {
                    // A transition can succeed for the iterator but fail for a
                    // decoder (or vice versa). Put every resource, including a
                    // controller created while the transition was pending,
                    // back into the prior coherent state.
                    const rollbackControls = new Set([
                        ...transitionControls,
                        ...controls.current,
                    ]);
                    const rollbackResults = await Promise.allSettled([
                        previousPlaying ? iterator.play() : iterator.pause(),
                        ...[...rollbackControls].map((control) =>
                            previousPlaying ? control.play() : control.pause()
                        ),
                    ]);
                    if (generation !== playbackRequest.current.generation) {
                        return;
                    }
                    const rollbackFailures = rollbackResults
                        .filter(
                            (result): result is PromiseRejectedResult =>
                                result.status === "rejected"
                        )
                        .map((result) => result.reason);
                    if (request === playbackStateRequest.current) {
                        const reconciledPlaying = !iterator.paused;
                        playbackIntent.current = reconciledPlaying;
                        setIsPlaying(reconciledPlaying);
                    }
                    throwFailures(
                        [...transitionFailures, ...rollbackFailures],
                        `Failed to ${
                            play ? "resume" : "pause"
                        } and roll back media playback`
                    );
                }

                if (request === playbackStateRequest.current) {
                    setIsPlaying(play);
                    setPlaybackError(undefined);
                }
            });
        } catch (error) {
            if (
                request === playbackStateRequest.current &&
                generation === playbackRequest.current.generation
            ) {
                const reconciledPlaying = streamListener.current
                    ? !streamListener.current.paused
                    : false;
                playbackIntent.current = reconciledPlaying;
                setIsPlaying(reconciledPlaying);
                setPlaybackError(
                    `Unable to ${
                        play ? "resume" : "pause"
                    } playback: ${errorMessage(error)}`
                );
            }
            throw error;
        }
    };

    let setVideoSize = () =>
        renderer.resize({ width: videoWidth(), height: videoHeight() });

    const showVideo = streamerOnline || (cursor !== "live" && controls.current);
    return (
        <Grid container direction="column">
            <Grid item>
                <div
                    data-iframe-height
                    className="container"
                    ref={containerRef}
                >
                    <div className="video-wrapper">
                        <ClickOnceForAudio
                            play={() => {
                                void setPlaybackState(true).catch(() => {
                                    // setPlaybackState reports and reconciles
                                    // the failure for the visible controls.
                                });
                            }}
                        >
                            <canvas
                                id="stream-playback"
                                style={{
                                    display: "block",
                                    maxWidth: styleWidth,
                                    maxHeight: styleHeight,
                                    justifyContent: "center",
                                }}
                                className="w-full h-full"
                                /*    style={{ width: "100%", height: "auto" }} */
                                ref={(node) => {
                                    if (
                                        !node ||
                                        (canvasRef.current &&
                                            canvasRef.current.isEqualNode(node))
                                    ) {
                                        return;
                                    }

                                    canvasRef.current =
                                        node as HTMLCanvasElement;

                                    let newCanvas = false;
                                    newCanvas =
                                        canvasRef.current !=
                                        lastCanvasRef.current;
                                    lastCanvasRef.current = canvasRef.current;

                                    if (canvasRef.current! && newCanvas) {
                                        renderer.setup(canvasRef.current!);
                                        /* let resizeTimer: any = undefined;
                                            window.onload = window.onresize = function () {
                                                clearTimeout(resizeTimer);
                                                resizeTimer = setTimeout(() => {
                                                    console.log("set size", videoHeight(), videoWidth());
                                                    setVideoSize();
                                                }, 100);
                                            }; */
                                    }
                                }}
                                width="300px"
                                height="300px"
                            />
                        </ClickOnceForAudio>
                        {showVideo && (
                            <div
                                style={{
                                    position: "absolute",
                                    bottom: "0px",
                                    width: "100%",
                                }}
                            >
                                <Controls
                                    liveStreamAvailable={liveStreamAvailable}
                                    isBuffering={isBuffering}
                                    mediaStreams={properties.stream}
                                    selectedResolution={selectedResolutions}
                                    resolutionOptions={resolutionOptions}
                                    viewRef={canvasRef.current}
                                    onQualityChange={(settings) => {
                                        const setting = settings[0];
                                        if (!setting) {
                                            return;
                                        }

                                        const streamToOpen =
                                            streamListener.current
                                                ?.options()
                                                .find(
                                                    (x) =>
                                                        x.source instanceof
                                                            WebcodecsStreamDB &&
                                                        x.source
                                                            .decoderDescription
                                                            .codedHeight ===
                                                            setting.video.height
                                                );

                                        streamListener.current.selectOption(
                                            streamToOpen
                                        );
                                        /*  
                                         let videoRef =
                                             document.getElementById(
                                                 "stream-playback"
                                             );
                                         if (!videoRef) {
                                             return;
                                         }
                                         return updateVideoStream(streamToOpen); */
                                    }}
                                    isPlaying={isPlaying}
                                    pause={() => setPlaybackState(false)}
                                    play={() => setPlaybackState(true)}
                                    maxTime={maxTime}
                                    currentTime={currentTime}
                                    progress={cursor}
                                    setProgress={(p) => {
                                        setProgress(p);
                                        /*  controls.current.forEach((c) => {
                                             c.setProgress(p);
                                         }); */
                                    }}
                                    setSpeed={(p) =>
                                        controls.current.forEach((c) =>
                                            c.setSpeed(p)
                                        )
                                    }
                                    mute={() =>
                                        controls.current.forEach(
                                            (c) => c.mute && c.mute()
                                        )
                                    }
                                    unmute={() =>
                                        controls.current.forEach(
                                            (c) => c.unmute && c.unmute()
                                        )
                                    }
                                    setVolume={(v) =>
                                        controls.current.forEach(
                                            (c) => c.setVolume && c.setVolume(v)
                                        )
                                    }
                                ></Controls>
                            </div>
                        )}
                        {playbackError && (
                            <Alert
                                severity="error"
                                onClose={() => setPlaybackError(undefined)}
                                sx={{
                                    position: "absolute",
                                    top: 8,
                                    left: 8,
                                    right: 8,
                                    zIndex: 10,
                                }}
                            >
                                {playbackError}
                            </Alert>
                        )}
                        {!streamerOnline && cursor === "live" && (
                            <Grid
                                container
                                direction="column"
                                className="video-loading"
                                justifyContent="center"
                                spacing={1}
                            >
                                <Grid
                                    item
                                    sx={{
                                        display: "flex",
                                        ml: "-10px",
                                        maxHeight: "40%",
                                        maxWidth: "40%",
                                        justifyContent: "center",
                                        alignContent: "center",
                                    }}
                                >
                                    <img src={CatOffline} />
                                </Grid>
                                <Grid item>Streamer is offline</Grid>
                            </Grid>
                        )}
                        {showVideo && isBuffering && (
                            <Grid
                                container
                                direction="column"
                                className="center-middle"
                                justifyContent="center"
                                spacing={1}
                            >
                                <Spinner />
                            </Grid>
                        )}
                    </div>
                </div>
            </Grid>
        </Grid>
    );
};
