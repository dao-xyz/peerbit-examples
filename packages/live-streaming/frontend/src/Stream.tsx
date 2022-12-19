import { usePeer } from '@dao-xyz/peerbit-react';
import { useRef, useState, useEffect, useContext } from 'react';
import { Chunk, VideoStream } from './database';
import PQueue from 'p-queue';
import { PutOperation } from '@dao-xyz/peerbit-document';
import { useParams } from 'react-router-dom';
import { getKeyFromStreamKey } from './routes';
import { WindowContext } from './WindowContext';
import { PublicSignKey } from '@dao-xyz/peerbit-crypto';
import { getClusterStartIndices } from './webm';
import { waitFor, delay } from '@dao-xyz/peerbit-time';
interface HTMLVideoElementWithCaptureStream extends HTMLVideoElement {
    captureStream?(fps?: number): MediaStream;
    mozCaptureStream?(fps?: number): MediaStream
}

const streamQueue = new PQueue({ concurrency: 1 })

/* const consumeQueue = new PQueue({ concurrency: 1 })
 */
let mimeType = 'video/webm;codecs=vp8'
export const Stream = () => {
    const [useWebcam, setUseWebcam] = useState(false);
    const [isStreamer, setIsStreamer] = useState(false);

    const videoStreamRef = useRef<VideoStream>();
    const videoRef = useRef<HTMLVideoElementWithCaptureStream>(null);
    const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder>()
    const { peer } = usePeer()
    const playbackRef = useRef<HTMLVideoElementWithCaptureStream>(null);
    const sourceBufferRef = useRef<SourceBuffer>();
    const test = useRef<boolean>(false);
    const params = useParams();
    const { windowIsActive } = useContext(WindowContext)
    const streamKeyRef = useRef<string>();


    // TODO
    useEffect(() => {
        if (!peer?.libp2p || !params.key || streamKeyRef.current && params.key === streamKeyRef.current) {
            return;
        }

        try {
            streamKeyRef.current = params.key;
            const streamKey = getKeyFromStreamKey(params.key)
            setIsStreamer(peer.identity.publicKey.equals(streamKey))
            if (peer && playbackRef) {
                const vs = new VideoStream(streamKey)
                const mediaSource = new MediaSource();
                playbackRef.current.src = URL.createObjectURL(mediaSource);
                mediaSource.addEventListener('sourceopen', () => {
                    const sb = mediaSource.addSourceBuffer(mimeType); ////'');
                    sb.onerror = ((error) => {
                        console.error("sb error", error)
                        //
                    })
                    sb.mode = 'sequence';


                    // sync?
                    /*  sb.onupdateend = (ev) => {
                         if (playbackRef && !test.current && ev.timeStamp - playbackRef.current?.currentTime * 1000 > 2000 && windowIsActive) {
                             test.current = true
                             console.log('sync!')
                             playbackRef.current.currentTime = ev.timeStamp / 1000 - 2
                             playbackRef.current.play();
 
                         }
                     } */
                    sourceBufferRef.current = sb;
                });
                playbackRef.current.onerror = ((error) => {
                    console.error("pb error", error)
                })

                let first = true;
                let firstChunk = new Uint8Array(0);
                peer.open(vs, {
                    replicate: true,
                    topic: 'world',
                    onUpdate: (log, change) => {
                        console.log('open!')
                        change.added.forEach(async (entry) => {
                            const operation = await entry.getPayloadValue();
                            if (operation instanceof PutOperation) {
                                const putOperation = operation as PutOperation<Chunk>
                                const chunk = (await putOperation.getValue(vs.chunks._valueEncoding))

                                console.log(sourceBufferRef?.current.updating)
                                if (sourceBufferRef?.current && sourceBufferRef?.current.updating === false) {
                                    if (first) {
                                        // append header and only chunk if it contains the entry of a cluster
                                        let arr = new Uint8Array(chunk.chunk.length + firstChunk.length);
                                        arr.set(firstChunk, 0);
                                        arr.set(chunk.chunk, firstChunk.length);
                                        const clusterIndices = getClusterStartIndices(arr);
                                        console.log(clusterIndices)
                                        if (clusterIndices.length >= 1) {
                                            sourceBufferRef?.current?.appendBuffer(first ? new Uint8Array([...chunk.header, ...arr.slice(clusterIndices[0])]) : chunk.chunk);
                                            first = false;
                                            console.log('first false')
                                        }
                                        /*       else {
                                                  firstChunk = arr;
                                              } */

                                    }
                                    else {
                                        sourceBufferRef?.current?.appendBuffer(first ? new Uint8Array([...chunk.header, ...chunk.chunk]) : chunk.chunk);
                                    }

                                }
                            }



                        })

                    }
                }).then((vs) => {
                    videoStreamRef.current = vs;
                    console.log(vs.address.toString())

                    const trimJob = async () => {
                        const trimeSeconds = 10;
                        while (true && playbackRef.current) {
                            const trimTo = playbackRef.current.currentTime - trimeSeconds;
                            const trimFrom = Math.max(playbackRef.current.currentTime - trimeSeconds * 2, 0)
                            console.log(trimTo, trimFrom)
                            try {
                                if (trimFrom > 10 && await waitFor(() => sourceBufferRef?.current.updating === false)) {
                                    console.log('trim!', trimTo)
                                    sourceBufferRef.current?.remove(0, trimTo);

                                }
                            } catch (error) {
                                // ignore
                            }
                            await delay(trimeSeconds * 1000)

                        }
                    }
                    trimJob();
                })


            }
        } catch (error) {
            console.error("Failed to create stream", error)
        }


    }, [peer?.id, playbackRef, params?.key]);

    useEffect(() => {
        if (!isStreamer) {
            return;
        }

        /*      videoRefRecording.current.srcObject = null; */
        if (useWebcam) {
            // Get access to the user's webcam and set up the video stream
            navigator.mediaDevices.getUserMedia({ video: true }).then(stream => {
                videoRef.current.srcObject = stream;
            });
        } else {

            if (videoRef.current && videoRef.current.srcObject) {
                const tracks = videoRef.current.srcObject["getTracks"]();
                tracks.forEach(track => track.stop());
                videoRef.current.srcObject = null;
            }

            // Set the URL of the video file as the src attribute of the video element
            videoRef.current.src =
                `${process.env.PUBLIC_URL}/clownfish.mp4`;
            videoRef.current.load()

        }
    }, [useWebcam, isStreamer]);

    const onStart = () => {
        console.log('start!')
        let stream: MediaStream;
        const fps = 0;
        if (videoRef.current.captureStream) {
            stream = videoRef.current.captureStream(fps);
        } else if (videoRef.current.mozCaptureStream) {
            stream = videoRef.current.mozCaptureStream(fps);
        } else {
            console.error('Stream capture is not supported', videoRef.current.captureStream);
            stream = null;
        }
        /*     videoRefRecording.current.srcObject = stream; */
        if (stream) {
            if (videoRef.current.muted) {
                stream.getAudioTracks().forEach(t => stream.removeTrack(t)) // Remove audo tracks, else the MediaRecorder will not work
            }

            const recorder = new MediaRecorder(stream, { mimeType: mimeType, videoBitsPerSecond: 1e5 });
            setMediaRecorder(recorder)
            let first = true;
            let header: Uint8Array | undefined = undefined;
            let remainder = new Uint8Array([]);
            recorder.ondataavailable = async (e) => {
                console.log('new data!')
                if (streamQueue.size > 10) // lagging
                {
                    console.warn('Can not keep up with video, clearing buffer')
                    streamQueue.clear();
                }
                let newArr = new Uint8Array(await e.data.arrayBuffer());
                let arr = new Uint8Array(newArr.length + remainder.length);
                arr.set(remainder, 0);
                arr.set(newArr, remainder.length);
                const clusterStartIndices = await getClusterStartIndices(arr);
                if (first && clusterStartIndices.length > 0) {
                    header = arr.slice(0, clusterStartIndices.splice(0, 1)[0]);
                    const chunk = new Chunk(e.data.type, header, arr)
                    videoStreamRef?.current?.chunks.put(chunk, { trim: { bytelength: 3 * 1e6 } })

                }
                else {
                    const chunk = new Chunk(e.data.type, header, arr)
                    videoStreamRef?.current?.chunks.put(chunk, { trim: { bytelength: 3 * 1e6 } })
                }


                /*     const clusters: Uint8Array[] = [];
                    if (clusterStartIndices.length >= 2) {
                        for (let i = 0; i < clusterStartIndices.length - 1; i++) {
                            clusters.push(arr.slice(clusterStartIndices[i], clusterStartIndices[i + 1]));
                        }
                        remainder = arr.slice(clusterStartIndices[clusterStartIndices.length - 1], arr.length);
                    }
                    else if (clusterStartIndices.length === 1) {
                        console.log('only one!')
                        remainder = arr.slice(clusterStartIndices[0], arr.length);
                    }
     
                    console.log('find offseT?', clusterStartIndices, clusters)
     
     
                    for (const cluster of clusters) {
                        const chunk = new Chunk(e.data.type, header, cluster)
                        videoStreamRef?.current?.chunks.put(chunk, { trim: { bytelength: 3 * 1e6 } }) // 3 mb
                    } */

                console.log('new data end!')


                first = false;



                //                console.log(streamQueue.size, videoStreamRef?.current?.chunks.store.oplog.length, videoStreamRef?.current?.chunks.store.oplog._entryIndex._cache.size, videoStreamRef?.current?.chunks.index.size, videoStreamRef?.current.chunks.store.oplog._values.byteLength)


            };
            recorder.start(100)
        }
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
            playbackRef.current.src = recordedUrl;
            playbackRef.current.loop = true; // play the video in a loop
        }
    }, [videoStreamRef, playbackRef]); */

    const onEnd = () => {
        mediaRecorder?.stop();
    }
    /* 
             useEffect(() => {
        
                // Set the URL of the video file as the src attribute of the video element
                // videoRef.current.src = "https://joy.videvo.net/videvo_files/video/free/2018-05/large_watermarked/bannerg004_preview.mp4";
                const videoStream = videoRef.current.captureStream()
                videoRefRecording.current.srcObject = videoStream;
            }, [videoRef?.current?.src]);  */



    return (
        <>

            {isStreamer ? <><button onClick={() => setUseWebcam(!useWebcam)}>
                Toggle Webcam
            </button>
                <video ref={videoRef} width="300" onPlay={onStart} onEnded={onEnd} muted autoPlay loop /></> : <></>}
            <video ref={playbackRef} width="300" muted controls autoPlay />
            {/*    <video ref={videoRefRecording} width="300" muted autoPlay /> */}

        </>
    );
}

