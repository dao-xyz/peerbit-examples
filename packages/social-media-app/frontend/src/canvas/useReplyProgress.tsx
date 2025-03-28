import React, { createContext, useContext, useState, useCallback } from "react";
import { PublicSignKey } from "@peerbit/crypto";
import { Canvas, CanvasMessage, ReplyingInProgresss } from "@dao-xyz/social";
import { type RequestEvent } from "@peerbit/rpc";

// A single reply entry holds a timestamp, the public key, and the timeout id.
interface ReplyEntry {
    lastUpdated: number;
    publicKey: PublicSignKey;
    timeoutId: ReturnType<typeof setTimeout>;
}

// Global map: key is canvas ID, value is an object with peerToReply map and an unregister function.
type GlobalReplyMap = Map<
    string,
    {
        peerToReply: Map<string, ReplyEntry>;
        unregister: () => void;
    }
>;
const ASSUME_DONE_TIMEOUT = 1e6;
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

    // Update the reply entry for a given canvas and peer.
    const updateReplyProgress = useCallback(
        (address: string, publicKey: PublicSignKey) => {
            setGlobalMap((prev) => {
                const newMap = new Map(prev);
                let entry = newMap.get(address);
                let inner: Map<string, ReplyEntry>;
                if (entry) {
                    inner = entry.peerToReply;
                } else {
                    inner = new Map();
                    // Create a new unregister function for this canvas.
                    entry = {
                        peerToReply: inner,
                        unregister: () => {
                            setGlobalMap((prev2) => {
                                const newMap2 = new Map(prev2);
                                newMap2.delete(address);
                                return newMap2;
                            });
                        },
                    };
                }
                const peerHash = publicKey.hashcode();
                if (inner.has(peerHash)) {
                    // Clear the existing timeout so we can reset it.
                    clearTimeout(inner.get(peerHash)!.timeoutId);
                }
                // Set a new timeout to remove this peer entry after 5 seconds.
                const timeoutId = setTimeout(() => {
                    setGlobalMap((prev2) => {
                        const newMap2 = new Map(prev2);
                        const entry2 = newMap2.get(address);
                        if (entry2) {
                            const inner2 = new Map(entry2.peerToReply);
                            inner2.delete(peerHash);
                            newMap2.set(address, {
                                peerToReply: inner2,
                                unregister: entry2.unregister,
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
                newMap.set(address, {
                    peerToReply: inner,
                    unregister: entry.unregister,
                });
                return newMap;
            });
        },
        []
    );

    const unregisterCanvas = useCallback((canvas: Canvas) => {
        setGlobalMap((prev) => {
            const newMap = new Map(prev);
            newMap.delete(canvas.address);
            return newMap;
        });
    }, []);

    // Register a canvas program so that its "request" events are monitored.
    const registerCanvas = useCallback(
        (canvas: Canvas) => {
            const listener = (e: { detail: RequestEvent<CanvasMessage> }) => {
                // We expect e.detail to be an instance of ReplyingInProgress.
                console.log(
                    "updateReplyProgress",
                    e.detail,
                    e.detail.request instanceof ReplyingInProgresss
                );

                if (
                    e.detail &&
                    e.detail.request instanceof ReplyingInProgresss
                ) {
                    // Assume e.detail.reference.request.canvas corresponds to this canvasId.
                    // And that e.detail.reference.from is the sender's public key.

                    updateReplyProgress(canvas.address, e.detail.from);
                }
            };
            canvas.messages.events.addEventListener("request", listener);
            canvas.messages.events.addEventListener("close", () => {
                // Remove the listener when the canvas closes.
                canvas.messages.events.removeEventListener("request", listener);
                unregisterCanvas(canvas);
            });
        },
        [updateReplyProgress, unregisterCanvas]
    );

    // Retrieve a list of replying peers for the given canvas ID.
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

    // Announce that this peer is replying to a canvas.
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
