import { inIframe, usePeer, useProgram } from "@peerbit/react";
import { useRef, useState, useEffect, useCallback } from "react";
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
import { isSafari } from "../utils";
import { equals } from "uint8arrays";
interface HTMLVideoElementWithCaptureStream extends HTMLVideoElement {
    captureStream(fps?: number): MediaStream;
    mozCaptureStream?(fps?: number): MediaStream;
}

const PACK_PERFECTLY = false;
if (PACK_PERFECTLY) {
    globalThis.Buffer = Buffer;
}
/* globalThis.VSTATS = new Map(); */

const wavEncoder = new WAVEncoder();

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

let lastVideoFrameTimestamp: bigint | undefined = undefined;
const openVideoStreamQueue = new PQueue({ concurrency: 1 });

const DEFAULT_QUALITY = resolutionToSourceSetting(360);

const isTouchScreen = window.matchMedia("(pointer: coarse)").matches;

const clampedFrameRate = (fps: number) => Math.max(Math.min(fps, 60), 10);
export const Stream = (args: { node: PublicSignKey }) => {
    const streamType = useRef<StreamType>({ type: "noise" });
    const [quality, setQuality] = useState<SourceSetting[]>([DEFAULT_QUALITY]);
    const [resolutionOptions, setResolutionOptions] = useState<Resolution[]>(
        []
    );
    const videoLoadedOnce = useRef(false);
    const { peer } = usePeer();
    const { program: mediaStreamDBs } = useProgram<MediaStreamDB>(
        new MediaStreamDB(peer.identity.publicKey),
        {
            args: {
                role: {
                    type: "replicator",
                    factor: 1,
                },
            },
            existing: "reuse",
        }
    );
    const videoEncoders = useRef<VideoStream[]>([]);
    const audioCapture = useRef<{ close: () => void | Promise<void> }>(
        undefined
    );
    const tickWorkerRef = useRef<Worker>();
    const lastFrameRate = useRef(30);
    const scheduleFrameFn = useRef<() => void>();
    const startId = useRef(0);
    const sessionTimestampRef = useRef(BigInt(+new Date()));
    const bumpSession = useCallback(() => {
        sessionTimestampRef.current = BigInt(+new Date());
    }, []);

    let videoRef = useRef<HTMLVideoElementWithCaptureStream>();

    const [errorMessage, setErrorMessage] = useState<string | undefined>(
        undefined
    );

    useEffect(() => {
        const clickListener = () => {
            setErrorMessage(undefined);
        };
        window.addEventListener("click", clickListener);
        return () => window.removeEventListener("click", clickListener);
    });
    useEffect(() => {
        if (!tickWorkerRef.current) {
            let f = 0;
            tickWorkerRef.current = new TickWorker();
            const tickListener = () => {
                scheduleFrameFn.current();
                f = +new Date();
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
        if (properties.streamType) {
            streamType.current = properties.streamType;
        }

        let newQualities: SourceSetting[] = [];
        let newVideoEncoders: VideoStream[] = [];
        let existingVideoEncoders: VideoStream[] = [];

        if (properties.streamType) {
            //  Cleanup video from previous soruce
            if (!prevStreamType) {
                bumpSession(); // should we do this, what about the DEFAULT_QUALTIY IS ALREADY IN QUALITY?
            }
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
        }

        // Check removed qualities
        for (const encoder of videoEncoders.current) {
            let stream = properties.quality.find(
                (x) =>
                    encoder.stream()?.source.decoderDescription.codedHeight ===
                    x.video.height
            );
            if (!stream) {
                await encoder.close();
            } else {
                existingVideoEncoders.push(encoder);
            }
        }

        // Check new qualtiies
        for (const quality of properties.quality) {
            if (
                !videoEncoders.current.find(
                    (y) => JSON.stringify(y.setting) === JSON.stringify(quality)
                )
            ) {
                // console.log("new quality!", videoEncoders.current.map(x => x.setting.video.height), "-->", q.video.height)
                newQualities.push(quality);
                let videoStreamDB: Track<WebcodecsStreamDB> | undefined =
                    undefined;
                let encoder: VideoEncoder | undefined = undefined;
                let abortController = new AbortController();

                let close = async (closeEncoder: boolean = true) => {
                    abortController.abort();
                    if (closeEncoder && encoder && encoder.state !== "closed") {
                        encoder.close();
                    }

                    if (videoStreamDB) {
                        videoStreamDB.source.close();
                        videoStreamDB.setEnd();

                        // update the track with the end timer

                        await mediaStreamDBs.streams.put(videoStreamDB, {
                            target: "all",
                        });
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

                    encoder = new VideoEncoder({
                        error: (e) => {
                            console.error(e);
                            const msg =
                                "Failed to encode video.\n" + e.toString();
                            setErrorMessage(msg);
                        },
                        output: async (chunk, metadata) => {
                            if (skip) {
                                return;
                            }
                            let arr = new Uint8Array(chunk.byteLength);
                            chunk.copyTo(arr);

                            if (metadata.decoderConfig) {
                                const videoTrack = new Track<WebcodecsStreamDB>(
                                    {
                                        sender: peer.identity.publicKey,
                                        session: sessionTimestampRef.current,
                                        source: new WebcodecsStreamDB({
                                            decoderDescription:
                                                metadata.decoderConfig,
                                            /*   timestamp: videoStreamDB?.timestamp, ??? */
                                        }),
                                        start:
                                            +new Date() -
                                            Number(sessionTimestampRef.current),
                                    }
                                );

                                let change = false;
                                if (videoStreamDB) {
                                    if (
                                        videoTrack.session >
                                        videoStreamDB.session
                                    ) {
                                        // ok!
                                        change = true;
                                    } else if (
                                        videoTrack.source.decoderConfigJSON !==
                                        videoStreamDB.source.decoderConfigJSON
                                    ) {
                                        // ok!
                                        change = true;
                                    } else {
                                        // no change, ignore

                                        console.log(
                                            "NO CHANGE",
                                            videoStreamDB.source
                                                .decoderConfigJSON
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

                                            const r = await peer.open(
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
                                            mediaStreamDBs.streams.put(r);
                                            abortController =
                                                new AbortController();
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
                                // TODO waitFor ?
                                if (s0 === undefined) {
                                    s0 = +new Date();
                                }

                                mem += arr.byteLength;
                                lastVideoFrameTimestamp = BigInt(
                                    chunk.timestamp
                                );

                                await videoStreamDB.source.chunks.put(
                                    new Chunk({
                                        type: chunk.type,
                                        chunk: arr,
                                        timestamp: lastVideoFrameTimestamp,
                                    }),
                                    {
                                        target: "all",
                                        meta: { next: [] },
                                        unique: true,
                                    }
                                );

                                //   console.log(mem / ((+new Date) - s0) * 1000)
                            }
                        },
                    });
                    // console.log("created encoder", encoder.state);
                };

                open();
                newVideoEncoders.push({
                    setting: quality,
                    encoder: () => encoder,
                    stream: () => videoStreamDB,
                    close,
                    open,
                });
            }
        }

        let qualitySetting = properties.quality || quality;

        setQuality(
            [...qualitySetting].sort((a, b) => b.video.height - a.video.height)
        );
        /*   console.log("set video encoders", [
              ...newVideoEncoders,
              ...existingVideoEncoders,
          ]); */
        videoEncoders.current = [...newVideoEncoders, ...existingVideoEncoders];

        if (!properties.streamType) {
            return;
        }

        // update for new source type

        const videoElementRef = await waitFor(() => videoRef.current);

        let firstQuality = quality[0]; // qualities are sorted

        // close before video pause (to make the closing "clean")
        await audioCapture.current?.close();

        videoElementRef.pause();
        switch (streamType.current.type) {
            case "noise":
                videoElementRef.muted = true;
                videoElementRef.src = import.meta.env.BASE_URL + "noise.mp4";
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
        audioCapture.current = await streamAudio(videoElementRef);
    };

    const streamAudio = async (videoRef: HTMLVideoElementWithCaptureStream) => {
        /**
         * This function will capture the audio from the video
         * upon pause it will end the current track
         * upon play it will create a new track
         */
        const encoderInit = wavEncoder.init(videoRef).then(() => {
            if (!videoRef.muted) {
                wavEncoder.play();
            }
        });

        const init = async () => {
            let lastAudioTimestamp: bigint = 0n;
            let lastAudioTime = +new Date();

            const audioTrack = await peer.open(
                new Track({
                    sender: peer.identity.publicKey,
                    session: sessionTimestampRef.current,
                    source: new AudioStreamDB({ sampleRate: 48000 }),
                    start: +new Date() - Number(sessionTimestampRef.current),
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

            await mediaStreamDBs.streams.put(audioTrack, { target: "all" });

            await encoderInit;

            const wavListener = (ev) => {
                const { audioBuffer } = ev.data as { audioBuffer: Uint8Array };
                let currentTime = +new Date();
                let timestamp =
                    lastVideoFrameTimestamp ||
                    BigInt((currentTime - lastAudioTime) * 1000) +
                        lastAudioTimestamp;
                lastAudioTime = currentTime;
                audioTrack.source.chunks.put(
                    new Chunk({ type: "", chunk: audioBuffer, timestamp }),
                    {
                        target: "all",
                        unique: true,
                    }
                );
                lastAudioTimestamp = timestamp;
            };
            wavEncoder.node.port.addEventListener("message", wavListener);
            const close = async () => {
                wavEncoder.node.port.removeEventListener(
                    "message",
                    wavListener
                );
                await audioTrack.close();
                audioTrack.setEnd();
                mediaStreamDBs.streams.put(audioTrack, { target: "all" });
            };
            return { close };
        };

        let audioControlsPromise: Promise<{ close: () => void }> | undefined =
            undefined;
        if (!videoRef.paused) {
            audioControlsPromise = init();
        }
        const onPlay = async () => {
            if (audioControlsPromise) {
                await (await audioControlsPromise)?.close();
            }
            audioControlsPromise = init();
        };

        const onPause = async () => {
            if (audioControlsPromise) {
                await (await audioControlsPromise)?.close();
                audioControlsPromise = undefined;
            }
        };

        videoRef.addEventListener("play", onPlay);
        videoRef.addEventListener("pause", onPause);

        return {
            close: () => {
                videoRef.removeEventListener("play", onPlay);
                videoRef.removeEventListener("pause", onPause);
                return audioControlsPromise?.then((p) => p.close());
            },
        };
    };
    const onStart = async (videoRef: HTMLVideoElementWithCaptureStream) => {
        let tempStartId = (startId.current = startId.current + 1);
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
        let counter = 0;
        let lastFrame: number | undefined = undefined;

        let framesSinceLastBackground = 0;

        /*  let t0 = 0; */

        const requestFrame = () => {
            /*    let t1 = +new Date;
               console.log(t1 - t0, tickWorkerRef.current);
               t0 = t1; */
            if (!inBackground && "requestVideoFrameCallback" in videoRef) {
                videoRef.requestVideoFrameCallback(frameFn);

                /*   setTimeout(() => { frameFn() }, 1e3 / 24) */
            } else {
                tickWorkerRef.current.postMessage({
                    type: "next",
                    tps: clampedFrameRate(lastFrameRate.current),
                } as NextTick);
            }
        };

        const frameFn = async () => {
            if (startId.current !== tempStartId) {
                return;
            }

            if (!inBackground) {
                if (lastFrame != null && framesSinceLastBackground > 10) {
                    const now = +new Date();
                    lastFrameRate.current = 1000 / (now - lastFrame);
                }
                lastFrame = +new Date();
                framesSinceLastBackground++;
            } else {
                lastFrame = undefined;
                framesSinceLastBackground = 0;
            }

            counter += 1;

            /// console.log(counter / ((+new Date() - t0) / 1000));
            const frame = new VideoFrame(videoRef);

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
                        if (encoder.encodeQueueSize > 15) {
                            // Too many frames in flight, encoder is overwhelmed
                            // let's drop this frame.
                            encoder.flush();
                            console.log("DROP FRAME");
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
    const onEnd = () => {
        return videoEncoders.current.map((x) => x.close());
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
                            ref={videoRef}
                            playsInline
                            height="auto"
                            width="100%"
                            onPlay={(e) =>
                                onStart(
                                    e.currentTarget as HTMLVideoElementWithCaptureStream
                                )
                            }
                            onEnded={() => {
                                onEnd();
                            }}
                            autoPlay
                            loop
                            onClick={() =>
                                videoRef.current.paused
                                    ? videoRef.current.play()
                                    : videoRef.current.pause()
                            }
                            muted={streamType.current.type === "noise"}
                            controls={false}
                        ></video>
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
                        />
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
