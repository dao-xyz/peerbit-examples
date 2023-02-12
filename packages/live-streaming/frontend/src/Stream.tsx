import { usePeer } from "@dao-xyz/peerbit-react";
import { useRef, useState, useEffect, useCallback } from "react";
import { Chunk, VideoStream } from "./database";
import { getClusterStartIndices } from "./webm";
import { ObserverType } from "@dao-xyz/peerbit-program";
import { Buffer } from "buffer";
import PetsIcon from "@mui/icons-material/Pets";
import CameraAltIcon from "@mui/icons-material/CameraAlt";
import { Grid, IconButton } from "@mui/material";
import { videoMimeType } from "./format";
import {
    PublicSignKey
} from "@dao-xyz/peerbit-crypto";
import { View } from "./View";

interface HTMLVideoElementWithCaptureStream extends HTMLVideoElement {
    captureStream(fps?: number): MediaStream;
    mozCaptureStream?(fps?: number): MediaStream;
}

const PACK_PERFECTLY = false;
if (PACK_PERFECTLY) {
    globalThis.Buffer = Buffer;
}
/* globalThis.VSTATS = new Map(); */

export const Stream = (args: { identity: PublicSignKey, node: PublicSignKey }) => {
    const [useWebcam, setUseWebcam] = useState(false);
    //const [isStreamer, setIsStreamer] = useState<boolean | undefined>(undefined);

    const [videoStream, setVideoStream] = useState<VideoStream | null>(null);
    const [videoCaptureStream, setVideoCaptureStream] =
        useState<HTMLVideoElementWithCaptureStream | null>(null);

    const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder>();
    const { peer } = usePeer();

    // TODO
    useEffect(() => {
        if (
            !peer?.libp2p || !args.identity || !args.node
        ) {
            return;
        }

        try {

            if (peer.idKey.publicKey.equals(args.node) && peer.identity.publicKey.equals(args.identity)) {
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

    const videoRef = useCallback(
        (node) => {
            const videoCaptureStream: HTMLVideoElementWithCaptureStream = node;
            // const ctx = videoCaptureStream.getContext("2d");

            if (!videoStream || !videoCaptureStream) {
                return;
            }

            if (useWebcam) {
                // Get access to the user's webcam and set up the video stream
                navigator.mediaDevices
                    .getUserMedia({
                        video: { width: 1280, height: 720 },
                        audio: true,
                    })
                    .then((stream) => {
                        /*      const processor = new globalThis.MediaStreamTrackProcessor(stream.getVideoTracks()[0]);
                             const reader = processor.readable.getReader(); */
                        /* readChunk();
                        function readChunk() {
                            reader.read().then(({ done, value }) => {
                                // the MediaStream video can have dynamic size
                                if (videoCaptureStream.width !== value.displayWidth || videoCaptureStream.height !== value.displayHeight) {
                                    videoCaptureStream.width = value.displayWidth;
                                    videoCaptureStream.height = value.displayHeight;
                                }
                                ctx.clearRect(0, 0, videoCaptureStream.width, videoCaptureStream.height);
                                // value is a VideoFrame
                                ctx.drawImage(value, 0, 0);
                                value.close(); // close the VideoFrame when we're done with it
                                if (!done) {
                                    readChunk();
                                }
                            });

                        }
                        onStart(videoCaptureStream, stream.getAudioTracks()[0]); */
                        videoCaptureStream.srcObject = stream;
                    });
            } else {
                /*   if (videoCaptureStream && videoCaptureStream.srcObject) {
                      const tracks = videoCaptureStream.srcObject["getTracks"]();
                      tracks.forEach((track) => track.stop());
                      videoCaptureStream.srcObject = null;
                  } */

                // Set the URL of the video file as the src attribute of the video element
                videoCaptureStream.src = import.meta.env.BASE_URL + "clownfish.mp4";
                videoCaptureStream.load();
            }

            setVideoCaptureStream(videoCaptureStream);
        },
        [videoStream?.id, useWebcam]
    );

    const onStart = () => {
        let stream: MediaStream = videoCaptureStream.srcObject as any as MediaStream;
        // use srcObject
        if (!stream) {
            let fps = 0;
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

        }
        // stream.addTrack(audioStream);

        function toggleMute() {
            /*    if (videoCaptureStream.muted) {
                   videoCaptureStream.muted = false;
               } */
            /* else {
               videoCaptureStream.muted = true;
               console.log("PLAY")
           } */
        }

        setTimeout(toggleMute, 1000);
        //  setTimeout(toggleMute, 1000);

        if (stream) {
            //if (videoCaptureStream.muted)
            // const audioTrack = stream.getAudioTracks()[0];
            {
                //stream.getAudioTracks().map(x=>x.getSettings())
                stream.getAudioTracks().forEach((t) => stream.removeTrack(t)); // Remove audo tracks, else the MediaRecorder will not work
            }
            //    stream.getVideoTracks().forEach((t) => stream.removeTrack(t))


            const recorder2 = new MediaRecorder(stream, {
                mimeType: videoMimeType,
                videoBitsPerSecond: 1e7,
            });


            let first = true;
            let header: Uint8Array | undefined = undefined;
            let remainder = new Uint8Array([]);
            let ts = BigInt(+new Date());

            let start = +new Date;
            let counter = 0;
            recorder2.ondataavailable = async (e) => {
                console.log('data!')
                counter += 1;
                //  console.log(+new Date - start)
                start = +new Date;
                let newArr = new Uint8Array(await e.data.arrayBuffer());
                if (newArr.length > 0) {
                    //   console.log(+new Date - start, newArr.length)
                    start = +new Date;
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
                        /* globalThis.VSTATS.set(chunk.id, { a: +new Date }) */
                        videoStream.chunks.put(chunk);

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
                    /* globalThis.VSTATS.set(chunk.id, { a: +new Date }) */
                    videoStream.chunks.put(chunk)

                }
            };


            recorder2.start(1)



            /*  const recorder = new MediaRecorder(new MediaStream(stream.getAudioTracks()), {
               mimeType: audioMimeType,
               audioBitsPerSecond: 1e5
           });
           setMediaRecorder(recorder);
         
                       let first2 = true;
                       let header2: Uint8Array | undefined = undefined;
                       let remainder2 = new Uint8Array([]);
                       let ts2 = BigInt(+new Date());
           
                       let start2 = +new Date;
                       let counter2 = 0;
                       recorder.ondataavailable = async (e) => {
                           counter2 += 1;
                           //  console.log(+new Date - start)
                           start2 = +new Date;
                           let newArr = new Uint8Array(await e.data.arrayBuffer());
                           if (newArr.length > 0) {
                               //   console.log(+new Date - start, newArr.length)
                               start2 = +new Date;
                           }
                           if (first2) {
                               let arr = new Uint8Array(
                                   newArr.length + remainder2.length
                               );
                               arr.set(remainder2, 0);
                               arr.set(newArr, remainder2.length);
                               const clusterStartIndices =
                                   await getClusterStartIndices(arr);
                               if (clusterStartIndices.length == 1) {
                                   const firstClusterIndex =
                                       clusterStartIndices.splice(0, 1)[0];
                                   header2 = arr.slice(0, firstClusterIndex);
                                   newArr = arr.slice(firstClusterIndex);
                                   remainder2 = new Uint8Array(0);
                                   const chunk = new Chunk(e.data.type, header2, arr);
                                   videoStream.audio.put(chunk).then(() => {
                                       console.log('first update')
           
                                   });;
                                   first2 = false;
                               } else {
                                   remainder2 = newArr;
                               }
                           } else {
                               ts2 = BigInt(+new Date());
                               const chunk = new Chunk(
                                   e.data.type,
                                   header2,
                                   newArr,
                                   ts2
                               );
           
                               globalThis.X = ts2
                               videoStream.audio.put(chunk);
                           }
                       };
                       recorder.start(1); */



            /*  const recordInterval = setInterval(() => {
                 recorder.requestData()
             }, 5)
             recorder.onstop = () => {
                 clearInterval(recordInterval)
             } */

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
                            autoPlay
                            loop
                            muted
                        >

                        </video>
                        {/*  <video
                            ref={videoRef}
                            width="300"
                            onPlay={onStart}
                            onEnded={onEnd}
                            controls={!useWebcam}
                            //muted
                            autoPlay={useWebcam}
                            loop
                        /> */}
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
                    {/*  {videoStream && <View db={videoStream}></View>} */}
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
