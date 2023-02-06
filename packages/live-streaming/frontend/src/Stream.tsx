import { usePeer } from "@dao-xyz/peerbit-react";
import { useRef, useState, useEffect, useContext, useCallback } from "react";
import { Chunk, VideoStream } from "./database";
import { useParams } from "react-router-dom";
import { getKeyFromStreamKey } from "./routes";
import { getClusterStartIndices } from "./webm";
import { Decoder, EBMLElementDetail, Encoder } from "ts-ebml";
import { ReplicatorType } from "@dao-xyz/peerbit-program";
import { Buffer } from "buffer";
import { toHexString } from "@dao-xyz/peerbit-crypto";
import PetsIcon from "@mui/icons-material/Pets";
import CameraAltIcon from "@mui/icons-material/CameraAlt";
import { Box, Grid, IconButton } from "@mui/material";

interface HTMLVideoElementWithCaptureStream extends HTMLVideoElement {
    captureStream?(fps?: number): MediaStream;
    mozCaptureStream?(fps?: number): MediaStream;
}

const PACK_PERFECTLY = false;
if (PACK_PERFECTLY) {
    globalThis.Buffer = Buffer;
}

let mimeType = "video/webm;codecs=vp8";
export const Stream = () => {
    const [useWebcam, setUseWebcam] = useState(false);
    //const [isStreamer, setIsStreamer] = useState<boolean | undefined>(undefined);

    const [videoStream, setVideoStream] = useState<VideoStream | null>(null);
    const [videoCaptureStream, setVideoCaptureStream] =
        useState<HTMLVideoElementWithCaptureStream | null>(null);

    const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder>();
    const { peer } = usePeer();
    const params = useParams();
    const streamKeyRef = useRef<string>();

    // TODO
    useEffect(() => {
        if (
            !peer?.libp2p ||
            !params.key ||
            (streamKeyRef.current && params.key === streamKeyRef.current)
        ) {
            return;
        }

        try {
            streamKeyRef.current = params.key;
            const streamKey = getKeyFromStreamKey(params.key);
            //  setIsStreamer(peer.identity.publicKey.equals(streamKey));
            if (peer.identity.publicKey.equals(streamKey)) {
                peer.open(new VideoStream(peer.identity.publicKey), {
                    role: new ReplicatorType(),
                    trim: {
                        type: "bytelength",
                        from: 1 * 1e6,
                        to: 0.5 * 1e6,
                    },
                }).then((vs) => {
                    setVideoStream(vs);
                });
            }
        } catch (error) {
            console.error("Failed to create stream", error);
        }
    }, [peer?.id, params?.key]);

    const videoRef = useCallback(
        (node) => {
            const videoCaptureStream: HTMLVideoElementWithCaptureStream = node;
            if (!videoStream || !videoCaptureStream) {
                return;
            }

            if (useWebcam) {
                // Get access to the user's webcam and set up the video stream
                navigator.mediaDevices
                    .getUserMedia({
                        video: { width: 1920, height: 1080 },
                        audio: true,
                    })
                    .then((stream) => {
                        videoCaptureStream.srcObject = stream;
                    });
            } else {
                if (videoCaptureStream && videoCaptureStream.srcObject) {
                    const tracks = videoCaptureStream.srcObject["getTracks"]();
                    tracks.forEach((track) => track.stop());
                    videoCaptureStream.srcObject = null;
                }

                // Set the URL of the video file as the src attribute of the video element
                videoCaptureStream.src =
                    import.meta.env.BASE_URL + "clownfish.mp4";
                videoCaptureStream.load();
            }

            setVideoCaptureStream(videoCaptureStream);
        },
        [videoStream?.id, useWebcam]
    );

    const onStart = () => {
        let stream: MediaStream;
        const fps = 0;
        if (videoCaptureStream.captureStream) {
            stream = videoCaptureStream.captureStream(fps);
        } else if (videoCaptureStream.mozCaptureStream) {
            stream = videoCaptureStream.mozCaptureStream(fps);
        } else {
            console.error(
                "Stream capture is not supported",
                videoCaptureStream.captureStream
            );
            stream = null;
        }
        if (stream) {
            if (videoCaptureStream.muted) {
                stream.getAudioTracks().forEach((t) => stream.removeTrack(t)); // Remove audo tracks, else the MediaRecorder will not work
            }

            const recorder = new MediaRecorder(stream, {
                mimeType: mimeType,
                videoBitsPerSecond: 1e7,
            });
            setMediaRecorder(recorder);
            let first = true;
            let header: Uint8Array | undefined = undefined;
            let remainder = new Uint8Array([]);
            const encoder = new Encoder();
            const decoder = new Decoder();

            recorder.ondataavailable = async (e) => {
                let newArr = new Uint8Array(await e.data.arrayBuffer());
                if (PACK_PERFECTLY) {
                    // FLAKY if MediaRecorder segment length <  1s
                    let diff: EBMLElementDetail[];
                    let arr = new Uint8Array(newArr.length + remainder.length);
                    arr.set(remainder, 0);
                    arr.set(newArr, remainder.length);
                    if (first) {
                        const clusterStartIndices =
                            await getClusterStartIndices(arr);
                        if (clusterStartIndices.length == 1) {
                            const firstClusterIndex =
                                clusterStartIndices.splice(0, 1)[0];
                            header = arr.slice(0, firstClusterIndex);
                            newArr = arr.slice(firstClusterIndex);
                            remainder = new Uint8Array(0);
                            diff = decoder.decode(newArr);
                            first = false;
                        } else {
                            remainder = newArr;
                        }
                    } else {
                        if (getClusterStartIndices(arr).length > 0) {
                            console.log("cluster!");
                        }
                        diff = decoder.decode(arr);
                    }

                    if (diff.length > 1) {
                        //newArr?.length > 0
                        const chunk = new Chunk(
                            e.data.type,
                            header,
                            new Uint8Array(encoder.encode(diff))
                        );
                        console.log(toHexString(chunk.chunk.subarray(0, 8)));
                        videoStream.chunks.put(chunk);
                        /*  pushed += 1;
                        videoStreamRef?.current?.chunks.put(chunk, { trim: { bytelength: 3 * 1e6 } }) */
                    } else {
                        remainder = arr;
                    }
                } else {
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
                            videoStream.chunks.put(chunk);
                            first = false;
                        } else {
                            remainder = newArr;
                        }
                    } else {
                        const chunk = new Chunk(e.data.type, header, newArr);
                        videoStream.chunks.put(chunk);
                    }
                }
            };
            recorder.start(50);
        }
    };

    const onEnd = () => {
        mediaRecorder?.stop();
    };
    return (
        <>
            {!!videoStream ? (
                <Grid container direction="column">
                    <Grid item>
                        <video
                            ref={videoRef}
                            width="300"
                            onPlay={onStart}
                            onEnded={onEnd}
                            muted
                            autoPlay
                            loop
                        />
                    </Grid>
                    <Grid item>
                        <IconButton onClick={() => setUseWebcam(!useWebcam)}>
                            {useWebcam ? (
                                <PetsIcon></PetsIcon>
                            ) : (
                                <CameraAltIcon></CameraAltIcon>
                            )}
                        </IconButton>
                    </Grid>
                </Grid>
            ) : (
                <></>
            )}
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
