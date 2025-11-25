import React, {
    createContext,
    useContext,
    useMemo,
    PropsWithChildren,
} from "react";
import { useQuery } from "@peerbit/document-react";
import { usePeer, useProgram } from "@peerbit/react";
import { NamedItems } from "@peerbit/music-library-utils";
import { equals } from "uint8arrays";

/* ───────── context shape ───────── */
interface NamesCtx {
    program?: ReturnType<typeof useProgram<NamedItems>>["program"];
    getName: (id: Uint8Array) => string;
    setName: (id: Uint8Array, name: string) => Promise<void>;
}

const Ctx = createContext<NamesCtx | null>(null);

/* ───────── provider ───────── */
export const NamesProvider = ({ children }: PropsWithChildren) => {
    const { peer } = usePeer();
    const namesProg = useProgram(peer, new NamedItems(), {});

    /* live cache of all docs */
    const { items: docs } = useQuery(namesProg.program?.documents, {
        query: useMemo(() => ({}), []),
        prefetch: true,
        batchSize: 1000,
        updates: {
            merge: true,
        },
        debug: false,
        remote: {
            reach: { eager: true },
            wait: { timeout: 5000 },
        },
    });

    const value = useMemo<NamesCtx>(() => {
        const program = namesProg.program;

        const getName = (id: Uint8Array) =>
            docs.find((d) => equals(d.id, id))?.name ?? "Untitled";

        const setName = async (id: Uint8Array, name: string) => {
            if (!program) throw new Error("names program not ready");
            await program.setName(id, name);
        };

        return { program, getName, setName };
    }, [namesProg.program, docs]);

    return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
};

/* ───────── hook ───────── */
export const useNames = () => {
    const ctx = useContext(Ctx);
    if (!ctx) throw new Error("useNames must be inside <NamesProvider>");
    return ctx;
};
