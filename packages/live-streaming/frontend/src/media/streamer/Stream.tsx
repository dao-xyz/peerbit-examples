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
import { SourceSetting, StreamType } from "./../controller/settings";
import { Controls } from "../controller/Control";
import { Resolution, RESOLUTIONS, resolutionToSourceSetting } from "../controller/SourceSettings";
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
    const [streamType, setStreamType] = useState<StreamType>({ type: "noise" });
    const [quality, setQuality] = useState<SourceSetting[]>([resolutionToSourceSetting(720)]);
    const [resolutionOptions, setResolutionOptions] = useState<Resolution[]>([]);
    const videoRef = useRef<HTMLVideoElementWithCaptureStream>(null);
    const videoRefsToRecord = useRef<HTMLVideoElement[]>([])
    const videoLoadedOnce = useRef(false);
    const [mediaRecorders, setMediaRecorders] = useState<{ ref: HTMLVideoElement, stream: MediaStreamDB; recorder: MediaRecorder }[]>([]);
    const { peer } = usePeer();
    const mediaStreamDBs = useRef<Promise<MediaStreamDBs>>(null);
    const updatingSource = useRef<boolean[] | boolean>(false);

    useEffect(() => {
        if (videoLoadedOnce.current) {
            return;
        }
        updateStream({ streamType: { type: "noise" } });
        videoLoadedOnce.current = true;
    }, [videoRef]);

    // TODO
    useEffect(() => {
        if (!peer?.libp2p || !args.node || mediaStreamDBs.current) {
            return;
        }
        mediaStreamDBs.current = peer.open(
            new MediaStreamDBs(peer.idKey.publicKey)
        );
    }, [peer?.id, args.node?.hashcode()]);

    const updateStream = async (properties: { streamType?: StreamType, quality?: SourceSetting[] }) => {
        if (properties.streamType) {
            setStreamType(properties.streamType);
        }
        let streamTypeSetting = properties.streamType || streamType
        let qualitySetting = properties.quality || quality
        let newQualities: Set<number>;
        if (properties.streamType) {
            // New stream type -> all qualities are "new"
            newQualities = new Set(qualitySetting.map((x, i) => x.video.height));
        }
        else {
            newQualities = !properties.quality ? new Set() : new Set(properties.quality.map((x, i) => !quality.find(y => JSON.stringify(y) === JSON.stringify(x)) ? x.video.height : undefined).filter(x => x != null));
        }

        console.log("NEW QUALITIES", newQualities, quality, properties.quality)

        setQuality(qualitySetting)

        /*  if (!videoRef.current) {
             return;
         }
  */

        updatingSource.current = true;
        let removedStreamDBs = new Set();
        if (properties.quality) {

            /// Quality has changed!
            /// Inactivate all that are no longer supported
            const dbs = await mediaStreamDBs.current;
            if (dbs) {
                const allStreams = [...dbs.streams.index.index.values()].filter(x => x.value.active)
                for (const stream of allStreams) {
                    // Inactivate existing stream
                    if (!properties.quality.find(x => x.video.height === stream.value.db.info.video.height)) {
                        console.log('CAN NOT FIND', stream.value.db.info.video.height, properties.quality.map(x => x.video.height))
                        removedStreamDBs.add(stream.value.id);
                        await dbs.streams.put(new MediaStreamDBInfo({ active: false, db: stream.value.db }))
                    }
                }
            }
        }

        if (properties.streamType) { // TODO, do we really need to inactivate dbs if we are going to stream same quality?

            console.log('REMOVE ALL')
            const dbs = await mediaStreamDBs.current;
            if (dbs) {
                const allStreams = [...dbs.streams.index.index.values()]
                for (const stream of allStreams) {
                    // Inactivate existing stream
                    removedStreamDBs.add(stream.value.id);
                    await dbs.streams.put(new MediaStreamDBInfo({ active: false, db: stream.value.db }))
                }
            }
        }

        console.log('REMOVED', removedStreamDBs, properties.quality)

        if (mediaRecorders.length > 0) {
            let newMediaRecorders = [];
            for (const mediaRecorder of mediaRecorders) {
                if (removedStreamDBs.has(mediaRecorder.stream.id)) {
                    console.log('STOP RECORDER!')
                    mediaRecorder.ref.src = '';
                    (mediaRecorder.ref.srcObject as MediaStream)?.getTracks()
                        .forEach((track) => {
                            if (track.readyState == "live") {
                                track.stop();
                            }
                            (videoRef.current.srcObject as MediaStream).removeTrack(
                                track
                            );
                        });

                    if (mediaRecorder.recorder.state !== 'inactive') {
                        mediaRecorder.recorder.stop();
                        await waitFor(() => mediaRecorder.recorder.state === "inactive");
                    }
                }
                else {
                    newMediaRecorders.push(mediaRecorder);
                }
            }
            setMediaRecorders(newMediaRecorders);
        }



        /*  if (videoRef.current.srcObject instanceof MediaStream) {
             (videoRef.current.srcObject as MediaStream)
                 .getTracks()
                 .forEach((track) => {
                     if (track.readyState == "live") {
                         track.stop();
                     }
                     (videoRef.current.srcObject as MediaStream).removeTrack(
                         track
                     );
                 });
         } */

        let allRefs = [videoRef.current, ...videoRefsToRecord.current].filter(x => !!x)
        const rv = qualitySetting.sort((a, b) => a.video.height - b.video.height).reverse()

        switch (streamTypeSetting.type) {
            case "noise":
                videoRef.current.src = import.meta.env.BASE_URL + "noise.mp4";
                videoRef.current.load();
                break;
            case "media":
                videoRef.current.src = streamTypeSetting.src;
                videoRef.current.load();
                break;

            case "camera":
                updatingSource.current = new Array(quality.length).fill(true)
                for (const [ix, s] of rv.entries()) {
                    let currentVideoRef = allRefs.find(x => (x.srcObject as MediaStream)?.getVideoTracks()?.[0]?.getSettings().height === s.video.height);
                    if (!currentVideoRef) {
                        currentVideoRef = allRefs.find(x => !x.srcObject);// find one with no video
                    }
                    if (!currentVideoRef) {
                        currentVideoRef = allRefs[0];
                    }

                    console.log('Start new camera stream?', s.video.height, newQualities, newQualities.has(s.video.height), quality)
                    if (newQualities.has(s.video.height)) {
                        const stream = await navigator.mediaDevices
                            .getUserMedia({
                                video: { height: s.video.height/* , aspectRatio: { ideal: 1 }  */ },
                                audio: !!s.audio

                            })
                        currentVideoRef.srcObject = stream;
                    }

                    updatingSource.current[ix] = false
                }

                break;

            case "screen":
                updatingSource.current = new Array(qualitySetting.length).fill(true)

                for (const [ix, s] of rv.entries()) {
                    let currentVideoRef = allRefs.find(x => (x.srcObject as MediaStream)?.getVideoTracks()?.[0]?.getSettings().height === s.video.height);
                    if (!currentVideoRef) {
                        currentVideoRef = allRefs.find(x => !x.srcObject);// find one with no video
                    }
                    if (!currentVideoRef) {
                        currentVideoRef = allRefs[0];
                    }

                    if (newQualities.has(s.video.height)) {
                        const stream = await navigator.mediaDevices
                            .getDisplayMedia({
                                video: { height: s.video.height }, // { height: s.video.height, width: s.video.width },
                                audio: !!s.audio,
                            })


                        currentVideoRef.srcObject = stream;

                    }
                    updatingSource.current[ix] = false

                }
                break;
        }
        updatingSource.current = false;

    };

    const onStart = async (videoRef: HTMLVideoElementWithCaptureStream, sourceSetting: SourceSetting) => {
        let existingMediaRecorder = mediaRecorders.find(x => x.ref === videoRef);

        /*  if ((Array.isArray(updatingSource.current) && updatingSource.current[index]) || (!Array.isArray(updatingSource.current) && updatingSource.current)) {
             return;
         } */
        console.log(updatingSource.current)

        let stream: MediaStream = videoRef
            .srcObject as any as MediaStream;

        if (videoRef && streamType) {

            console.log('UPDATE AVAILABLE RESOLUTION!', streamType.type)
            // TODO why do we need this here?
            if (streamType.type === "noise" || streamType.type === "media") {
                setResolutionOptions([videoRef.videoHeight as Resolution]);
            } else {
                setResolutionOptions(RESOLUTIONS);
            }
        }

        if (existingMediaRecorder) {
            console.log('already set!', existingMediaRecorder.recorder.state)
            return // already set!
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
        console.log("START", videoRef.videoWidth, stream.getVideoTracks()[0].getSettings().width, streamType);

        if (stream) {
            // stream.getAudioTracks().forEach((t) => stream.removeTrack(t)); // Remove audo tracks, else the MediaRecorder will not work
            const dbs = await mediaStreamDBs.current;

            //    const allStreams = [...dbs.streams.index.index.values()].filter(x => x.value.active).sort((a, b));
            console.log('start stream!')
            let recorder: MediaRecorder;
            let mediaStreamDB: MediaStreamDB;

            if (streamType.type !== "noise") {

                const setting = sourceSetting
                recorder = (
                    new MediaRecorder(stream, {
                        mimeType: setting.audio
                            ? videoAudioMimeType
                            : videoNoAudioMimeType,
                        videoBitsPerSecond: setting.video.bitrate,
                    })
                );
                mediaStreamDB = await peer.open(
                    new MediaStreamDB(
                        peer.idKey.publicKey,
                        new MediaStreamInfo({
                            audio: setting.audio,
                            video: {
                                ...setting.video,
                                height: videoRef.videoHeight,
                                width: videoRef.videoWidth,
                            },
                        })
                    ),
                    {
                        role: new ReplicatorType(),
                    }
                );
                await dbs.streams.put(new MediaStreamDBInfo({ active: true, db: mediaStreamDB }));

            } else {
                stream.getAudioTracks().forEach((t) => stream.removeTrack(t));
                recorder = new MediaRecorder(stream, {
                    mimeType: videoNoAudioMimeType,
                    videoBitsPerSecond: 1e5,
                })

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

                await dbs.streams.put(new MediaStreamDBInfo({ active: true, db: mediaStreamDB }));
            }

            let newMediaRecorders = [...mediaRecorders];
            newMediaRecorders.push({ ref: videoRef, recorder, stream: mediaStreamDB })
            console.log(newMediaRecorders)
            setMediaRecorders(
                newMediaRecorders
            );

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
                    let arr = new Uint8Array(
                        newArr.length + remainder.length
                    );
                    arr.set(remainder, 0);
                    arr.set(newArr, remainder.length);
                    const clusterStartIndices =
                        await getClusterStartIndices(arr);
                    if (clusterStartIndices.length == 1) {
                        const firstClusterIndex =
                            clusterStartIndices.splice(0, 1)[0];
                        header = arr.slice(0, firstClusterIndex);
                        newArr = arr.slice(firstClusterIndex);
                        remainder = new Uint8Array(0);
                        const chunk = new Chunk(e.data.type, header, arr);
                        if (
                            mediaStreamDB.closed ||
                            recorder.state === "inactive"
                        ) {
                            return;
                        }

                        mediaStreamDB.chunks.put(chunk, { unique: true });

                        first = false;
                    } else {
                        remainder = newArr;
                    }
                } else {
                    ts = BigInt(+new Date());
                    const chunk = new Chunk(
                        e.data.type,
                        header,
                        newArr,
                        ts
                    );
                    if (
                        mediaStreamDB.closed ||
                        recorder.state === "inactive"
                    ) {
                        return;
                    }

                    mediaStreamDB.chunks.put(chunk, { unique: true });
                }
            };
            recorder.start(1);
        }
    };

    const onEnd = () => {
        console.log("end!");
        mediaRecorders.map((x) => x.recorder.stop());
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
                            <video
                                ref={videoRef}
                                height="auto"
                                width="100%"
                                onPlay={(e) => onStart(e.currentTarget as HTMLVideoElementWithCaptureStream, quality[0])}
                                onEnded={onEnd}
                                autoPlay
                                loop
                                /*   controls */
                                muted={streamType.type === "noise"}
                            ></video>

                            {/* <video
                                ref={(ref) => videoRefsToRecord.current[1] = ref}
                                height="auto"
                                width="100%"
                                onPlay={onStart}
                                onEnded={onEnd}
                                autoPlay
                                loop
                            ></video> */}
                            <Controls
                                isStreamer={true}
                                resolutionOptions={resolutionOptions}
                                videoRef={videoRef}

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
                {quality.length}
                {(streamType.type === 'screen' || streamType.type === 'camera') && quality.filter((s, i) => i > 0).map((s, i) =>
                    <video
                        key={i}
                        ref={(ref) => { videoRefsToRecord.current[i] = ref }}
                        /*    height="0"
                           width="0" */
                        height="auto"
                        width="100%"
                        onPlay={(e) => onStart(e.currentTarget as HTMLVideoElementWithCaptureStream, s)}
                        onEnded={onEnd}
                        autoPlay
                        loop
                        muted
                    ></video>
                )}


                {/*   <SourceMenu onStreamType={(type) => updateStream(type)} />
                <SourceSettingsDialog open={sourceSettingsOpen} onClose={(value) => {
                    setSourceSettingsOpen(false);
                    if (value && streamType.type !== 'noise') {
                        updateStream({ ...streamType, settings: value })
                    }
                }} ></SourceSettingsDialog> */}

                {/*  {videoStream && <View db={videoStream}></View>} */}
            </Grid>
        </>
    );
};

/* useEffect(() => {
        console.log('got chunks?', chunksRef.current.length)
        // If there are recorded video chunks, create a Blob from them and
        // create an object URL that points to the Blob
        streamQueue
        if (chunksRef.current.length > 0) {
            console.log('got chunks!', chunksRef.current)
            const recordedBlob = new Blob(chunksRef.current, { type: 'video/webm' });
            const recordedUrl = URL.createObjectURL(recordedBlob);

            // Set the recorded URL as the src attribute of the playback video element
            playbackRef.src = recordedUrl;
            playbackRef.loop = true; // play the video in a loop
        }
    }, [videoStreamRef, playbackRef]); */
/*
             useEffect(() => {

                // Set the URL of the video file as the src attribute of the video element
                // videoRef.current.src = "https://joy.videvo.net/videvo_files/video/free/2018-05/large_watermarked/bannerg004_preview.mp4";
                const videoStream = videoRef.current.captureStream()
                videoRefRecording.current.srcObject = videoStream;
            }, [videoRef?.current?.src]);  */
/*          encoder.('data', (e) => {
                        console.log('encoder data', e)
                    })
                    decoder.on('data', (e) => {
                        console.log(e[1]);
                        encoder.write(e, 'binary', (e) => {
                            console.log('eerror', e)
                        });

                                }) */

//    if (e[1].name === "Timecode")
//       console.log('data', e[1].start, sourceBufferRef.current?.timestampOffset, e[1].start + sourceBufferRef.current?.timestampOffset * 1e6, playbackRef?.currentTime)

/*  const trimJob = async () => {
                            const trimeSeconds = 10;
                            while (true && playbackRef) {
                                const trimTo =
                                    playbackRef.currentTime -
                                    trimeSeconds;
                                const trimFrom = Math.max(
                                    playbackRef.currentTime -
                                    trimeSeconds * 2,
                                    0
                                );
                                console.log(trimTo, trimFrom);
                                try {
                                    if (
                                        trimFrom > 10 &&
                                        (await waitFor(
                                            () =>
                                                sourceBufferRef?.current
                                                    .updating === false
                                        ))
                                    ) {
                                        sourceBufferRef.current?.remove(
                                            0,
                                            trimTo
                                        );
                                    }
                                } catch (error) {
                                    // ignore
                                }
                                await delay(trimeSeconds * 1000);
                            }
                        };
                        trimJob(); */
