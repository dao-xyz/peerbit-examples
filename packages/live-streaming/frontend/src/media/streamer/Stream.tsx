import { inIframe, usePeer } from "@peerbit/react";
import { useRef, useState, useEffect, useCallback } from "react";
import {
    Chunk,
    WebcodecsStreamDB,
    Track,
    MediaStreamDBs,
    AudioStreamDB,
} from "../database";
import { Buffer } from "buffer";
import { waitFor } from "@peerbit/time";
import { Grid } from "@mui/material";
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
    stream: () => WebcodecsStreamDB;
    close: () => Promise<void>;
    open: () => Promise<void>;
}

let lastVideoFrameTimestamp: bigint | undefined = undefined;
const openVideoStreamQueue = new PQueue({ concurrency: 1 });

const DEFAULT_QUALITY = resolutionToSourceSetting(360);

const clampedFrameRate = (fps: number) => Math.max(Math.min(fps, 60), 1);
export const Stream = (args: { node: PublicSignKey }) => {
    const streamType = useRef<StreamType>({ type: "noise" });
    const [quality, setQuality] = useState<SourceSetting[]>([DEFAULT_QUALITY]);
    const [resolutionOptions, setResolutionOptions] = useState<Resolution[]>(
        []
    );
    const videoLoadedOnce = useRef(false);
    const { peer } = usePeer();
    const mediaStreamDBs = useRef<MediaStreamDBs>(null);
    const videoEncoders = useRef<VideoStream[]>([]);
    const tickWorkerRef = useRef<Worker>();
    const lastFrameRate = useRef(30);
    const scheduleFrameFn = useRef<() => void>();
    const startId = useRef(0);
    const sessionTimestampRef = useRef(BigInt(+new Date()));
    const bumpSession = useCallback(() => {
        sessionTimestampRef.current = BigInt(+new Date());
    }, []);

    let videoRef = useRef<HTMLVideoElement>();

    useEffect(() => {
        if (!tickWorkerRef.current) {
            tickWorkerRef.current = new TickWorker();
            let listener = () => {
                if (document.hidden) {
                    tickWorkerRef.current.postMessage({
                        type: "next",
                        tps: clampedFrameRate(lastFrameRate.current),
                    } as NextTick);
                } else {
                    tickWorkerRef.current.postMessage({ type: "stop" } as Stop);
                }
            };

            document.addEventListener("visibilitychange", listener);
            const tickListener = () => {
                scheduleFrameFn.current();
            };
            tickWorkerRef.current.addEventListener("message", tickListener);

            return () => {
                document.removeEventListener("visibilitychange", listener);
                tickWorkerRef.current.terminate();
                tickWorkerRef.current = undefined;
            };
        }
    }, []);
    useEffect(() => {
        if (videoLoadedOnce.current) {
            return;
        }
        updateStream({ streamType: { type: "noise" }, quality: quality });
        videoLoadedOnce.current = true;
    }, [videoRef.current]);

    // TODO
    useEffect(() => {
        if (!peer || !args.node) {
            return;
        }
        peer.open(new MediaStreamDBs(peer.identity.publicKey), {
            existing: "reuse",
        }).then(async (db) => {
            mediaStreamDBs.current = db;
            return db;
        });
    }, [peer?.identity.publicKey.hashcode(), args.node?.hashcode()]);

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
        for (const encoder of videoEncoders.current) {
            let stream = properties.quality.find(
                (x) =>
                    encoder.stream()?.decoderDescription.codedHeight ===
                    x.video.height
            );
            if (!stream) {
                await encoder.close();
            } else {
                existingVideoEncoders.push(encoder);
            }
        }

        if (properties.streamType) {
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

        if (properties.quality) {
            for (const q of properties.quality) {
                if (
                    !videoEncoders.current.find(
                        (y) => JSON.stringify(y.setting) === JSON.stringify(q)
                    )
                ) {
                    // console.log("new quality!", videoEncoders.current.map(x => x.setting.video.height), "-->", q.video.height)
                    newQualities.push(q);
                    let videoStreamDB: WebcodecsStreamDB | undefined =
                        undefined;
                    let encoder: VideoEncoder | undefined = undefined;
                    let close = async (closeEncoder: boolean = true) => {
                        if (
                            closeEncoder &&
                            encoder &&
                            encoder.state !== "closed"
                        ) {
                            encoder.close();
                        }
                        if (videoStreamDB) {
                            videoStreamDB.close();
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
                            },
                            output: async (chunk, metadata) => {
                                if (skip) {
                                    return;
                                }
                                let arr = new Uint8Array(chunk.byteLength);
                                chunk.copyTo(arr);

                                if (metadata.decoderConfig) {
                                    const newStreamDB = new WebcodecsStreamDB({
                                        sender: peer.identity.publicKey,
                                        decoderDescription:
                                            metadata.decoderConfig,
                                        /*   timestamp: videoStreamDB?.timestamp, ??? */
                                    });
                                    if (
                                        !videoStreamDB ||
                                        newStreamDB.id !== videoStreamDB.id
                                    ) {
                                        skip = true;
                                        // console.log('got frame', chunk.type, arr.length, !!metadata.decoderConfig)
                                        // deactivate previous
                                        await openVideoStreamQueue
                                            .add(async () => {
                                                //  console.log('open video stream db!', videoStreamDB?.timestamp)

                                                const r = await peer.open(
                                                    newStreamDB,
                                                    {
                                                        /*   trim: { type: 'length', to: 10 }, */
                                                    }
                                                );
                                                while (videoStreamDB) {
                                                    await close(false);
                                                }
                                                return r;
                                            })
                                            .then((newVideoStreamDB) => {
                                                if (
                                                    newVideoStreamDB instanceof
                                                    WebcodecsStreamDB
                                                ) {
                                                    videoStreamDB =
                                                        newVideoStreamDB;

                                                    const streamInfo =
                                                        new Track({
                                                            session:
                                                                sessionTimestampRef.current,
                                                            source: videoStreamDB,
                                                        });
                                                    return mediaStreamDBs.current.streams.put(
                                                        streamInfo
                                                    );
                                                }
                                            })
                                            .finally(() => {
                                                skip = false;
                                            });
                                    }
                                }
                                if (videoStreamDB) {
                                    if (s0 === undefined) {
                                        s0 = +new Date();
                                    }

                                    mem += arr.byteLength;
                                    lastVideoFrameTimestamp = BigInt(
                                        chunk.timestamp
                                    );

                                    await videoStreamDB.chunks.put(
                                        new Chunk({
                                            type: chunk.type,
                                            chunk: arr,
                                            timestamp: lastVideoFrameTimestamp,
                                        }),
                                        { meta: { next: [] }, unique: true }
                                    );

                                    //   console.log(mem / ((+new Date) - s0) * 1000)
                                }
                            },
                        });
                        // console.log("created encoder", encoder.state);
                    };

                    open();
                    newVideoEncoders.push({
                        setting: q,
                        encoder: () => encoder,
                        stream: () => videoStreamDB,
                        close,
                        open,
                    });
                }
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
        await waitFor(() => videoRef.current);
        let s = quality[0]; // qualities are sorted
        const videoElementRef = videoRef.current;

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
                videoElementRef.setAttribute("REQUESTING_DISPLAY_MEDIA", "Y");
                videoElementRef.srcObject =
                    await navigator.mediaDevices.getUserMedia({
                        video: {
                            height: { ideal: 1440 },
                        },
                        audio: !!s.audio,
                    });

                videoElementRef.removeAttribute("REQUESTING_DISPLAY_MEDIA");

                break;

            case "screen":
                videoElementRef.setAttribute("REQUESTING_DISPLAY_MEDIA", "Y");
                videoElementRef.srcObject =
                    await navigator.mediaDevices.getDisplayMedia({
                        video: {
                            height: { ideal: 1440 },
                            //height: { ideal: 1440 }
                        }, // { height: s.video.height, width: s.video.width },
                        audio: true,
                    });
                videoElementRef.removeAttribute("REQUESTING_DISPLAY_MEDIA");

                break;
        }
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

        let audioStreamDB: AudioStreamDB | undefined = undefined;
        const encoderInit = wavEncoder.init(videoRef).then(() => {
            if (!videoRef.muted) {
                wavEncoder.play();
            }
        });
        const t = async () => {
            let lastAudioTimestamp: bigint = 0n;
            let lastAudioTime = +new Date();

            audioStreamDB = await peer.open(
                new AudioStreamDB(peer.identity.publicKey, 48000)
            );

            const dbs = await mediaStreamDBs.current;
            await dbs.streams.put(
                new Track({
                    session: sessionTimestampRef.current,
                    source: audioStreamDB,
                })
            );
            await encoderInit;
            wavEncoder.node.port.onmessage = (ev) => {
                const { audioBuffer } = ev.data as { audioBuffer: Uint8Array };
                let currentTime = +new Date();
                let timestamp =
                    lastVideoFrameTimestamp ||
                    BigInt((currentTime - lastAudioTime) * 1000) +
                        lastAudioTimestamp;
                lastAudioTime = currentTime;
                audioStreamDB.chunks.put(
                    new Chunk({ type: "", chunk: audioBuffer, timestamp }),
                    {
                        unique: true,
                    }
                );
                lastAudioTimestamp = timestamp;
            };
        };
        t();

        let frameCounter = 0;
        let counter = 0;
        let lastFrame: number | undefined = undefined;

        let framesSinceLastBackground = 0;
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
                            codec: isSafari
                                ? "avc1.428020"
                                : "av01.0.04M.10" /* "vp09.00.10.08", */ /* "avc1.428020" ,*/, //"av01.0.04M.10", // "av01.0.08M.10",//"av01.2.15M.10.0.100.09.16.09.0" //
                            height: videoEncoder.setting.video.height,
                            width: videoRef.videoWidth * scaler,
                            bitrate: videoEncoder.setting.video.bitrate,
                            /*          latencyMode: "realtime",
                                     bitrateMode: "variable", */
                        });
                    }

                    if (encoder.state === "configured") {
                        if (encoder.encodeQueueSize > 2) {
                            // Too many frames in flight, encoder is overwhelmed
                            // let's drop this frame.
                        } else {
                            frameCounter++;
                            const insert_keyframe =
                                Math.round(
                                    frameCounter / videoEncoders.current.length
                                ) %
                                    60 ===
                                0;

                            encoder.encode(frame, {
                                keyFrame: insert_keyframe,
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
                            crossOrigin="anonymous" /* Allow createMediaElementSource */
                            data-iframe-height
                            ref={videoRef}
                            height="auto"
                            width="100%"
                            onPlay={(e) =>
                                onStart(
                                    e.currentTarget as HTMLVideoElementWithCaptureStream
                                )
                            }
                            onPause={() => {
                                wavEncoder.pause();
                            }}
                            onEnded={() => {
                                onEnd();
                                wavEncoder.pause();
                            }}
                            autoPlay
                            loop
                            onClick={() =>
                                videoRef.current.paused
                                    ? videoRef.current.play()
                                    : videoRef.current.pause()
                            }
                            muted={streamType.current.type === "noise"}
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
                        />
                    </div>
                </div>
            </Grid>

            {/*  {true && <View db={mediaStreamDBs.current} node={args.node} ></View>} */}
        </Grid>
    );
};
