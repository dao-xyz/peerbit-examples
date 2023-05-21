import { inIframe, usePeer } from "@dao-xyz/peerbit-react";
import { useRef, useState, useEffect, useCallback } from "react";
import {
    Chunk,
    WebcodecsStreamDB,
    Track,
    MediaStreamDBs,
    MediaStreamInfo,
    VideoInfo,
    AudioStreamDB,
} from "../database";
import { ReplicatorType, ObserverType } from "@dao-xyz/peerbit-program";
import { Buffer } from "buffer";
import { waitFor } from "@dao-xyz/peerbit-time";
import { Grid } from "@mui/material";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import {
    SourceSetting,
    StreamType,
    Resolution,
    resolutionToSourceSetting,
    RESOLUTIONS,
} from "../controls/settings.js";

import {
    MediaRecorder as EMediaRecorder,
    register,
} from "extendable-media-recorder";
import { connect } from "extendable-media-recorder-wav-encoder";
import useVideoPlayer from "./controller/useVideoPlayer";
import { Controls } from "./controller/Control";
import PQueue from "p-queue";

let audioEncoderConnect = register(await connect());

interface HTMLVideoElementWithCaptureStream extends HTMLVideoElement {
    captureStream(fps?: number): MediaStream;
    mozCaptureStream?(fps?: number): MediaStream;
}

const PACK_PERFECTLY = false;
if (PACK_PERFECTLY) {
    globalThis.Buffer = Buffer;
}
/* globalThis.VSTATS = new Map(); */

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

export const Stream = (args: { node: PublicSignKey }) => {
    const streamType = useRef<StreamType>({ type: "noise" });
    const [quality, setQuality] = useState<SourceSetting[]>([
        resolutionToSourceSetting(360),
    ]);
    const [resolutionOptions, setResolutionOptions] = useState<Resolution[]>(
        []
    );
    const videoLoadedOnce = useRef(false);
    const { peer } = usePeer();
    const mediaStreamDBs = useRef<Promise<MediaStreamDBs>>(null);
    const videoEncoders = useRef<VideoStream[]>([]);
    const startId = useRef(0);
    let videoRef = useRef<HTMLVideoElement>();

    useEffect(() => {
        if (videoLoadedOnce.current) {
            return;
        }
        updateStream({ streamType: { type: "noise" }, quality: quality });
        videoLoadedOnce.current = true;
    }, [videoRef.current]);

    // TODO
    useEffect(() => {
        if (!peer?.libp2p || !args.node || mediaStreamDBs.current) {
            return;
        }
        //  console.log('setup media stream start!')
        mediaStreamDBs.current = peer
            .open(new MediaStreamDBs(peer.idKey.publicKey))
            .then(async (db) => {
                //  console.log("LOAD")
                await db.load();

                //  console.log("LOAD DONE!", [...db.streams.index.index.values()].length, db.streams.index.size);

                // See all previous dbs as inactive, we do this since the last session might have ended unexpectedly

                console.log("INACTIVATE", [...db.streams.index.index.values()]);
                await Promise.all(
                    [...db.streams.index.index.values()].map((x) => {
                        if (x.value.active) {
                            return db.streams.put(x.value.toInactive());
                        }
                    })
                );

                console.log(
                    "AFTER DEACTIVE!",
                    [...db.streams.index.index.values()].length,
                    db.streams.index.size
                );

                return db;
            });
    }, [peer?.idKey.publicKey.hashcode(), args.node?.hashcode()]);

    const updateStream = async (properties: {
        streamType?: StreamType;
        quality: SourceSetting[];
    }) => {
        if (properties.streamType) {
            streamType.current = properties.streamType;
        }

        let qualitySetting = properties.quality || quality;
        let newQualities: SourceSetting[] = [];

        await waitFor(() => !!mediaStreamDBs.current);
        const dbs = await mediaStreamDBs.current;
        //  const allStreams = [...dbs.streams.index.index.values()].filter((x) => x.value.active);

        // console.log('update stream!', properties)
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
                            await Promise.all([
                                videoStreamDB.close(),
                                dbs.streams.put(
                                    new Track({
                                        active: false,
                                        source: videoStreamDB,
                                    })
                                ),
                            ]);
                            videoStreamDB = undefined;
                        }
                    };

                    let open = async () => {
                        // console.log('open!')
                        if (encoder && encoder.state !== "closed") {
                            await encoder.close();
                        }

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
                                        sender: peer.idKey.publicKey,
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
                                                        role: new ReplicatorType(),
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
                                                            active: true,
                                                            source: videoStreamDB,
                                                        });
                                                    //   console.log("ACTIVATE NEW TRACK", videoStreamDB.id, videoStreamDB.address.toString())
                                                    return dbs.streams.put(
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
                                    /*  const peers = [
                                         ...peer.libp2p.services.pubsub.peers.keys(),
                                     ];
                                     if (peers.length > 1) {
                                         console.log(
                                             peers.length,
                                             peer.libp2p.services.pubsub.routes.getPath(
                                                 peer.libp2p.services.pubsub
                                                     .publicKeyHash,
                                                 peers[0]
                                             )?.length,
                                             peer.libp2p.services.pubsub.routes.getPath(
                                                 peer.libp2p.services.pubsub
                                                     .publicKeyHash,
                                                 peers[1]
                                             )?.length
                                         );
                                     } else {
                                         console.log(
                                             peers,
                                             peer.libp2p.services.pubsub.routes
                                                 .nodeCount
                                         );
                                     } */
                                    await videoStreamDB.chunks.put(
                                        new Chunk({
                                            type: chunk.type,
                                            chunk: arr,
                                            timestamp: lastVideoFrameTimestamp,
                                        }),
                                        { nexts: [], unique: true }
                                    );

                                    //   console.log(mem / ((+new Date) - s0) * 1000)
                                }
                            },
                        });
                        console.log("created encoder", encoder.state);
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

        /*  const encoder = new VideoEncoder({
             error: (e) => { }, output: async (chunk, metadata) => {
                 let arr = new Uint8Array(chunk.byteLength);
                 chunk.copyTo(arr)
                 if (metadata.decoderConfig) {
                     // console.log('got frame', chunk.type, arr.length, !!metadata.decoderConfig)
                     videoStreamDB = peer.open(
                         new WebcodecsStreamDB(
                             {
                                 sender: peer.idKey.publicKey,
                                 decoderDescription: metadata.decoderConfig
                             }
                         ),
                         {
                             role: new ReplicatorType(),
                         }
                     );
                     const streamInfo = new Track({ active: true, source: await videoStreamDB });
                     await dbs.streams.put(
                         streamInfo
                     );
                 }
 
                 lastVideoFrameTimestamp = chunk.timestamp;
                 (await videoStreamDB)!.chunks.put(new Chunk({ type: chunk.type, chunk: arr, timestamp: chunk.timestamp }), {
                     unique: true,
                 });
             }
         });
 
         encoder.configure({
             codec: 'av01.0.20M.10',
             height: videoRef.videoHeight,
             width: videoRef.videoWidth
         }) */

        // Quality needs to be sorted highest first, so that requesting user media works as expected (bug/feature of chrome?)

        setQuality(
            [...qualitySetting].sort((a, b) => b.video.height - a.video.height)
        );
        console.log("set video encoders", [
            ...newVideoEncoders,
            ...existingVideoEncoders,
        ]);
        videoEncoders.current = [...newVideoEncoders, ...existingVideoEncoders];

        if (!properties.streamType) {
            return;
        }
        await waitFor(() => videoRef.current);
        let s = quality[0]; // qualities are sorted
        const videoElementRef = videoRef.current;

        console.log("on ref", videoElementRef.src);
        videoElementRef.pause();
        switch (streamType.current.type) {
            case "noise":
                /*    if (videoElementRef.src?.length > 0) {
                       return;
                   } */
                videoElementRef.muted = true;
                videoElementRef.src = import.meta.env.BASE_URL + "noise.mp4";
                videoElementRef.load();
                break;
            case "media":
                /*  if (videoElementRef.src?.length > 0) {
                     return;
                 } */
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

                //updatingSource.current[ix] = false
                break;
        }

        await waitFor(() => !videoElementRef.paused);

        // stream.getAudioTracks().forEach((t) => stream.removeTrack(t)); // Remove audo tracks, else the MediaRecorder will not work

        //    const allStreams = [...dbs.streams.index.index.values()].filter(x => x.value.active).sort((a, b));
        /*  let existingMediaRecorder = mediaRecorders.current.find(
            (x) => x.settings.video.height === s.video.height
        );

        if (existingMediaRecorder) {
            existingMediaRecorder.ref = videoRef;
            existingMediaRecorder.recorder = undefined;
            existingMediaRecorder.settings = s; 
        } else */ {
            // New !
            /* let videoStreamDB: WebcodecsStreamDB = await peer.open(
                new WebcodecsStreamDB(
                    peer.idKey.publicKey,
                    new MediaStreamInfo({
                        video: new VideoInfo({
                            height: videoRef.videoHeight,
                            width: videoRef.videoWidth,
                        }),
                    })
                ),
                {
                    role: new ReplicatorType(),
                }
            );
            let audioStreamDB: AudioStreamDB | undefined = undefined;
            if (streamType.current.type !== "noise") {
                videoStreamDB = await peer.open(
                    new WebcodecsStreamDB(
                        peer.idKey.publicKey,
                        
                    ),
                    {
                        role: new ReplicatorType(),
                    }
                );
            } else {
               
                audioStreamDB = await peer.open(new AudioStreamDB(peer.idKey.publicKey))
            } 
                 const streamInfo = new MediaStreamDBInfo({ active: true, db: videoStreamDB });
            await dbs.streams.put(
                streamInfo
            );
            */
            /*   mediaRecorders.current.push({
                  ref: videoRef,
                  settings: s,
                  video: new MediaStreamInfo({
                      video: {
                          ...s.video,
                          height: videoRef.videoHeight,
                          width: videoRef.videoWidth,
                      },
                  })
              }); */
        }
    };

    const onStart = async (videoRef: HTMLVideoElementWithCaptureStream) => {
        /*   let existingMediaRecorder = await waitFor(() =>
              mediaRecorders.current.find(
                  (x) => x.settings.video.height === sourceSetting.video.height
              )
          ); */
        /*   let existingMediaRecorder = await waitFor(() =>
              mediaRecorders.current.find(
                  (x) => x.ref.srcObject === videoRef.srcObject || (x.ref.src && x.ref.src === videoRef.src) // x.settings.video.height === sourceSetting.video.height
              )
          );
   */

        console.log("START!");
        let tempStartId = (startId.current = startId.current + 1);
        let stream: MediaStream = videoRef.srcObject as any as MediaStream;
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

        // use srcObject
        if (!stream) {
            let fps = 0;
            if (videoRef.captureStream) {
                stream = videoRef.captureStream(fps);
            } else if (videoRef.mozCaptureStream) {
                stream = videoRef.mozCaptureStream(fps);
            } else {
                console.error(
                    "Stream capture is not supported",
                    videoRef.captureStream
                );
                stream = null;
            }
        }

        if (stream.getAudioTracks().length > 0) {
            const audioStream = new MediaStream(stream.getAudioTracks());
            await waitFor(
                () =>
                    audioStream.getAudioTracks()[0].getSettings().sampleRate !==
                    undefined
            );
            await audioEncoderConnect;
            const recorder = new EMediaRecorder(audioStream, {
                mimeType: "audio/wav",
            }); //new AudioRecorderPolyFill(stream)

            audioStreamDB = await peer.open(
                new AudioStreamDB(
                    peer.idKey.publicKey,
                    audioStream.getAudioTracks()[0].getSettings().sampleRate
                ),
                {
                    role: new ReplicatorType(),
                }
            );
            const dbs = await mediaStreamDBs.current;
            await dbs.streams.put(
                new Track({ active: true, source: audioStreamDB })
            );

            // Set record to <audio> when recording will be finished
            let wavHeader: Uint8Array | undefined = undefined;
            let lastAudioTimestamp: bigint = undefined;
            let lastAudioTime = +new Date();

            recorder.addEventListener("dataavailable", (e) => {
                e.data.arrayBuffer().then((arr) => {
                    let uint8array: Uint8Array | undefined = undefined;
                    if (!wavHeader) {
                        wavHeader = new Uint8Array(arr.slice(0, 44));
                        uint8array = new Uint8Array(arr);
                    } else {
                        let uarr = new Uint8Array(arr);
                        uint8array = new Uint8Array(
                            uarr.byteLength + wavHeader.byteLength
                        );
                        uint8array.set(wavHeader, 0);
                        uint8array.set(uarr, wavHeader.byteLength);
                    }
                    let currentTime = +new Date();
                    let timestamp =
                        lastVideoFrameTimestamp ||
                        BigInt((currentTime - lastAudioTime) * 1000) +
                            lastAudioTimestamp;
                    lastAudioTime = currentTime;
                    audioStreamDB.chunks.put(
                        new Chunk({ type: "", chunk: uint8array, timestamp }),
                        {
                            unique: true,
                        }
                    );
                    lastAudioTimestamp = timestamp;
                });

                //audio.src = URL.createObjectURL(e.data)
            });

            // Start recording
            recorder.start(100);
        }

        /*   const videoProcessor = new MediaStreamTrackProcessor({
              track: stream.getVideoTracks()[0],
          });
          const reader = videoProcessor.readable.getReader(); */
        let frameCounter = 0;

        let counter = 0;
        let t0 = +new Date();
        /*  while (true) */ {
            /*  const result = await reader.read();
             if (result.done) {
                 console.log("Stream done!");
                 break;
             }
             let frame = result.value; */
            //  console.log(videoRef.videoWidth, videoEncoders.current.map(x => x.setting.video.height))

            const frameFn = async () => {
                if (startId.current !== tempStartId) {
                    return;
                }

                counter += 1;
                console.log(counter / ((+new Date() - t0) / 1000));
                const frame = new VideoFrame(videoRef);
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
                                codec: "av01.0.04M.10", // "av01.0.08M.10",//"av01.2.15M.10.0.100.09.16.09.0" //"av01.0.04M.10",
                                height: videoEncoder.setting.video.height,
                                width: videoRef.videoWidth * scaler,
                                bitrate: videoEncoder.setting.video.bitrate,
                                latencyMode: "realtime",
                                bitrateMode: "variable",
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
                                        frameCounter /
                                            videoEncoders.current.length
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
                if (/* false &&  */ "requestVideoFrameCallback" in videoRef) {
                    videoRef.requestVideoFrameCallback(frameFn);
                } else {
                    requestAnimationFrame(frameFn);
                }
            };
            if (/* false && */ "requestVideoFrameCallback" in videoRef) {
                videoRef.requestVideoFrameCallback(frameFn);
            } else {
                requestAnimationFrame(frameFn);
            }
        }

        /* 
                const audioTrack = stream.getAudioTracks()[0];
                console.log('audiotrack', audioTrack)
                const audioContext = new AudioContext()
                if (audioTrack) {
                    let mem: Uint8Array[] = []
                    const audioEncoder = new AudioEncoder({
                        error: (e) => { console.error(e); throw e }, output: async (chunk, metadata) => {
                            console.log('got audio chunk!', chunk)
                            if (chunk.type === 'key' && mem.length > 0) {
                                audioContext.decodeAudioData(concat(mem).buffer, (d) => {
                                    console.log('success!', d)
                                }, (e) => { console.error("FAILED", e) })
                                mem = [];
                            }
                            const chunkArr = new Uint8Array(chunk.byteLength);
                            chunk.copyTo(chunkArr);
                            mem.push(chunkArr);
        
                        }
                    });
                    audioEncoder.configure({
                        codec: 'pcm-f32-planar',
                        numberOfChannels: 2,
                        sampleRate: 48000,
                    })
        
        
                    const audioProcessor = new MediaStreamTrackProcessor({ track: audioTrack });
                    const audioReader = audioProcessor.readable.getReader();
                    while (true) {
                        const result = await audioReader.read();
                        if (result.done)
                            break;
                        let frame = result.value;
                        audioEncoder.encode(frame);
                        frame.close();
                    }
                }
        
         */

        /* if (stream) {
            let recorder: MediaRecorder;
            if (streamType.current.type !== "noise") {
                const setting = sourceSetting;
                recorder = new MediaRecorder(stream, {
                    mimeType: setting.audio
                        ? videoAudioMimeType
                        : videoNoAudioMimeType,
                    videoBitsPerSecond: setting.video.bitrate,
                });
            } else {
                stream.getAudioTracks().forEach((t) => stream.removeTrack(t));
                recorder = new MediaRecorder(stream, {
                    mimeType: videoNoAudioMimeType,
                    videoBitsPerSecond: 1e5,
                });
            }
            existingMediaRecorder.recorder = recorder;

            let first = true;
            let header: Uint8Array | undefined = undefined;
            let remainder = new Uint8Array([]);
            let ts = BigInt(+new Date());
            let start = +new Date();
            let counter = 0;
            recorder.ondataavailable = async (e) => {
                counter += 1;
                //  console.log(+new Date - start)
                start = +new Date();
                let newArr = new Uint8Array(await e.data.arrayBuffer());
                if (newArr.length > 0) {
                    //   console.log(+new Date - start, newArr.length)
                    start = +new Date();
                }

                if (first) {
                    let arr = new Uint8Array(newArr.length + remainder.length);
                    arr.set(remainder, 0);
                    arr.set(newArr, remainder.length);
                    const clusterStartIndices = await getClusterStartIndices(
                        arr
                    );
                    if (clusterStartIndices.length == 1) {
                        const firstClusterIndex = clusterStartIndices.splice(
                            0,
                            1
                        )[0];
                        header = arr.slice(0, firstClusterIndex);
                        newArr = arr.slice(firstClusterIndex);
                        remainder = new Uint8Array(0);
                        const chunk = new Chunk(e.data.type, header, arr);
                        if (
                            existingMediaRecorder.stream.closed ||
                            recorder.state === "inactive"
                        ) {
                            return;
                        }

                        existingMediaRecorder.stream.chunks.put(chunk, {
                            unique: true,
                        });

                        first = false;
                    } else {
                        remainder = newArr;
                    }
                } else {
                    ts = BigInt(+new Date());
                    const chunk = new Chunk(e.data.type, header, newArr, ts);
                    if (
                        existingMediaRecorder.stream.closed ||
                        recorder.state === "inactive"
                    ) {
                        return;
                    }

                    existingMediaRecorder.stream.chunks.put(chunk, {
                        unique: true,
                    });
                }
            };
            recorder.start(1);
        } */
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
                            style={{ pointerEvents: "none" }}
                            data-iframe-height
                            ref={videoRef}
                            height="auto"
                            width="100%"
                            onPlay={(e) =>
                                onStart(
                                    e.currentTarget as HTMLVideoElementWithCaptureStream
                                )
                            }
                            onEnded={onEnd}
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
