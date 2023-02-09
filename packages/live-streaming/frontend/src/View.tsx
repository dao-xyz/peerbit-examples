import { usePeer } from "@dao-xyz/peerbit-react";
import { useRef, useState, useEffect, useCallback } from "react";
import { VideoStream } from "./database.js";
import { useParams } from "react-router-dom";
import { getKeyFromStreamKey } from "./routes";
import { createFirstCluster, getClusterStartIndices } from "./webm.js";
import { Decoder } from "ts-ebml";
import { ObserverType, ReplicatorType } from "@dao-xyz/peerbit-program";
import PQueue from "p-queue";
import { waitFor } from "@dao-xyz/peerbit-time";
import { Button, Grid } from "@mui/material";
import { mimeType } from "./format.js";
interface HTMLVideoElementWithCaptureStream extends HTMLVideoElement {
    captureStream?(fps?: number): MediaStream;
    mozCaptureStream?(fps?: number): MediaStream;
}

const addStreamListener = (
    vs: VideoStream,
    pb: HTMLVideoElementWithCaptureStream
) => {
    let appendQueue = new PQueue({ concurrency: 1 });
    let firstChunk = new Uint8Array(0);
    let first = true;
    let decoder = new Decoder();
    let lastTs = 0;
    let sb: SourceBuffer | undefined = undefined;
    let syncInterval: any = undefined;
    const resetSB = () => {
        if (!pb) {
            return;
        }
        clearInterval(syncInterval);
        const mediaSource = new MediaSource();
        pb.src = URL.createObjectURL(mediaSource);
        mediaSource.addEventListener("sourceopen", () => {
            sb = mediaSource.addSourceBuffer(mimeType); ////'');
            sb.onerror = (error) => {
                console.error("sb error", error);
                //
            };
            sb.mode = "sequence";

            // sync?
            let lastLastTs = lastTs;
            const vend = () =>
                pb.buffered.length > 0
                    ? pb.buffered.end(pb.buffered.length - 1)
                    : 0;

            sb.onupdateend = (ev) => {
                if (lastLastTs !== lastTs) {
                    if (!first && pb) {
                        // UNCOMMENT FOR AUTO SYNC
                        /* console.log("sync!", vend, vend - pb.currentTime);  */
                        //  pb.currentTime = vend - 0.03;
                        /*          pb.play(); */

                        // create a sync interval at ends when delta is low
                        if (vend() - pb.currentTime > 0.2) {
                            //pb.currentTime = vend - 0.03//
                            console.log(
                                "FAST SPEED",
                                vend() - pb.currentTime,
                                pb.currentTime
                            );
                            pb.playbackRate = 1.5;

                            clearInterval(syncInterval);
                            syncInterval = setInterval(() => {
                                if (vend() - pb.currentTime < 0.05) {
                                    console.log(
                                        "NORMAL SPEED",
                                        vend() - pb.currentTime
                                    );
                                    pb.playbackRate = 1;
                                    clearInterval(syncInterval);
                                    syncInterval = undefined;
                                }
                            }, 1000 / 60);
                        } else {
                        }
                    }
                    lastLastTs = lastTs;
                }
            };
        });
    };
    resetSB();
    setTimeout(() => {
        console.log("len!", vs.chunks.index.size);
        let evtCounter = 0;
        vs.chunks.events.addEventListener("change", (evt) => {
            //   const t1 = +new Date;

            evtCounter += 1;
            const chunks = evt.detail.added;
            appendQueue.add(async () => {
                for (const chunk of chunks) {
                    ///   console.log("A", BigInt(+new Date) - chunk.ts)
                    await waitFor(() => sb && sb.updating === false, {
                        delayInterval: 10,
                        timeout: 30000,
                    });

                    //   console.log("B", BigInt(+new Date) - chunk.ts)

                    if (first) {
                        const firstCluster = createFirstCluster(
                            chunk.chunk,
                            firstChunk
                        );
                        if (firstCluster.type === "cluster") {
                            const f = new Uint8Array([
                                ...chunk.header,
                                ...firstCluster.cluster,
                            ]);
                            decoder.decode(f);
                            first = false;
                            sb?.appendBuffer(f);
                        } else {
                            firstChunk = firstCluster.remainder;
                        }
                    } else {
                        const diff = decoder.decode(chunk.chunk);
                        for (const d of diff) {
                            if (d.name === "Timestamp" && d.type === "u") {
                                lastTs = d.value / 1000;
                            }
                        }
                        try {
                            sb?.appendBuffer(
                                first
                                    ? new Uint8Array([
                                          ...chunk.header,
                                          ...chunk.chunk,
                                      ])
                                    : chunk.chunk
                            );
                            const t2 = +new Date();
                        } catch (error) {
                            resetSB();
                            first = true;
                        }
                    }
                }
            });
        });
    }, 1000);
};

export const View = (opts?: { db?: VideoStream }) => {
    const [videoStream, setVideoStream] = useState<VideoStream | null>();
    const videoStreamRef = useRef<HTMLVideoElementWithCaptureStream>();

    const { peer } = usePeer();
    const params = useParams();

    useEffect(() => {
        if (!peer?.libp2p || !params.key) {
            return;
        }
        try {
            if (opts?.db) {
                setVideoStream(opts.db);
            } else {
                const streamKey = getKeyFromStreamKey(params.key);
                if (!peer.identity.publicKey.equals(streamKey)) {
                    // Open the VideStream database as a viewer
                    peer.open(new VideoStream(streamKey), {
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
    }, [peer?.id, params?.key]);

    const playbackRefCb = useCallback(
        (node) => {
            const playbackRef: HTMLVideoElementWithCaptureStream = node;
            videoStreamRef.current = playbackRef;
            if (peer && playbackRef && videoStream) {
                playbackRef.onerror = (error) => {
                    console.error("pb error", error);
                };
                addStreamListener(videoStream, playbackRef);
            }
        },
        [peer, videoStream]
    );

    return (
        <Grid container direction="column">
            <Grid item>
                <video
                    ref={playbackRefCb}
                    width="300"
                    muted
                    controls
                    autoPlay
                />
            </Grid>
            <Grid item>
                <Button
                    onClick={() =>
                        (videoStreamRef.current.currentTime =
                            Number.MAX_SAFE_INTEGER)
                    }
                >
                    Go live
                </Button>
            </Grid>
        </Grid>
    );
};
