import { Program, OpenOptions, ProgramEvents } from "@peerbit/program";
import { usePeer } from "./usePeer.js";
import { PublicSignKey } from "@peerbit/crypto";
import { useEffect, useReducer, useRef, useState } from "react";
const addressOrDefined = <A, B extends ProgramEvents, P extends Program<A, B>>(
    p?: P
) => {
    try {
        return p?.address;
    } catch (error) {
        return !!p;
    }
};
type ExtractArgs<T> = T extends Program<infer Args> ? Args : never;
type ExtractEvents<T> = T extends Program<any, infer Events> ? Events : never;

export const useProgram = <
    P extends Program<ExtractArgs<P>, ExtractEvents<P>> &
        Program<any, ProgramEvents>
>(
    addressOrOpen?: P | string,
    options?: OpenOptions<P> & { id?: string; keepOpenOnUnmount?: boolean }
) => {
    const { peer } = usePeer();
    let [program, setProgram] = useState<P | undefined>();
    const [id, setId] = useState<string | undefined>(options?.id);
    let [loading, setLoading] = useState(true);
    const [session, forceUpdate] = useReducer((x) => x + 1, 0);
    let programLoadingRef = useRef<Promise<P>>(undefined);
    const [peers, setPeers] = useState<PublicSignKey[]>([]);

    let closingRef = useRef<Promise<any>>(Promise.resolve());
    /*   if (options?.debug) {
          console.log("useProgram", addressOrOpen, options);
      } */
    useEffect(() => {
        if (!peer || !addressOrOpen) {
            return;
        }
        setLoading(true);
        let changeListener: (() => void) | undefined = undefined;

        closingRef.current.then(() => {
            programLoadingRef.current = peer
                ?.open(addressOrOpen, { ...options, existing: "reuse" })
                .then((p) => {
                    // if program has topics do change listening on peers
                    if (
                        [p, ...p.allPrograms].filter(
                            (x) =>
                                x.closed === false &&
                                x.getTopics &&
                                x.getTopics?.().length > 0
                        ).length === 0
                    ) {
                        setPeers([peer.identity.publicKey]);
                    } else {
                        changeListener = () => {
                            p.getReady().then((set) => {
                                setPeers([...set.values()]);
                            });
                        };
                        p.events.addEventListener("join", changeListener);
                        p.events.addEventListener("leave", changeListener);
                        p.getReady()
                            .then((set) => {
                                setPeers([...set.values()]);
                            })
                            .catch((e) => {
                                console.log("Error getReady()", e);
                            });
                    }

                    setProgram(p);
                    forceUpdate();
                    if (options?.id) {
                        setId(p.address);
                    }
                    return p;
                })
                .catch((e) => {
                    console.error("failed to open", e);
                    throw e;
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
                    programLoadingRef.current.then((p) => {
                        const unsubscribe = () => {
                            changeListener &&
                                p.events.removeEventListener(
                                    "join",
                                    changeListener
                                );
                            changeListener &&
                                p.events.removeEventListener(
                                    "leave",
                                    changeListener
                                );
                        };

                        if (programLoadingRef.current === startRef) {
                            setProgram(undefined);
                            programLoadingRef.current = undefined;
                        }

                        if (options?.keepOpenOnUnmount) {
                            unsubscribe();
                            return; // nothing to close
                        }

                        return p.close().then(unsubscribe);
                    }) || Promise.resolve();
            }
        };
    }, [
        peer?.identity.publicKey.hashcode(),
        options?.id,
        typeof addressOrOpen === "string"
            ? addressOrOpen
            : addressOrDefined(addressOrOpen),
    ]);
    return {
        program,
        session,
        loading,
        promise: programLoadingRef.current,
        peers,
        id,
    };
};
