import { usePeer } from "@dao-xyz/peerbit-react";
import { useRef, useState, useEffect, useCallback } from "react";
import { Chunk, VideoStream } from "./database";
import { getClusterStartIndices } from "./webm";
import { ObserverType } from "@dao-xyz/peerbit-program";
import { Buffer } from "buffer";
import { waitFor, delay } from "@dao-xyz/peerbit-time";
import { Button, Grid, IconButton } from "@mui/material";
import { videoNoAudioMimeType, videoAudioMimeType } from "./format";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { View } from "./View";
import VideoCameraFrontIcon from "@mui/icons-material/VideoCameraFront";
import OndemandVideoIcon from "@mui/icons-material/OndemandVideo";
import PresentToAllIcon from "@mui/icons-material/PresentToAll";
import TvOffIcon from "@mui/icons-material/TvOff";
interface HTMLVideoElementWithCaptureStream extends HTMLVideoElement {
    captureStream(fps?: number): MediaStream;
    mozCaptureStream?(fps?: number): MediaStream;
}

const PACK_PERFECTLY = false;
if (PACK_PERFECTLY) {
    globalThis.Buffer = Buffer;
}
/* globalThis.VSTATS = new Map(); */

type StreamType = "camera" | "screen" | "media" | undefined;
export const Stream = (args: {
    identity: PublicSignKey;
    node: PublicSignKey;
}) => {
    const [streamType, setStreamType] = useState<StreamType>(undefined);
    //const [isStreamer, setIsStreamer] = useState<boolean | undefined>(undefined);

    const [mediaSrc, setMediaSrc] = useState(null);

    const [videoStream, setVideoStream] = useState<VideoStream | null>(null);
    const videoRef = useRef<HTMLVideoElementWithCaptureStream>(null);

    const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder>();
    const { peer } = usePeer();

    // TODO
    useEffect(() => {
        if (!peer?.libp2p || !args.identity || !args.node) {
            return;
        }

        try {
            if (
                peer.idKey.publicKey.equals(args.node) &&
                peer.identity.publicKey.equals(args.identity)
            ) {
                peer.open(new VideoStream(peer.identity.publicKey), {
                    role: new ObserverType(),
                    /*   trim: {
                          type: "bytelength",
                          from: 1 * 1e6,
                          to: 0.5 * 1e6,
                      }, */
                }).then((vs) => {
                    setVideoStream(vs);
                });
            }
        } catch (error) {
            console.error("Failed to create stream", error);
        }
    }, [peer?.id, args.identity?.hashcode(), args.node?.hashcode()]);

    const updateStream = async (streamType: StreamType) => {
        if (!videoRef.current) {
            return;
        }
        videoRef.current.pause();
        if (mediaRecorder) {
            if (mediaRecorder.state !== "inactive") {
                mediaRecorder?.stop();
                await waitFor(() => mediaRecorder.state === "inactive");
            }
        }

        if (videoRef.current.srcObject instanceof MediaStream) {
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
        }
        videoRef.current.srcObject = undefined;
        switch (streamType) {
            case undefined:
                videoRef.current.src = import.meta.env.BASE_URL + "noise.mp4";
                videoRef.current.load();
                break;
            case "media":
                videoRef.current.src = mediaSrc;
                videoRef.current.load();
                break;

            case "camera":
                navigator.mediaDevices
                    .getUserMedia({
                        video: { width: 1280, height: 720 },
                        audio: true,
                    })
                    .then((stream) => {
                        videoRef.current.srcObject = stream;
                    });

                break;

            case "screen":
                navigator.mediaDevices
                    .getDisplayMedia({
                        video: true,
                        audio: true,
                    })
                    .then((stream) => {
                        videoRef.current.srcObject = stream;
                    });

                break;
        }
    };
    useEffect(() => {
        updateStream(streamType);
    }, [videoRef.current]);

    useEffect(() => {
        updateStream(streamType);
    }, [streamType, mediaSrc]);

    const onStart = () => {
        let stream: MediaStream = videoRef.current
            .srcObject as any as MediaStream;
        // use srcObject
        if (!stream) {
            let fps = 0;
            if (videoRef.current.captureStream) {
                stream = videoRef.current.captureStream(fps);
            } else if (videoRef.current.mozCaptureStream) {
                stream = videoRef.current.mozCaptureStream(fps);
            } else {
                console.error(
                    "Stream capture is not supported",
                    videoRef.current.captureStream
                );
                stream = null;
            }
        }
        if (stream) {
            // stream.getAudioTracks().forEach((t) => stream.removeTrack(t)); // Remove audo tracks, else the MediaRecorder will not work
            const recorder = new MediaRecorder(stream, {
                mimeType:
                    !streamType || streamType === "screen"
                        ? videoNoAudioMimeType
                        : videoAudioMimeType,
                videoBitsPerSecond: 1e7,
            });
            setMediaRecorder(recorder);
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
                        /* globalThis.VSTATS.set(chunk.id, { a: +new Date }) */
                        videoStream.chunks.put(chunk);

                        first = false;
                    } else {
                        remainder = newArr;
                    }
                } else {
                    ts = BigInt(+new Date());
                    const chunk = new Chunk(e.data.type, header, newArr, ts);

                    /* globalThis.VSTATS.set(chunk.id, { a: +new Date }) */
                    videoStream.chunks.put(chunk);
                }
            };
            recorder.start(1);
        }
    };

    const onEnd = () => {
        mediaRecorder?.stop();
    };
    return (
        <>
            <Grid container direction="column" spacing={1}>
                <Grid item>
                    <video
                        ref={videoRef}
                        width="100%"
                        onPlay={onStart}
                        onEnded={onEnd}
                        autoPlay
                        loop
                        muted={streamType === "camera" || !streamType}
                    ></video>
                </Grid>
                <Grid item container spacing={2}>
                    <Grid item>
                        <Button
                            size="small"
                            endIcon={<VideoCameraFrontIcon />}
                            onClick={() => setStreamType("camera")}
                        >
                            Camera
                        </Button>
                    </Grid>
                    <Grid item>
                        <Button
                            size="small"
                            endIcon={<PresentToAllIcon />}
                            onClick={() => setStreamType("screen")}
                        >
                            Screen
                        </Button>
                    </Grid>
                    <Grid item>
                        <Button
                            size="small"
                            component="label"
                            endIcon={
                                <OndemandVideoIcon />
                            } /* onClick={() => setStreamType('media')}  */
                        >
                            Media
                            <input
                                hidden
                                accept="video/*"
                                multiple
                                type="file"
                                onClick={(event) =>
                                    (event.target["value"] = "")
                                }
                                onChange={(event) => {
                                    if (event.target.files.length === 0) {
                                        return;
                                    }
                                    setMediaSrc(
                                        URL.createObjectURL(
                                            event.target.files[0]
                                        )
                                    );
                                    setStreamType("media");
                                }}
                            />
                        </Button>
                    </Grid>
                    <Grid item>
                        <Button
                            size="small"
                            endIcon={<TvOffIcon />}
                            onClick={() => setStreamType(undefined)}
                        >
                            Noise
                        </Button>
                    </Grid>
                </Grid>
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
