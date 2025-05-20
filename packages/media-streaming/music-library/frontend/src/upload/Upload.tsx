import React, { useState, useRef, ChangeEvent } from "react";
import {
    MediaStreamDB,
    AudioStreamDB,
    Track,
    Chunk,
} from "@peerbit/media-streaming";
import { WAVEncoder } from "@peerbit/media-streaming-web";
import { Play } from "../play/Play";
import { useNavigate, useSearchParams } from "react-router";
import { useNames } from "../NamesProvider";

type Props = { source: MediaStreamDB };

export const Upload: React.FC<Props> = ({ source }) => {
    const navigate = useNavigate();
    const [search] = useSearchParams();
    const libAddr = search.get("lib");

    const [status, setStatus] = useState<
        "idle" | "encoding" | "done" | "error"
    >("idle");
    const [msg, setMsg] = useState("");
    const [progress, setProgress] = useState(0);

    const encoderRef = useRef<WAVEncoder>();
    const trackRef = useRef<Track<AudioStreamDB>>();
    const { setName } = useNames();

    /* ---------------- core flow ---------------- */
    const handleFile = async (file: File) => {
        setStatus("encoding");
        setMsg(`Encoding “${file.name}”…`);
        setProgress(0);

        try {
            /* ① open track */
            const track = await source.node.open(
                new Track({
                    sender: source.node.identity.publicKey,
                    source: new AudioStreamDB({ sampleRate: 48_000 }),
                    start: 0,
                })
            );
            await track.source.replicate("streamer");
            await source.tracks.put(track, { target: "all" });
            trackRef.current = track;

            /* ② encoder */
            console.log("INIT ENCODER");

            console.log("INIT ENCODER DONE");

            /* progress */
            let bytes = 0;
            let lastTs = -1;

            let clear = async () => {
                await wav.pause();
                await wav.destroy();
                await source.setEnd(track, lastTs);
                setProgress(1);
                setStatus("done");
                setMsg("Upload complete 🎉");
            };

            const onMessage = (props: {
                last?: boolean;
                audioBuffer: Uint8Array;
                timestamp: number;
                index: number;
                length: number;
            }) => {
                if (!props.audioBuffer) return;

                let thisTime = props.timestamp;
                if (thisTime == lastTs) {
                    thisTime++;
                }
                lastTs = thisTime;

                console.log("onMessage", props.timestamp);

                track.put(
                    new Chunk({
                        type: "key",
                        chunk: props.audioBuffer,
                        time: lastTs,
                    })
                );

                bytes += props.audioBuffer.length;
                setProgress(Math.min(props.index / props.length, 1));

                if (props.last) {
                    console.log("DONE!");
                    clear();
                }
            };

            const wav = new WAVEncoder();
            encoderRef.current = wav;
            await wav.init(
                { file },
                {
                    onChunk: onMessage,
                }
            );

            await wav.play();

            await setName(source.id, file.name);
        } catch (err: any) {
            console.error(err);
            setStatus("error");
            setMsg(err.message ?? "Something went wrong");
        }
    };

    const onChange = (e: ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file) handleFile(file);
        e.target.value = "";
    };

    /* ---------------- UI ---------------- */
    return (
        <div className="max-w-md mx-auto mt-16 p-8 rounded-3xl bg-neutral-800/60 backdrop-blur-md shadow-2xl">
            {/* Back button (only if we know the parent library) */}
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

            <label className="block cursor-pointer">
                <span className="sr-only">Choose file</span>
                <input
                    type="file"
                    accept="audio/*,video/*"
                    onChange={onChange}
                    className="hidden"
                />
                <div className="w-full py-4 rounded-xl border-2 border-dashed border-neutral-500 text-neutral-300 flex items-center justify-center hover:border-emerald-500 hover:text-white transition">
                    Click or drop to select file
                </div>
            </label>

            {status === "encoding" && (
                <div className="mt-8 w-full h-3 bg-neutral-700 rounded-full overflow-hidden">
                    <div
                        className="h-full bg-emerald-500 transition-all"
                        style={{ width: `${progress * 100}%` }}
                    />
                </div>
            )}

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

            {status === "done" && (
                <div className="mt-8">
                    <Play source={source} />
                </div>
            )}
        </div>
    );
};
