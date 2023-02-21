import { usePeer } from "@dao-xyz/peerbit-react";
import { useRef, useState, useEffect, useCallback } from "react";
import { Chunk, VideoStream } from "./database.js";
import { ObserverType, ReplicatorType } from "@dao-xyz/peerbit-program";
import PQueue from "p-queue";
import { waitFor } from "@dao-xyz/peerbit-time";
import { Button, Grid } from "@mui/material";
import { audioMimeType } from "./format.js";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { Documents } from "@dao-xyz/peerbit-document";
import { createFirstCluster } from "./webm.js";

const resetSB = async (
    pb: HTMLAudioElement | HTMLVideoElement,
    mimeType: string
) => {
    let sb: SourceBuffer | undefined = undefined;
    if (!pb) {
        throw new Error("Missing pb");
    }

    //clearInterval(syncInterval);
    const mediaSource = new MediaSource();
    pb.src = URL.createObjectURL(mediaSource);
    let ready = false;
    mediaSource.addEventListener("sourceopen", () => {
        sb = mediaSource.addSourceBuffer(mimeType); ////'');
        sb.onerror = (error) => {
            console.error("sb error", error);
            //
        };
        sb.mode = "sequence";
        /* 
                const vend = () =>
                    pb.buffered.length > 0
                        ? pb.buffered.end(pb.buffered.length - 1)
                        : 0; */
        ready = true;
        sb.onupdateend = (ev) => {};
    });

    let ret = await waitFor(() => sb);
    await waitFor(() => ready);
    return ret;
};
const addStreamListener = async (
    chunkDB: Documents<Chunk>,
    pb: HTMLVideoElement | HTMLAudioElement
) => {
    let appendQueue = new PQueue({ concurrency: 1 });

    // make sure video plays in background
    let focused = true;
    pb.onpause = (ev) => {
        //  if (!focused) TODO
        {
            pb.play();
        }
    };
    pb.onblur = () => {
        focused = false;
    };
    pb.onfocus = () => {
        focused = true;
    };

    pb.onerror = (err) => {
        console.log(err);
    };

    let firstChunk = new Uint8Array(0);
    let first = true;
    let lastMimeType = undefined;
    let s1 = +new Date();
    let sb: SourceBuffer | undefined = undefined;
    const listener = async (evt) => {
        const chunks: Chunk[] = evt.detail.added;
        const fn = async () => {
            for (const chunk of chunks) {
                if (chunk.type !== lastMimeType) {
                    lastMimeType = chunk.type;
                    first = true;
                    firstChunk = new Uint8Array(0);
                    sb = await resetSB(pb, lastMimeType);
                }

                s1 = +new Date();
                await waitFor(() => sb && sb.updating === false, {
                    delayInterval: 2,
                    timeout: 30000,
                });
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
                        //  decoder.decode(f);
                        first = false;

                        sb?.appendBuffer(f);
                    } else {
                        console.log("waiting for first!");
                        firstChunk = firstCluster.remainder;
                    }
                } else {
                    try {
                        sb.appendBuffer(
                            first
                                ? new Uint8Array([
                                      ...chunk.header,
                                      ...chunk.chunk,
                                  ])
                                : chunk.chunk
                        );
                    } catch (error) {
                        appendQueue.clear();
                        first = true;
                        firstChunk = new Uint8Array(0);
                        await appendQueue.add(() => resetSB(pb, lastMimeType));
                    }
                }
            }
        };
        appendQueue.add(fn);
    };

    chunkDB.events.addEventListener("change", listener);
    return () => {
        chunkDB.events.removeEventListener("change", listener);
    };
};

type DBArgs = { db: VideoStream };
type IdentityArgs = { node: PublicSignKey };
export const View = (args: DBArgs | IdentityArgs) => {
    const [videoStream, setVideoStream] = useState<VideoStream | null>();
    /* const [isStreamerFromAnotherTab, setIsStreamerFromAnotherTab] =
        useState<boolean>(); */
    const cleanupRef = useRef<() => void>();
    const videoStreamRef = useRef<HTMLVideoElement>();

    const { peer } = usePeer();

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
                    peer.open(new VideoStream(idArgs.node), {
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

    const playbackRefCb = useCallback(
        (node) => {
            if (cleanupRef.current) {
                cleanupRef.current();
            }
            const playbackRef: HTMLAudioElement | HTMLVideoElement = node;
            if (node instanceof HTMLVideoElement)
                videoStreamRef.current = playbackRef as HTMLVideoElement;
            if (peer && playbackRef && videoStream) {
                playbackRef.onerror = (error) => {
                    console.error("pb error", error);
                };
                addStreamListener(videoStream.chunks, playbackRef).then(
                    (cleanup) => (cleanupRef.current = cleanup)
                );
            }
        },
        [peer, videoStream]
    );

    return (
        <Grid container direction="column">
            <Grid item>
                <video
                    ref={playbackRefCb}
                    width="100%"
                    height="100%"
                    muted
                    controls
                    autoPlay
                    loop
                />
            </Grid>
            <Grid item>
                <Button
                    onClick={() =>
                        (videoStreamRef.current.currentTime =
                            videoStreamRef.current.buffered.length > 0
                                ? videoStreamRef.current.buffered.end(
                                      videoStreamRef.current.buffered.length - 1
                                  )
                                : 0)
                    }
                >
                    Sync
                </Button>
            </Grid>
        </Grid>
    );
};
