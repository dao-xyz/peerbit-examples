// ScopeRegistry.tsx
import * as React from "react";
import { usePeer } from "@peerbit/react";
import { Scope, createRootScope } from "@giga-app/interface";
import { concat } from "uint8arrays";

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

    const scopesRef = React.useRef(new Map<string, Scope>());
    const inflightRef = React.useRef(new Map<string, Promise<Scope>>());

    const ensure = React.useCallback(
        async (address: string, opts?: { private?: boolean }) => {
            if (!peer) {
                return undefined; // still loading
            }

            const key = normalizeKey(address);
            const isPrivate = resolvePrivacy(address, opts);

            // cache hit
            const cached = scopesRef.current.get(key);
            if (cached) return cached;

            // in-flight
            const inflight = inflightRef.current.get(key);
            if (inflight) return inflight;

            // open
            const p = (async () => {
                let s: Scope;
                if (key === "@public" && !isPrivate) {
                    s = await peer.open(createRootScope(), {
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
                    s = await peer.open(
                        new Scope({ publicKey: peer.identity.publicKey, seed }),
                        {
                            existing: "reuse",
                            args: { replicate: persisted },
                        }
                    );
                } else {
                    // custom *public-like* key: reuse the root scope (simple, low-friction default)
                    s = await peer.open(createRootScope(), {
                        existing: "reuse",
                        args: { replicate: persisted },
                    });
                }

                scopesRef.current.set(key, s);
                inflightRef.current.delete(key);
                return s;
            })().catch((e) => {
                inflightRef.current.delete(key);
                throw e;
            });

            inflightRef.current.set(key, p);
            return p;
        },
        [peer?.identity?.toString(), persisted]
    );

    const value = React.useMemo<Registry>(
        () => ({
            get: (k: string) => scopesRef.current.get(normalizeKey(k)),
            ensure,
        }),
        [ensure]
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

export const PublicScope = getOrCreateSingleton("publicScope", () => ({
    useScope: () => useScope("public"),
}));

export const PrivateScope = getOrCreateSingleton("privateScope", () => ({
    useScope: () => useScope("private"),
}));

// Optional default export mimicking old API (public scope by default)
export { useScope as default };
