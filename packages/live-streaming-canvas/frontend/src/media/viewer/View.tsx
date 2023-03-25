import { usePeer } from "@dao-xyz/peerbit-react";
import { useRef, useState, useEffect, useCallback } from "react";
import {
    Chunk,
    WebcodecsStreamDB,
    MediaStreamDBs,
    Track,
    AudioStreamDB,
    TrackSource,
} from "../database.js";
import { ObserverType, ReplicatorType } from "@dao-xyz/peerbit-program";
import { Grid } from "@mui/material";
import { PublicSignKey, sha256Base64Sync } from "@dao-xyz/peerbit-crypto";
import {
    DocumentQuery,
    Documents,
    DocumentsChange,
} from "@dao-xyz/peerbit-document";
import "./View.css";
import CatOffline from "/catbye64.png";
import { Controls } from "./controller/Control.js";
import { ControlFunctions } from "./controller/controls.js";
import VideoWorker from "./videoWorker.js?worker";
import { Resolution } from "../controls/settings.js";

import { FrameMessage, ResizeMessage, CanvasMessage } from "./videoWorker.js";

const webworker = new VideoWorker();

const addVideoStreamListener = async (streamDB: WebcodecsStreamDB) => {
    console.log("Add stream listener");
    let pendingFrames: VideoFrame[] = [];
    let underflow = true;
    let currentTime = 0;

    let play = true;
    let baseTime: number | undefined = undefined;
    function calculateTimeUntilNextFrame(timestamp: number) {
        if (!baseTime) {
            throw new Error("Basetime not set");
        }

        let mediaTime = performance.now() - baseTime;
        return Math.max(0, timestamp / 1000 - mediaTime);
    }
    const renderFrame = async () => {
        underflow = pendingFrames.length == 0;
        //  console.log("RENDER FRAME", underflow, !play, pendingFrames.length)
        if (underflow) return;

        if (!play) {
            return;
        }
        let frame = pendingFrames.shift();

        webworker.postMessage({ type: "frame", frame } as FrameMessage, [
            frame as any as Transferable,
        ]); // TODO fix types

        currentTime = frame.timestamp;
        if (!baseTime) {
            baseTime = performance.now() - frame.timestamp / 1000;
        }
        //  console.log("NEXT FRAME IN", calculateTimeUntilNextFrame(currentTime), frame.duration, currentTime / 1000, baseTime, performance.now() - baseTime)
        setTimeout(renderFrame, calculateTimeUntilNextFrame(currentTime));
    };
    let decoder: VideoDecoder = new VideoDecoder({
        error: (e) => {},
        output: (frame) => {
            console.log("got frame!");
            handleFrame(frame);
        },
    });

    decoder.configure(streamDB.decoderDescription);

    let waitForKeyFrame = true;
    const handleFrame = (frame: VideoFrame) => {
        pendingFrames.push(frame);
        if (underflow /*  && pendingFrames.length > 100 */) {
            renderFrame();
        }
    };

    const listener = (change: CustomEvent<DocumentsChange<Chunk>>) => {
        for (const added of change.detail.added) {
            const chunk = new EncodedVideoChunk({
                timestamp: added.timestamp,
                type: added.type as "key" | "delta",
                data: added.chunk,
            });

            if (decoder && decoder.state !== "closed") {
                if (waitForKeyFrame) {
                    if (chunk.type !== "key") {
                        return;
                    }
                    waitForKeyFrame = false;
                }
                decoder.decode(chunk);
            }
        }
    };

    let cleanup: (() => void) | undefined = undefined;
    return {
        close: () => {
            cleanup?.();
            if (decoder.state !== "closed") {
                decoder.close();
            }
        },
        setProgress: (progress: number) => {
            cleanup?.();
        },
        setSpeed: (number) => {
            // TODO
        },
        setLive: () => {
            console.log("go live video!");
            cleanup = () =>
                streamDB.chunks.events.removeEventListener("change", listener);
            streamDB.chunks.events.addEventListener("change", listener);
        },
        play: () => {
            play = true;
            console.log("play!");
            renderFrame();
        },
        pause: () => {
            play = false;
        },
        currentTime: () => currentTime,
    };
};

const addAudioStreamListener = async (
    streamDB: AudioStreamDB,
    currentVideoTime?: () => number
) => {
    let play = true;
    let pendingFrames: { buffer: AudioBuffer; timestamp: number }[] = [];
    let underflow = true;
    let audioContext: AudioContext | undefined = undefined;
    let setVolume: ((value: number) => void) | undefined = undefined;
    let gainNode: GainNode | undefined = undefined;

    const stop = () => {
        if (audioContext) {
            audioContext.close();
        }
        audioContext = undefined;
        setVolume = undefined;
        gainNode = undefined;
    };
    setVolume = (volume: number) => {
        if (gainNode) gainNode.gain.value = volume;
    };

    const setupAudioContext = () => {
        stop();
        audioContext = new AudioContext({ sampleRate: streamDB.sampleRate });
        gainNode = audioContext.createGain();
        gainNode.connect(audioContext.destination);
    };

    const mute = () => {}; // we don't do anything with the source, we let the controller set volume to 0
    const unmute = () => {}; // we don't do anything with the source, we let the controller set volume back to previous volume before mute

    let time = 0;
    let expectedLatency = 0.1;

    const renderFrame = async () => {
        if (!time) {
            // we've not yet started the queue - just queue this up,
            // leaving a "latency gap" so we're not desperately trying
            // to keep up.  Note if the network is slow, this is going
            // to fail.  Latency gap here is 100 ms.
            time = Math.max(audioContext.currentTime - expectedLatency, 0);
        }

        // time - audioContext.currentTime should never be negative!

        underflow = pendingFrames.length == 0;
        if (underflow) return;
        if (!play) return;

        const frame = pendingFrames.shift();
        const audioSource = audioContext.createBufferSource();
        audioSource.buffer = frame.buffer;
        audioSource.connect(gainNode);
        audioSource.start(time);

        let currentLag =
            (currentVideoTime
                ? Math.min(time, currentVideoTime() / 1e6)
                : time) - audioContext.currentTime;
        let lagRatio = currentLag / expectedLatency;
        let damp = 0.95;
        const playbackRate = 1 * damp + Math.max(0, lagRatio) * (1 - damp);

        //  let detune = -12 * Math.log2(1 / playbackRate) * 100;
        // audioSource.detune.value = -detune

        // audioSource.detune.linearRampToValueAtTime(-detune, time)
        audioSource.playbackRate.value = playbackRate;

        // console.log('AUDIO INFO', audioSource.buffer.duration / playbackRate + time, currentVideoTime?.(), frame.timestamp)
        time += audioSource.buffer.duration / playbackRate;

        // Immediately schedule rendering of the next frame
        requestAnimationFrame(renderFrame);
    };

    const listener = (change: CustomEvent<DocumentsChange<Chunk>>) => {
        for (const added of change.detail.added) {
            // seems like 'decodeAudioData' requires a cloned, 0 offset buffer,
            // additionally, if we reuse the same array we seem to run into issues where decodeAudioData mutates the original array in someway (?)
            let zeroOffsetBuffer = new Uint8Array(added.chunk.length);
            zeroOffsetBuffer.set(added.chunk, 0);
            audioContext.decodeAudioData(
                zeroOffsetBuffer.buffer,
                (data) => {
                    pendingFrames.push({
                        buffer: data,
                        timestamp: added.timestamp,
                    });
                    if (underflow) setTimeout(renderFrame, 0);
                },
                (e) => {
                    console.error("Failed to decode error", e);
                }
            );
        }
    };
    let cleanup: (() => void) | undefined = undefined;
    return {
        close: () => {
            cleanup?.();
        },
        setProgress: (progress: number) => {
            cleanup?.();
        },
        setSpeed: (value: number) => {},
        setLive: () => {
            if (!audioContext) {
                setupAudioContext();
            }
            cleanup = () =>
                streamDB.chunks.events.removeEventListener("change", listener);
            streamDB.chunks.events.addEventListener("change", listener);
        },
        setVolume,
        mute,
        unmute,
        play: () => {
            (play = true), setupAudioContext();
            renderFrame();
        },
        pause: () => {
            cleanup();
            play = false;
            stop();
        },
    };
};

type DBArgs = { db: MediaStreamDBs };
type IdentityArgs = { node: PublicSignKey };
type Streams<T extends TrackSource> = {
    source: T;
    controls: ControlFunctions & { close: () => void };
};

let videoHeight = () => window.innerHeight;
let videoWidth = () => window.innerWidth;

export const View = (args: DBArgs | IdentityArgs) => {
    const [videoStream, setVideoStream] = useState<MediaStreamDBs | null>();

    const offscreenCanvasRef = useRef<OffscreenCanvas>();
    const canvasRef = useRef<HTMLCanvasElement>();
    const videoStreamOptions = useRef<Track<WebcodecsStreamDB>[]>([]);
    const [resolutionOptions, setResolutionOptions] = useState<Resolution[]>(
        []
    );
    const [selectedResolutions, setSelectedResolutions] = useState<
        Resolution[]
    >([]);
    const videoLoadingRef = useRef<Promise<Streams<WebcodecsStreamDB>>>();
    const currentVideoRef = useRef<Streams<WebcodecsStreamDB>>(null);
    const audioLoadingRef = useRef<Promise<Streams<AudioStreamDB>>>();
    const currentAudioRef = useRef<Streams<AudioStreamDB>>(null);

    const containerRef = useRef<HTMLDivElement>(null);
    const [streamerOnline, setStreamerOnline] = useState(false);
    const { peer } = usePeer();
    const controls = useRef<ControlFunctions[]>([]);
    const [isPlaying, setIsPlaying] = useState(false);

    useEffect(() => {
        if (!peer?.libp2p) {
            return;
        }
        try {
            if ((args as DBArgs).db) {
                setVideoStream((args as DBArgs).db);
            } else {
                const idArgs = args as IdentityArgs;

                if (!peer.idKey.publicKey.equals(idArgs.node)) {
                    // Open the VideStream database as a viewer
                    peer.open(new MediaStreamDBs(idArgs.node), {
                        role: new ObserverType(),
                        sync: () => true,
                    }).then((vs) => {
                        setVideoStream(vs);
                    });
                }
            }
        } catch (error) {
            console.error("Failed to create stream", error);
        }
    }, [
        peer?.id,
        (args as DBArgs).db?.id.toString(),
        (args as IdentityArgs).node?.hashcode(),
    ]);

    const updateVideoStream = async (
        streamToOpen: Track<WebcodecsStreamDB>
    ) => {
        await videoLoadingRef.current;
        if (currentVideoRef.current) {
            currentVideoRef.current.controls.close();
            currentVideoRef.current.source?.drop();
            controls.current = controls.current.filter(
                (x) => x === currentVideoRef.current.controls
            );
        }

        videoLoadingRef.current = new Promise((resolve, reject) => {
            peer.open(streamToOpen.source, {
                role: new ObserverType(),
                sync: () => true,
            })
                .then(async (s) => {
                    setSelectedResolutions([
                        s.decoderDescription.codedHeight as Resolution,
                    ]);
                    return {
                        video: s,
                        controls: await addVideoStreamListener(s),
                    };
                })
                .then(({ video, controls: videoFns }) => {
                    controls.current.push(videoFns);
                    resolve({ source: video, controls: videoFns });
                })
                .catch(reject);
        });

        return videoLoadingRef.current.then((streams) => {
            currentVideoRef.current = streams;
            currentVideoRef.current.controls.setLive();
        });
    };

    const updateAudioStream = async (streamToOpen: Track<AudioStreamDB>) => {
        await audioLoadingRef.current;
        if (currentAudioRef.current) {
            currentAudioRef.current.controls.close();
            await currentAudioRef.current.source?.drop();
        }

        // get stream with closest bitrate
        let currentVideoTime: (() => number) | undefined = undefined;

        audioLoadingRef.current = new Promise((resolve, reject) => {
            peer.open(streamToOpen.source, {
                role: new ObserverType(),
                sync: () => true,
            })
                .then(async (s) => {
                    await addAudioStreamListener(s, currentVideoTime).then(
                        (audioFns) => {
                            /*   let mergedControls = {
                              setSpeed: (value) => {
                                  audioFns.setSpeed(value)
                                  videoFns.setSpeed(value)
                              },
                              setLive: () => {
                                  audioFns.setLive()
                                  videoFns.setLive()
                              },
                              setProgress: (value) => {
                                  audioFns.setProgress(value);
                                  videoFns.setProgress(value)
                              },
                              pause: () => {
                                  audioFns.pause()
                                  videoFns.pause()
                                  setIsPlaying(false);
                              },
                              play: () => {
                                  audioFns.play()
                                  videoFns.play()
                                  setIsPlaying(true);
                              },
                              close: () => {
                                  audioFns.close()
                                  videoFns.close()
                              },
                              setVolume: audioFns.setVolume,
                              mute: audioFns.mute,
                              unmute: audioFns.unmute,
                            
                          }; */
                            controls.current.push(audioFns);
                            resolve({ source: s, controls: audioFns });
                        }
                    );
                })
                .catch(reject);
        });

        return audioLoadingRef.current.then((streams) => {
            currentAudioRef.current = streams;
            currentAudioRef.current.controls.setLive();
        });
    };

    const playbackRefCb = useCallback(
        (node) => {
            if (currentAudioRef.current) {
                currentAudioRef.current.source?.close();
            }
            if (currentVideoRef.current) {
                currentVideoRef.current.source?.close();
            }

            let setVideoSize = () =>
                webworker.postMessage({
                    type: "size",
                    height: videoHeight(),
                    width: videoWidth(),
                } as ResizeMessage);

            canvasRef.current = node as HTMLCanvasElement;

            if (node && !offscreenCanvasRef.current) {
                offscreenCanvasRef.current = (
                    node as HTMLCanvasElement
                ).transferControlToOffscreen();
                webworker.postMessage(
                    {
                        type: "canvas",
                        canvas: offscreenCanvasRef.current,
                    } as CanvasMessage,
                    [offscreenCanvasRef.current]
                );
                let resizeTimer: any = undefined;
                window.onload = window.onresize = function () {
                    clearTimeout(resizeTimer);
                    resizeTimer = setTimeout(() => {
                        console.log("set size", videoHeight(), videoWidth());
                        setVideoSize();
                    }, 100);
                };
            }

            if (peer && offscreenCanvasRef.current && videoStream) {
                setInterval(async () => {
                    const results = await videoStream.streams.index.query(
                        new DocumentQuery({ queries: [] })
                    );

                    const uniqueResults = results
                        .map((x) => x.results)
                        .flat()
                        .map((x) => x.value)
                        .filter(
                            (v, ix, arr) =>
                                v.active &&
                                arr.findIndex((x) => x.id === v.id) === ix
                        )
                        .map((x) => x);

                    const removedStreams = videoStreamOptions.current.filter(
                        (x) => !uniqueResults.find((y) => y.id === x.id)
                    );

                    await videoLoadingRef.current;
                    await audioLoadingRef.current;

                    let currentVideoIsRemoved = !!removedStreams.find(
                        (x) => x.id == currentVideoRef.current?.source.id
                    );

                    console.log(
                        uniqueResults.map((x) => x.active + "-" + x.id),
                        currentVideoIsRemoved,
                        videoStreamOptions.current.length
                    );

                    let videoResults = uniqueResults.filter(
                        (x) => x.source instanceof WebcodecsStreamDB
                    ) as Track<WebcodecsStreamDB>[];
                    let audioResult = uniqueResults.filter(
                        (x) => x.source instanceof AudioStreamDB
                    ) as Track<AudioStreamDB>[];

                    if (
                        videoResults.length > 0 &&
                        (videoStreamOptions.current.length === 0 ||
                            currentVideoIsRemoved)
                    ) {
                        let wantedHeight = currentVideoIsRemoved
                            ? currentVideoRef.current.source.decoderDescription
                                  .codedHeight
                            : 0;
                        videoResults.sort(
                            (a, b) =>
                                Math.abs(
                                    a.source.decoderDescription.codedHeight -
                                        wantedHeight
                                ) -
                                Math.abs(
                                    b.source.decoderDescription.codedHeight -
                                        wantedHeight
                                )
                        );
                        let streamToOpen = videoResults[0];
                        videoHeight = () =>
                            Math.min(
                                (window.innerWidth /
                                    streamToOpen.source.decoderDescription
                                        .codedWidth) *
                                    streamToOpen.source.decoderDescription
                                        .codedHeight,
                                window.innerHeight
                            );
                        videoWidth = () =>
                            Math.min(
                                (window.innerHeight /
                                    streamToOpen.source.decoderDescription
                                        .codedHeight) *
                                    streamToOpen.source.decoderDescription
                                        .codedWidth,
                                window.innerWidth
                            );

                        setVideoSize();
                        console.log(
                            "update stream!",
                            streamToOpen.source.decoderDescription.codedWidth,
                            streamToOpen.source.decoderDescription.codedHeight
                        );
                        await updateVideoStream(streamToOpen);
                        console.log("update stream done");
                        console.log(
                            "resolutions options",
                            videoResults.map(
                                (x) => x.source.decoderDescription.codedHeight
                            )
                        );
                    }
                    videoStreamOptions.current = videoResults;
                    setResolutionOptions(
                        [
                            ...videoResults.map(
                                (x) => x.source.decoderDescription.codedHeight
                            ),
                        ].sort() as Resolution[]
                    );

                    if (
                        audioResult.length > 0 &&
                        (!currentAudioRef.current ||
                            !!removedStreams.find(
                                (x) =>
                                    x.id == currentAudioRef.current?.source.id
                            ))
                    ) {
                        console.log(
                            "open audio stream",
                            audioResult.length,
                            currentAudioRef.current
                        );

                        await updateAudioStream(audioResult[0]);
                    }

                    setStreamerOnline(
                        peer.libp2p.directsub
                            .getSubscribers(videoStream.address.toString())
                            .has(videoStream.sender.hashcode())
                    );
                }, 1000);
            }
        },
        [peer, videoStream]
    );

    console.log(resolutionOptions);
    return (
        <Grid container direction="column">
            <Grid item>
                <div className="container" ref={containerRef}>
                    <div className="video-wrapper">
                        <canvas
                            id="stream-playback"
                            ref={playbackRefCb}
                            width="300px"
                            height="300px"
                        />
                        {streamerOnline && !!controls && (
                            <Controls
                                progress={0.3}
                                isStreamer={false}
                                selectedResolution={selectedResolutions}
                                resolutionOptions={resolutionOptions}
                                viewRef={canvasRef.current}
                                onQualityChange={(settings) => {
                                    const setting = settings[0];
                                    if (!setting) {
                                        return;
                                    }
                                    const streamToOpen =
                                        videoStreamOptions.current.find(
                                            (x) =>
                                                x.source.decoderDescription
                                                    .codedHeight ===
                                                setting.video.height
                                        );
                                    let videoRef =
                                        document.getElementById(
                                            "stream-playback"
                                        );
                                    if (!videoRef) {
                                        return;
                                    }
                                    return updateVideoStream(streamToOpen);
                                }}
                                isPlaying={isPlaying}
                                pause={() =>
                                    controls.current.forEach((c) => c.pause())
                                }
                                play={() =>
                                    controls.current.forEach((c) => c.play())
                                }
                                setLive={() =>
                                    controls.current.forEach((c) => c.setLive())
                                }
                                setProgress={(p) =>
                                    controls.current.forEach((c) =>
                                        c.setProgress(p)
                                    )
                                }
                                setSpeed={(p) =>
                                    controls.current.forEach((c) =>
                                        c.setSpeed(p)
                                    )
                                }
                                mute={() =>
                                    controls.current.forEach(
                                        (c) => c.mute && c.mute()
                                    )
                                }
                                unmute={() =>
                                    controls.current.forEach(
                                        (c) => c.unmute && c.unmute()
                                    )
                                }
                                setVolume={(v) =>
                                    controls.current.forEach(
                                        (c) => c.setVolume && c.setVolume(v)
                                    )
                                }
                            ></Controls>
                        )}
                        {!streamerOnline && (
                            <Grid
                                container
                                direction="column"
                                className="cat"
                                justifyContent="center"
                                spacing={1}
                            >
                                <Grid
                                    item
                                    sx={{
                                        display: "flex",
                                        ml: "-10px",
                                        maxHeight: "40%",
                                        maxWidth: "40%",
                                        justifyContent: "center",
                                        alignContent: "center",
                                    }}
                                >
                                    <img src={CatOffline} />
                                </Grid>
                                <Grid item>Streamer is offline</Grid>
                            </Grid>
                        )}
                    </div>
                </div>
            </Grid>
        </Grid>
    );
};
