import type { NetworkOption } from "@peerbit/react";
import { usePeer } from "@peerbit/react";
import React, { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Spinner } from "../utils/Spinner";

type Props = {
    network: "local" | "remote" | NetworkOption;
    children: React.ReactNode;
};

/**
 * Ensures low-level peer transport settings are applied before any downstream
 * providers start opening programs / scopes that may trigger seek-delivery flows.
 *
 * This prevents flaky unhandled `DeliveryError` bursts on cold starts (especially
 * in Playwright) where the default 10s seek timeout is too aggressive.
 */
export const PeerSetupGate: React.FC<Props> = ({ children, network }) => {
    const { peer, status } = usePeer();
    const [configured, setConfigured] = useState(false);
    const [connected, setConnected] = useState(false);

    const peerKey = useMemo(
        () => peer?.identity?.publicKey?.hashcode?.() || "",
        [peer?.identity?.publicKey?.hashcode?.()]
    );

    useLayoutEffect(() => {
        if (!peer) {
            setConfigured(false);
            return;
        }
        try {
            const services: any = (peer as any).services;
            const seekTimeoutMs = 60_000;
            if (typeof services?.pubsub?.seekTimeout === "number") {
                services.pubsub.seekTimeout = seekTimeoutMs;
            }
            if (typeof services?.blocks?.seekTimeout === "number") {
                services.blocks.seekTimeout = seekTimeoutMs;
            }
        } catch {
            // ignore
        }
        setConfigured(true);
    }, [peerKey]);

    useEffect(() => {
        if (!peer || !configured) {
            setConnected(false);
            return;
        }

        // In Playwright, block until we have at least one successful dial.
        // In interactive use, don't hard-block startup for long; keep dialing in the background.
        const isE2E =
            typeof navigator !== "undefined" &&
            (navigator as any).webdriver === true;

        const resolveTarget = (n: Props["network"]) => {
            if (typeof n === "string") return { kind: n } as const;
            const t = (n as any).type as string | undefined;
            if (t === "local") return { kind: "local" } as const;
            if (t === "remote") return { kind: "remote" } as const;
            if ("bootstrap" in (n as any)) {
                const list = ((n as any).bootstrap as any[]) ?? [];
                const addrs = Array.isArray(list)
                    ? list.map(String).filter(Boolean)
                    : [];
                return { kind: "explicit", addrs } as const;
            }
            return { kind: "remote" } as const;
        };

        const target = resolveTarget(network);
        const retryDelayMs = 1500;
        const blockMs = isE2E ? 60_000 : 5_000;
        const start = Date.now();

        // Offline = explicit empty bootstrap list
        if (target.kind === "explicit" && target.addrs.length === 0) {
            setConnected(true);
            return;
        }

        let cancelled = false;
        setConnected(false);

        const tryOnce = async (): Promise<boolean> => {
            if (cancelled) return false;

            if (target.kind === "local") {
                try {
                    const peerId = await (
                        await fetch("http://localhost:8082/peer/id")
                    ).text();
                    const localAddress =
                        "/ip4/127.0.0.1/tcp/8002/ws/p2p/" + peerId;
                    return await peer.dial(localAddress);
                } catch {
                    return false;
                }
            }

            if (target.kind === "remote") {
                try {
                    await peer.bootstrap?.();
                    return true;
                } catch {
                    return false;
                }
            }

            // explicit bootstraps
            for (const addr of target.addrs) {
                if (cancelled) return false;
                try {
                    const ok = await peer.dial(addr);
                    if (ok) return true;
                } catch {
                    // try next
                }
            }
            return false;
        };

        (async () => {
            let allowedUi = false;
            while (!cancelled) {
                const ok = await tryOnce();
                if (ok) {
                    setConnected(true);
                    return;
                }

                if (!isE2E && !allowedUi && Date.now() - start >= blockMs) {
                    allowedUi = true;
                    setConnected(true);
                    // keep retrying in background
                }

                await new Promise((r) => setTimeout(r, retryDelayMs));
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [configured, network, peer, peerKey]);

    if (!peer || !configured || !connected) {
        const title =
            status === "failed" ? "Reconnecting…" : "Starting session…";
        return (
            <div className="min-h-[70vh] flex items-center justify-center px-3 py-10">
                <div className="w-full max-w-md rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-all-lg p-6">
                    <div className="flex items-center justify-between">
                        <div className="text-lg font-semibold">{title}</div>
                        <Spinner />
                    </div>
                </div>
            </div>
        );
    }

    return <>{children}</>;
};
