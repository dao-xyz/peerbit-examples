import { usePeer } from "@dao-xyz/peerbit-react";
import { useRef, useState, useEffect, useCallback } from "react";
import { Chunk, VideoStream } from "./database.js";
import { ObserverType, ReplicatorType } from "@dao-xyz/peerbit-program";
import PQueue from "p-queue";
import { waitFor } from "@dao-xyz/peerbit-time";
import { Button, Grid } from "@mui/material";
import { audioMimeType, videoMimeType } from "./format.js";
import {
    PublicSignKey
} from "@dao-xyz/peerbit-crypto";
import { Documents } from "@dao-xyz/peerbit-document";

const resetSB = async (pb: HTMLAudioElement | HTMLVideoElement, lastId: () => string) => {
    let sb: SourceBuffer | undefined = undefined
    if (!pb) {
        throw new Error("Missing pb")
    }

    //clearInterval(syncInterval);
    const mediaSource = new MediaSource();
    pb.src = URL.createObjectURL(mediaSource);
    let syncInterval = undefined;

    mediaSource.addEventListener("sourceopen", () => {
        sb = mediaSource.addSourceBuffer(pb instanceof HTMLAudioElement ? audioMimeType : videoMimeType); ////'');
        sb.onerror = (error) => {
            console.error("sb error", error);
            //
        };
        sb.mode = "sequence";
        // sync?
        // let lastLastTs = lastTs;
        const vend = () =>
            pb.buffered.length > 0
                ? pb.buffered.end(pb.buffered.length - 1)
                : 0;
        let ready = true
        // let s1 = +new Date;
        sb.onupdateend = (ev) => {
            /* console.log(+new Date - s1);
            s1 = +new Date; */

            /* if (lastId) {
                   globalThis.VSTATS.set(lastId(), { ...globalThis.VSTATS.get(lastId()), d: +new Date }) 
                 const stats = globalThis.VSTATS.get(lastId());
                 console.log(stats.b - stats.a, stats.c - stats.b, stats.d - stats.c)
             }*/
            if (vend() - pb.currentTime < 0.05) {
                pb.playbackRate = 1;
                //    console.log("SETUP TO 1", appendQueue.size)
            }
            else {
                //   console.log("FASTER", appendQueue.size)

                //pb.playbackRate = 1 + Math.max((vend() - pb.currentTime - 0.1), 0) / 10;
            }
            /*    console.log(
                   vend() - pb.currentTime,
                   pb.currentTime,
                   pb.playbackRate
               ); */
            //  console.log(appendQueue.size, 1 + Math.max((vend() - pb.currentTime - 0.015), 0))

            //if (lastLastTs !== lastTs) 
            {
                //if (!first && pb && !pb.paused)
                {

                    // UNCOMMENT FOR AUTO SYNC
                    //  pb.currentTime = vend - 0.03;

                    // create a sync interval at ends when delta is low
                    if (!pb.paused && ready && vend() - pb.currentTime > 0.1) {
                        // console.log(vend() - pb.currentTime)
                        /*   console.log("SYNC!", vend() - pb.currentTime)
                          pb.currentTime = vend()
                          setTimeout(() => { ready = true }, 500) */
                        //  pb.playbackRate = 4;
                        //pb.play()
                        /*  console.log(
                             "SYNCING",
                             vend() - pb.currentTime,
                             pb.currentTime,
                             pb.playbackRate
                         ); */
                        //  pb.currentTime = Number.MAX_SAFE_INTEGER;
                        //    pb.play()
                        /*  clearInterval(syncInterval);
                         syncInterval = setInterval(() => {
                             //pb.playbackRate = 1.05// + Math.max((vend() - pb.currentTime - 0.015), 0);
                             pb.currentTime = vend
                             if (vend() - pb.currentTime < 0.1) {
                                 console.log(
                                     "SYNCED!",
                                     vend() - pb.currentTime
                                 );
                                 // pb.playbackRate = 1;
                                 clearInterval(syncInterval);
                                 syncInterval = undefined;
                             }
                         }, 10); */
                        if (vend() - pb.currentTime > 0.15) {
                            //pb.currentTime = vend - 0.03//
                            console.log("FAST SPEED", vend() - pb.currentTime, pb.currentTime);
                            pb.playbackRate = 1.5;

                            clearInterval(syncInterval);
                            syncInterval = setInterval(() => {
                                if (vend() - pb.currentTime < 0.05) {
                                    console.log("NORMAL SPEED", vend() - pb.currentTime);
                                    pb.playbackRate = 1;
                                    clearInterval(syncInterval);
                                    syncInterval = undefined;
                                }
                            }, 1000 / 60);
                        } else {
                        }
                        // console.log('sync')
                        ready = false

                        // pb.currentTime = vend() - 0.06;
                        //   pb.playbackRate = 1.5;
                        //    let appendStart = vs.audio.index.size;
                        // console.log("giga sync")
                        // pb.currentTime = vend()

                        /*      const interval = setInterval(() => {
     
                                 if (vend() - pb.currentTime < 0.06) {
                                     clearInterval(interval)
                                     pb.playbackRate = 1;
     
                                 }
                             }, 5) */
                        //    setTimeout(() => { pb.playbackRate = 1; }, 100)
                        //   pb.currentTime = vend() - 0.02
                        /*   pb.playbackRate = 4;*/
                        //    setTimeout(() => { pb.playbackRate = 1; ready = true }, 1000)
                        /* pb.play()  */
                    }/*  else */ {
                        // pb.playbackRate = 1;
                    }
                }
                //     lastLastTs = lastTs;
            }
        };
    });

    return waitFor(() => sb);
};
const addStreamListener = async (
    vs: Documents<Chunk>,
    pb: HTMLVideoElement | HTMLAudioElement
) => {
    let appendQueue = new PQueue({ concurrency: 1 });

    // make sure video plays in background
    let focused = true;
    pb.onpause = (ev) => {
        //  if (!focused) 
        {
            pb.play()
        }
    }
    pb.onblur = () => {
        focused = false;
    };
    pb.onfocus = () => {
        focused = true
    }

    pb.onerror = (err) => {
        console.log(err);
    }
    /* 
    window.onfocus = function () { pb.play(); };
    window.onblur = function () { pb.play(); }; */

    let firstChunk = new Uint8Array(0);
    let first = true;
    //let decoder = new Decoder();
    let lastTs = 0;
    let sb1: SourceBuffer | undefined = undefined;
    let sb2: SourceBuffer | undefined = undefined;

    let lastId = "";
    const sb = await resetSB(pb, () => lastId);
    let evtCounter = 0;
    // const startSize = vs.chunks.index.size;
    let rt = +new Date;
    let s1 = +new Date;
    let counter = 0;

    const listener = async (evt) => {
        //   const t1 = +new Date;

        /*  evtCounter += 1;
 
         if (evtCounter < startSize) {
             console.log("SKIP!", evtCounter)
             return; // skip some updates
         } */

        const chunks: Chunk[] = evt.detail.added;
        /*  if (globalThis.X) {
             console.log(globalThis.X - chunks[0].ts, chunks[0].chunk.length)
         } */
        const fn = async () => {

            for (const chunk of chunks) {


                console.log(+new Date - s1);
                s1 = +new Date;

                /*  globalThis.VSTATS.set(chunk.id, { ...globalThis.VSTATS.get(chunk.id), b: +new Date }) */
                //  console.log(                        globalThis.X -                    chunk.ts)
                ///   console.log("A", BigInt(+new Date) - chunk.ts)
              /*   await waitFor(() => sb && sb.updating === false, {
                    delayInterval: 2,
                    timeout: 30000,
                }); */

                //  sb.appendWindowStart = Math.max(pb.currentTime, 0)

                //   console.log("B", BigInt(+new Date) - chunk.ts)

                /* if (first) {
                    const firstCluster = createFirstCluster(
                        chunk.chunk,
                        firstChunk
                    );
                    if (firstCluster.type === "cluster") {
                        const f = new Uint8Array([
                            ...chunk.header,
                            ...firstCluster.cluster,
                        ]);
                        //  decoder.decode(f);
                        first = false;

                        sb?.appendBuffer(f);
                    } else {
                        console.log('waiting for first!')
                        firstChunk = firstCluster.remainder;
                    }
                } else */ {
                    /*   const firstClusterIndices = getClusterStartIndices(chunk.chunk);
                      if (firstClusterIndices.length > 0) {
                          //
                          first = true;
                          firstChunk = new Uint8Array(0)
                          //  chunks = [chunk.sub]
                          //  appendQueue.add(() => resetSB(pb));
                          //await resetSB(pb);
                          await fn();
  
                      } */
                    /* const diff = decoder.decode(chunk.chunk);
                    for (const d of diff) {
                        if (d.name === "Timestamp" && d.type === "u") {
                            let nrt = +new Date;
                            console.log(d.value / 1000 - lastTs, nrt - rt)
                            rt = nrt;
                            lastTs = d.value / 1000;
                        }
    
                    } */
                    /*  globalThis.VSTATS.set(chunk.id, { ...globalThis.VSTATS.get(chunk.id), c: +new Date }) */

                    /*   try {
                          lastId = chunk.id;
                          sb.appendBuffer(
                              first
                                  ? new Uint8Array([
                                      ...chunk.header,
                                      ...chunk.chunk,
                                  ])
                                  : chunk.chunk
                          );
  
                      } catch (error) {
                          appendQueue.clear()
                          first = true;
                          firstChunk = new Uint8Array(0);
                          await appendQueue.add(() => resetSB(pb, () => lastId));
                      } */
                }
            }
        }
        appendQueue.add(fn);
    }

    vs.events.addEventListener("change", listener);
    return () => {
        vs.events.removeEventListener("change", listener);
    }

};
type DBArgs = { db: VideoStream };
type IdentityArgs = { identity: PublicSignKey, node: PublicSignKey }
export const View = (args: DBArgs | IdentityArgs) => {
    const [videoStream, setVideoStream] = useState<VideoStream | null>();
    const [isStreamerFromAnotherTab, setIsStreamerFromAnotherTab] = useState<boolean>();
    const cleanupRef = useRef<() => void>();
    const videoStreamRef = useRef<HTMLVideoElement>();

    const { peer } = usePeer();

    useEffect(() => {
        if (!peer?.libp2p) {
            return;
        }
        try {
            if ((args as DBArgs).db) {
                setVideoStream(((args as DBArgs)).db);
            } else {
                const idArgs = args as IdentityArgs;

                if (!peer.idKey.publicKey.equals(idArgs.node)) {

                    // Open the VideStream database as a viewer
                    peer.open(new VideoStream(idArgs.identity), {
                        role: new ObserverType(),
                        sync: () => true,
                    }).then((vs) => {
                        setVideoStream(vs);
                    });
                }
                setIsStreamerFromAnotherTab(peer.identity.publicKey.equals(idArgs.identity));
            }
        } catch (error) {
            console.error("Failed to create stream", error);
        }
    }, [peer?.id, (args as DBArgs).db?.id.toString(), (args as IdentityArgs).identity?.hashcode(), (args as IdentityArgs).node?.hashcode()]);

    const playbackRefCb = useCallback(
        (node) => {
            if (cleanupRef.current) {
                cleanupRef.current()
            }
            const playbackRef: HTMLAudioElement | HTMLVideoElement = node;
            if (node instanceof HTMLVideoElement)
                videoStreamRef.current = playbackRef as HTMLVideoElement;
            if (peer && playbackRef && videoStream) {
                /*  function toggleMute() {
                     playbackRef.play()
 
                     if (playbackRef.muted) {
                         console.log('unmute!')
                         playbackRef.muted = false;
                     }
                 }
 
                 setTimeout(toggleMute, 1000); */

                playbackRef.onerror = (error) => {
                    console.error("pb error", error);
                };
                addStreamListener(videoStream.chunks, playbackRef).then((cleanup) => cleanupRef.current = cleanup);
                // setClose(cleanup)
            }


        },
        [peer, videoStream]
    );

    /*     const playbackRefCb2 = useCallback(
            (node) => {
                if (cleanupRef.current) {
                    cleanupRef.current()
                }
                const playbackRef: HTMLVideoElement = node;
                if (peer && playbackRef && videoStream) {
                    playbackRef.onerror = (error) => {
                        console.error("pb error", error);
                    };
                    cleanupRef.current = addStreamListener(videoStream.video, playbackRef);
                }
    
    
            },
            [peer, videoStream]
        ); */


    return (
        <Grid container direction="column">
            <Grid item>
                {/*   <audio
                    ref={playbackRefCb}
                    controls
                    autoPlay
                    preload="auto"
                    muted

                /> */}
                {
                    <video
                        ref={playbackRefCb}
                        width="300"
                        muted
                        controls
                        autoPlay
                        loop
                    />}

            </Grid>
            <Grid item>
                <Button
                    onClick={() =>
                        videoStreamRef.current.currentTime = videoStreamRef.current.buffered.length > 0
                            ? videoStreamRef.current.buffered.end(videoStreamRef.current.buffered.length - 1)
                            : 0
                    }
                >
                    Go live
                </Button>
            </Grid>
        </Grid >
    );
};
