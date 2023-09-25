import { Program, ProgramEvents, OpenOptions } from "@peerbit/program";
import { usePeer } from "./usePeer.js";
import { useEffect, useRef, useState } from "react";

const addressOrUndefined = <
    A,
    B extends ProgramEvents,
    P extends Program<A, B>
>(
    p: P
) => {
    try {
        return p.address;
    } catch (error) {
        return undefined;
    }
};

export const useProgram = <P extends Program<Args, Events>, Args = any, Events extends ProgramEvents = ProgramEvents>(
    addressOrOpen: P | string,
    options?: OpenOptions<Args, P>
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
            ?.open(addressOrOpen, { ...options, existing: "reuse" })
            .then((p) => {
                setProgram(p);
                return p;
            })
            .finally(() => {
                setLoading(false);
            });
    }, [
        peer?.identity.publicKey.hashcode(),
        typeof addressOrOpen === "string"
            ? addressOrOpen
            : addressOrUndefined(addressOrOpen),
    ]);
    return { program, loading, promise: programRef.current };
};
