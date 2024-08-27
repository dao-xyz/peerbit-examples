import { usePeer } from "@peerbit/react";
import { useRef, useState, useEffect } from "react";
import {
    Chunk,
    WebcodecsStreamDB,
    MediaStreamDB,
    Track,
    AudioStreamDB,
    TrackSource,
} from "../database.js";
import { Grid } from "@mui/material";
import { PublicSignKey } from "@peerbit/crypto";
import { DocumentsChange } from "@peerbit/document";
import "./View.css";
import CatOffline from "/catbye64.png";
import { Controls } from "./controller/Control.js";
import { ControlFunctions } from "./controller/controls.js";
import { Resolution } from "../controls/settings.js";
import { renderer } from "./video/renderer.js";
import PQueue from "p-queue";
import { equals } from "uint8arrays";
import { getKeepAspectRatioBoundedSize } from "../MaintainAspectRatio.js";
import ClickOnceForAudio from "./ClickOnceForAudio.js";

let inBackground = false;
document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        inBackground = true;
    } else {
        inBackground = false;
    }
});

const addVideoStreamListener = async (
    streamDB: WebcodecsStreamDB,
    play: boolean
) => {
    let pendingFrames: VideoFrame[] = [];
    let underflow = true;
    let currentTime = 0;
    let baseTime: number | undefined = undefined;
    function calculateTimeUntilNextFrame(timestamp: number) {
        if (!baseTime) {
            throw new Error("Basetime not set");
        }

        let mediaTime = performance.now() - baseTime;
        return Math.max(0, timestamp / 1000 - mediaTime);
    }

    let nextFrameTimeout: ReturnType<typeof setTimeout> | undefined = undefined;
    const renderFrame = async () => {
        underflow = pendingFrames.length == 0;
        if (underflow) {
            return;
        }

        if (!play) {
            return;
        }

        let frame = pendingFrames.shift();
        currentTime = frame.timestamp;
        if (!baseTime) {
            baseTime = performance.now() - frame.timestamp / 1000;
        }

        if (document.visibilityState === "hidden") {
            frame.close();
        } else {
            renderer.draw(frame);
        }

        // TODO better
        /*    
            const timeUntilNextFrame = calculateTimeUntilNextFrame(currentTime);  
            clearTimeout(nextFrameTimeout);
        */
        nextFrameTimeout = setTimeout(
            renderFrame,
            0 /* pendingFrames.length > 0 ? 1 : frame.duration */
        ); // TODO this can be a cause of LAG sometimes before/after blur events
    };

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
                handleFrame(frame);
            },
        });
        decoder.configure(streamDB.decoderDescription);
        waitForKeyFrame = true;
    };

    configureDecoder();

    const handleFrame = (frame: VideoFrame) => {
        if (inBackground) {
            // don't push frames in background
            frame.close();
            if (pendingFrames.length > 0) {
                pendingFrames.forEach((p) => {
                    p.close();
                });
                pendingFrames = [];
            }
            return;
        }
        pendingFrames.push(frame);
        if (underflow) {
            renderFrame();
        }
    };

    const listener = (change: CustomEvent<DocumentsChange<Chunk>>) => {
        for (const added of change.detail.added) {
            const chunk = new EncodedVideoChunk({
                timestamp: Number(added.timestamp),
                type: added.type as "key" | "delta",
                data: added.chunk,
            });

            if (decoder) {
                if (decoder.state === "closed") {
                    // For some reason the decoder can close if not recieving more frames (?)
                    configureDecoder();
                }

                if (decoder.state !== "closed") {
                    if (waitForKeyFrame) {
                        if (chunk.type !== "key") {
                            return;
                        }
                        waitForKeyFrame = false;
                    }
                    decoder.decode(chunk);
                }
            }
        }
    };

    let cleanup: (() => void) | undefined = () =>
        streamDB.chunks.events.removeEventListener("change", listener);
    let setLive = () => {
        streamDB.chunks.events.removeEventListener("change", listener);
        streamDB.chunks.events.addEventListener("change", listener);
    };
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
        setLive,
        play: () => {
            play = true;
            setLive();
            renderFrame();
        },
        pause: () => {
            play = false;
            cleanup();
        },
        currentTime: () => currentTime,
    };
};

const updateAudioStreamQueue = new PQueue({ concurrency: 1 });
const updateVIdeotreamQueue = new PQueue({ concurrency: 1 });

const addAudioStreamListener = async (
    streamDB: AudioStreamDB,
    play: boolean,
    currentVideoTime?: () => number
) => {
    let pendingFrames: { buffer: AudioBuffer; timestamp: bigint }[] = [];
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
        console.log("STOP");
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
        audioContext = new AudioContext({ sampleRate: streamDB.sampleRate });
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

    const renderFrame = async (x?: number) => {
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

            // we have been succesfully been able
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

        setTimeout(() => renderFrame(bufferedAudioTime), bufferedAudioTime); // requestAnimationFrame will not run in background. delay here is 1 ms, its fine as if weunderflow we will stop this loop
        //requestAnimationFrame(renderFrame);
    };

    const decodeAudioDataQueue = new PQueue({ concurrency: 1 });
    const listener = (change: CustomEvent<DocumentsChange<Chunk>>) => {
        let resuming = false;
        console.log("CHANGE", change.detail.added.length);

        if (play) {
            for (const added of change.detail.added) {
                // seems like 'decodeAudioData' requires a cloned, 0 offset buffer,
                // additionally, if we reuse the same array we seem to run into issues where decodeAudioData mutates the original array in someway (?)
                if (decodeAudioDataQueue.size > 10) {
                    decodeAudioDataQueue.clear(); // We can't keep up, clear the queue
                }

                decodeAudioDataQueue.add(() => {
                    let zeroOffsetBuffer = new Uint8Array(added.chunk.length);
                    zeroOffsetBuffer.set(added.chunk, 0);
                    audioContext?.decodeAudioData(
                        zeroOffsetBuffer.buffer,
                        (data) => {
                            const frame = {
                                buffer: data,
                                timestamp: added.timestamp,
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
                                            renderFrame(-1);
                                        })
                                        .catch((e) => {});
                                }
                            } else {
                                /*   const wasEmpty = pendingFrames.length; */
                                pendingFrames.push(frame);
                                if (!isUnderflow()) {
                                    renderFrame(bufferedAudioTime);
                                }
                            }
                        },
                        (e) => {
                            console.error("Failed to decode error", e);
                        }
                    );
                });
            }
        }
    };
    let cleanup: (() => void) | undefined = () => {
        decodeAudioDataQueue.clear();
        streamDB.chunks.events.removeEventListener("change", listener);
    };
    let setLive = async () => {
        if (!audioContext) {
            await setupAudioContext();
        }
        streamDB.chunks.events.removeEventListener("change", listener);
        streamDB.chunks.events.addEventListener("change", listener);
    };
    return {
        close: async () => {
            cleanup?.();
            await stop();
        },
        setProgress: (progress: number) => {
            cleanup?.();
        },
        setSpeed: (value: number) => {},
        setLive,
        setVolume,
        mute,
        unmute,
        play: async () => {
            play = true;
            setupAudioContext();
            await setLive();
            renderFrame();
        },
        pause: () => {
            cleanup();
            play = false;
            stop();
        },
    };
};

type DBArgs = { db: MediaStreamDB };
type IdentityArgs = { node: PublicSignKey };
type StreamControlFunction = ControlFunctions & {
    close: () => void;
};
type StreamWithControls<T extends TrackSource> = {
    source: Track<T>;
    controls: StreamControlFunction;
};

let videoHeight = () => window.innerHeight;
let videoWidth = () => window.innerWidth;

export const View = (args: DBArgs | IdentityArgs) => {
    const videoStream = useRef<MediaStreamDB>();
    const canvasRef = useRef<HTMLCanvasElement>();
    const lastCanvasRef = useRef<HTMLCanvasElement>();

    const videoStreamOptions = useRef<Track<WebcodecsStreamDB>[]>([]);
    const [resolutionOptions, setResolutionOptions] = useState<Resolution[]>(
        []
    );
    const [selectedResolutions, setSelectedResolutions] = useState<
        Resolution[]
    >([]);

    const videoLoadingRef =
        useRef<Promise<StreamWithControls<WebcodecsStreamDB>>>();
    const currentVideoRef = useRef<StreamWithControls<WebcodecsStreamDB>>(null);
    const audioLoadingRef =
        useRef<Promise<StreamWithControls<AudioStreamDB>>>();
    const currentAudioRef = useRef<StreamWithControls<AudioStreamDB>>(null);

    const containerRef = useRef<HTMLDivElement>(null);
    const [streamerOnline, setStreamerOnline] = useState(false);
    const { peer } = usePeer();
    const controls = useRef<StreamControlFunction[]>([]);
    const [isPlaying, setIsPlaying] = useState(true);
    /* 
        const [styleHeight, setStyleHeight] = useState<'100dvh' | 'fit-content'>("fit-content");
        const [styleWidth, setStyleWidth] = useState<'100dvw' | 'fit-content'>("100dvw");
     */

    const { height: styleHeight, width: styleWidth } =
        getKeepAspectRatioBoundedSize({
            height: videoHeight(),
            width: videoWidth(),
        });

    useEffect(() => {
        if (!peer) {
            return;
        }
        if ((args as DBArgs).db) {
            // setVideoStream((args as DBArgs).db);
        } else {
            const idArgs = args as IdentityArgs;

            console.log(peer.getMultiaddrs().map((x) => x.toString()));
            if (!peer.identity.publicKey.equals(idArgs.node)) {
                // Open the VideStream database as a viewer
                peer.open(new MediaStreamDB(idArgs.node), {
                    args: {
                        replicate: {
                            factor: 1,
                        },
                    },
                    existing: "reuse",
                    // reset: true, // TODO function without reset
                }).then((vs) => {
                    videoStream.current = vs;

                    let updateStreamTimeout:
                        | ReturnType<typeof setTimeout>
                        | undefined = undefined;

                    videoStream.current.streams.events.addEventListener(
                        "change",
                        async (_e) => {
                            clearTimeout(updateStreamTimeout);
                            updateStreamTimeout = setTimeout(() => {
                                updateStreamChoice();
                            }, 50);
                        }
                    );

                    // Wait for streamer to be online, then query active
                    if (videoStream.current.closed) {
                        return;
                    }

                    videoStream.current
                        .waitFor(videoStream.current.owner)
                        .then(() => {
                            updateStreamChoice();
                            videoStream.current.getLatest({
                                remote: { replicate: true },
                            });
                        })
                        .catch((e) => {
                            console.error("Failed to find streamer");
                            console.error(e);
                        });
                });
            }
        }

        return () => {
            // TODO are we doing everything we need here?
            videoStreamOptions.current = [];

            /*       currentVideoRef.current?.controls.close();
                  currentAudioRef.current?.controls.close(); */
        };
    }, [
        peer?.identity.publicKey.hashcode(),
        (args as DBArgs).db?.id.toString(),
        (args as IdentityArgs).node?.hashcode(),
    ]);

    const updateStreamChoice = async () => {
        const activeStreams = await videoStream.current.getLatest({
            remote: false,
            local: true,
        });

        // remove closed streams
        const removedStreams = [
            currentAudioRef.current?.source,
            ...videoStreamOptions.current,
        ].filter((x) => x && !activeStreams.find((y) => equals(y.id, x.id)));

        await videoLoadingRef.current;
        await audioLoadingRef.current;

        let currentVideoIsRemoved = !!removedStreams.find((x) =>
            equals(x.id, currentVideoRef.current?.source.id)
        );

        let videoResults = activeStreams.filter(
            (x) => x.source instanceof WebcodecsStreamDB
        ) as Track<WebcodecsStreamDB>[];

        let audioResult = activeStreams.filter(
            (x) => x.source instanceof AudioStreamDB
        ) as Track<AudioStreamDB>[];

        const currentOptions = videoStreamOptions.current.filter(
            (x) => !x.closed
        );
        videoStreamOptions.current = videoResults;
        console.log(
            "NEW STREAM?",
            videoResults,
            currentOptions.length,
            videoStreamOptions.current.length,
            currentVideoIsRemoved
        );

        if (
            videoResults.length > 0 &&
            (currentOptions.length === 0 || currentVideoIsRemoved)
        ) {
            let wantedHeight = currentVideoIsRemoved
                ? currentVideoRef.current.source.source.decoderDescription
                      .codedHeight
                : 0;
            videoResults.sort(
                (a, b) =>
                    Math.abs(
                        a.source.decoderDescription.codedHeight - wantedHeight
                    ) -
                    Math.abs(
                        b.source.decoderDescription.codedHeight - wantedHeight
                    )
            );
            let streamToOpen = videoResults[0];

            const ratio = Math.ceil(window.devicePixelRatio); // for dense displays, like mobile we need to scale canvas to not make it look blurry
            videoHeight = () =>
                streamToOpen.source.decoderDescription.codedHeight * ratio;
            videoWidth = () =>
                streamToOpen.source.decoderDescription.codedWidth * ratio;
            setVideoSize();
            await updateVideoStream(streamToOpen);
        }
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
                !!removedStreams.find((x) =>
                    equals(x.id, currentAudioRef.current?.source.id)
                ))
        ) {
            await updateAudioStream(audioResult[0]);
        }

        videoStream.current
            .getReady()
            .then((set) =>
                setStreamerOnline(set.has(videoStream.current.owner.hashcode()))
            );
    };

    const updateVideoStream = async (
        streamToOpen: Track<WebcodecsStreamDB>
    ) => {
        updateVIdeotreamQueue.clear();
        return updateVIdeotreamQueue.add(() =>
            updateMediaStream(videoLoadingRef, currentVideoRef, streamToOpen)
        );
    };

    const updateAudioStream = async (streamToOpen: Track<AudioStreamDB>) => {
        updateAudioStreamQueue.clear();
        return updateAudioStreamQueue.add(() =>
            updateMediaStream(audioLoadingRef, currentAudioRef, streamToOpen)
        );
    };

    const updateMediaStream = async (
        loadingRef: React.MutableRefObject<Promise<StreamWithControls<any>>>,
        resultRef: React.MutableRefObject<StreamWithControls<any>>,
        streamToOpen: Track<any>
    ) => {
        const prev = await loadingRef.current;

        if (prev) {
            await prev.controls.close();
            await prev.source?.drop();
        }

        // get stream with closest bitrate
        let currentVideoTime: (() => number) | undefined = undefined;

        loadingRef.current = new Promise((resolve, reject) => {
            peer.open(streamToOpen, {
                args: {
                    replicate: {
                        factor: 1,
                    },
                },
                existing: "reuse",
            })
                .then(async (s) => {
                    streamToOpen.source instanceof AudioStreamDB &&
                        console.log("ADD AUDIO LISTENER");
                    const controllerResolver =
                        s.source instanceof AudioStreamDB
                            ? addAudioStreamListener
                            : addVideoStreamListener;
                    await controllerResolver(
                        s.source,
                        isPlaying,
                        currentVideoTime
                    ).then((fns) => {
                        controls.current.push(fns);
                        const ret = { source: s, controls: fns };
                        resultRef.current = ret;
                        ret.controls.setLive();
                        resolve(ret);
                    });
                })
                .catch(reject);
        });

        return loadingRef.current;
    };

    let setVideoSize = () =>
        renderer.resize({ width: videoWidth(), height: videoHeight() });

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
                            play={() => console.log("PLAY AUDIO")}
                        >
                            <canvas
                                id="stream-playback"
                                style={{
                                    width: styleWidth,
                                    height: styleHeight,
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
                                    console.log(
                                        "NOT EQUAL",
                                        canvasRef.current,
                                        node
                                    );
                                    canvasRef.current =
                                        node as HTMLCanvasElement;
                                    if (currentAudioRef.current) {
                                        currentAudioRef.current.source?.close();
                                    }
                                    if (currentVideoRef.current) {
                                        currentVideoRef.current.source?.close();
                                    }

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
                        {streamerOnline && !!controls.current && (
                            <Controls
                                progress={0.3}
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
                                pause={() => {
                                    setIsPlaying(false);
                                    controls.current.forEach((c) => c.pause());
                                }}
                                play={() => {
                                    setIsPlaying(true);
                                    controls.current.forEach((c) => c.play());
                                }}
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
