import { usePeer } from "@peerbit/react";
import { useRef, useState, useEffect } from "react";
import {
    Chunk,
    WebcodecsStreamDB,
    MediaStreamDB,
    Track,
    AudioStreamDB,
    TrackSource,
    TracksIterator,
} from "../database.js";
import { Grid } from "@mui/material";
import { PublicSignKey } from "@peerbit/crypto";
import {
    DocumentsChange,
    ResultsIterator,
    SearchRequest,
    SortDirection,
} from "@peerbit/document";
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
import { delay } from "@peerbit/time";
import { hrtime } from "@peerbit/time";

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
    let abortController = new AbortController();
    let pendingFrames: VideoFrame[] = [];
    let underflow = true;
    let currentTime = 0;
    let lastFrame: VideoFrame | undefined = undefined;
    let nextFrameMicro: number = 0;

    /*   let scheduleNextFrameImmediate = () => {
          nextFrameMicro = 0;
      };
  
      let scheduleNextFramePerfectly = () => {
          const nextFrame = pendingFrames[0];
          if (!nextFrame) {
              underflow = true;
  
              return;
          }
  
          underflow = false;
  
          const delta = lastFrame
              ? (nextFrame.timestamp - lastFrame.timestamp) * 1000
              : 0;
  
          if (delta < 0) {
              console.error(
                  "SCHEDULE NEXT DELTA",
                  nextFrame.timestamp / 1e6,
                  delta / 1e6
              );
          } else {
              console.log(
                  "SCHEDULE NEXT DELTA",
                  nextFrame.timestamp / 1e6,
                  delta / 1e6
              );
          }
          lastFrame = nextFrame;
          nextFrameMicro = Number(hrtime.bigint()) / 1e3 + delta;
      };
  
      let scheduleFrameFunction: () => void = scheduleNextFrameImmediate;
  
      let onRenderFrame: (() => void) | undefined = undefined;
  
      let session = 0;
      const renderLoop = (currentSession: number = session) => {
          if (currentSession !== session) {
              return;
          }
  
          if (abortController.signal.aborted) {
              return;
          }
  
          if (nextFrameMicro < Number(hrtime.bigint()) / 1e3) {
              renderFrame();
          }
  
          requestAnimationFrame(() => renderLoop(currentSession));
      };
      const renderFrame = () => {
          if (!play) {
              return;
          }
  
          let frame = pendingFrames.shift();
          if (!frame) {
              underflow = true;
              return;
          }
  
          onRenderFrame?.();
          currentTime = frame.timestamp;
  
          if (document.visibilityState === "hidden") {
              // is the app hidden?
              console.log("HIDDEN");
  
              frame.close();
          } else {
              // this is the step where the rendering  happens
              renderer.draw(frame);
          }
      };
   */
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

    /*  const clearPending = async () => {
         if (pendingFrames.length > 0) {
             pendingFrames.forEach((p) => {
                 p.close();
             });
             pendingFrames = [];
         }
     };
     const handleFrame = (frame: VideoFrame) => {
         //  console.log("RECEIVED FRAME", pendingFrames.length, frame, inBackground, underflow)
         if (inBackground) {
             // don't push frames in background
             frame.close();
             clearPending();
             return;
         }
         pendingFrames.push(frame);
         if (underflow) {
             scheduleFrameFunction();
         }
     };
  */
    const processChunk = (chunk: Chunk) => {
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

    /*   const liveListener = (change: CustomEvent<DocumentsChange<Chunk>>) => {
          for (const added of change.detail.added) {
              processChunk(added);
          }
      };
  
      let lastTs = 0;
      let previousTimestamp = 0;
  
      const iteratorListener = async (
          iterator: ResultsIterator<Chunk>,
          currentSession = session
      ) => {
          console.log("ITERATOR LISTENER", iterator.done());
          while (iterator.done() == false) {
              // we don't want to consume the iterator at once.
              // we want to consume it so we only buffer necessary amounts
              if (Math.max(decoder.decodeQueueSize, pendingFrames.length) < 200) {
                  // buffer for 10 second when 60fps or 20 secods when 30 fps
                  //   console.log("GET NEXT!", decoder.decodeQueueSize)
                  const results = await iterator.next(30);
                  for (const result of results) {
                      if (result.time < lastTs) {
                          lastTs = result.time;
                      }
                  }
                  console.log("RECEIVED BATCH", results[0].time);
                  // console.log("RESULTS", results)
                  if (currentSession != session) {
                      console.log("STOP ITERATOR");
                      break;
                  }
                  for (const result of results) {
                      if (result.time < previousTimestamp) {
                          console.error(
                              "Received wronge timestamp!: " +
                              result.time +
                              " --- " +
                              previousTimestamp
                          );
                      }
  
                      previousTimestamp = result.time;
                      processChunk(result);
                  }
              } else {
                  console.log(
                      "WAIT BEFORE LOW PASS",
                      decoder.decodeQueueSize,
                      pendingFrames.length,
                      underflow,
                      decoder.state
                  );
                  // wait until the queue is getting small enough
  
                  // proxy shift fn and wait for it getting dangerously low
                  try {
                      await new Promise<void>((resolve, reject) => {
                          abortController.signal.addEventListener("abort", () => {
                              decoder.removeEventListener("dequeue", onDequeue);
                              reject();
                          });
                          const onDequeue = () => {
                              //  console.log("ON DEQUEUE", decoder.decodeQueueSize, pendingFrames.length)
                              if (
                                  Math.max(
                                      decoder.decodeQueueSize,
                                      pendingFrames.length
                                  ) < 100
                              ) {
                                  // Time to buffer more
                                  decoder.removeEventListener(
                                      "dequeue",
                                      onDequeue
                                  );
  
                                  console.log("DEQUEUE RESOLVE");
                                  onRenderFrame = undefined;
                                  resolve();
                              }
                          };
                          onRenderFrame = onDequeue;
                          onDequeue();
                          decoder.addEventListener("dequeue", onDequeue);
                      });
                  } catch (error) {
                      return; // aborted
                  }
              }
          }
  
          console.log("DONE");
      }; */

    let cleanup: (() => Promise<void>) | undefined = async () => {
        /*    console.log("CLEANUP ");
           abortController.abort();
           underflow = true;
           await clearPending(); */
        if (decoder.state !== "closed") {
            decoder.close();
        }
        /*  lastFrame = undefined;
         waitForKeyFrame = true;
         console.log("CLEANUP DONE ");
         abortController = new AbortController(); */
    };

    /*  let setLive = () => {
         scheduleFrameFunction = scheduleNextFrameImmediate;
         streamDB.source.chunks.events.removeEventListener("change", liveListener);
         streamDB.source.chunks.events.addEventListener("change", liveListener);
         abortController.signal.addEventListener("abort", () => {
             streamDB.source.chunks.events.removeEventListener("change", liveListener);
         });
     };
 
     let setAtProgress = async (progress: number) => {
         console.log("SET PROGRESS", progress);
 
         console.log("INIT AT PROGRSS", progress);
         scheduleFrameFunction = scheduleNextFramePerfectly;
         iteratorListener(await streamDB.iterate(progress));
         console.log("INIT AT PROGRSS DONE", progress);
     };
  */
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

        decodeAudioDataQueue.add(() => {
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
            setupAudioContext();
            /*   await setLive(); */
            renderFrame();
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
type StreamWithControls<T extends TrackSource> = {
    source: Track<T>;
    controls: StreamControlFunction;
};

let videoHeight = () => window.innerHeight;
let videoWidth = () => window.innerWidth;

export const View = (properties: DBArgs) => {
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
    const controls = useRef<(StreamControlFunction & { track: Track<any> })[]>(
        []
    );
    const [isPlaying, setIsPlaying] = useState(true);

    const [cursor, setCursor] = useState<number | "live">("live");
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

    const setProgress = (progress: number | "live") => {
        updateProgressQueue.current.clear();
        updateProgressQueue.current.add(async () => {
            await streamListener.current?.close();
            streamListener.current = await properties.stream.iterate(progress, {
                onProgress: (ev) => {
                    processChunk({ track: ev.track, chunk: ev.chunk });
                },
                onOptionsChange: (ev) => {
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
        if (!peer) {
            return;
        }
        if (properties.stream) {
            console.log(peer.getMultiaddrs().map((x) => x.toString()));

            let updateStreamTimeout: ReturnType<typeof setTimeout> | undefined =
                undefined;

            /* videoStream.current.streams.events.addEventListener(
                "change",
                async (_e) => {
                    clearTimeout(updateStreamTimeout);
                    updateStreamTimeout = setTimeout(() => {
                        updateStreamChoice();
                    }, 50);
                }
            ); */

            // Wait for streamer to be online, then query active
            if (properties.stream.closed) {
                return;
            }

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
        }

        return () => {
            // TODO are we doing everything we need here?
            videoStreamOptions.current = [];

            /*       currentVideoRef.current?.controls.close();
                  currentAudioRef.current?.controls.close(); */
        };
    }, [peer?.identity.publicKey.hashcode(), properties.stream?.address]);

    /*  const updateStreamChoice = async () => {
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
             console.log("UPDATE FOR VIDEO STREMA", streamToOpen);
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
  */

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

            console.log("PROCESS CHUNK", properties.track);
            const newController: StreamControlFunction & { track: Track<any> } =
                {
                    track: properties.track,
                    ...controllerResolver(properties.track, isPlaying),
                };

            controls.current.push(newController);
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

    /*  const updateVideoStream = async (
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
         streamToOpen.source instanceof AudioStreamDB &&
             console.log("A CLOSE PREV?", loadingRef.current);
         const prev = await loadingRef.current;
 
         if (prev) {
             await prev.controls.close();
             await prev.source?.drop();
         }
         streamToOpen.source instanceof AudioStreamDB &&
             console.log("B CLOSE PREV?", loadingRef.current);
 
         // get stream with closest bitrate
         let currentVideoTime: (() => number) | undefined = undefined;
 
         loadingRef.current = new Promise((resolve, reject) => {
             peer.open(streamToOpen, {
                 args: {
                     role: "observer",
                     sync: () => true,
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
                         s,
                         isPlaying,
                         currentVideoTime
                     ).then((fns) => {
                         controls.current.push(fns);
                         const ret = { source: s, controls: fns };
                         resultRef.current = ret;
                         ret.controls.setProgress("live");
                         resolve(ret);
                     });
                 })
                 .catch(reject);
         });
 
         return loadingRef.current;
     }; */

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
                            <div style={{ marginTop: "-40px", width: "100%" }}>
                                <Controls
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
                                        setIsPlaying(false);
                                        controls.current.forEach((c) =>
                                            c.pause()
                                        );
                                    }}
                                    play={() => {
                                        setIsPlaying(true);
                                        controls.current.forEach((c) =>
                                            c.play()
                                        );
                                    }}
                                    progress={cursor}
                                    setProgress={(p) => {
                                        setCursor(p);
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
