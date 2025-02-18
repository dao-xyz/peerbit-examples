import { usePeer } from "@peerbit/react";
import { useRef, useState, useEffect } from "react";
import {
    Chunk,
    WebcodecsStreamDB,
    MediaStreamDB,
    Track,
    AudioStreamDB,
    TracksIterator,
} from "@peerbit/video-lib";
import { Grid } from "@mui/material";

import "./View.css";
import CatOffline from "/catbye64.png";
import { Controls } from "./controller/Control.js";
import { ControlFunctions } from "./controller/controls.js";
import { Resolution } from "../controls/settings.js";
import { renderer } from "./video/renderer.js";
import PQueue from "p-queue";
import { getKeepAspectRatioBoundedSize } from "../MaintainAspectRatio.js";
import ClickOnceForAudio from "./ClickOnceForAudio.js";
import { Spinner } from "../../utils/Spinner.js";

let inBackground = false;
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        inBackground = true;
    } else {
        inBackground = false;
    }
});

const addVideoStreamListener = (
    streamDB: Track<WebcodecsStreamDB>,
    play: boolean
) => {
    let currentTime = 0;

    let decoder: VideoDecoder;
    let waitForKeyFrame = true;

    const configureDecoder = () => {
        if (decoder && decoder.state === "configured") {
            return;
        }
        if (decoder && decoder.state === "unconfigured") {
            decoder.close();
        }

        decoder = new VideoDecoder({
            error: () => {},
            output: (frame) => {
                /* handleFrame(frame); */
                if (document.visibilityState === "hidden") {
                    // is the app hidden?
                    console.log("HIDDEN");

                    frame.close();
                } else {
                    // this is the step where the rendering  happens
                    renderer.draw(frame);
                }
            },
        });
        decoder.configure(streamDB.source.decoderDescription);
        waitForKeyFrame = true;
    };

    configureDecoder();

    const processChunk = (chunk: Chunk) => {
        console.log("got chunk", chunk.time, chunk.chunk.length);
        const encodedChunk = new EncodedVideoChunk({
            timestamp: Number(chunk.time),
            type: chunk.type as "key" | "delta",
            data: chunk.chunk,
        });

        if (decoder) {
            if (decoder.state === "closed") {
                // For some reason the decoder can close if not recieving more frames (?)
                configureDecoder();
            }

            if (decoder.state !== "closed") {
                if (waitForKeyFrame) {
                    if (encodedChunk.type !== "key") {
                        return;
                    }
                    waitForKeyFrame = false;
                }
                decoder.decode(encodedChunk);
            }
        }
    };

    let cleanup: (() => Promise<void>) | undefined = async () => {
        /*    console.log("CLEANUP ");
           abortController.abort();
           underflow = true;
           await clearPending(); */
        if (decoder.state !== "closed") {
            decoder.close();
        }
    };

    return {
        close: async () => {
            await cleanup?.();
        },
        /*  setProgress: async (progress: number | "live") => {
             console.log("SET PROGRESS", progress);
             session++;
             await cleanup?.();
             renderLoop();
             abortController = new AbortController();
             if (progress === "live") {
                 setLive();
             } else {
                 setAtProgress(progress);
             }
         },
         setSpeed: (number) => {
             // TODO
         }, */
        push: processChunk,
        play: () => {
            play = true;
            /* setLive(); */
            /*       renderFrame();
                  renderLoop(); */
        },
        pause: async () => {
            play = false;
            await cleanup();
        },
        currentTime: () => currentTime,
    };
};

const addAudioStreamListener = (
    streamDB: Track<AudioStreamDB>,
    play: boolean,
    currentVideoTime?: () => number
) => {
    console.log("ADD AUDIO STREAM LISTENER");
    let pendingFrames: { buffer: AudioBuffer; timestamp: number }[] = [];
    let audioContext: AudioContext | undefined = undefined;
    let setVolume: ((value: number) => void) | undefined = undefined;
    let gainNode: GainNode | undefined = undefined;

    const audioContextListener = () => {
        if (
            audioContext.state === "suspended" ||
            audioContext.state === "closed"
        ) {
            play = false;
        }
    };
    const stop = async () => {
        console.log("STOP AUDIO LISTENER");
        if (audioContext) {
            audioContext.removeEventListener(
                "statechange",
                audioContextListener
            );
            audioContext.destination.disconnect();
            await audioContext.close();
            gainNode.disconnect();
        }
        audioContext = undefined;
        setVolume = undefined;
        gainNode = undefined;
    };
    setVolume = (volume: number) => {
        if (gainNode) gainNode.gain.value = volume;
    };

    const setupAudioContext = async () => {
        await stop();
        bufferedAudioTime = 0;
        console.log("SETUP AUDIO CONTEXT");
        audioContext = new AudioContext({
            sampleRate: streamDB.source.sampleRate,
        });
        audioContext.addEventListener("statechange", audioContextListener);
        gainNode = audioContext.createGain();
        gainNode.connect(audioContext.destination);
    };

    const mute = () => {}; // we don't do anything with the source, we let the controller set volume to 0
    const unmute = () => {}; // we don't do anything with the source, we let the controller set volume back to previous volume before mute

    let bufferedAudioTime = undefined;
    const MIN_EXPECTED_LATENCY = 0.01; // seconds
    let currentExpectedLatency = 3;
    let succesfullFrameCount = 0;
    const isUnderflow = () => 0; /* pendingFrames.length < 30 */

    const updateExpectedLatency = (latency: number) => {
        console.log("UPDATE EXPECTED LATENCY", latency);
        currentExpectedLatency = latency;
        bufferedAudioTime = Math.max(
            currentExpectedLatency + audioContext.currentTime,
            0
        );
    };

    const renderFrame = async () => {
        //  console.log("RENDER AUDIO CHUNK", bufferedAudioTime, pendingFrames.length, audioContext.currentTime, audioContext.state, play, audioContext.state === "running" && play, pendingFrames.length > 0, isUnderflow());

        if (!bufferedAudioTime) {
            // we've not yet started the queue - just queue this up,
            // leaving a "latency gap" so we're not desperately trying
            // to keep up.  Note if the network is slow, this is going
            // to fail.  Latency gap here is 100 ms.
            updateExpectedLatency(MIN_EXPECTED_LATENCY);
        }

        if (!play) return;
        if (pendingFrames.length === 0) return;
        if (audioContext.state !== "running") {
            return;
        }

        /**
         *  Take one element from the queue
         */
        const frame = pendingFrames.shift();

        const audioSource = audioContext.createBufferSource();
        audioSource.buffer = frame.buffer;
        audioSource.connect(gainNode);

        const isBehindSeconds = Math.max(
            audioContext.currentTime - bufferedAudioTime,
            0
        );

        let skipframe = false;
        if (isBehindSeconds > 0) {
            // we are not catching up, i.e. the player is going faster than we get new chunks
            if (isBehindSeconds > audioSource.buffer.duration) {
                skipframe = true;
            }
            succesfullFrameCount = 0;
            // here we want to do something about the expectedLatency, because if we also end up here
            // it means we are trying to watch in "too" much realtime
            updateExpectedLatency(currentExpectedLatency * 2);
        } else if (currentExpectedLatency > MIN_EXPECTED_LATENCY) {
            succesfullFrameCount++;

            // we have been succesfully able to play audio for some time
            // lets try to reduce the latency
            if (succesfullFrameCount > 1000) {
                const newLatency = currentExpectedLatency / 2;
                if (newLatency >= MIN_EXPECTED_LATENCY) {
                    updateExpectedLatency(newLatency);
                }
                succesfullFrameCount = 0;
            }
        }

        !skipframe && audioSource.start(bufferedAudioTime, isBehindSeconds);
        bufferedAudioTime += audioSource.buffer.duration;

        setTimeout(() => renderFrame(), bufferedAudioTime); // requestAnimationFrame will not run in background. delay here is 1 ms, its fine as if weunderflow we will stop this loop
        //requestAnimationFrame(renderFrame);
    };

    const decodeAudioDataQueue = new PQueue({ concurrency: 1 });
    let resuming = false;

    let push = (chunk: Chunk) => {
        if (decodeAudioDataQueue.size > 10) {
            decodeAudioDataQueue.clear(); // We can't keep up, clear the queue
        }

        decodeAudioDataQueue.add(async () => {
            let zeroOffsetBuffer = new Uint8Array(chunk.chunk.length);
            zeroOffsetBuffer.set(chunk.chunk, 0);
            audioContext?.decodeAudioData(
                zeroOffsetBuffer.buffer,
                (data) => {
                    const frame = {
                        buffer: data,
                        timestamp: chunk.time,
                    };

                    if (audioContext?.state !== "running" && play) {
                        pendingFrames = [];
                        pendingFrames.push(frame);
                        if (!resuming) {
                            resuming = true;
                            audioContext
                                ?.resume()
                                .then((r) => {
                                    resuming = false;
                                    renderFrame();
                                })
                                .catch((e) => {});
                        }
                    } else {
                        /*   const wasEmpty = pendingFrames.length; */
                        pendingFrames.push(frame);
                        if (!isUnderflow()) {
                            renderFrame();
                        }
                    }
                },
                (e) => {
                    console.error("Failed to decode error", e);
                }
            );
        });
    };
    /*   const listener = (change: CustomEvent<DocumentsChange<Chunk>>) => {
  
          if (play) {
              for (const added of change.detail.added) {
                  // seems like 'decodeAudioData' requires a cloned, 0 offset buffer,
                  // additionally, if we reuse the same array we seem to run into issues where decodeAudioData mutates the original array in someway (?)
                  push(added)
              }
          }
      };
     
      let setLive = async () => {
          if (!audioContext) {
              await setupAudioContext();
          }
          streamDB.source.chunks.events.removeEventListener("change", listener);
          streamDB.source.chunks.events.addEventListener("change", listener);
      }; */

    let cleanup: (() => void) | undefined = () => {
        decodeAudioDataQueue.clear();
        /*    streamDB.source.chunks.events.removeEventListener("change", listener); */
    };
    return {
        close: async () => {
            cleanup?.();
            await stop();
        },
        /*     setProgress: (progress: number) => {
                cleanup?.();
                setLive();
            },
            setSpeed: (value: number) => { }, */
        push,
        setVolume,
        mute,
        unmute,
        play: async () => {
            play = true;
            setupAudioContext().then(() => {
                audioContext.resume().then(() => renderFrame());
            });
        },
        pause: () => {
            cleanup();
            play = false;
            stop();
        },
    };
};

type DBArgs = { stream: MediaStreamDB };

type StreamControlFunction = Omit<ControlFunctions, "setProgress"> & {
    close: () => void;
    /*   track: Track<any>; */
    push: (data: Chunk) => void;
};

let videoHeight = () => window.innerHeight;
let videoWidth = () => window.innerWidth;

export const View = (properties: DBArgs) => {
    const canvasRef = useRef<HTMLCanvasElement>();
    const lastCanvasRef = useRef<HTMLCanvasElement>();
    const [resolutionOptions, setResolutionOptions] = useState<Resolution[]>(
        []
    );

    const [currentTime, setCurrentTime] = useState(0);
    const [maxTime, setMaxTime] = useState(0);

    const [selectedResolutions, setSelectedResolutions] = useState<
        Resolution[]
    >([]);

    const containerRef = useRef<HTMLDivElement>(null);
    const [streamerOnline, setStreamerOnline] = useState(false);
    const { peer } = usePeer();
    const controls = useRef<(StreamControlFunction & { track: Track<any> })[]>(
        []
    );
    const [isPlaying, setIsPlaying] = useState(true);
    const [isBuffering, setIsBuffering] = useState(true);

    const [cursor, setCursor] = useState<number | "live">(0);

    /* 
        const [styleHeight, setStyleHeight] = useState<'100dvh' | 'fit-content'>("fit-content");
        const [styleWidth, setStyleWidth] = useState<'100dvw' | 'fit-content'>("100dvw");
     */

    const { height: styleHeight, width: styleWidth } =
        getKeepAspectRatioBoundedSize({
            height: videoHeight(),
            width: videoWidth(),
        });

    const streamListener = useRef<TracksIterator | undefined>();
    const updateProgressQueue = useRef<PQueue>(new PQueue({ concurrency: 1 }));
    const [liveStreamAvailable, setLiveStreamAvailable] = useState(false);

    const setProgress = (progress: number | "live") => {
        setCursor(progress);
        setIsBuffering(true);
        updateProgressQueue.current.clear();
        updateProgressQueue.current.add(async () => {
            console.log("CLOSE PREV!", progress, streamListener.current);
            /*     if (progress !== "live") {
                    return;
                } */
            try {
                await streamListener.current?.close();
            } catch (error) {
                console.error("Failed to close stream listener", error);
                throw error;
            }

            console.log(
                "ITERATE WITH PROGRESS",
                progress,
                typeof progress === "number" ? progress * maxTime : progress
            );
            streamListener.current = await properties.stream.iterate(progress, {
                keepTracksOpen: true,
                onUnderflow: () => {
                    console.log("underflow");
                    setIsBuffering(true);
                },
                onProgress: (ev) => {
                    setIsBuffering(false);
                    setCurrentTime(
                        Math.round((ev.track.startTime + ev.chunk.time) / 1e3)
                    );
                    processChunk({ track: ev.track, chunk: ev.chunk });
                },
                onMaxTimeChange: (ev) => {
                    setMaxTime(Math.max(ev.maxTime / 1e3, maxTime));
                },
                onTracksChange: (ev) => {
                    let canLiveStream = false;
                    for (const track of ev) {
                        if (track.endTime == null) {
                            // TODO this is actually not expected behaviour because we should be able to watch a video while uploading?
                            canLiveStream = true;
                        }
                    }
                    setLiveStreamAvailable(canLiveStream);
                    setSelectedResolutions(
                        [
                            ...ev
                                .filter(
                                    (x): x is Track<WebcodecsStreamDB> =>
                                        x.source instanceof WebcodecsStreamDB
                                )
                                .map(
                                    (x) =>
                                        x.source.decoderDescription.codedHeight
                                ),
                        ].sort() as Resolution[]
                    );
                },
                onTrackOptionsChange: (ev) => {
                    setResolutionOptions(
                        [
                            ...ev
                                .filter(
                                    (x): x is Track<WebcodecsStreamDB> =>
                                        x.source instanceof WebcodecsStreamDB
                                )
                                .map(
                                    (x) =>
                                        x.source.decoderDescription.codedHeight
                                ),
                        ].sort() as Resolution[]
                    );
                },
            });
        });
    };

    useEffect(() => {
        if (!peer || !properties.stream || properties.stream.closed) {
            return;
        }
        if (cursor === "live") {
            properties.stream
                .waitFor(properties.stream.owner)
                .then(async () => {
                    setStreamerOnline(true);
                    setProgress(cursor);
                })
                .catch((e) => {
                    console.error("Failed to find streamer");
                    console.error(e);
                });
        } else {
            setProgress(cursor);
        }

        return () => {
            // TODO are we doing everything we need here?
            /*       currentVideoRef.current?.controls.close();
                  currentAudioRef.current?.controls.close(); */
        };
    }, [peer?.identity.publicKey.hashcode(), properties.stream?.address]);

    const processChunk = async (properties: {
        track: Track<any>;
        chunk: Chunk;
    }) => {
        // check if track
        let fn = controls.current.find((x) => x.track === properties.track);
        if (!fn) {
            // create controls
            const controllerResolver: (
                x: Track<WebcodecsStreamDB | AudioStreamDB>,
                isPlaying: boolean
            ) => StreamControlFunction =
                properties.track.source instanceof AudioStreamDB
                    ? addAudioStreamListener
                    : addVideoStreamListener;

            const newController: StreamControlFunction & { track: Track<any> } =
                {
                    track: properties.track,
                    ...controllerResolver(properties.track, isPlaying),
                };

            controls.current.push(newController);
            if (isPlaying) {
                newController.play();
            }
            fn = newController;
            if (properties.track.source instanceof WebcodecsStreamDB) {
                const ratio = Math.ceil(window.devicePixelRatio); // for dense displays, like mobile we need to scale canvas to not make it look blurry
                videoHeight = () =>
                    properties.track.source.decoderDescription.codedHeight *
                    ratio;
                videoWidth = () =>
                    properties.track.source.decoderDescription.codedWidth *
                    ratio;
                setVideoSize();
            }
        }

        fn.push(properties.chunk);
    };

    let setVideoSize = () =>
        renderer.resize({ width: videoWidth(), height: videoHeight() });

    const showVideo = streamerOnline || (cursor !== "live" && controls.current);
    return (
        <Grid container direction="column">
            <Grid item>
                <div
                    data-iframe-height
                    className="container"
                    ref={containerRef}
                >
                    <div className="video-wrapper">
                        <ClickOnceForAudio
                            play={() => {
                                controls.current
                                    .filter(
                                        (x) =>
                                            x.track.source instanceof
                                            AudioStreamDB
                                    )
                                    .map((x) => x.play());
                            }}
                        >
                            <canvas
                                id="stream-playback"
                                style={{
                                    display: "block",
                                    width: styleWidth,
                                    height: styleHeight,
                                    justifyContent: "center",
                                }}
                                /*    style={{ width: "100%", height: "auto" }} */
                                ref={(node) => {
                                    if (
                                        !node ||
                                        (canvasRef.current &&
                                            canvasRef.current.isEqualNode(node))
                                    ) {
                                        return;
                                    }

                                    canvasRef.current =
                                        node as HTMLCanvasElement;

                                    let newCanvas = false;
                                    newCanvas =
                                        canvasRef.current !=
                                        lastCanvasRef.current;
                                    lastCanvasRef.current = canvasRef.current;

                                    if (canvasRef.current! && newCanvas) {
                                        renderer.setup(canvasRef.current!);
                                        /* let resizeTimer: any = undefined;
                                            window.onload = window.onresize = function () {
                                                clearTimeout(resizeTimer);
                                                resizeTimer = setTimeout(() => {
                                                    console.log("set size", videoHeight(), videoWidth());
                                                    setVideoSize();
                                                }, 100);
                                            }; */
                                    }
                                }}
                                width="300px"
                                height="300px"
                            />
                        </ClickOnceForAudio>
                        {showVideo && (
                            <div style={{ marginTop: "-40px", width: "100%" }}>
                                <Controls
                                    liveStreamAvailable={liveStreamAvailable}
                                    isBuffering={isBuffering}
                                    mediaStreams={properties.stream}
                                    selectedResolution={selectedResolutions}
                                    resolutionOptions={resolutionOptions}
                                    viewRef={canvasRef.current}
                                    onQualityChange={(settings) => {
                                        const setting = settings[0];
                                        if (!setting) {
                                            return;
                                        }

                                        console.log(
                                            "SELECT ",
                                            settings,
                                            streamListener.current?.options()
                                        );
                                        const streamToOpen =
                                            streamListener.current
                                                ?.options()
                                                .find(
                                                    (x) =>
                                                        x.source instanceof
                                                            WebcodecsStreamDB &&
                                                        x.source
                                                            .decoderDescription
                                                            .codedHeight ===
                                                            setting.video.height
                                                );

                                        streamListener.current.selectOption(
                                            streamToOpen
                                        );
                                        /*  
                                         let videoRef =
                                             document.getElementById(
                                                 "stream-playback"
                                             );
                                         if (!videoRef) {
                                             return;
                                         }
                                         return updateVideoStream(streamToOpen); */
                                    }}
                                    isPlaying={isPlaying}
                                    pause={() => {
                                        streamListener.current.pause();
                                        setIsPlaying(false);
                                        controls.current.forEach((c) =>
                                            c.pause()
                                        );
                                    }}
                                    play={() => {
                                        streamListener.current.play();
                                        setIsPlaying(true);
                                        controls.current.forEach((c) =>
                                            c.play()
                                        );
                                    }}
                                    maxTime={maxTime}
                                    currentTime={currentTime}
                                    progress={cursor}
                                    setProgress={(p) => {
                                        setProgress(p);
                                        /*  controls.current.forEach((c) => {
                                             c.setProgress(p);
                                         }); */
                                    }}
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
                            </div>
                        )}
                        {!streamerOnline && cursor === "live" && (
                            <Grid
                                container
                                direction="column"
                                className="video-loading"
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
                        {showVideo && isBuffering && (
                            <Grid
                                container
                                direction="column"
                                className="video-buffering"
                                justifyContent="center"
                                spacing={1}
                            >
                                <Spinner />
                            </Grid>
                        )}
                    </div>
                </div>
            </Grid>
        </Grid>
    );
};
