import { inIframe, usePeer, useProgram } from "@peerbit/react";
import React, { useRef, useState, useEffect, useCallback } from "react";
import {
    Chunk,
    WebcodecsStreamDB,
    Track,
    MediaStreamDB,
    AudioStreamDB,
    hrtimeMicroSeconds,
    MediaStreamDBs,
} from "@peerbit/media-streaming";
import { Buffer } from "buffer";
import { AbortError, TimeoutError, waitFor } from "@peerbit/time";
import {
    SourceSetting,
    StreamType,
    Resolution,
    resolutionToSourceSetting,
    RESOLUTIONS,
} from "../controls/settings.js";

import { Controls } from "./controller/Control";
import PQueue from "p-queue";
import { WAVEncoder } from "@peerbit/media-streaming-web";
import TickWorker from "./tickWorker.js?worker";
import { NextTick, Stop } from "./tickWorker.js";
import * as Dialog from "@radix-ui/react-dialog";
import { FiAlertCircle } from "react-icons/fi"; // Using react-icons for icons
import { FirstMenuSelect } from "./controller/FirstMenuSelect";
import pDefer from "p-defer";
import { isSafari } from "../utils";
import { convertGPUFrameToCPUFrame } from "./convertGPUFrameToCPUFrame";
import { Tracks } from "../controls/Tracks.js";
import { start } from "repl";

interface HTMLVideoElementWithCaptureStream extends HTMLVideoElement {
    captureStream(fps?: number): MediaStream;
    mozCaptureStream?(fps?: number): MediaStream;
}

const PACK_PERFECTLY = false;
if (PACK_PERFECTLY) {
    globalThis.Buffer = Buffer;
}

let inBackground = false;
document.addEventListener("visibilitychange", () => {
    inBackground = document.hidden;
});

interface VideoStream {
    video?: {
        width: number;
        height: number;
    };
    setting: SourceSetting;
    encoder: () => VideoEncoder;
    stream: () => Track<WebcodecsStreamDB>;
    close: () => Promise<void>;
    drop: () => Promise<void>;
    open: () => Promise<void>;
    trackPromise: Promise<Track<WebcodecsStreamDB>>;
}

const openVideoStreamQueue = new PQueue({ concurrency: 1 });

const DEFAULT_QUALITY = resolutionToSourceSetting(360);

/* const isTouchScreen = window.matchMedia("(pointer: coarse)").matches; */

const createVideoEncoder = (properties: {
    mediaStreamDBs: MediaStreamDB;
    quality: SourceSetting;
    setErrorMessage: (message: string) => void;
    time:
        | {
              type: "live";
              sessionTimestampRef: React.RefObject<number>;
          }
        | {
              type: "0";
          };
    preferCPUEncoding: () => Promise<boolean>;
}): VideoStream => {
    let videoTrack: Track<WebcodecsStreamDB> | undefined = undefined;
    let encoder: VideoEncoder | undefined = undefined;
    let abortController = new AbortController();

    let closeListener = () => abortController.abort();

    properties.mediaStreamDBs.events.addEventListener("close", closeListener);
    let aborted = false;
    abortController.signal.addEventListener("abort", () => {
        aborted = true;
    });

    abortController.signal.addEventListener("abort", () => {
        properties.mediaStreamDBs.events.removeEventListener(
            "close",
            closeListener
        );
    });

    let lastChunkTimestamp: number = 0;

    let close = async (closeEncoder: boolean = true) => {
        abortController.abort();
        if (closeEncoder && encoder && encoder?.state !== "closed") {
            encoder.close();
        }

        if (videoTrack) {
            // update the track with the end timer
            //   await videoStreamDB.close() TODD should we also close? (we have disabled this because we need to ensure replication before doing this)
            await properties.mediaStreamDBs.setEnd(
                videoTrack,
                properties.time.type === "live" ? undefined : lastChunkTimestamp
            );

            console.log(
                "CLOSE VIDEO STREAM",
                videoTrack.source.decoderConfigJSON,
                closeEncoder
            );
        }
    };

    let trackPromise = pDefer<Track<WebcodecsStreamDB>>();

    let open = async () => {
        let skip = false;
        let mem = 0;

        if (videoTrack) {
            // TODO
            if (videoTrack.endTime == null) {
                await properties.mediaStreamDBs.setEnd(
                    videoTrack,
                    properties.time.type === "live"
                        ? undefined
                        : lastChunkTimestamp
                );
                await videoTrack.close();
            }

            videoTrack = undefined;
        }

        encoder = new VideoEncoder({
            error: async (e) => {
                console.error(e);
                const msg = "Failed to encode video.\n" + e.toString();
                console.log(msg, e.toString().includes("OperationError"));
                abortController.abort();
                if (
                    e.toString().includes("OperationError") &&
                    (await properties.preferCPUEncoding())
                ) {
                    return; // preferCPUEncoding will make us retry encoding but without gpu loading
                } else {
                    properties.setErrorMessage(msg);
                }
            },
            output: async (chunk, metadata) => {
                if (skip) {
                    return;
                }
                let arr = new Uint8Array(chunk.byteLength);
                chunk.copyTo(arr);

                if (metadata.decoderConfig) {
                    const videoTrackToOpen = new Track<WebcodecsStreamDB>({
                        sender: properties.mediaStreamDBs.owner,
                        source: new WebcodecsStreamDB({
                            decoderDescription: metadata.decoderConfig,
                            /*   timestamp: videoStreamDB?.timestamp, ??? */
                        }),
                        ...(properties.time.type === "0"
                            ? {
                                  start: 0,
                              }
                            : {
                                  globalTime: resolveTimeStampRefValue(
                                      properties.time.sessionTimestampRef
                                  ),
                                  now: hrtimeMicroSeconds,
                              }),
                    });

                    let change = false;
                    if (videoTrack) {
                        /*  if (
                                    videoTrack.session >
                                    videoStreamDB.session
                                ) {
                                    // ok!
                                    change = true;
                                } else  */ if (
                            videoTrackToOpen.source.decoderConfigJSON !==
                            videoTrack.source.decoderConfigJSON
                        ) {
                            // ok!
                            change = true;
                        } else {
                            // no change, ignore

                            console.log(
                                "NO CHANGE",
                                videoTrack.source.decoderConfigJSON
                            );
                        }
                    } else {
                        change = true;
                    }

                    if (change) {
                        skip = true;
                        // console.log('got frame', chunk.type, arr.length, !!metadata.decoderConfig)
                        // deactivate previous
                        await openVideoStreamQueue
                            .add(async () => {
                                //  console.log('open video stream db!', videoStreamDB?.timestamp)

                                const newVideoTrack =
                                    await properties.mediaStreamDBs.node.open(
                                        videoTrackToOpen,
                                        {
                                            /*   trim: { type: 'length', to: 10 }, */
                                        }
                                    );
                                await newVideoTrack.source.replicate(
                                    "streamer"
                                );

                                await close(false); // do we need to call this more times? like while not closed close(false)? (TODO that was the previous behaviour)

                                await properties.mediaStreamDBs.tracks.put(
                                    newVideoTrack
                                );
                                trackPromise.resolve(newVideoTrack);
                                abortController = new AbortController();
                                videoTrack = newVideoTrack;
                                return newVideoTrack;
                            })
                            .finally(() => {
                                skip = false;
                            });
                    }
                }
                try {
                    if (
                        await waitFor(() => videoTrack, {
                            signal: abortController.signal,
                        })
                    ) {
                        mem += arr.byteLength;
                        properties.mediaStreamDBs.maybeUpdateMaxTime(
                            chunk.timestamp
                        );
                        lastChunkTimestamp = chunk.timestamp;
                        // console.log("VIDEO PUT CHUNK", toBase64(videoStreamDB.id), lastVideoChunkTimestamp, "bytes");

                        try {
                            await videoTrack.put(
                                new Chunk({
                                    type: chunk.type,
                                    chunk: arr,
                                    time: lastChunkTimestamp,
                                    /*  duration: chunk.duration, */
                                })
                            );
                        } catch (error) {
                            console.error("Failed to put chunk", error);
                            throw error;
                        }
                        //   console.log(mem / ((+new Date) - s0) * 1000)
                    }
                } catch (error) {
                    if (
                        error instanceof AbortError ||
                        error instanceof TimeoutError
                    ) {
                        return;
                    }
                    throw error;
                }
            },
        });

        const closeFn = encoder.close.bind(encoder);
        encoder.close = () => {
            //  abortController.abort(); TODO?
            console.log("CLOSE!");
            try {
                closeFn();
            } catch (error) {
                if (error["code"] === 20) {
                    // aborted
                    return;
                }
                throw error;
            }
        };
        // console.log("created encoder", encoder.state);
    };
    const drop = async (): Promise<void> => {
        abortController.abort();
        if (encoder?.state !== "closed") {
            encoder.close();
        }
        if (videoTrack) {
            await videoTrack.drop();
            await properties.mediaStreamDBs.tracks.del(videoTrack.id);
            console.log(
                "SIZE AFTER DELETE",
                await properties.mediaStreamDBs.tracks.index.getSize()
            );
        }
    };

    const controls = {
        setting: properties.quality,
        encoder: () => encoder,
        stream: () => videoTrack,
        close,
        drop,
        open,
        trackPromise: trackPromise.promise,
    };
    return controls;
};

const createAudioEncoder = async (properties: {
    mediaStreamDBs: MediaStreamDB;
    time:
        | { type: "live"; sessionTimestampRef: React.RefObject<number> }
        | { type: "0" };
    loopCounter: React.RefObject<number>;
    wavEncoder: React.RefObject<WAVEncoder>;
    videoRef: HTMLVideoElementWithCaptureStream;
}) => {
    /**
     * This function will capture the audio from the video
     * upon pause it will end the current track
     * upon play it will create a new track
     */

    let muted = properties.videoRef.muted;
    let initialized = false;

    let audioTrack: Track<AudioStreamDB> | undefined = undefined;
    const init = async () => {
        /* if (!properties.wavEncoder.current.hasSource) { TODO necessary check?
            console.log("No audio found");
            return null; // no audio
        } */

        if (initialized) {
            console.log("Already initialized");
            return;
        }

        initialized = true;

        let startPlayTime = -1;

        audioTrack = await properties.mediaStreamDBs.node.open(
            new Track({
                sender: properties.mediaStreamDBs.node.identity.publicKey,
                source: new AudioStreamDB({ sampleRate: 48000 }),
                ...(properties.time.type === "0"
                    ? {
                          start: 0,
                      }
                    : {
                          globalTime: resolveTimeStampRefValue(
                              properties.time.sessionTimestampRef
                          ),
                          now: hrtimeMicroSeconds,
                      }),
            })
        );
        await audioTrack.source.replicate("streamer");

        await properties.mediaStreamDBs.tracks.put(audioTrack, {
            target: "all",
        });

        let lastAudioTimestamp = -1;
        const wavListener = (data: {
            audioBuffer: Uint8Array;
            timestamp: number;
            last?: boolean;
        }) => {
            if (!data) {
                throw new Error("Unexpected: Missing audio data");
            }

            if (startPlayTime === -1) {
                startPlayTime =
                    properties.wavEncoder.current.ctx.currentTime * 1e6;
            }

            const { audioBuffer } = data as { audioBuffer: Uint8Array };
            /*       let currentTime = +new Date();
                  let timestamp =
                      lastVideoChunkTimestamp ||
                      (currentTime - lastAudioTime) * 1000 + lastAudioTimestamp;
                  lastAudioTime = currentTime; */
            // console.log("AUDIO PUT CHUNK", { id: toBase64(audioTrack.id), timestamp, diff: wavEncoder.current.audioContext.currentTime * 1e6 - startPlayTime, timeStamp: ev.timeStamp, startPlayTime, wavEncoderTime: wavEncoder.current.audioContext.currentTime });

            // for some reason, the audio gets glitchy if we use the timestamp?
            // so we use the ctx.currentTime instead
            let thisTime = Math.round(
                properties.wavEncoder.current.ctx.currentTime * 1e6 -
                    startPlayTime
            );
            if (thisTime == lastAudioTimestamp) {
                thisTime++;
            }
            lastAudioTimestamp = thisTime;

            audioTrack.put(
                new Chunk({
                    type: "key",
                    chunk: audioBuffer,
                    time: thisTime,
                })
            );
            /*     lastAudioTimestamp = timestamp; */
        };

        await properties.wavEncoder.current.init(
            {
                element: properties.videoRef,
            },
            {
                onChunk: wavListener,
            }
        );

        const closeEncoder = async () => {
            initialized = false;
            await properties.wavEncoder.current.pause();
        };
        const close = async () => {
            await closeEncoder();
            // await audioTrack.close() TODD should we also close? (we have disabled this because we need to ensure replication before doing this)
            properties.mediaStreamDBs.setEnd(
                audioTrack,
                properties.time.type === "live" ? undefined : lastAudioTimestamp
            );
        };

        const drop = async () => {
            await closeEncoder();
        };
        console.log("done init audio");
        return {
            close,
            pause: () => {
                console.trace("PAUSE AUDIO");
                properties.wavEncoder.current.pause();
            },
            drop,
            play: () => {
                if (properties.videoRef.muted) {
                    return;
                }
                console.log("PLAY AUDIO!", properties.videoRef.muted);
                properties.wavEncoder.current.play();
                if (properties.loopCounter.current === 0) {
                    startPlayTime =
                        properties.wavEncoder.current.ctx.currentTime * 1e6;
                }
            },
        };
    };

    let audioControlsPromise: Promise<{
        close: () => void;
        pause: () => Promise<void> | void;
        play: () => Promise<void> | void;
        drop: () => Promise<void>;
    }> | null = undefined;

    const onPlay = async () => {
        let controls = await audioControlsPromise;
        if (!controls) {
            audioControlsPromise = init();
        }

        controls = await audioControlsPromise;
        await controls?.play();
    };

    const reset = async () => {
        const controls = await audioControlsPromise;
        controls?.close();
        audioControlsPromise = undefined;
    };
    const onPause = async () => {
        const controls = await audioControlsPromise;
        controls?.pause();
    };

    const drop = async () => {
        if (audioTrack) {
            await properties.mediaStreamDBs.tracks.del(audioTrack.id);
            await audioTrack.drop();
        }

        const controls = await audioControlsPromise;
        await controls?.drop();
    };
    const onUnmute = async (ev) => {
        let wasMuted = muted;
        if (!properties.videoRef.muted && wasMuted) {
            await onPlay();
        } else if (properties.videoRef.muted && !wasMuted) {
            onPause();
        }
        muted = properties.videoRef.muted;
    };
    properties.videoRef.addEventListener("volumechange", onUnmute);

    return {
        play: onPlay,
        pause: onPause,
        close: () => {
            properties.videoRef.removeEventListener("volumechange", onUnmute);
            reset();
        },
        drop,
    };
};

const clampedFrameRate = (fps: number) => Math.max(Math.min(fps, 60), 10);

let streamByDefault = false;

const resolveTimeStampRefValue = (
    sessionTimestampRef: React.MutableRefObject<number>
) => {
    if (sessionTimestampRef.current == null) {
        sessionTimestampRef.current = Number(hrtimeMicroSeconds());
    }
    return sessionTimestampRef.current;
};

const trackScheduling: "live" | "0" = "0";

const shouldRerenderOnChange = (sourceType: StreamType) =>
    sourceType.type === "upload-media" || sourceType.type === "demo";

const preferCPUEncodingDefault = isSafari;
export const Renderer = (args: { stream: MediaStreamDB }) => {
    const [quality, setQuality] = useState<SourceSetting[]>([DEFAULT_QUALITY]);
    const [resolutionOptions, setResolutionOptions] = useState<Resolution[]>(
        []
    );
    const [sourceType, setSourceType] = useState<StreamType | undefined>(
        undefined
    );
    const sourceTypeRef = useRef<StreamType | undefined>(undefined);
    const { peer } = usePeer();

    const videoLoadedOnce = useRef(false);
    const { program: mediaStreamDB } = useProgram<MediaStreamDB>(
        peer,
        args.stream,
        {
            existing: "reuse",
        }
    );

    const { program: mediaStreamDBs } = useProgram<MediaStreamDBs>(
        peer,
        new MediaStreamDBs(),
        {
            existing: "reuse",
            args: {
                replicate: false,
            },
        }
    );
    const videoEncoders = useRef<VideoStream[]>([]);
    const audioCapture = useRef<{
        pause: () => void | Promise<void>;
        play: () => void | Promise<void>;
        close: () => void | Promise<void>;
        drop: () => Promise<void>;
    }>(undefined);
    const tickWorkerRef = useRef<Worker>(undefined);
    const lastFrameRate = useRef(30);
    const scheduleFrameFn =
        useRef<
            (
                now: DOMHighResTimeStamp,
                metadata: VideoFrameCallbackMetadata
            ) => void
        >(undefined);
    const sourceId = useRef(0);
    const startId = useRef(0);

    const preferCPUEncodingRef = useRef(preferCPUEncodingDefault);
    const sessionTimestampRef = useRef<number | undefined>(undefined);

    let videoRef = useRef<HTMLVideoElementWithCaptureStream>(undefined);

    const [errorMessage, setErrorMessage] = useState<string | undefined>(
        undefined
    );
    const [loop, setLoop] = useState(false);

    const wavEncoder = useRef(new WAVEncoder());
    const loopCounter = useRef(0);
    const frameEncodingQueue = useRef(new PQueue({ concurrency: 1 }));
    const [waitingForEncoder, setWaitingForEncoder] = useState(false);

    useEffect(() => {
        const clickListener = () => {
            setErrorMessage(undefined);
        };
        window.addEventListener("click", clickListener);
        return () => window.removeEventListener("click", clickListener);
    });

    useEffect(() => {
        if (!tickWorkerRef.current) {
            tickWorkerRef.current = new TickWorker();
            const tickListener = () => {
                // TODO background safari?
                scheduleFrameFn.current?.(undefined, undefined);
            };

            let listener = () => {
                if (document.hidden) {
                    tickWorkerRef.current.postMessage({
                        type: "next",
                        tps: clampedFrameRate(lastFrameRate.current),
                    } as NextTick);
                    tickWorkerRef.current.addEventListener(
                        "message",
                        tickListener
                    );
                } else {
                    tickWorkerRef.current.postMessage({ type: "stop" } as Stop);
                    tickWorkerRef.current.removeEventListener(
                        "message",
                        tickListener
                    );
                }
            };

            document.addEventListener("visibilitychange", listener);

            return () => {
                tickWorkerRef.current.removeEventListener(
                    "message",
                    tickListener
                );

                document.removeEventListener("visibilitychange", listener);
                tickWorkerRef.current.terminate();
                tickWorkerRef.current = undefined;
            };
        }
    }, []);

    useEffect(() => {
        if (
            videoLoadedOnce.current ||
            !mediaStreamDB ||
            mediaStreamDB?.closed ||
            !mediaStreamDBs ||
            mediaStreamDBs?.closed
        ) {
            return;
        }

        if (streamByDefault) {
            updateStream({ streamType: { type: "noise" }, quality: quality });
        }

        // announce it in the discovery db so other replicators (non browser) nodes can find it and replicate it
        mediaStreamDBs.mediaStreams.put(mediaStreamDB);

        videoLoadedOnce.current = true;
    }, [
        videoRef.current,
        mediaStreamDB?.address,
        mediaStreamDB?.closed,
        mediaStreamDBs?.address,
        mediaStreamDBs?.closed,
    ]);

    useEffect(() => {
        if (!mediaStreamDB?.address) {
            return;
        }
        const stopMaxTime = mediaStreamDB.listenForMaxTimeChanges(true).stop;

        const stopReplicationInfo =
            mediaStreamDB.listenForReplicationInfo().stop;
        return () => {
            stopMaxTime();
            stopReplicationInfo();
        };
    }, [mediaStreamDB?.address]);

    const updateStream = async (properties: {
        streamType?: StreamType;
        quality: SourceSetting[];
    }) => {
        preferCPUEncodingRef.current = preferCPUEncodingDefault;

        const updateQualitySettingsState = () => {
            let qualitySetting = properties.quality || quality;
            setQuality(
                [...qualitySetting].sort(
                    (a, b) => b.video.height - a.video.height
                )
            );
        };

        const dropAll = async () => {
            frameEncodingQueue.current.clear();
            setWaitingForEncoder(false);

            // we should rerender all so so lets just drop all dbs and pretend we are fresh
            if (videoEncoders.current) {
                for (const encoder of videoEncoders.current) {
                    await encoder.drop();
                }
                videoEncoders.current = [];
            }

            if (audioCapture.current) {
                await audioCapture.current.drop();
                audioCapture.current = undefined;
            }
        };

        const updateQualitySettings = async (rerender?: boolean) => {
            let existingVideoEncoders: VideoStream[] = [];

            const shouldRerender =
                rerender ?? shouldRerenderOnChange(sourceTypeRef.current);

            if (shouldRerender) {
                sessionTimestampRef.current = undefined;
                videoRef?.current?.pause();
                await dropAll();
                await createAndAssignAudioEcoder(); // we need to recreate the audio encoder because we are changing the source
            }

            // Check removed qualities
            for (const encoder of videoEncoders.current) {
                let stream = properties.quality.find(
                    (x) =>
                        encoder.stream()?.source.decoderDescription
                            .codedHeight === x.video.height
                );
                if (!stream) {
                    await encoder.close();
                } else {
                    existingVideoEncoders.push(encoder);
                }
            }

            // Create new video streams for new qualities
            const newVideoStreams = await createNewVideoEncoders(
                videoEncoders.current,
                properties.quality
            );

            videoEncoders.current = [
                ...newVideoStreams,
                ...existingVideoEncoders,
            ];

            updateQualitySettingsState();

            if (shouldRerender) {
                videoRef.current.currentTime = 0;
            }

            videoRef.current.play();
        };

        const createNewVideoEncoders = async (
            current: VideoStream[],
            qualities: SourceSetting[]
        ) => {
            let newVideoEncoders: VideoStream[] = [];
            for (const quality of qualities) {
                if (
                    !current.find(
                        (y) =>
                            JSON.stringify(y.setting) ===
                            JSON.stringify(quality)
                    )
                ) {
                    // console.log("new quality!", videoEncoders.current.map(x => x.setting.video.height), "-->", q.video.height)
                    let controls = createVideoEncoder({
                        mediaStreamDBs: mediaStreamDB,
                        time:
                            (trackScheduling as any) === "live"
                                ? {
                                      type: "live",
                                      sessionTimestampRef: sessionTimestampRef,
                                  }
                                : {
                                      type: "0",
                                  },
                        quality,
                        setErrorMessage: (msg) => setErrorMessage(msg),
                        preferCPUEncoding: async () => {
                            if (!preferCPUEncodingRef.current) {
                                console.log("PREFER CPU ENCODING");
                                preferCPUEncodingRef.current = true;
                                await updateQualitySettings(true);
                                return true;
                            }
                            return false;
                        },
                    });

                    await controls.open();

                    newVideoEncoders.push(controls);
                }
            }
            return newVideoEncoders;
        };

        const createAndAssignAudioEcoder = async () => {
            audioCapture.current = await createAudioEncoder({
                mediaStreamDBs: mediaStreamDB,
                time:
                    (trackScheduling as any) === "live"
                        ? {
                              type: "live",
                              sessionTimestampRef: sessionTimestampRef,
                          }
                        : {
                              type: "0",
                          },
                loopCounter,
                wavEncoder,
                videoRef: videoRef.current,
            });
        };

        if (!properties.streamType) {
            // only quality has changed
            await updateQualitySettings();

            return; // nothing more to do
        } else {
            sourceTypeRef.current = properties.streamType;

            await dropAll();

            videoRef.current.removeAttribute("src");
            (videoRef.current.srcObject as MediaStream)
                ?.getTracks()
                .forEach((track) => {
                    if (track.readyState == "live") {
                        track.stop();
                    }
                    (videoRef.current.srcObject as MediaStream).removeTrack(
                        track
                    );
                });

            videoRef.current.srcObject = undefined;

            if (properties.quality.length === 0 && quality.length === 0) {
                properties.quality = [DEFAULT_QUALITY]; // when changing source with no resolution set, choose the default one
            }

            videoEncoders.current = await createNewVideoEncoders(
                [],
                properties.quality
            );

            updateQualitySettingsState();

            // update for new source type

            const videoElementRef = await waitFor(() => videoRef.current);

            let firstQuality = quality[0]; // qualities are sorted

            videoElementRef.pause();

            loopCounter.current = 0;
            sourceId.current += 1;

            await createAndAssignAudioEcoder();

            switch (sourceTypeRef.current.type) {
                case "noise":
                    videoElementRef.muted = true;
                    videoElementRef.src =
                        import.meta.env.BASE_URL + "noise.mp4";
                    videoElementRef.load();

                    break;
                case "demo":
                    videoElementRef.src = import.meta.env.BASE_URL + "bird.mp4";
                    videoElementRef.preload = "auto";
                    videoElementRef.load();
                    break;
                case "upload-media":
                    videoElementRef.src = sourceTypeRef.current.src;
                    videoElementRef.preload = "auto";
                    videoElementRef.load();
                    break;

                case "camera":
                    videoElementRef.srcObject =
                        await navigator.mediaDevices.getUserMedia({
                            video: {
                                height: { ideal: 720 },
                            },
                            audio: !!firstQuality.audio
                                ? {
                                      autoGainControl: false,
                                      echoCancellation: false,
                                      noiseSuppression: false,
                                  }
                                : false,
                        });

                    break;

                case "screen":
                    videoElementRef.srcObject =
                        await navigator.mediaDevices.getDisplayMedia({
                            video: {
                                height: { ideal: 1440 },
                                //height: { ideal: 1440 }
                            }, // { height: s.video.height, width: s.video.width },
                            audio: {
                                autoGainControl: false,
                                echoCancellation: false,
                                noiseSuppression: false,
                            },
                        });

                    break;
            }
            videoRef.current.play();
        }
    };

    const onRender = async (videoRef: HTMLVideoElementWithCaptureStream) => {
        if (sourceTypeRef.current == null) {
            return;
        }

        // manage audio capture
        audioCapture.current.play();

        // manage video encoders
        if (sourceId.current === startId.current) {
            return;
        }

        startId.current = sourceId.current;
        const sourceIdOnStart = startId.current;

        let totalFrameCounter = 0;
        let lastFrame: number | undefined = undefined;
        let framesSinceLastBackground = 0;
        let lastFrameTimestamp = -1;
        let firstFrameHighresTimestamp: undefined | number = undefined;

        const maxEncoderQueueSize = 30;
        const requestFrame = () => {
            if (!inBackground && "requestVideoFrameCallback" in videoRef) {
                videoRef.requestVideoFrameCallback(frameFn);
            } else {
                console.log("USE TICK WORKER");
                tickWorkerRef.current.postMessage({
                    type: "next",
                    tps: clampedFrameRate(lastFrameRate.current),
                } as NextTick);
            }
        };

        const frameFn = async (
            domHighRes?: DOMHighResTimeStamp,
            metadata?: VideoFrameCallbackMetadata
        ) => {
            try {
                if (sourceIdOnStart !== sourceId.current) {
                    return; // new source, expect a reboot of the frame loop cycle
                }

                const now = domHighRes ?? performance.now();

                if (!inBackground) {
                    if (lastFrame != null && framesSinceLastBackground > 10) {
                        lastFrameRate.current = 1000 / (now - lastFrame);
                    }
                    lastFrame = now;
                    framesSinceLastBackground++;
                } else {
                    lastFrame = undefined;
                    framesSinceLastBackground = 0;
                }

                if (firstFrameHighresTimestamp == null) {
                    firstFrameHighresTimestamp = now;
                }

                const observedMediaTime =
                    !metadata ||
                    (metadata.presentedFrames > 0 && metadata.mediaTime === 0)
                        ? (now - firstFrameHighresTimestamp) * 1e3
                        : Math.round(metadata.mediaTime * 1e6);
                const timestamp =
                    loopCounter.current > 0
                        ? loopCounter.current * videoRef.duration * 1e6 +
                          observedMediaTime
                        : isSafari
                          ? observedMediaTime
                          : undefined;

                let frame = new VideoFrame(videoRef, {
                    timestamp,
                });
                if (preferCPUEncodingRef.current) {
                    frame = await convertGPUFrameToCPUFrame(videoRef, frame);
                }
                const encodeFrameFn = async () => {
                    /* console.log("Render frame: ", {
                        timestamp,
                        frameTimestamp: frame.timestamp,
                        observedMediaTime,
                        firstFrameHighresTimestamp,
                    }); */

                    // console.log("FRAME", { domHighRes, metadata, timestamp, frameCounter, currentTime: videoRef.currentTime, out: frame.timestamp, outBefore: beforeTimeStamp });

                    let newTimestamp = frame.timestamp;
                    /* if (newTimestamp === lastFrameTimestamp) {
                        frame.close();
                        return;
                    } */

                    if (newTimestamp !== lastFrameTimestamp) {
                        lastFrameTimestamp = newTimestamp;
                        for (const videoEncoder of videoEncoders.current) {
                            const encoder = videoEncoder.encoder();
                            if (encoder.state !== "closed") {
                                if (
                                    videoEncoder.video &&
                                    (videoEncoder.video.height !==
                                        videoRef.videoHeight ||
                                        videoEncoder.video.width !==
                                            videoRef.videoWidth)
                                ) {
                                    // Reinitialize a new stream, size the aspect ratio has changed
                                    let limitedQualities = quality.filter(
                                        (x) =>
                                            x.video.height <=
                                            videoRef.videoHeight
                                    );
                                    if (
                                        limitedQualities.length !==
                                        quality.length
                                    ) {
                                        frame.close();
                                        await updateStream({
                                            streamType: sourceTypeRef.current,
                                            quality: limitedQualities,
                                        });
                                        return;
                                    } else {
                                        await videoEncoder.open();
                                    }
                                    //  console.log('resolution change reopen!', videoEncoder.video.height, videoRef.videoHeight)
                                }

                                videoEncoder.video = {
                                    height: videoRef.videoHeight,
                                    width: videoRef.videoWidth,
                                };

                                if (encoder.state === "unconfigured") {
                                    let scaler =
                                        videoEncoder.setting.video.height /
                                        videoRef.videoHeight;
                                    // console.log('set bitrate', videoEncoder.setting.video.bitrate)
                                    encoder.configure({
                                        codec: "vp09.00.51.08.01.01.01.01.00" /*  "vp09.00.10.08" */ /* isSafari
                                        ? "avc1.428020"
                                        : "av01.0.04M.10" */ /* "vp09.00.10.08", */ /* "avc1.428020" ,*/, //"av01.0.04M.10", // "av01.0.08M.10",//"av01.2.15M.10.0.100.09.16.09.0" //
                                        height: videoEncoder.setting.video
                                            .height,
                                        width: videoRef.videoWidth * scaler,
                                        bitrate:
                                            videoEncoder.setting.video.bitrate,
                                        latencyMode: "realtime",
                                        bitrateMode: "variable",
                                    });
                                }

                                if (encoder.state === "configured") {
                                    if (
                                        encoder.encodeQueueSize >
                                        maxEncoderQueueSize + 1
                                    ) {
                                        // Too many frames in flight, encoder is overwhelmed
                                        // let's drop this frame.
                                        encoder.flush();

                                        // TODO in non streaming mode, slow down the playback
                                    } else {
                                        const droppedFrames = Math.max(
                                            (metadata?.presentedFrames ?? 0) -
                                                totalFrameCounter,
                                            0
                                        );
                                        /*  console.log({ droppedFrames })
                                         if (metadata?.presentedFrames && metadata?.presentedFrames > 10 && droppedFrames / metadata.presentedFrames > 0.1) {
                                             videoRef.playbackRate = 0.3;
                                         } */
                                        /* console.log({
                                            frameCounter: totalFrameCounter,
                                            playedFrame:
                                                metadata?.presentedFrames,
                                            droppedFrames,
                                        }); */
                                        totalFrameCounter++;
                                        const insertKeyframe =
                                            Math.round(
                                                totalFrameCounter /
                                                    videoEncoders.current.length
                                            ) %
                                                60 ===
                                            0;

                                        //let t1 = +new Date;
                                        //        console.log("PUT CHUNK", encoder.encodeQueueSize, (t1 - t0));
                                        // t0 = t1;
                                        encoder.encode(frame, {
                                            keyFrame: insertKeyframe,
                                        });
                                    }
                                }
                            }
                        }
                    }
                    frame.close();
                };

                frameEncodingQueue.current.add(encodeFrameFn);

                if (frameEncodingQueue.current.size > maxEncoderQueueSize) {
                    videoRef.pause();
                    setWaitingForEncoder(true);
                    frameEncodingQueue.current.onIdle().then(() => {
                        videoRef.play();
                        setWaitingForEncoder(false);
                    });
                }
            } catch (error) {
                console.error("err?", error);
                throw error;
            }
            requestFrame();
        };
        scheduleFrameFn.current = frameFn;
        requestFrame();
    };
    const onEnd = async () => {
        console.log("end?");
        if (loop || sourceTypeRef.current.type === "noise") {
            loopCounter.current++;
            videoRef.current.play();
        } else {
            return Promise.all([
                audioCapture.current.close(),
                videoEncoders.current.map((x) => x.close()),
            ]);
        }
    };

    const onPause = async () => {
        console.log("pause?");
        if (sourceTypeRef.current == null) {
            return;
        }

        if (videoRef.current.ended && loop) {
            return; // dont pause recorders because we are going to loop around and play again
        }
        await audioCapture.current.pause();
    };

    return (
        <div className="flex flex-col space-y-4">
            <div
                className={`flex ${
                    !inIframe() ? "justify-center" : "justify-start"
                } ${!inIframe() ? "max-h-[80%]" : "max-h-full"}`}
            >
                {/*  <div className="absolute z-50">
                    {sourceType == null && <div className="">
                        <FirstMenuSelect setSourceType={(settings) => {
                            console.log("HERE", settings)
                            setSourceType(settings)
                            updateStream({
                                streamType: settings,
                                quality: quality,
                            });
                        }}

                            sourceType={sourceType} />
                    </div>
                    }
                </div> */}
                <div className="container">
                    <div className="video-wrapper">
                        <video
                            crossOrigin="anonymous"
                            data-iframe-height
                            playsInline
                            ref={(ref) => {
                                videoRef.current =
                                    ref as HTMLVideoElementWithCaptureStream;
                            }}
                            height="auto"
                            width="100%"
                            onPlay={(e) =>
                                onRender(
                                    e.currentTarget as HTMLVideoElementWithCaptureStream
                                )
                            }
                            onPause={() => {
                                onPause();
                            }}
                            onEnded={() => {
                                onEnd();
                            }}
                            onResize={(ev) => {
                                if (videoRef && sourceTypeRef?.current) {
                                    // TODO why do we need this here?
                                    if (
                                        sourceTypeRef.current.type ===
                                            "noise" ||
                                        sourceTypeRef.current.type ===
                                            "upload-media"
                                    ) {
                                        setResolutionOptions(
                                            RESOLUTIONS.filter(
                                                (x) =>
                                                    x <=
                                                    ev.currentTarget.videoHeight
                                            )
                                        );
                                    } else {
                                        setResolutionOptions(RESOLUTIONS);
                                    }
                                }
                            }}
                            autoPlay
                            onClick={() =>
                                videoRef.current.paused
                                    ? videoRef.current.play()
                                    : videoRef.current.pause()
                            }
                            muted={sourceTypeRef.current?.type === "noise"}
                            controls={false}
                            className={
                                sourceType == null
                                    ? "absolute left-[-9999px] right-[-9999px]"
                                    : ""
                            }
                        ></video>
                        {waitingForEncoder && (
                            <div className="center-middle">
                                Waiting for encoder:{" "}
                                {frameEncodingQueue.current.size}
                            </div>
                        )}
                        {sourceType == null ? (
                            <div className="mt-4 mb-4">
                                <FirstMenuSelect
                                    setSourceType={(settings) => {
                                        setSourceType(settings);
                                        updateStream({
                                            streamType: settings,
                                            quality: quality,
                                        });
                                    }}
                                    sourceType={sourceType}
                                />
                            </div>
                        ) : (
                            <>
                                <div className="w-full">
                                    <Controls
                                        selectedResolution={
                                            quality.map(
                                                (x) => x.video.height
                                            ) as Resolution[]
                                        }
                                        resolutionOptions={resolutionOptions}
                                        sourceType={sourceType}
                                        setSourceType={(settings) => {
                                            setSourceType(settings);
                                            updateStream({
                                                streamType: settings,
                                                quality: quality,
                                            });
                                        }}
                                        onQualityChange={(settings) => {
                                            updateStream({ quality: settings });
                                        }}
                                        onVolumeChange={() => {}}
                                        videoRef={videoRef.current}
                                        viewRef={videoRef.current}
                                        alwaysShow={true}
                                        muted={
                                            sourceTypeRef.current?.type ===
                                            "noise"
                                        }
                                        mediaStreams={mediaStreamDB}
                                    />
                                </div>
                            </>
                        )}
                    </div>
                </div>
            </div>

            {sourceType != null && (
                <Tracks
                    mediaStreams={args.stream}
                    currentTime={0}
                    setProgress={() => {}}
                    videoRef={videoRef.current}
                />
            )}
            {errorMessage && (
                <Dialog.Root open={true}>
                    <Dialog.Portal>
                        <Dialog.Overlay className="fixed inset-0 bg-black opacity-30" />
                        <Dialog.Content
                            className="fixed top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 bg-white p-6 rounded-lg shadow-lg"
                            onEscapeKeyDown={() => setErrorMessage(undefined)}
                            onPointerDownOutside={() =>
                                setErrorMessage(undefined)
                            }
                        >
                            <div className="flex items-center">
                                <FiAlertCircle
                                    className="text-red-500 mr-2"
                                    size={24}
                                />
                                <Dialog.Title className="text-lg font-bold">
                                    Error
                                </Dialog.Title>
                            </div>
                            <Dialog.Description className="mt-2 text-sm text-gray-600">
                                {errorMessage}
                            </Dialog.Description>
                            <div className="mt-4 flex justify-end">
                                <button
                                    onClick={() => setErrorMessage(undefined)}
                                    className="px-4 py-2 bg-blue-500 text-white rounded"
                                >
                                    Close
                                </button>
                            </div>
                        </Dialog.Content>
                    </Dialog.Portal>
                </Dialog.Root>
            )}
            {/* {true && <View db={mediaStreamDBs.current} node={args.node} ></View>} */}
        </div>
    );
};
