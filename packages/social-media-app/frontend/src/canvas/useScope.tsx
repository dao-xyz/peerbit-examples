// ScopeRegistry.tsx
import * as React from "react";
import { usePeer } from "@peerbit/react";
import { Scope, createRootScope } from "@giga-app/interface";
import { concat } from "uint8arrays";
import { publishStartupPerfSnapshot, startupMark } from "../debug/perf";

/* ────────────────────────────────────────────────────────────────────────────
 * Registry context
 * ──────────────────────────────────────────────────────────────────────────── */

type Registry = {
    get: (key: string) => Scope | undefined;
    ensure: (key: string, opts?: { private?: boolean }) => Promise<Scope>;
};

const ScopeRegistryCtx = React.createContext<Registry>({
    get: () => undefined,
    ensure: async () => {
        throw new Error("ScopeRegistryProvider missing");
    },
});

type RegistryState = {
    scopes: Map<string, Scope>;
    inflight: Map<string, Promise<Scope>>;
    openQueue: Promise<void>;
};

const registryStateByPeer = new WeakMap<object, RegistryState>();
const privateScopeByPeer = new WeakMap<object, Scope>();
const privateInflightByPeer = new WeakMap<object, Promise<Scope>>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = async <T,>(
    promise: Promise<T>,
    ms: number,
    label: string
): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => {
                    reject(new Error(`${label} timed out after ${ms}ms`));
                }, ms);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
};

const isRetryableScopeOpenError = (error: unknown) => {
    const message = String((error as any)?.message ?? error ?? "").toLowerCase();
    return (
        message.includes("fanout join timed out") ||
        message.includes("timed out") ||
        message.includes("delivery") ||
        message.includes("seek") ||
        message.includes("abort")
    );
};

const getRegistryState = (peer: object): RegistryState => {
    const existing = registryStateByPeer.get(peer);
    if (existing) return existing;
    const created: RegistryState = {
        scopes: new Map(),
        inflight: new Map(),
        openQueue: Promise.resolve(),
    };
    registryStateByPeer.set(peer, created);
    return created;
};

/* Normalize string keys */
function normalizeKey(addr: string) {
    if (addr === "public") return "@public";
    if (addr === "private") return "@private";
    return addr;
}
function resolvePrivacy(addr: string, opts?: { private?: boolean }) {
    if (addr === "private") return true;
    if (addr === "public") return false;
    return !!opts?.private;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Provider
 * ──────────────────────────────────────────────────────────────────────────── */

export function ScopeRegistryProvider({
    children,
}: {
    children: React.ReactNode;
}) {
    const { peer, persisted } = usePeer();
    const registryState = React.useMemo(
        () =>
            peer
                ? getRegistryState(peer as unknown as object)
                : {
                      scopes: new Map<string, Scope>(),
                      inflight: new Map<string, Promise<Scope>>(),
                      openQueue: Promise.resolve(),
                  },
        [peer]
    );

    const enqueueOpen = React.useCallback(<T,>(task: () => Promise<T>) => {
        const run = registryState.openQueue
            .catch(() => undefined)
            .then(task);
        registryState.openQueue = run.then(
            () => undefined,
            () => undefined
        );
        return run;
    }, [registryState]);

    const ensure = React.useCallback(
        async (address: string, opts?: { private?: boolean }) => {
            if (!peer) {
                return undefined; // still loading
            }

            const key = normalizeKey(address);
            const isPrivate = resolvePrivacy(address, opts);

            // cache hit
            const cached = registryState.scopes.get(key);
            if (cached) return cached;

            // in-flight
            const inflight = registryState.inflight.get(key);
            if (inflight) return inflight;

            // open
            startupMark(`scope:${key}:open:start`, {
                private: isPrivate,
                persisted,
            });
            const p = (async () => {
                let s: Scope;
                s = await enqueueOpen(async () => {
                    if (key === "@public" && !isPrivate) {
                        return await peer.open(createRootScope(), {
                            existing: "reuse",
                            args: { replicate: persisted },
                        });
                    } else if (isPrivate) {
                        // deterministic per user (and key) private scope
                        const seedTag = key === "@private" ? "draft" : key;
                        const seed = concat([
                            peer.identity.publicKey.bytes,
                            new TextEncoder().encode(seedTag),
                        ]);
                        let lastError: unknown;
                        for (let attempt = 1; attempt <= 3; attempt++) {
                            try {
                                return await withTimeout(
                                    peer.open(
                                        new Scope({
                                            publicKey: peer.identity.publicKey,
                                            seed,
                                        }),
                                        {
                                            existing: "reuse",
                                            args: {
                                                replicate: persisted,
                                                messages: false,
                                            },
                                        }
                                    ),
                                    45_000,
                                    `scope:${key}:open`
                                );
                            } catch (error) {
                                lastError = error;
                                console.warn(
                                    `[ScopeRegistry] private open failed (attempt ${attempt}/3)`,
                                    error
                                );
                                if (
                                    attempt === 3 ||
                                    !isRetryableScopeOpenError(error)
                                ) {
                                    throw error;
                                }
                                await sleep(1_000 * attempt);
                            }
                        }
                        throw lastError;
                    }
                    return await peer.open(createRootScope(), {
                        existing: "reuse",
                        args: { replicate: persisted },
                    });
                });

                registryState.scopes.set(key, s);
                registryState.inflight.delete(key);
                startupMark(`scope:${key}:open:end`, {
                    private: isPrivate,
                    address: s?.address,
                });
                publishStartupPerfSnapshot(`scope:${key}:open:end`);
                return s;
            })().catch((e) => {
                console.error(`[ScopeRegistry] failed to open ${key}`, e);
                registryState.inflight.delete(key);
                throw e;
            });

            registryState.inflight.set(key, p);
            return p;
        },
        [enqueueOpen, peer?.identity?.toString(), persisted, registryState]
    );

    const value = React.useMemo<Registry>(
        () => ({
            get: (k: string) => registryState.scopes.get(normalizeKey(k)),
            ensure,
        }),
        [ensure, registryState]
    );

    return (
        <ScopeRegistryCtx.Provider value={value}>
            {children}
        </ScopeRegistryCtx.Provider>
    );
}

/* ────────────────────────────────────────────────────────────────────────────
 * Hook: useScope(address | Scope, opts?)
 *   - 'public' | 'private' | '<custom>' → resolved via registry
 *   - Scope instance → returned as-is (no registry involvement)
 * ──────────────────────────────────────────────────────────────────────────── */

export function useScope(
    addressOrScope: "private" | "public" | string | Scope,
    opts?: { private?: boolean }
) {
    const reg = React.useContext(ScopeRegistryCtx);

    // If the caller passed a Scope instance, just return it (stable ref via state).
    const passedScope =
        typeof addressOrScope === "object"
            ? (addressOrScope as Scope)
            : undefined;

    const key = React.useMemo(
        () =>
            passedScope
                ? `@direct:${passedScope.address}`
                : normalizeKey(addressOrScope as string),
        [passedScope?.address, addressOrScope]
    );

    const [scope, setScope] = React.useState<Scope | undefined>(() =>
        passedScope ? passedScope : reg.get(key)
    );

    React.useEffect(() => {
        let cancel = false;

        // Direct scope input → set once and bail.
        if (passedScope) {
            setScope(passedScope);
            return () => {
                cancel = true;
            };
        }

        // String key path
        const existing = reg.get(key);
        if (existing) {
            setScope(existing);
            return () => {
                cancel = true;
            };
        }

        const addr = addressOrScope as string;
        reg.ensure(addr, opts).then((s) => {
            if (!cancel) setScope(s);
        });

        return () => {
            cancel = true;
        };
    }, [key, passedScope, reg, addressOrScope, opts?.private]);

    return scope;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Optional: legacy singletons for drop-in compatibility
 * ──────────────────────────────────────────────────────────────────────────── */

function getOrCreateSingleton<T>(name: string, factory: () => T): T {
    const g = globalThis as any;
    if (!g.__scope_singletons__) g.__scope_singletons__ = {};
    if (!g.__scope_singletons__[name]) g.__scope_singletons__[name] = factory();
    return g.__scope_singletons__[name] as T;
}

function useDirectPrivateScope() {
    const { peer, persisted } = usePeer();
    const [scope, setScope] = React.useState<Scope | undefined>(() =>
        peer ? privateScopeByPeer.get(peer as unknown as object) : undefined
    );

    React.useEffect(() => {
        let cancelled = false;
        if (!peer) {
            setScope(undefined);
            return () => {
                cancelled = true;
            };
        }

        const peerKey = peer as unknown as object;
        const cached = privateScopeByPeer.get(peerKey);
        if (cached) {
            setScope(cached);
            return () => {
                cancelled = true;
            };
        }

        const existingInflight = privateInflightByPeer.get(peerKey);
        if (existingInflight) {
            existingInflight.then((opened) => {
                if (!cancelled) setScope(opened);
            });
            return () => {
                cancelled = true;
            };
        }

        startupMark("scope:@private:open:start", {
            private: true,
            persisted,
        });

        const seed = concat([
            peer.identity.publicKey.bytes,
            new TextEncoder().encode("draft"),
        ]);
        const inflight = peer
            .open(
                new Scope({
                    publicKey: peer.identity.publicKey,
                    seed,
                }),
                {
                    existing: "reuse",
                    args: {
                        replicate: persisted,
                        messages: false,
                    },
                }
            )
            .then((opened) => {
                privateScopeByPeer.set(peerKey, opened);
                privateInflightByPeer.delete(peerKey);
                startupMark("scope:@private:open:end", {
                    private: true,
                    address: opened.address,
                });
                publishStartupPerfSnapshot("scope:@private:open:end");
                return opened;
            })
            .catch((error) => {
                privateInflightByPeer.delete(peerKey);
                console.error("[PrivateScope] failed to open", error);
                throw error;
            });

        privateInflightByPeer.set(peerKey, inflight);
        inflight.then((opened) => {
            if (!cancelled) setScope(opened);
        });

        return () => {
            cancelled = true;
        };
    }, [peer, peer?.identity?.publicKey?.hashcode?.(), persisted]);

    return scope;
}

export const PublicScope = getOrCreateSingleton("publicScope", () => ({
    useScope: () => useScope("public"),
}));

export const PrivateScope = getOrCreateSingleton("privateScope", () => ({
    useScope: () => useDirectPrivateScope(),
}));

// Optional default export mimicking old API (public scope by default)
export { useScope as default };
