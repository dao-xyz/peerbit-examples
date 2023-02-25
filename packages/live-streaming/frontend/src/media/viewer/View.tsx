import { usePeer } from "@dao-xyz/peerbit-react";
import { useRef, useState, useEffect, useCallback } from "react";
import { Chunk, MediaStreamDB, MediaStreamDBs } from "../database.js";
import { ObserverType, ReplicatorType } from "@dao-xyz/peerbit-program";
import PQueue from "p-queue";
import { waitFor } from "@dao-xyz/peerbit-time";
import { Button, Grid } from "@mui/material";
import { audioMimeType } from "../format.js";
import { PublicSignKey } from "@dao-xyz/peerbit-crypto";
import { DocumentQueryRequest, Documents } from "@dao-xyz/peerbit-document";
import { createFirstCluster } from "../webm.js";
import { delay } from "@dao-xyz/peerbit-time";
import { Controls } from "../controller/Control.js";
import { Resolution } from "../controller/SourceSettings.js";
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
        sb.onupdateend = (ev) => { };
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

type DBArgs = { db: MediaStreamDBs };
type IdentityArgs = { node: PublicSignKey };
export const View = (args: DBArgs | IdentityArgs) => {
    const [videoStream, setVideoStream] = useState<MediaStreamDBs | null>();

    const cleanupRef = useRef<() => void>();
    const videoStreamRef = useRef<HTMLVideoElement>();
    const streamOptions = useRef<MediaStreamDB[]>([]);
    const [resolutionOptions, setResolutionOptions] = useState<Resolution[]>(
        []
    );
    const currentStreamRef = useRef<Promise<MediaStreamDB>>(null);

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

    const updateStream = async (streamToOpen: MediaStreamDB, playbackRef: HTMLVideoElement) => {
        const current = (await currentStreamRef.current)
        if (current) {
            cleanupRef.current()
            await current.close()
        }

        // get stream with closest bitrate
        currentStreamRef.current = peer
            .open(streamToOpen, {
                role: new ObserverType(),
                sync: () => true,
            })
            .then((s) => {
                console.log("add listener!");
                addStreamListener(s.chunks, playbackRef).then(
                    (cleanup) => (cleanupRef.current = cleanup)
                );
                return s;
            });
    }

    const playbackRefCb = useCallback(
        (node) => {
            if (cleanupRef.current) {
                cleanupRef.current();
            }
            const playbackRef: HTMLVideoElement = node;
            if (node instanceof HTMLVideoElement) {
                videoStreamRef.current = playbackRef as HTMLVideoElement;
            }

            if (peer && playbackRef && videoStream) {
                playbackRef.onerror = (error) => {
                    console.error("pb error", error);
                };
                setInterval(async () => {
                    const results = await videoStream.streams.index.query(
                        new DocumentQueryRequest({ queries: [] })
                    );
                    const uniqueResults = results
                        .map((x) => x.results)
                        .flat()
                        .map((x) => x.value)
                        .filter(
                            (v, ix, arr) =>
                                v.active && arr.findIndex((x) => x.id === v.id) === ix
                        ).map(x => x.db);
                    const newStreams = uniqueResults.filter(
                        (x) => !streamOptions.current.find((y) => y.id === x.id)
                    );

                    const removedStreams = streamOptions.current.filter(
                        (x) => !uniqueResults.find((y) => y.id === x.id)
                    );

                    const current = (await currentStreamRef.current)
                    let currentIsRemoved = !!removedStreams.find(x => x.id == current?.id);

                    console.log(
                        newStreams,
                        uniqueResults.length,
                        streamOptions.current.length,
                        currentIsRemoved
                    );
                    if (
                        uniqueResults.length > 0 &&
                        (streamOptions.current.length === 0 || currentIsRemoved)
                    ) {
                        let wantedBitrate = currentIsRemoved ? current.info.video.bitrate : 1e5;
                        uniqueResults.sort((a, b) => Math.abs(a.info.video.bitrate - wantedBitrate) - Math.abs(b.info.video.bitrate - wantedBitrate));
                        let streamToOpen = uniqueResults[0];

                        await updateStream(streamToOpen, playbackRef)

                    }
                    streamOptions.current = uniqueResults;
                    console.log("RESOLUTIONS", [...uniqueResults.map(
                        (x) => x.info.video.height
                    )].sort())
                    setResolutionOptions(
                        [...uniqueResults.map(
                            (x) => x.info.video.height
                        )].sort() as Resolution[]
                    );
                }, 1000);
                /*  videoStream.streams.events.addEventListener('change', (c) => {
                     console.log('change!', c)
                 }) */
                /* 
                /*
                addStreamListener(videoStream.chunks, playbackRef).then(
                    (cleanup) => (cleanupRef.current = cleanup)
                ); */
            }
        },
        [peer, videoStream]
    );

    return (
        <Grid container direction="column">
            <Grid item>
                <div className="container">
                    <div className="video-wrapper">
                        <video
                            id="stream-playback"
                            ref={playbackRefCb}
                            width="100%"
                            height="100%"
                            muted
                            autoPlay
                            loop
                        />
                        <Controls
                            isStreamer={false}
                            resolutionOptions={resolutionOptions}
                            videoRef={videoStreamRef}
                            onQualityChange={(settings) => {
                                const streamToOpen = streamOptions.current.find(x => x.info.video.height === settings[0].video.height);
                                return updateStream(streamToOpen, document.getElementById("stream-playback") as HTMLVideoElement)
                            }}
                        ></Controls>
                    </div>
                </div>
            </Grid>
        </Grid>
    );
};
