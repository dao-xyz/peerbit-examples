import type { Ed25519Keypair } from "@peerbit/crypto";
import { PeerProvider, type NetworkOption } from "@peerbit/react";
import { getOrCreateKeypairForUser } from "@peerbit/identity-supabase";
import React, { useEffect, useMemo, useState, type JSX } from "react";
import { Spinner } from "../utils/Spinner";
import { useAuth } from "./useAuth";

type Props = {
    network: "local" | "remote" | NetworkOption;
    iframe: any;
    waitForConnnected?: boolean | "in-flight";
    inMemory?: boolean;
    singleton?: boolean;
    children: JSX.Element;
};

export const PeerWithAuth: React.FC<Props> = ({
    network,
    iframe,
    waitForConnnected,
    inMemory,
    singleton,
    children,
}) => {
    const auth = useAuth();
    const [boot, setBoot] = useState<
        | { type: "guest" }
        | { type: "account"; userId: string; keypair: Ed25519Keypair }
        | { type: "error"; message: string }
        | null
    >(null);

    const normalizeKeypairLoadError = (e: any): string => {
        const msg = String(e?.message || "");
        const lowered = msg.toLowerCase();
        if (
            lowered.includes("could not find the table") &&
            lowered.includes("peerbit_keypairs")
        ) {
            return "Your Supabase project is connected, but it’s missing the table `peerbit_keypairs`. Create it using the SQL in `packages/identity/supabase/README.md`, then reload.";
        }
        if (msg) return msg;
        return "Failed to load your saved identity. Try reloading.";
    };

    useEffect(() => {
        if (boot) return;

        // If Supabase isn't configured, just boot as guest.
        if (!auth.enabled) {
            setBoot({ type: "guest" });
            return;
        }

        // Wait for Supabase to hydrate persisted sessions.
        if (auth.loading) return;

        // No session => guest identity.
        if (!auth.user || !auth.supabase) {
            setBoot({ type: "guest" });
            return;
        }

        let cancelled = false;
        (async () => {
            try {
                const keypair = await getOrCreateKeypairForUser(
                    auth.supabase!,
                    {
                        userId: auth.user!.id,
                    }
                );
                if (cancelled) return;
                setBoot({
                    type: "account",
                    userId: auth.user!.id,
                    keypair,
                });
            } catch (e: any) {
                console.error("[PeerWithAuth] failed to load keypair", e);
                if (cancelled) return;
                setBoot({
                    type: "error",
                    message: normalizeKeypairLoadError(e),
                });
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [auth.enabled, auth.loading, auth.supabase, auth.user, boot]);

    const peerKey = useMemo(() => {
        if (!boot) return "boot:pending";
        if (boot.type === "guest") return "boot:guest";
        if (boot.type === "account")
            return `boot:account:${boot.userId}:${boot.keypair.publicKey.hashcode()}`;
        return "boot:error";
    }, [boot]);

    if (!boot || boot.type === "error") {
        const title =
            boot?.type === "error"
                ? "Sign-in setup needed"
                : "Starting session…";
        return (
            <div className="min-h-[70vh] flex items-center justify-center px-3 py-10">
                <div className="w-full max-w-md rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-all-lg p-6">
                    <div className="flex items-center justify-between">
                        <div className="text-lg font-semibold">{title}</div>
                        <Spinner />
                    </div>
                    {boot?.type === "error" && (
                        <div className="mt-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-800 dark:text-red-200">
                            {boot.message}
                            <div className="mt-3 flex gap-2">
                                <button
                                    className="btn btn-secondary"
                                    onClick={() => window.location.reload()}
                                >
                                    Reload
                                </button>
                                <button
                                    className="btn"
                                    onClick={() => setBoot({ type: "guest" })}
                                >
                                    Continue as guest
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        );
    }

    return (
        <PeerProvider
            key={peerKey}
            network={network}
            iframe={iframe}
            waitForConnnected={waitForConnnected}
            inMemory={inMemory}
            singleton={singleton}
            keypair={boot.type === "account" ? boot.keypair : undefined}
        >
            {children}
        </PeerProvider>
    );
};
