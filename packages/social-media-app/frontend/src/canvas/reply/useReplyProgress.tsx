import React, { createContext, useContext, useState, useCallback } from "react";
import { PublicSignKey } from "@peerbit/crypto";
import {
    Canvas,
    CanvasMessage,
    ReplyingInProgresss,
} from "@giga-app/interface";
import { type RequestEvent } from "@peerbit/rpc";

// A single reply entry holds a timestamp, the public key, and the timeout id.
interface ReplyEntry {
    lastUpdated: number;
    publicKey: PublicSignKey;
    timeoutId: ReturnType<typeof setTimeout>;
}

// Each canvas entry now also holds a counter.
interface GlobalReplyEntry {
    counter: number;
    peerToReply: Map<string, ReplyEntry>;
    unregister: () => void;
}

// Global map: key is canvas ID.
type GlobalReplyMap = Map<string, GlobalReplyEntry>;

const ASSUME_DONE_TIMEOUT = 2000;

export interface ReplyProgressContextType {
    // Registers a canvas's program (which exposes a messages EventTarget) to listen for reply progress events.
    registerCanvas: (canvas: Canvas) => void;
    // Returns the list of peer PublicSignKeys currently replying for the given canvas.
    getReplying: (address: string) => PublicSignKey[];
    // Announces that this peer is replying to the given canvas.
    announceReply: (canvas: Canvas) => Promise<void>;
}

const ReplyProgressContext = createContext<
    ReplyProgressContextType | undefined
>(undefined);

export const ReplyProgressProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const [globalMap, setGlobalMap] = useState<GlobalReplyMap>(new Map());

    // Helper to create a new entry for a canvas.
    const createGlobalReplyEntry = (address: string): GlobalReplyEntry => {
        return {
            counter: 1,
            peerToReply: new Map(),
            unregister: () => {
                setGlobalMap((prev) => {
                    const newMap = new Map(prev);
                    const entry = newMap.get(address);
                    if (entry) {
                        if (entry.counter <= 1) {
                            newMap.delete(address);
                        } else {
                            entry.counter--;
                            newMap.set(address, entry);
                        }
                    }
                    return newMap;
                });
            },
        };
    };

    // Unregister a canvas by decrementing its counter.
    const unregisterCanvas = useCallback((canvas: Canvas) => {
        setGlobalMap((prev) => {
            const newMap = new Map(prev);
            const entry = newMap.get(canvas.address);
            if (entry) {
                if (entry.counter <= 1) {
                    newMap.delete(canvas.address);
                } else {
                    entry.counter--;
                    newMap.set(canvas.address, entry);
                }
            }
            return newMap;
        });
    }, []);

    // Update the reply entry for a given canvas and peer.
    const updateReplyProgress = useCallback(
        (address: string, publicKey: PublicSignKey) => {
            setGlobalMap((prev) => {
                const newMap = new Map(prev);
                let entry = newMap.get(address);
                if (!entry) {
                    // If an event comes in without registration, create an entry with counter 0.
                    entry = {
                        counter: 0,
                        peerToReply: new Map(),
                        unregister: () => {},
                    };
                }
                const peerHash = publicKey.hashcode();
                const inner = entry.peerToReply;
                if (inner.has(peerHash)) {
                    // Clear any existing timeout before resetting.
                    clearTimeout(inner.get(peerHash)!.timeoutId);
                }
                // Set a timeout to remove this peer after ASSUME_DONE_TIMEOUT.
                const timeoutId = setTimeout(() => {
                    setGlobalMap((prev2) => {
                        const newMap2 = new Map(prev2);
                        const entry2 = newMap2.get(address);
                        if (entry2) {
                            const inner2 = new Map(entry2.peerToReply);
                            inner2.delete(peerHash);
                            newMap2.set(address, {
                                ...entry2,
                                peerToReply: inner2,
                            });
                        }
                        return newMap2;
                    });
                }, ASSUME_DONE_TIMEOUT);
                inner.set(peerHash, {
                    publicKey,
                    lastUpdated: Date.now(),
                    timeoutId,
                });

                newMap.set(address, { ...entry, peerToReply: inner });
                return newMap;
            });
        },
        []
    );

    // Register a canvas program. This now subscribes to both canvas and canvas.origin
    // (if canvas.origin exists and differs from canvas.address).
    const registerCanvas = useCallback(
        (canvas: Canvas) => {
            // Either create a new entry or increment the counter.
            setGlobalMap((prev) => {
                const newMap = new Map(prev);
                let entry = newMap.get(canvas.address);
                if (entry) {
                    entry.counter++;
                    newMap.set(canvas.address, entry);
                } else {
                    entry = createGlobalReplyEntry(canvas.address);
                    newMap.set(canvas.address, entry);
                }
                return newMap;
            });

            // Create an array with the main canvas and (if different) its origin.
            const canvasesToSubscribe: Canvas[] = [canvas];
            if (canvas.origin && canvas.origin.address !== canvas.address) {
                canvasesToSubscribe.push(canvas.origin);
            }

            // Shared event listener for request events.
            const listener = (e: { detail: RequestEvent<CanvasMessage> }) => {
                /* console.log("RECEIVED REQUEST", {
                    address: canvas.address,
                    publicKey: e.detail.from,
                    request: e.detail.request,
                }); */
                if (
                    e.detail &&
                    e.detail.request instanceof ReplyingInProgresss
                ) {
                    const refAddress = e.detail.request.reference.address;
                    // Listen for events coming from either the main canvas or its origin.

                    if (
                        refAddress === canvas.address ||
                        (canvas.origin && refAddress === canvas.origin.address)
                    ) {
                        updateReplyProgress(canvas.address, e.detail.from);
                    }
                }
            };

            // Ensure we only unregister once.
            let unsubscribed = false;
            const handleClose = () => {
                if (!unsubscribed) {
                    unsubscribed = true;
                    canvasesToSubscribe.forEach((c) => {
                        c.messages.events.removeEventListener(
                            "request",
                            listener
                        );
                        c.messages.events.removeEventListener(
                            "close",
                            handleClose
                        );
                    });
                    unregisterCanvas(canvas);
                }
            };

            // Subscribe to both canvases.
            canvasesToSubscribe.forEach((c) => {
                c.messages.events.addEventListener("request", listener);
                c.messages.events.addEventListener("close", handleClose);
            });
        },
        [updateReplyProgress, unregisterCanvas]
    );

    // Retrieve the list of replying peers for a given canvas ID.
    const getReplying = useCallback(
        (canvasId: string): PublicSignKey[] => {
            const entry = globalMap.get(canvasId);
            if (!entry) return [];
            return Array.from(entry.peerToReply.values()).map(
                (v) => v.publicKey
            );
        },
        [globalMap]
    );

    // Announce that this peer is replying.
    const announceReply = useCallback(async (canvas: Canvas) => {
        const message = new ReplyingInProgresss({
            reference: canvas,
        });
        await canvas.messages.send(message);
    }, []);

    return (
        <ReplyProgressContext.Provider
            value={{ registerCanvas, getReplying, announceReply }}
        >
            {children}
        </ReplyProgressContext.Provider>
    );
};

export const useReplyProgress = (): ReplyProgressContextType => {
    const context = useContext(ReplyProgressContext);
    if (!context) {
        throw new Error(
            "useReplyProgress must be used within a ReplyProgressProvider"
        );
    }
    return context;
};
