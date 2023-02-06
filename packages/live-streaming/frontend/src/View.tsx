import { usePeer } from "@dao-xyz/peerbit-react";
import { useRef, useState, useEffect, useCallback } from "react";
import { VideoStream } from "./database.js";
import { useParams } from "react-router-dom";
import { getKeyFromStreamKey } from "./routes";
import { createFirstCluster, getClusterStartIndices } from "./webm.js";
import { Decoder } from "ts-ebml";
import { ObserverType } from "@dao-xyz/peerbit-program";
import PQueue from "p-queue";
import { waitFor } from "@dao-xyz/peerbit-time";
import { Grid, IconButton } from "@mui/material";
import LiveTvIcon from "@mui/icons-material/LiveTv";
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
    const resetSB = () => {
        if (!pb) {
            return;
        }

        const mediaSource = new MediaSource();
        pb.src = URL.createObjectURL(mediaSource);
        mediaSource.addEventListener("sourceopen", () => {
            console.log("reset sb!");
            sb = mediaSource.addSourceBuffer(mimeType); ////'');
            sb.onerror = (error) => {
                console.error("sb error", error);
                //
            };
            sb.mode = "sequence";

            // sync?
            let lastLastTs = lastTs;
            sb.onupdateend = (ev) => {
                if (lastLastTs !== lastTs) {
                    const vend =
                        pb.buffered.length > 0
                            ? pb.buffered.end(pb.buffered.length - 1)
                            : 0;

                    if (!first && pb && vend - pb.currentTime > 0.2) {
                        // UNCOMMENT FOR AUTO SYNC
                        /* console.log("sync!", vend, vend - pb.currentTime);  */
                        /*          pb.currentTime = Number.MAX_SAFE_INTEGER;
                                 pb.play(); */
                    }
                    lastLastTs = lastTs;
                }
            };
        });
    };

    resetSB();

    console.log("ADD EVENT LISTENER!");

    setTimeout(() => {
        vs.chunks.events.addEventListener("change", (evt) => {
            const chunks = evt.detail.added;
            appendQueue.add(async () => {
                for (const chunk of chunks) {
                    await waitFor(() => sb && sb.updating === false, {
                        delayInterval: 10,
                        timeout: 30000,
                    });

                    const startIndices = getClusterStartIndices(chunk.chunk);
                    if (startIndices.length > 0) {
                        console.error("GOT STARTED INDICES?");
                    }
                    if (first) {
                        // append header and only chunk if it contains the entry of a cluster
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
                        } catch (error) {
                            //   playbackRef.pause();
                            resetSB();
                            first = true;
                        }
                    }
                }
            });
        });
    }, 5000);
};

let mimeType = "video/webm;codecs=vp8";
export const View = () => {
    const [videoStream, setVideoStream] = useState<VideoStream | null>();
    const videoStreamRef = useRef<HTMLVideoElementWithCaptureStream>();

    const { peer } = usePeer();
    const params = useParams();

    useEffect(() => {
        if (!peer?.libp2p || !params.key) {
            return;
        }

        try {
            const streamKey = getKeyFromStreamKey(params.key);
            if (!peer.identity.publicKey.equals(streamKey)) {
                peer.open(new VideoStream(streamKey), {
                    role: new ObserverType(),
                    sync: () => true,
                    /* trim: {
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
    }, [peer?.id, params?.key]);

    const playbackRefCb = useCallback(
        (node) => {
            const playbackRef: HTMLVideoElementWithCaptureStream = node;
            videoStreamRef.current = playbackRef;

            //let encoder = new Encoder();
            if (peer && playbackRef && videoStream) {
                //  const vs = new VideoStream(peer.identity.publicKey);
                playbackRef.onerror = (error) => {
                    console.error("pb error", error);
                };

                addStreamListener(videoStream, playbackRef);

                /* let firstChunk = new Uint8Array(0);
            setTimeout(() => {
                console.log('OPEN?')
                peer.open(vs, {
                    role: new ReplicatorType(),
                    trim: {
                        type: "bytelength",
                        from: 1 * 1e6,
                        to: 0.5 * 1e6,
                    },
                }).then((vs) => {
                    console.log('OPEN!!')


                    videoStreamRef.current = vs;
                    console.log(vs.address.toString());

                });
            }, 5000); */
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
                <IconButton
                    onClick={() =>
                        (videoStreamRef.current.currentTime =
                            Number.MAX_SAFE_INTEGER)
                    }
                >
                    <LiveTvIcon></LiveTvIcon>
                </IconButton>
            </Grid>
        </Grid>
    );
};
