import * as Dialog from "@radix-ui/react-dialog";
import { usePeer } from "@peerbit/react";
import React, {
    createContext,
    useCallback,
    useContext,
    useMemo,
    useRef,
    useState,
} from "react";
import { useNavigate } from "react-router";
import { AUTH } from "../routes";
import { useAuth } from "./useAuth";

const STORAGE_GUEST_SEEN = "giga.identity.notice.guest.v1";
const STORAGE_TEMP_SEEN = "giga.identity.notice.temporary.v1";

type IdentityNoticeContextValue = {
    ensurePublishAllowed: () => Promise<boolean>;
};

const IdentityNoticeContext = createContext<
    IdentityNoticeContextValue | undefined
>(undefined);

export const useIdentityNotice = (): IdentityNoticeContextValue => {
    const ctx = useContext(IdentityNoticeContext);
    if (!ctx)
        throw new Error(
            "useIdentityNotice must be used within IdentityNoticeProvider"
        );
    return ctx;
};

export const IdentityNoticeProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const { persisted } = usePeer();
    const auth = useAuth();
    const navigate = useNavigate();

    const [open, setOpen] = useState(false);
    const inflight = useRef<Promise<boolean> | null>(null);
    const resolveRef = useRef<((ok: boolean) => void) | null>(null);

    const isTemporary = persisted === false;

    const alreadySeen = useMemo(() => {
        try {
            const k = isTemporary ? STORAGE_TEMP_SEEN : STORAGE_GUEST_SEEN;
            return window.localStorage.getItem(k) === "true";
        } catch {
            return false;
        }
    }, [isTemporary]);

    const markSeen = useCallback(() => {
        try {
            const k = isTemporary ? STORAGE_TEMP_SEEN : STORAGE_GUEST_SEEN;
            window.localStorage.setItem(k, "true");
        } catch {}
    }, [isTemporary]);

    const finish = useCallback(
        (ok: boolean) => {
            setOpen(false);
            if (ok) markSeen();
            try {
                resolveRef.current?.(ok);
            } finally {
                resolveRef.current = null;
                inflight.current = null;
            }
        },
        [markSeen]
    );

    const ensurePublishAllowed = useCallback(async () => {
        // Signed-in users: no warning.
        if (auth.user) return true;

        // If the browser granted persistence and the user dismissed already, don't nag.
        if (alreadySeen) return true;

        // If sign-in isn't enabled, still show the "guest/temporary" notice once.
        if (inflight.current) return inflight.current;

        setOpen(true);
        inflight.current = new Promise<boolean>((resolve) => {
            resolveRef.current = resolve;
        });
        return inflight.current;
    }, [alreadySeen, auth.user]);

    const value = useMemo<IdentityNoticeContextValue>(
        () => ({ ensurePublishAllowed }),
        [ensurePublishAllowed]
    );

    const title = isTemporary ? "Quick session" : "Posting as guest";
    const description = isTemporary
        ? auth.enabled
            ? "This session might disappear when you close this tab. Sign in to keep your identity."
            : "This session might disappear when you close this tab."
        : auth.enabled
          ? "You’re using a guest identity saved on this device. Sign in to keep it on other devices too."
          : "You’re using a guest identity saved on this device. On another device you’ll look like a different person.";

    return (
        <IdentityNoticeContext.Provider value={value}>
            {children}

            <Dialog.Root
                open={open}
                onOpenChange={(next) => {
                    // Treat closing as cancel (don’t publish).
                    if (!next && open) finish(false);
                    setOpen(next);
                }}
            >
                <Dialog.Portal>
                    <Dialog.Overlay className="fixed inset-0  backdrop-blur-sm z-50" />
                    <Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 p-6 rounded-lg max-w-sm w-full z-50 outline-0 bg-white dark:bg-neutral-950 border border-neutral-200 dark:border-neutral-800 shadow-all-lg">
                        <Dialog.Title className="text-xl font-semibold">
                            {title}
                        </Dialog.Title>
                        <Dialog.Description className="mt-3 text-sm text-neutral-700 dark:text-neutral-300">
                            {description}
                        </Dialog.Description>

                        <div className="mt-5 flex flex-col gap-2">
                            {auth.enabled && (
                                <button
                                    className="btn btn-secondary w-full"
                                    onClick={() => {
                                        navigate(AUTH, {});
                                        finish(false);
                                    }}
                                >
                                    Login / Create account
                                </button>
                            )}
                            <button
                                className={
                                    auth.enabled
                                        ? "btn w-full"
                                        : "btn btn-secondary w-full"
                                }
                                onClick={() => finish(true)}
                            >
                                Continue as guest
                            </button>
                        </div>
                    </Dialog.Content>
                </Dialog.Portal>
            </Dialog.Root>
        </IdentityNoticeContext.Provider>
    );
};
