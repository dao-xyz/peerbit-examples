import React, {
    createContext,
    useContext,
    useMemo,
    PropsWithChildren,
} from "react";
import { usePeer, useProgram } from "@peerbit/react";
import { StoraOfLibraries } from "@peerbit/music-library-utils";
import { MediaStreamDBs } from "@peerbit/media-streaming";
import { randomBytes } from "@peerbit/crypto";

/* ——— context shape ——— */
interface LibrariesCtx {
    libraries?: ReturnType<typeof useProgram<StoraOfLibraries>>["program"];
    create: () => Promise<MediaStreamDBs>;
    loading: boolean;
    remove: (id: Uint8Array) => Promise<void>;
}

const Ctx = createContext<LibrariesCtx | null>(null);

/* ——— provider ——— */
export const LibrariesProvider = ({ children }: PropsWithChildren) => {
    const { peer } = usePeer();

    /* singleton store program */
    const storeProg = useProgram(peer ? new StoraOfLibraries() : null, {
        existing: "reuse",
        args: { replicate: false },
    });

    const value = useMemo<LibrariesCtx>(() => {
        const libraries = storeProg.program;

        return {
            libraries,
            loading: storeProg.loading,

            /* create empty library */
            async create() {
                if (!libraries) throw new Error("store not ready");
                let lib = new MediaStreamDBs({
                    id: randomBytes(32),
                    owner: peer.identity.publicKey,
                });
                await libraries.libraries.put(lib);
                const out = await peer.open(lib, {
                    args: { replicate: "owned" },
                    existing: "reuse",
                });
                console.log("CREATED LIB", out.mediaStreams.address);
                return out;
            },

            async remove(id: Uint8Array) {
                if (!libraries) throw new Error("store not ready");
                // TODO clear up everything correctly
                console.warn("TODO implement remove");
                await libraries.libraries.del(id);
            },
        };
    }, [
        storeProg.program,
        storeProg.loading,
        storeProg.program?.closed,
        peer?.identity.publicKey.hashcode(),
    ]);

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

/* ——— hook ——— */
export const useLibraries = () => {
    const ctx = useContext(Ctx);
    if (!ctx)
        throw new Error("useLibraries must be inside <LibrariesProvider>");
    return ctx;
};
