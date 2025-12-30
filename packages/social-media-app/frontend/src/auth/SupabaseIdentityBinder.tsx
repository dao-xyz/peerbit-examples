import * as Dialog from "@radix-ui/react-dialog";
import {
    getKeypairForUser,
    insertKeypairForUser,
} from "@peerbit/identity-supabase";
import { usePeer } from "@peerbit/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "./useAuth";

const useSavedKey = (userId: string) =>
    `giga:supabaseIdentity:${userId}:useSaved`;
const dismissedKey = (userId: string) =>
    `giga:supabaseIdentity:${userId}:dismissedPeerHash`;

export const SupabaseIdentityBinder = () => {
    const auth = useAuth();
    const { peer } = usePeer();
    const [mismatchOpen, setMismatchOpen] = useState(false);
    const [mismatchEmail, setMismatchEmail] = useState<string | undefined>(
        undefined
    );

    const handledKey = useRef<string | null>(null);
    const inflight = useRef<Promise<void> | null>(null);

    const peerPublicKeyHash = peer?.identity?.publicKey?.hashcode?.();

    useEffect(() => {
        if (!auth.enabled || !auth.user || !auth.supabase || !peer) {
            handledKey.current = null;
            inflight.current = null;
            setMismatchOpen(false);
            return;
        }

        const userId = auth.user.id;
        if (peerPublicKeyHash === undefined || peerPublicKeyHash === null) {
            return;
        }

        const nextHandledKey = `${userId}:${String(peerPublicKeyHash)}`;
        if (handledKey.current === nextHandledKey) return;
        if (inflight.current) return;

        let cancelled = false;
        inflight.current = (async () => {
            try {
                const currentPeerHash = String(peerPublicKeyHash);
                const existing = await getKeypairForUser(auth.supabase!, {
                    userId,
                });
                if (cancelled) return;

                if (!existing) {
                    // First login: save current device identity to the account.
                    try {
                        await insertKeypairForUser(auth.supabase!, {
                            userId,
                            keypair: peer.identity as any,
                        });
                        try {
                            // If we just saved the current identity, ensure we won't prompt to switch.
                            window.localStorage.removeItem(useSavedKey(userId));
                            window.localStorage.removeItem(
                                dismissedKey(userId)
                            );
                        } catch {}
                        setMismatchOpen(false);
                        handledKey.current = nextHandledKey;
                        return;
                    } catch (e) {
                        // Might race with another device; read again.
                        const after = await getKeypairForUser(auth.supabase!, {
                            userId,
                        });
                        if (!after) throw e;
                        if (cancelled) return;
                        if (after.publicKey.hashcode() !== currentPeerHash) {
                            const dismissed =
                                (() => {
                                    try {
                                        return window.localStorage.getItem(
                                            dismissedKey(userId)
                                        );
                                    } catch {
                                        return null;
                                    }
                                })() ?? null;
                            if (dismissed !== String(peerPublicKeyHash ?? "")) {
                                setMismatchEmail(auth.user?.email ?? undefined);
                                setMismatchOpen(true);
                            } else {
                                setMismatchOpen(false);
                            }
                        } else {
                            setMismatchOpen(false);
                        }
                        handledKey.current = nextHandledKey;
                        return;
                    }
                }

                // Existing account identity differs from current device identity.
                if (existing.publicKey.hashcode() !== currentPeerHash) {
                    const dismissed =
                        (() => {
                            try {
                                return window.localStorage.getItem(
                                    dismissedKey(userId)
                                );
                            } catch {
                                return null;
                            }
                        })() ?? null;
                    if (dismissed !== String(peerPublicKeyHash ?? "")) {
                        setMismatchEmail(auth.user?.email ?? undefined);
                        setMismatchOpen(true);
                    } else {
                        setMismatchOpen(false);
                    }
                } else {
                    setMismatchOpen(false);
                }

                handledKey.current = nextHandledKey;
            } catch (e) {
                console.error("[SupabaseIdentityBinder] failed", e);
                handledKey.current = nextHandledKey; // avoid loops
            } finally {
                inflight.current = null;
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [auth.enabled, auth.supabase, auth.user?.id, peerPublicKeyHash]);

    const title = useMemo(() => {
        if (!mismatchEmail) return "Use your saved identity";
        return `Use saved identity for ${mismatchEmail}?`;
    }, [mismatchEmail]);

    return (
        <Dialog.Root open={mismatchOpen} onOpenChange={setMismatchOpen}>
            <Dialog.Portal>
                <Dialog.Overlay className="fixed inset-0  backdrop-blur-sm z-50" />
                <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 p-6 rounded-lg max-w-sm w-full z-50 outline-0 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 shadow-all-lg">
                    <Dialog.Title className="text-xl font-semibold">
                        {title}
                    </Dialog.Title>
                    <Dialog.Description className="mt-3 text-sm text-neutral-700 dark:text-neutral-300">
                        This account already has an identity saved. To use it in
                        the app, reload now. If you continue without reloading,
                        you’ll post as a different person.
                    </Dialog.Description>

                    <div className="mt-5 flex flex-col gap-2">
                        <button
                            className="btn btn-secondary w-full"
                            onClick={() => {
                                if (auth.user?.id) {
                                    try {
                                        window.localStorage.setItem(
                                            useSavedKey(auth.user.id),
                                            "1"
                                        );
                                        window.localStorage.removeItem(
                                            dismissedKey(auth.user.id)
                                        );
                                    } catch {}
                                }
                                window.location.reload();
                            }}
                        >
                            Reload and switch
                        </button>
                        <button
                            className="btn w-full"
                            onClick={() => {
                                if (auth.user?.id) {
                                    try {
                                        window.localStorage.setItem(
                                            dismissedKey(auth.user.id),
                                            String(peerPublicKeyHash ?? "")
                                        );
                                    } catch {}
                                }
                                setMismatchOpen(false);
                            }}
                        >
                            Continue for now
                        </button>
                    </div>
                </Dialog.Content>
            </Dialog.Portal>
        </Dialog.Root>
    );
};
