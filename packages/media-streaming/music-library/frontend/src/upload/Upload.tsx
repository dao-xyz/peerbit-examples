import React, { useState, useRef, ChangeEvent } from "react";
import {
    MediaStreamDB as AudioContainer,
    AudioStreamDB,
    Track,
    Chunk,
    MediaStreamDBs,
} from "@peerbit/media-streaming";
import { WAVEncoder } from "@peerbit/media-streaming-web";
import { Play } from "../play/Play";
import { useNavigate, useSearchParams } from "react-router";
import { useNames } from "../NamesProvider";
import { usePeer, useProgram } from "@peerbit/react";
import { ImageItems } from "@peerbit/music-library-utils";
import { SpinnerSong } from "../Spinner";
import { useCover } from "../images/useCover";
import { Pencil1Icon } from "@radix-ui/react-icons";
import { getPicSumLink } from "../images/utils";

type Props = { source: AudioContainer };

export const Upload: React.FC<Props> = ({ source }) => {
    const peer = usePeer();
    const navigate = useNavigate();
    const [search] = useSearchParams();
    const libAddr = search.get("lib");

    // the two file inputs
    const [audioFile, setAudioFile] = useState<File | null>(null);
    const [coverFile, setCoverFile] = useState<File | null>(null);

    // upload state
    const [status, setStatus] = useState<
        "idle" | "encoding" | "done" | "error"
    >("idle");
    const [msg, setMsg] = useState("");
    const [progress, setProgress] = useState(0);

    // for the encoder & track
    const encoderRef = useRef<WAVEncoder>(undefined);
    const { setName } = useNames();

    // open your ImageItems store once, reuse
    const imgs = useProgram(new ImageItems(), { existing: "reuse" });

    // subscribe to any already-stored cover for that track:
    const [storedCover, setCover] = useCover(source?.id);

    // handlers for file inputs
    const onAudioPicked = (e: ChangeEvent<HTMLInputElement>) => {
        setAudioFile(e.target.files?.[0] ?? null);
        e.target.value = "";
    };
    const onCoverPicked = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        setCoverFile(file ?? null);
        e.target.value = "";
    };

    // core upload flow
    const upload = async () => {
        if (!audioFile) return;
        setStatus("encoding");
        setMsg(`Encoding “${audioFile.name}”…`);
        setProgress(0);

        try {
            // 0️⃣ peek at sample-rate
            const peekCtx = new AudioContext();
            const inBuf = await peekCtx.decodeAudioData(
                await audioFile.arrayBuffer()
            );
            const srcRate = inBuf.sampleRate;
            await peekCtx.close();

            // 1️⃣ create a new Track in your MediaStreamDB
            const track = await source.node.open(
                new Track({
                    sender: source.node.identity.publicKey,
                    source: new AudioStreamDB({ sampleRate: srcRate }),
                    start: 0,
                })
            );
            await track.source.replicate("streamer");
            await source.tracks.put(track, { target: "all" });

            // 2️⃣ wire up the WAVEncoder
            const wav = new WAVEncoder();
            encoderRef.current = wav;

            let lastTs = -1;
            const finish = async (ts: number) => {
                await wav.pause();
                await wav.destroy();
                await source.setEnd(track, ts);
                setProgress(1);
                setStatus("done");
                setMsg("Upload complete 🎉");
            };
            let bytes = 0;
            await wav.init(
                { file: audioFile, useElement: true },
                {
                    onChunk: ({
                        audioBuffer,
                        timestamp,
                        last,
                        index,
                        length,
                    }) => {
                        if (!audioBuffer) return;
                        // ensure strictly‐increasing timestamps
                        const ts =
                            timestamp === lastTs ? timestamp + 1 : timestamp;
                        lastTs = ts;
                        track.put(
                            new Chunk({
                                type: "key",
                                chunk: audioBuffer,
                                time: ts,
                            })
                        );
                        bytes += audioBuffer.length;
                        // this progress bar is not perfect..
                        // maybe use wav.ctx.currentTime instead?

                        setProgress(Math.min(bytes / audioFile.size, 1));
                        if (last) void finish(ts);
                    },
                }
            );
            await wav.play();

            // store meta info
            console.log("coverFile", { coverFile });

            if (coverFile) {
                setCover(coverFile);
            }
            await setName(source.id, audioFile.name);

            peer.peer
                .open<MediaStreamDBs>(libAddr, {
                    existing: "reuse",
                    args: {
                        replicate: "owned",
                    },
                })
                .then((lib) => {
                    // save lib
                    return lib.mediaStreams.put(source);
                })
                .catch((e) => {
                    console.error(e);
                    setStatus("error");
                    setMsg("Failed to save track to library");
                });
        } catch (e: any) {
            console.error(e);
            setStatus("error");
            setMsg(e.message ?? "Something went wrong");
        }
    };

    return (
        <div className="max-w-md w-full mx-auto mt-16 p-8 rounded-3xl bg-neutral-800/60 backdrop-blur-md shadow-2xl">
            {/* while your cover-store is loading */}
            {imgs.loading && <SpinnerSong />}

            {!imgs.loading && (
                <>
                    {libAddr && (
                        <button
                            onClick={() => navigate(`/l/${libAddr}`)}
                            className="mb-4 flex items-center gap-1 text-sm text-emerald-400 hover:text-emerald-300 transition"
                        >
                            ← Back to library
                        </button>
                    )}

                    <h2 className="text-3xl font-bold text-white mb-6">
                        Upload a track
                    </h2>

                    {/* preview + pickers */}
                    <div className="space-y-6">
                        {/* cover preview & picker */}
                        <div
                            className="relative group w-full h-40 mx-auto rounded-lg overflow-hidden bg-neutral-700 cursor-pointer"
                            onClick={() =>
                                document.getElementById("cover-input")!.click()
                            }
                        >
                            <img
                                src={
                                    coverFile
                                        ? URL.createObjectURL(coverFile)
                                        : storedCover ||
                                          (source.id
                                              ? getPicSumLink(source, 400)
                                              : "")
                                }
                                className="w-full h-full object-cover"
                                alt="Track cover"
                            />

                            {/* overlay on hover */}
                            <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/40 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition">
                                <Pencil1Icon className="w-6 h-6 text-white mb-1" />
                                <span className="text-white text-sm font-semibold">
                                    Change cover
                                </span>
                            </div>
                        </div>
                        <input
                            id="cover-input"
                            type="file"
                            accept="image/*"
                            onChange={onCoverPicked}
                            className="hidden"
                        />

                        {/* audio picker */}
                        <label className="block cursor-pointer">
                            <input
                                type="file"
                                accept="audio/*,video/*"
                                onChange={onAudioPicked}
                                className="hidden"
                            />
                            <div className="w-full p-3 rounded-xl border-2 border-dashed border-neutral-500 text-neutral-300 flex items-center justify-center hover:border-emerald-500 hover:text-white transition">
                                {audioFile
                                    ? audioFile.name
                                    : "Click to select audio"}
                            </div>
                        </label>

                        {/* start button */}
                        <button
                            disabled={!audioFile || status === "encoding"}
                            onClick={upload}
                            className="w-full py-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white font-semibold disabled:opacity-50"
                        >
                            {status === "encoding"
                                ? "Uploading…"
                                : "Start upload"}
                        </button>
                    </div>

                    {/* progress bar */}
                    {status === "encoding" && (
                        <div className="mt-6 w-full h-3 bg-neutral-700 rounded-full overflow-hidden">
                            <div
                                className="h-full bg-emerald-500 transition-all"
                                style={{
                                    width: `${Math.round(progress * 100)}%`,
                                }}
                            />
                        </div>
                    )}

                    {/* message */}
                    {msg && (
                        <p
                            className={`mt-4 text-sm ${
                                status === "error"
                                    ? "text-red-400"
                                    : status === "done"
                                      ? "text-emerald-400"
                                      : "text-neutral-300"
                            }`}
                        >
                            {msg}
                        </p>
                    )}

                    {/* instant player */}
                    {status === "done" && (
                        <div className="mt-8">
                            <Play source={source} />
                        </div>
                    )}
                </>
            )}
        </div>
    );
};
