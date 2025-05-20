import { createContext, useContext, PropsWithChildren, useMemo } from "react";
import { useCount, useProgram } from "@peerbit/react";
import { PlayStats, PlayEvent } from "@peerbit/music-library-utils"; // ← path to your file

/* ---------- context shape ---------- */
interface PlayStatsCtx {
    /** underlying program instance (might be undefined until opened) */
    program?: ReturnType<typeof useProgram<PlayStats>>["program"];

    /** add a new play (duration ms & track-id)  */
    addPlay: (args: {
        duration: number;
        sourceId: Uint8Array;
    }) => Promise<void>;
}

/* ---------- ctx impl ---------- */
const Ctx = createContext<PlayStatsCtx | null>(null);

export const PlayStatsProvider = ({ children }: PropsWithChildren) => {
    /* open once – replicate to everyone */
    const stats = useProgram(new PlayStats(), {
        existing: "reuse",
        args: {}, // no extra args
    });

    const value = useMemo<PlayStatsCtx>(() => {
        return {
            program: stats.program,
            addPlay: async ({ duration, sourceId }) => {
                if (!stats.program) return;
                const ev = new PlayEvent({ duration, source: sourceId });
                await stats.program.documents.put(ev, { target: "all" });
            },
        };
    }, [stats.program]);

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

/* hook */
export const usePlayStats = () => {
    const ctx = useContext(Ctx);
    if (!ctx)
        throw new Error("usePlayStats must be inside <PlayStatsProvider>");
    return ctx;
};

/* ---------- single-track counter ---------- */
/** live counter for one media-stream idString (debounced) */
export const usePlayCount = (sourceId: Uint8Array, debounce = 1000) => {
    const { program } = usePlayStats();

    const query = useMemo(
        () => ({
            source: sourceId,
        }),
        [sourceId]
    );

    return useCount(program?.documents, { query, debounce });
};
