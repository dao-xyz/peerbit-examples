import { Program, OpenOptions, ProgramEvents } from "@peerbit/program";
import { usePeer } from "./usePeer.js";
import { useEffect, useReducer, useRef, useState } from "react";
const addressOrUndefined = <
    A,
    B extends ProgramEvents,
    P extends Program<A, B>
>(
    p?: P
) => {
    try {
        return p?.address;
    } catch (error) {
        return undefined;
    }
};
type ExtractArgs<T> = T extends Program<infer Args> ? Args : never;
type ExtractEvents<T> = T extends Program<any, infer Events> ? Events : never;

export const useProgram = <
    P extends Program<ExtractArgs<P>, ExtractEvents<P>> &
        Program<any, ProgramEvents>
>(
    addressOrOpen?: P | string,
    options?: OpenOptions<P>
) => {
    const { peer } = usePeer();
    let [program, setProgram] = useState<P | undefined>();
    let [loading, setLoading] = useState(true);
    const [session, forceUpdate] = useReducer((x) => x + 1, 0);
    let programLoadingRef = useRef<Promise<P>>();
    const [peerCounter, setPeerCounter] = useState<number>(1);
    let closingRef = useRef<Promise<any>>(Promise.resolve());

    useEffect(() => {
        if (!peer || !addressOrOpen) {
            return;
        }
        setLoading(true);
        let changeListener: () => void;

        closingRef.current.then(() => {
            programLoadingRef.current = peer
                ?.open(addressOrOpen, { ...options, existing: "reuse" })
                .then((p) => {
                    changeListener = () => {
                        p.getReady().then((set) => {
                            setPeerCounter(set.size);
                        });
                    };
                    p.events.addEventListener("join", changeListener);
                    p.events.addEventListener("leave", changeListener);
                    p.getReady().then((set) => {
                        setPeerCounter(set.size);
                    });
                    setProgram(p);
                    forceUpdate();

                    return p;
                })
                .finally(() => {
                    setLoading(false);
                });
        });

        // TODO AbortController?
        return () => {
            let startRef = programLoadingRef.current;

            // TODO don't close on reopen the same db?
            if (programLoadingRef.current) {
                closingRef.current =
                    programLoadingRef.current.then((p) =>
                        p.close().then(() => {
                            p.events.removeEventListener(
                                "join",
                                changeListener
                            );
                            p.events.removeEventListener(
                                "leave",
                                changeListener
                            );

                            if (programLoadingRef.current === startRef) {
                                setProgram(undefined);
                                programLoadingRef.current = undefined;
                            }
                        })
                    ) || Promise.resolve();
            }
        };
    }, [
        peer?.identity.publicKey.hashcode(),
        typeof addressOrOpen === "string"
            ? addressOrOpen
            : addressOrUndefined(addressOrOpen),
    ]);
    return {
        program,
        session,
        loading,
        promise: programLoadingRef.current,
        peerCounter,
    };
};
