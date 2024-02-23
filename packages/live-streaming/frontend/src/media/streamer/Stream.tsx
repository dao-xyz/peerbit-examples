import { inIframe, usePeer, useProgram } from "@peerbit/react";
import React, { useRef, useState, useEffect, useCallback } from "react";
import {
    Chunk,
    WebcodecsStreamDB,
    Track,
    MediaStreamDB,
    AudioStreamDB,
} from "../database";
import { Buffer } from "buffer";
import { waitFor } from "@peerbit/time";
import { Alert, AlertTitle, Grid, Snackbar } from "@mui/material";
import { PublicSignKey } from "@peerbit/crypto";
import {
    SourceSetting,
    StreamType,
    Resolution,
    resolutionToSourceSetting,
    RESOLUTIONS,
} from "../controls/settings.js";

import { Controls } from "./controller/Control";
import PQueue from "p-queue";
import { WAVEncoder } from "./audio.js";
import TickWorker from "./tickWorker.js?worker";
import { NextTick, Stop } from "./tickWorker.js";
import { Client } from "@peerbit/program";
import { delay } from "@peerbit/time";
import { toBase64 } from "@peerbit/crypto";

interface HTMLVideoElementWithCaptureStream extends HTMLVideoElement {
    captureStream(fps?: number): MediaStream;
    mozCaptureStream?(fps?: number): MediaStream;
}

const PACK_PERFECTLY = false;
if (PACK_PERFECTLY) {
    globalThis.Buffer = Buffer;
}
/* globalThis.VSTATS = new Map(); */

let inBackground = false;
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        inBackground = true;
    } else {
        inBackground = false;
    }
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
    open: () => Promise<void>;
}

let lastVideoChunkTimestamp: number | undefined = undefined;
const openVideoStreamQueue = new PQueue({ concurrency: 1 });

const DEFAULT_QUALITY = resolutionToSourceSetting(360);

const isTouchScreen = window.matchMedia("(pointer: coarse)").matches;

const createVideoEncoder = (
    mediaStreamDBs: MediaStreamDB,
    sessionTimestampRef: React.RefObject<number>,
    quality: SourceSetting,
    setErrorMessage: (message: string) => void
): VideoStream => {
    let videoStreamDB: Track<WebcodecsStreamDB> | undefined = undefined;
    let encoder: VideoEncoder | undefined = undefined;
    let abortController = new AbortController();

    let openTimestamp: number = 0;
    let close = async (closeEncoder: boolean = true) => {
        abortController.abort();
        if (closeEncoder && encoder && encoder?.state !== "closed") {
            encoder.close();
        }

        if (videoStreamDB) {
            videoStreamDB.source.close();
            videoStreamDB.setEnd();

            // update the track with the end timer

            await mediaStreamDBs.tracks.put(videoStreamDB, {
                target: "all",
            });

            console.log(
                "CLOSE VIDEO STREAM",
                videoStreamDB.source.decoderConfigJSON
            );
            videoStreamDB = undefined;
        }
    };

    let open = async () => {
        // console.log('open!')
        /* if (encoder && encoder.state !== "closed") {
            await encoder.close();
        } */

        let skip = false;
        let s0: number | undefined = undefined;
        let mem = 0;

        console.log("NEW ENCODER!");
        encoder = new VideoEncoder({
            error: (e) => {
                console.error(e);
                const msg = "Failed to encode video.\n" + e.toString();
                setErrorMessage(msg);
            },
            output: async (chunk, metadata) => {
                if (skip) {
                    return;
                }
                let arr = new Uint8Array(chunk.byteLength);
                chunk.copyTo(arr);

                if (metadata.decoderConfig) {
                    openTimestamp = sessionTimestampRef.current;
                    const videoTrack = new Track<WebcodecsStreamDB>({
                        sender: mediaStreamDBs.owner,
                        source: new WebcodecsStreamDB({
                            decoderDescription: metadata.decoderConfig,
                            /*   timestamp: videoStreamDB?.timestamp, ??? */
                        }),
                        globalTime: openTimestamp,
                        now: () => performance.now(),
                    });

                    let change = false;
                    if (videoStreamDB) {
                        /*  if (
                                    videoTrack.session >
                                    videoStreamDB.session
                                ) {
                                    // ok!
                                    change = true;
                                } else  */ if (
                            videoTrack.source.decoderConfigJSON !==
                            videoStreamDB.source.decoderConfigJSON
                        ) {
                            // ok!
                            change = true;
                        } else {
                            // no change, ignore

                            console.log(
                                "NO CHANGE",
                                videoStreamDB.source.decoderConfigJSON
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

                                const r = await mediaStreamDBs.node.open(
                                    videoTrack,
                                    {
                                        args: {
                                            role: {
                                                type: "replicator",
                                                factor: 1,
                                            },
                                        },
                                        /*   trim: { type: 'length', to: 10 }, */
                                    }
                                );
                                while (videoStreamDB) {
                                    await close(false);
                                }
                                mediaStreamDBs.tracks.put(r);
                                abortController = new AbortController();
                                videoStreamDB = r;
                                return r;
                            })
                            .finally(() => {
                                skip = false;
                            });
                    }
                }
                if (
                    await waitFor(() => videoStreamDB, {
                        signal: abortController.signal,
                    })
                ) {
                    mem += arr.byteLength;
                    lastVideoChunkTimestamp = chunk.timestamp;
                    // console.log("VIDEO PUT CHUNK", toBase64(videoStreamDB.id), lastVideoChunkTimestamp, "bytes");

                    try {
                        await videoStreamDB.source.chunks.put(
                            new Chunk({
                                type: chunk.type,
                                chunk: arr,
                                time: lastVideoChunkTimestamp,
                                /*  duration: chunk.duration, */
                            }),
                            {
                                target: "all",
                                meta: { next: [] },
                                unique: true,
                            }
                        );
                    } catch (error) {
                        console.error("FFF", openVideoStreamQueue.size, error);
                        throw error;
                    }

                    //   console.log(mem / ((+new Date) - s0) * 1000)
                }
            },
        });
        // console.log("created encoder", encoder.state);
    };

    const controls = {
        setting: quality,
        encoder: () => encoder,
        stream: () => videoStreamDB,
        close,
        open,
    };
    return controls;
};

const createAudioEncoder = async (
    mediaStreamDBs: MediaStreamDB,
    sessionTimestampRef: React.RefObject<number>,
    loopCounter: React.RefObject<number>,
    wavEncoder: React.RefObject<WAVEncoder>,
    videoRef: HTMLVideoElementWithCaptureStream
) => {
    /**
     * This function will capture the audio from the video
     * upon pause it will end the current track
     * upon play it will create a new track
     */

    let muted = videoRef.muted;
    let initialized = false;
    let openTimestamp = 0;

    console.log("CREATE AUDIO RECORDER");

    const init = async () => {
        await wavEncoder.current.init(videoRef);
        if (wavEncoder.current.source == null) {
            return; // no audio
        }

        if (initialized) {
            return;
        }

        initialized = true;

        let startPlayTime = 0;

        openTimestamp = sessionTimestampRef.current;

        console.log("INIT AUDIO TRAACK");
        const audioTrack = await mediaStreamDBs.node.open(
            new Track({
                sender: mediaStreamDBs.node.identity.publicKey,
                source: new AudioStreamDB({ sampleRate: 48000 }),
                globalTime: openTimestamp,
                now: () => performance.now(),
            }),
            {
                args: {
                    role: {
                        type: "replicator",
                        factor: 1,
                    },
                },
            }
        );

        await mediaStreamDBs.tracks.put(audioTrack, { target: "all" });

        const wavListener = (ev: {
            data: { audioBuffer: Uint8Array };
            timeStamp: number;
        }) => {
            if (!ev.data) {
                throw new Error("Unexpected: Missing audio data");
            }

            const { audioBuffer } = ev.data as { audioBuffer: Uint8Array };
            /*       let currentTime = +new Date();
                  let timestamp =
                      lastVideoChunkTimestamp ||
                      (currentTime - lastAudioTime) * 1000 + lastAudioTimestamp;
                  lastAudioTime = currentTime; */
            // console.log("AUDIO PUT CHUNK", { id: toBase64(audioTrack.id), timestamp, diff: wavEncoder.current.audioContext.currentTime * 1e6 - startPlayTime, timeStamp: ev.timeStamp, startPlayTime, wavEncoderTime: wavEncoder.current.audioContext.currentTime });

            audioTrack.source.chunks.put(
                new Chunk({
                    type: "key",
                    chunk: audioBuffer,
                    time: Math.round(
                        wavEncoder.current.audioContext.currentTime * 1e6 -
                            startPlayTime
                    ),
                }),
                {
                    target: "all",
                    unique: true,
                }
            );
            /*     lastAudioTimestamp = timestamp; */
        };

        wavEncoder.current.node.port.addEventListener("message", wavListener);

        const close = async () => {
            initialized = false;
            wavEncoder.current.node.port.removeEventListener(
                "message",
                wavListener
            );
            await wavEncoder.current.pause();
            await audioTrack.close();
            console.log("CLOSE AUDIO TRACK");
            audioTrack.setEnd();
            mediaStreamDBs.tracks.put(audioTrack, { target: "all" });
        };
        return {
            close,
            pause: () => {
                console.log("PAUSE AUDIO");
                wavEncoder.current.pause();
            },
            play: () => {
                if (videoRef.muted) {
                    return;
                }
                console.log("PLAY AUDIO!", videoRef.muted);

                wavEncoder.current.play();
                if (loopCounter.current === 0) {
                    startPlayTime =
                        wavEncoder.current.audioContext.currentTime * 1e6;
                }
            },
        };
    };

    let audioControlsPromise:
        | Promise<{
              close: () => void;
              pause: () => Promise<void> | void;
              play: () => Promise<void> | void;
          }>
        | undefined = undefined;

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
        console.log("RESET AUDIO", controls);
        controls?.close();
        audioControlsPromise = undefined;
    };
    const onPause = async () => {
        reset();
    };

    const onUnmute = async (ev) => {
        let wasMuted = muted;

        if (!videoRef.muted && wasMuted) {
            await onPlay();
        } else if (videoRef.muted && !wasMuted) {
            onPause();
        }

        muted = videoRef.muted;
    };
    videoRef.addEventListener("volumechange", onUnmute);

    return {
        play: onPlay,
        pause: onPause,
        close: () => {
            videoRef.removeEventListener("volumechange", onUnmute);
            reset();
        },
    };
};

const clampedFrameRate = (fps: number) => Math.max(Math.min(fps, 60), 10);
export const Stream = (args: { stream: MediaStreamDB }) => {
    const streamType = useRef<StreamType>({ type: "noise" });
    const [quality, setQuality] = useState<SourceSetting[]>([DEFAULT_QUALITY]);
    const [resolutionOptions, setResolutionOptions] = useState<Resolution[]>(
        []
    );
    const videoLoadedOnce = useRef(false);
    const { peer } = usePeer();
    const { stream: mediaStreamDBs } = args;
    const videoEncoders = useRef<VideoStream[]>([]);
    const audioCapture = useRef<{
        pause: () => void | Promise<void>;
        play: () => void | Promise<void>;
        close: () => void | Promise<void>;
    }>(undefined);
    const tickWorkerRef = useRef<Worker>();
    const lastFrameRate = useRef(30);
    const scheduleFrameFn = useRef<() => void>();
    const sourceId = useRef(0);
    const startId = useRef(0);

    const sessionTimestampRef = useRef(performance.now());
    /*     const bumpSession = useCallback(() => {
            sessionTimestampRef.current = + new Date;
        }, []); */

    let videoRef = useRef<HTMLVideoElementWithCaptureStream>();

    const [errorMessage, setErrorMessage] = useState<string | undefined>(
        undefined
    );
    const [loop, setLoop] = useState(true);

    const wavEncoder = useRef(new WAVEncoder());
    const loopCounter = useRef(0);

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
                scheduleFrameFn.current?.();
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
        if (videoLoadedOnce.current || !mediaStreamDBs) {
            return;
        }
        updateStream({ streamType: { type: "noise" }, quality: quality });
        videoLoadedOnce.current = true;
    }, [videoRef.current, mediaStreamDBs?.address]);

    const updateStream = async (properties: {
        streamType?: StreamType;
        quality: SourceSetting[];
    }) => {
        let prevStreamType = streamType.current;

        const updateQualitySettings = () => {
            let qualitySetting = properties.quality || quality;
            setQuality(
                [...qualitySetting].sort(
                    (a, b) => b.video.height - a.video.height
                )
            );
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
                    let controls = createVideoEncoder(
                        mediaStreamDBs,
                        sessionTimestampRef,
                        quality,
                        (msg) => setErrorMessage(msg)
                    );

                    await controls.open();

                    newVideoEncoders.push(controls);
                }
            }
            return newVideoEncoders;
        };

        if (!properties.streamType) {
            // only quality has changed

            let existingVideoEncoders: VideoStream[] = [];

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

            updateQualitySettings();
            return; // nothing more to do
        } else {
            // stream type has changed
            streamType.current = properties.streamType;

            //  Cleanup video from previous soruce
            /* if (!prevStreamType) {
                bumpSession(); // should we do this, what about the DEFAULT_QUALTIY IS ALREADY IN QUALITY?
            } */

            // remove existing encoders
            for (const encoder of videoEncoders.current) {
                await encoder.close();
            }

            // close before video pause (to make the closing "clean")
            await audioCapture.current?.close();

            console.log("STOP TRACK");
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

            updateQualitySettings();

            // update for new source type

            const videoElementRef = await waitFor(() => videoRef.current);

            let firstQuality = quality[0]; // qualities are sorted

            videoElementRef.pause();

            loopCounter.current = 0;
            sourceId.current += 1;
            audioCapture.current = await createAudioEncoder(
                mediaStreamDBs,
                sessionTimestampRef,
                loopCounter,
                wavEncoder,
                videoElementRef
            );
            switch (streamType.current.type) {
                case "noise":
                    videoElementRef.muted = true;
                    videoElementRef.src =
                        import.meta.env.BASE_URL + "noise.mp4";
                    videoElementRef.load();
                    break;
                case "media":
                    videoElementRef.src = streamType.current.src;
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
        }
    };

    const onPlay = async (videoRef: HTMLVideoElementWithCaptureStream) => {
        // manage audio capture
        audioCapture.current.play();

        // manage video encoders
        if (sourceId.current === startId.current) {
            return;
        }

        startId.current = sourceId.current;
        const sourceIdOnStart = startId.current;

        if (videoRef && streamType) {
            // TODO why do we need this here?
            if (
                streamType.current.type === "noise" ||
                streamType.current.type === "media"
            ) {
                setResolutionOptions(
                    RESOLUTIONS.filter((x) => x <= videoRef.videoHeight)
                );
            } else {
                setResolutionOptions(RESOLUTIONS);
            }
        }

        let frameCounter = 0;
        let lastFrame: number | undefined = undefined;
        let framesSinceLastBackground = 0;
        let lastFrameTimestamp = -1;
        const requestFrame = () => {
            if (!inBackground && "requestVideoFrameCallback" in videoRef) {
                videoRef.requestVideoFrameCallback(frameFn);
            } else {
                tickWorkerRef.current.postMessage({
                    type: "next",
                    tps: clampedFrameRate(lastFrameRate.current),
                } as NextTick);
            }
        };

        const frameFn = async () => {
            if (sourceIdOnStart !== sourceId.current) {
                return; // new source, expect a reboot of the frame loop cycle
            }

            if (!inBackground) {
                const now = performance.now();
                if (lastFrame != null && framesSinceLastBackground > 10) {
                    lastFrameRate.current = 1000 / (now - lastFrame);
                }
                lastFrame = now;
                framesSinceLastBackground++;
            } else {
                lastFrame = undefined;
                framesSinceLastBackground = 0;
            }

            /// console.log(counter / ((+new Date() - t0) / 1000));
            const timestamp =
                loopCounter.current > 0
                    ? (loopCounter.current * videoRef.duration +
                          videoRef.currentTime) *
                      1e6
                    : undefined;
            const frame = new VideoFrame(videoRef, {
                timestamp,
            });

            let newTimestamp = frame.timestamp;
            if (newTimestamp === lastFrameTimestamp) {
                frame.close();
                return;
            }

            lastFrameTimestamp = newTimestamp;

            for (const videoEncoder of videoEncoders.current) {
                const encoder = videoEncoder.encoder();
                if (encoder.state !== "closed") {
                    if (
                        videoEncoder.video &&
                        (videoEncoder.video.height !== videoRef.videoHeight ||
                            videoEncoder.video.width !== videoRef.videoWidth)
                    ) {
                        // Reinitialize a new stream, size the aspect ratio has changed
                        let limitedQualities = quality.filter(
                            (x) => x.video.height <= videoRef.videoHeight
                        );
                        if (limitedQualities.length !== quality.length) {
                            frame.close();
                            await updateStream({
                                streamType: streamType.current,
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
                            height: videoEncoder.setting.video.height,
                            width: videoRef.videoWidth * scaler,
                            bitrate: videoEncoder.setting.video.bitrate,
                            /*          latencyMode: "realtime",
                                     bitrateMode: "variable", */
                        });
                    }

                    if (encoder.state === "configured") {
                        if (encoder.encodeQueueSize > 30) {
                            // Too many frames in flight, encoder is overwhelmed
                            // let's drop this frame.
                            encoder.flush();

                            // TODO in non streaming mode, slow down the playback
                        } else {
                            frameCounter++;
                            const insertKeyframe =
                                Math.round(
                                    frameCounter / videoEncoders.current.length
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

            await frame.close();
            requestFrame();
        };
        scheduleFrameFn.current = frameFn;
        requestFrame();
    };
    const onEnd = async () => {
        if (loop) {
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
        if (videoRef.current.ended && loop) {
            return; // dont pause recorders because we are going to loop around and play again
        }
        await audioCapture.current.pause();
    };

    return (
        <Grid container direction="column" spacing={1}>
            <Grid
                item
                sx={{
                    display: "flex",
                    maxHeight: !inIframe() ? "80%" : "100%",
                }}
                justifyContent={!inIframe() ? "center" : "left"}
            >
                <div className="container">
                    <div className="video-wrapper">
                        <video
                            crossOrigin="anonymous"
                            data-iframe-height
                            ref={(ref) => {
                                videoRef.current =
                                    ref as HTMLVideoElementWithCaptureStream;
                            }}
                            /*   playsInline */
                            height="auto"
                            width="100%"
                            onPlay={(e) =>
                                onPlay(
                                    e.currentTarget as HTMLVideoElementWithCaptureStream
                                )
                            }
                            onPause={() => {
                                onPause();
                            }}
                            onEnded={() => {
                                onEnd();
                            }}
                            autoPlay
                            onClick={() =>
                                videoRef.current.paused
                                    ? videoRef.current.play()
                                    : videoRef.current.pause()
                            }
                            muted={streamType.current.type === "noise"}
                            controls={false}
                        ></video>
                        <div style={{ marginTop: "-42px", width: "100%" }}>
                            <Controls
                                selectedResolution={
                                    quality.map(
                                        (x) => x.video.height
                                    ) as Resolution[]
                                }
                                resolutionOptions={resolutionOptions}
                                onStreamTypeChange={(settings) => {
                                    updateStream({
                                        streamType: settings,
                                        quality: quality,
                                    });
                                }}
                                onQualityChange={(settings) => {
                                    updateStream({ quality: settings });
                                }}
                                videoRef={videoRef.current}
                                viewRef={videoRef.current}
                                alwaysShow={isTouchScreen}
                                muted={streamType.current.type === "noise"}
                            />
                        </div>
                        {/*   <Tracks db={mediaStreamDBs} />
                         */}
                    </div>
                </div>
            </Grid>
            {errorMessage && (
                <Snackbar
                    open={true}
                    anchorOrigin={{
                        vertical: "top",
                        horizontal: "center",
                    }}
                >
                    <Alert severity="error">
                        <AlertTitle>Error</AlertTitle>
                        {errorMessage}
                    </Alert>
                </Snackbar>
            )}
            {/*  {true && <View db={mediaStreamDBs.current} node={args.node} ></View>} */}
        </Grid>
    );
};
