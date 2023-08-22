import { Program, ProgramEvents, OpenOptions } from "@peerbit/program";
import { usePeer } from "./usePeer.js";
import { useEffect, useRef, useState } from "react";

export const useProgram = <A, B extends ProgramEvents, P extends Program<A, B>>(
    addressOrOpen: P | string,
    options?: OpenOptions<A, P>
) => {
    const { peer } = usePeer();
    let [program, setProgram] = useState<P | undefined>();
    let programRef = useRef<Promise<P>>();
    let [loading, setLoading] = useState(false);
    useEffect(() => {
        if (!peer || !addressOrOpen) {
            return;
        }
        setLoading(true);
        programRef.current = peer
            .open(addressOrOpen, { ...options, existing: "reuse" })
            .then((p) => {
                setProgram(p);
                return p;
            })
            .finally(() => {
                setLoading(false);
            });
    }, [peer?.identity.publicKey.hashcode(), addressOrOpen]);
    return { program, loading, promise: programRef.current };
};
