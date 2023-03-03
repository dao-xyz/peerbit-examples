import { inIframe, usePeer } from "@dao-xyz/peerbit-react";
import { useRef, useState, useEffect, useCallback } from "react";
import {
    Chunk,
    MediaStreamDB,
    MediaStreamDBInfo,
    MediaStreamDBs,
    MediaStreamInfo,
    VideoInfo,
} from "../database";
import { getClusterStartIndices } from "../webm";
import { ObserverType, ReplicatorType } from "@dao-xyz/peerbit-program";
import { Buffer } from "buffer";
import { waitFor, delay } from "@dao-xyz/peerbit-time";
import {
    Button,
    Grid,
    IconButton,
    MenuItem,
    Select,
    Slider,
} from "@mui/material";
import { videoNoAudioMimeType, videoAudioMimeType } from "../format";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { Controls } from "../controller/Control";
import {
    SourceSetting,
    StreamType,
    Resolution,
    resolutionToSourceSetting,
    RESOLUTIONS,
} from "./../controller/settings.js";

interface HTMLVideoElementWithCaptureStream extends HTMLVideoElement {
    captureStream(fps?: number): MediaStream;
    mozCaptureStream?(fps?: number): MediaStream;
}

const PACK_PERFECTLY = false;
if (PACK_PERFECTLY) {
    globalThis.Buffer = Buffer;
}
/* globalThis.VSTATS = new Map(); */

export const Stream = (args: { node: PublicSignKey }) => {
    const streamType = useRef<StreamType>({ type: "noise" });
    const [quality, setQuality] = useState<SourceSetting[]>([
        resolutionToSourceSetting(360),
    ]);
    const [resolutionOptions, setResolutionOptions] = useState<Resolution[]>(
        []
    );
    const videoRefsToRecord = useRef<HTMLVideoElement[]>([]);
    const videoLoadedOnce = useRef(false);
    const mediaRecorders = useRef<
        {
            ref: HTMLVideoElement;
            stream: MediaStreamDB;
            settings: SourceSetting;
            recorder?: MediaRecorder;
        }[]
    >([]);
    const { peer } = usePeer();
    const mediaStreamDBs = useRef<Promise<MediaStreamDBs>>(null);

    useEffect(() => {
        if (videoLoadedOnce.current) {
            return;
        }
        updateStream({ streamType: { type: "noise" } });
        videoLoadedOnce.current = true;
    }, [videoRefsToRecord.current.length > 0]);

    // TODO
    useEffect(() => {
        if (!peer?.libp2p || !args.node || mediaStreamDBs.current) {
            return;
        }
        mediaStreamDBs.current = peer
            .open(new MediaStreamDBs(peer.idKey.publicKey))
            .then(async (db) => {
                await db.load();

                // See all previous dbs as inactive, we do this since the last session might have ended unexpectedly
                [...db.streams.index.index.values()].map((x) =>
                    db.streams.put(
                        new MediaStreamDBInfo({ db: x.value.db, active: false })
                    )
                );
                return db;
            });
    }, [peer?.id, args.node?.hashcode()]);

    const updateStream = async (properties: {
        streamType?: StreamType;
        quality?: SourceSetting[];
    }) => {
        if (properties.streamType) {
            streamType.current = properties.streamType;
        }

        let qualitySetting = properties.quality || quality;
        let newQualities: Set<number>;
        let reInitializeAll = false;
        if (properties.streamType) {
            // New stream type -> all qualities are "new"
            newQualities = new Set(
                qualitySetting.map((x, i) => x.video.height)
            );
            reInitializeAll = true;
        } else {
            newQualities = !properties.quality
                ? new Set()
                : new Set(
                    properties.quality
                        .map((x, i) =>
                            !quality.find(
                                (y) => JSON.stringify(y) === JSON.stringify(x)
                            )
                                ? x.video.height
                                : undefined
                        )
                        .filter((x) => x != null)
                );

            // There seems to be an issue that we have to reopen all streams
            // Else we will never be able to request the highest resolution
            reInitializeAll = true;
            if (properties.quality) {
                outer: for (const q of properties.quality) {
                    if (!newQualities.has(q.video.height)) {
                        for (const nq of newQualities) {
                            if (q.video.height >= nq) {
                                reInitializeAll = false;
                                break outer;
                            }
                        }
                    }
                }
            }
        }

        /*  if (!videoRef.current) {
             return;
         }
    */

        let removedStreamDBs = new Set();

        if (reInitializeAll) {
            // TODO, do we really need to inactivate dbs if we are going to stream same quality?

            const dbs = await mediaStreamDBs.current;
            if (dbs) {
                const allStreams = [...dbs.streams.index.index.values()];
                for (const stream of allStreams) {
                    // Inactivate existing stream
                    removedStreamDBs.add(stream.value.id);
                    await dbs.streams.put(
                        new MediaStreamDBInfo({
                            active: false,
                            db: stream.value.db,
                        })
                    );
                }
            }
        } else if (properties.quality) {
            /// Quality has changed!
            /// Inactivate all that are no longer supported
            const dbs = await mediaStreamDBs.current;
            if (dbs) {
                const allStreams = [...dbs.streams.index.index.values()].filter(
                    (x) => x.value.active
                );
                for (const stream of allStreams) {
                    // Inactivate existing stream
                    if (
                        !properties.quality.find(
                            (x) =>
                                x.video.height ===
                                stream.value.db.info.video.height
                        )
                    ) {
                        console.log(
                            "CAN NOT FIND",
                            stream.value.db.info.video.height,
                            properties.quality.map((x) => x.video.height)
                        );
                        removedStreamDBs.add(stream.value.id);
                        await dbs.streams.put(
                            new MediaStreamDBInfo({
                                active: false,
                                db: stream.value.db,
                            })
                        );
                    }
                }
            }
        }

        if (mediaRecorders.current.length > 0) {
            let newMediaRecorders = [];
            for (const mediaRecorder of mediaRecorders.current) {
                let removed = false;
                if (removedStreamDBs.has(mediaRecorder.stream.id) || removed) {
                    mediaRecorder.ref.removeAttribute("DISPLAY_MEDIA_HEIGHT");
                    mediaRecorder.ref.removeAttribute("src");
                    (mediaRecorder.ref.srcObject as MediaStream)
                        ?.getTracks()
                        .forEach((track) => {
                            if (track.readyState == "live") {
                                track.stop();
                            }
                            (
                                mediaRecorder.ref.srcObject as MediaStream
                            ).removeTrack(track);
                        });

                    if (
                        mediaRecorder.recorder &&
                        mediaRecorder.recorder.state !== "inactive"
                    ) {
                        mediaRecorder.recorder.stop();
                        await waitFor(
                            () => mediaRecorder.recorder.state === "inactive"
                        );
                    }
                    delete mediaRecorder.recorder;
                    mediaRecorder.ref.srcObject = undefined;

                    // removed = true;
                } else {
                    newMediaRecorders.push(mediaRecorder);
                }
            }

            mediaRecorders.current = newMediaRecorders;
        }

        videoRefsToRecord.current = videoRefsToRecord.current.filter(
            (x) => !!x
        );
        // Quality needs to be sorted highest first, so that requesting user media works as expected (bug/feature of chrome?)

        setQuality(
            [...qualitySetting].sort((a, b) => b.video.height - a.video.height)
        );
    };

    const onRef = async (
        videoRef: HTMLVideoElementWithCaptureStream,
        s: SourceSetting
    ) => {
        if (!videoRef) {
            return videoRef;
        }

        switch (streamType.current.type) {
            case "noise":
                if (videoRef.src?.length > 0) {
                    return;
                }
                videoRef.muted = true;
                videoRef.src = import.meta.env.BASE_URL + "noise.mp4";
                videoRef.load();
                break;
            case "media":
                if (videoRef.src?.length > 0) {
                    return;
                }
                videoRef.src = streamType.current.src;
                videoRef.load();
                break;

            case "camera":


                if ((videoRef.srcObject as MediaStream)?.active === true) {
                    console.log(
                        (videoRef.srcObject as MediaStream)
                            .getVideoTracks()[0]
                            .getSettings().height,
                        s.video.height
                    );
                    if (
                        Math.abs(
                            (videoRef.srcObject as MediaStream)
                                .getVideoTracks()[0]
                                .getSettings().height - s.video.height
                        ) < 50
                    ) {
                        console.log(
                            "ALREADY HAVE MEDIA STREAM",
                            s.video.height
                        );
                        return;
                    }
                    /* if (videoRef.getAttribute("DISPLAY_MEDIA_HEIGHT") === String(s.video.height)) {
                        console.log('ALREADY HAVE MEDIA STREAM', s.video.height, (videoRef.srcObject as MediaStream).getVideoTracks()[0].getSettings().height)
                        return;
                    } */
                }

                if (videoRef.getAttribute("REQUESTING_DISPLAY_MEDIA") === "Y") {
                    return;
                }
                videoRef.setAttribute("REQUESTING_DISPLAY_MEDIA", "Y");
                videoRef.srcObject = await navigator.mediaDevices.getUserMedia({
                    video: { height: s.video.height },
                    audio: !!s.audio,
                });
                videoRef.removeAttribute("REQUESTING_DISPLAY_MEDIA");
                videoRef.setAttribute(
                    "DISPLAY_MEDIA_HEIGHT",
                    String(s.video.height)
                );

                break;

            case "screen":
                if ((videoRef.srcObject as MediaStream)?.active === true) {
                    console.log(
                        (videoRef.srcObject as MediaStream)
                            .getVideoTracks()[0]
                            .getSettings().height,
                        s.video.height
                    );
                    if (
                        Math.abs(
                            (videoRef.srcObject as MediaStream)
                                .getVideoTracks()[0]
                                .getSettings().height - s.video.height
                        ) < 50
                    ) {
                        console.log(
                            "ALREADY HAVE MEDIA STREAM",
                            s.video.height
                        );
                        return;
                    }
                    /* if (videoRef.getAttribute("DISPLAY_MEDIA_HEIGHT") === String(s.video.height)) {
                        console.log('ALREADY HAVE MEDIA STREAM', s.video.height, (videoRef.srcObject as MediaStream).getVideoTracks()[0].getSettings().height)
                        return;
                    } */
                }

                if (videoRef.getAttribute("REQUESTING_DISPLAY_MEDIA") === "Y") {
                    return;
                }
                videoRef.setAttribute("REQUESTING_DISPLAY_MEDIA", "Y");
                videoRef.srcObject =
                    await navigator.mediaDevices.getDisplayMedia({
                        video: { height: s.video.height }, // { height: s.video.height, width: s.video.width },
                        audio: !!s.audio,
                    });
                videoRef.removeAttribute("REQUESTING_DISPLAY_MEDIA");
                videoRef.setAttribute(
                    "DISPLAY_MEDIA_HEIGHT",
                    String(s.video.height)
                );

                //updatingSource.current[ix] = false
                break;
        }

        await waitFor(() => !videoRef.paused);

        // stream.getAudioTracks().forEach((t) => stream.removeTrack(t)); // Remove audo tracks, else the MediaRecorder will not work
        const dbs = await waitFor(() => mediaStreamDBs.current);

        //    const allStreams = [...dbs.streams.index.index.values()].filter(x => x.value.active).sort((a, b));
        console.log("start stream!");
        let existingMediaRecorder = mediaRecorders.current.find(
            (x) => x.settings.video.height === s.video.height
        );
        if (existingMediaRecorder) {
            existingMediaRecorder.ref = videoRef;
            existingMediaRecorder.recorder = undefined;
            existingMediaRecorder.settings = s;
        } else {
            let mediaStreamDB: MediaStreamDB;
            if (streamType.current.type !== "noise") {
                mediaStreamDB = await peer.open(
                    new MediaStreamDB(
                        peer.idKey.publicKey,
                        new MediaStreamInfo({
                            audio: s.audio,
                            video: {
                                ...s.video,
                                height: videoRef.videoHeight,
                                width: videoRef.videoWidth,
                            },
                        })
                    ),
                    {
                        role: new ReplicatorType(),
                    }
                );
                await dbs.streams.put(
                    new MediaStreamDBInfo({ active: true, db: mediaStreamDB })
                );
            } else {
                mediaStreamDB = await peer.open(
                    new MediaStreamDB(
                        peer.idKey.publicKey,
                        new MediaStreamInfo({
                            video: new VideoInfo({
                                bitrate: 1e5,
                                height: videoRef.videoHeight,
                                width: videoRef.videoWidth,
                            }),
                        })
                    ),
                    {
                        role: new ReplicatorType(),
                    }
                );

                await dbs.streams.put(
                    new MediaStreamDBInfo({ active: true, db: mediaStreamDB })
                );
            }
            mediaRecorders.current.push({
                ref: videoRef,
                settings: s,
                stream: mediaStreamDB,
            });
        }
    };

    const onStart = async (
        videoRef: HTMLVideoElementWithCaptureStream,
        sourceSetting: SourceSetting
    ) => {
        let existingMediaRecorder = await waitFor(() =>
            mediaRecorders.current.find(
                (x) => x.settings.video.height === sourceSetting.video.height
            )
        );

        let stream: MediaStream = videoRef.srcObject as any as MediaStream;

        if (videoRef && streamType) {
            // TODO why do we need this here?
            if (
                streamType.current.type === "noise" ||
                streamType.current.type === "media"
            ) {
                setResolutionOptions([videoRef.videoHeight as Resolution]);
            } else {
                setResolutionOptions(RESOLUTIONS);
            }
        }

        if (existingMediaRecorder.recorder) {
            return; // already set!
        }

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

        if (stream) {
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
        }
    };

    const onEnd = () => {
        mediaRecorders.current.map((x) => x.recorder.stop());
    };
    return (
        <>
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
                            {quality.map((s, i) => (
                                <video
                                    id={"video-" + s.video.height}
                                    key={i}
                                    ref={(ref) => {
                                        videoRefsToRecord.current[i] = ref;
                                        onRef(
                                            ref as HTMLVideoElementWithCaptureStream,
                                            s
                                        );
                                    }}
                                    /*    height="0"
                                       width="0" */
                                    height={i === 0 ? "auto" : "0"}
                                    width={i === 0 ? "100%" : "0"}
                                    onPlay={(e) =>
                                        onStart(
                                            e.currentTarget as HTMLVideoElementWithCaptureStream,
                                            s
                                        )
                                    }
                                    onEnded={onEnd}
                                    autoPlay
                                    loop
                                    muted={streamType.current.type === "noise"}
                                ></video>
                            ))}

                            <Controls
                                isStreamer={true}
                                selectedResolution={
                                    quality.map(
                                        (x) => x.video.height
                                    ) as Resolution[]
                                }
                                resolutionOptions={resolutionOptions}
                                videoRef={videoRefsToRecord.current[0]}
                                onStreamTypeChange={(settings) => {
                                    updateStream({ streamType: settings });
                                }}
                                onQualityChange={(settings) => {
                                    updateStream({ quality: settings });
                                }}
                            ></Controls>
                        </div>
                    </div>
                </Grid>

                {/*  {videoStream && <View db={videoStream}></View>} */}
            </Grid>
        </>
    );
};
