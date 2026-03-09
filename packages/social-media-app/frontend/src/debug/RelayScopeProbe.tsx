import { Scope, createRootScope } from "@giga-app/interface";
import { usePeer } from "@peerbit/react";
import { concat } from "uint8arrays";
import { useEffect, useMemo, useRef, useState } from "react";
import { publishStartupPerfSnapshot, startupMark } from "./perf";

type ProbeStatus = "idle" | "pending" | "open" | "error" | "skipped";

type ScopeResult = {
    status: ProbeStatus;
    address?: string;
    error?: string;
};

type ProbeSnapshot = {
    mode: string;
    peerHash: string | number | null;
    persisted: boolean | null;
    public: ScopeResult;
    private: ScopeResult;
};

const getPrivateScope = async (
    peer: NonNullable<ReturnType<typeof usePeer>["peer"]>,
    options: { replicate: boolean; messages: boolean }
) => {
    const seed = concat([
        peer.identity.publicKey.bytes,
        new TextEncoder().encode("draft"),
    ]);
    return await peer.open(
        new Scope({ publicKey: peer.identity.publicKey, seed }),
        {
            existing: "reuse",
            args: {
                replicate: options.replicate,
                messages: options.messages,
            },
        }
    );
};

const getPublicScope = async (peer: NonNullable<ReturnType<typeof usePeer>["peer"]>, persisted: boolean) =>
    await peer.open(createRootScope(), {
        existing: "reuse",
        args: { replicate: persisted },
    });

const normalizeError = (error: unknown) =>
    error instanceof Error ? error.message : String(error);

export const RelayScopeProbe = (props: { mode: string }) => {
    const { peer, persisted, status } = usePeer();
    const [publicResult, setPublicResult] = useState<ScopeResult>({
        status: "idle",
    });
    const [privateResult, setPrivateResult] = useState<ScopeResult>({
        status: "idle",
    });
    const runKey = useMemo(
        () =>
            `${props.mode}:${peer?.identity?.publicKey?.hashcode?.() ?? "none"}:${persisted}`,
        [props.mode, peer?.identity?.publicKey?.hashcode?.(), persisted]
    );
    const plan = useMemo(() => {
        switch (props.mode) {
            case "public-only":
                return {
                    runPublic: true,
                    runPrivate: false,
                    serial: false,
                    replicatePrivate: persisted,
                    privateMessages: true,
                };
            case "private-only":
                return {
                    runPublic: false,
                    runPrivate: true,
                    serial: false,
                    replicatePrivate: persisted,
                    privateMessages: true,
                };
            case "private-only-no-messages":
                return {
                    runPublic: false,
                    runPrivate: true,
                    serial: false,
                    replicatePrivate: persisted,
                    privateMessages: false,
                };
            case "private-only-local":
                return {
                    runPublic: false,
                    runPrivate: true,
                    serial: false,
                    replicatePrivate: false,
                    privateMessages: true,
                };
            case "private-only-local-no-messages":
                return {
                    runPublic: false,
                    runPrivate: true,
                    serial: false,
                    replicatePrivate: false,
                    privateMessages: false,
                };
            case "parallel-no-messages":
                return {
                    runPublic: true,
                    runPrivate: true,
                    serial: false,
                    replicatePrivate: persisted,
                    privateMessages: false,
                };
            case "serial":
                return {
                    runPublic: true,
                    runPrivate: true,
                    serial: true,
                    replicatePrivate: persisted,
                    privateMessages: true,
                };
            case "serial-no-messages":
                return {
                    runPublic: true,
                    runPrivate: true,
                    serial: true,
                    replicatePrivate: persisted,
                    privateMessages: false,
                    privateFirst: false,
                };
            case "serial-private-first-no-messages":
                return {
                    runPublic: true,
                    runPrivate: true,
                    serial: true,
                    replicatePrivate: persisted,
                    privateMessages: false,
                    privateFirst: true,
                };
            case "serial-private-local":
                return {
                    runPublic: true,
                    runPrivate: true,
                    serial: true,
                    replicatePrivate: false,
                    privateMessages: true,
                    privateFirst: false,
                };
            case "serial-private-local-no-messages":
                return {
                    runPublic: true,
                    runPrivate: true,
                    serial: true,
                    replicatePrivate: false,
                    privateMessages: false,
                    privateFirst: false,
                };
            case "parallel-private-local":
                return {
                    runPublic: true,
                    runPrivate: true,
                    serial: false,
                    replicatePrivate: false,
                    privateMessages: true,
                    privateFirst: false,
                };
            case "parallel-private-local-no-messages":
                return {
                    runPublic: true,
                    runPrivate: true,
                    serial: false,
                    replicatePrivate: false,
                    privateMessages: false,
                    privateFirst: false,
                };
            default:
                return {
                    runPublic: true,
                    runPrivate: true,
                    serial: false,
                    replicatePrivate: persisted,
                    privateMessages: true,
                    privateFirst: false,
                };
        }
    }, [props.mode, persisted]);
    const startedRef = useRef<string>("");

    const snapshot: ProbeSnapshot = useMemo(
        () => ({
            mode: props.mode,
            peerHash: peer?.identity?.publicKey?.hashcode?.() ?? null,
            persisted: peer ? persisted : null,
            public: publicResult,
            private: privateResult,
        }),
        [peer?.identity?.publicKey?.hashcode?.(), persisted, props.mode, publicResult, privateResult]
    );

    useEffect(() => {
        try {
            (window as any).__scopeProbe = snapshot;
            window.dispatchEvent(
                new CustomEvent("scopeprobe:update", { detail: snapshot })
            );
        } catch {
            // ignore
        }
    }, [snapshot]);

    useEffect(() => {
        if (!peer) return;
        if (startedRef.current === runKey) return;
        startedRef.current = runKey;

        const run = async () => {
            setPublicResult({
                status: plan.runPublic ? "pending" : "skipped",
            });
            setPrivateResult({
                status: plan.runPrivate ? "pending" : "skipped",
            });

            const openPublic = async () => {
                startupMark("scopeprobe:public:start", { persisted });
                try {
                    const scope = await getPublicScope(peer, persisted);
                    startupMark("scopeprobe:public:end", {
                        address: scope.address,
                    });
                    setPublicResult({ status: "open", address: scope.address });
                    return scope;
                } catch (error) {
                    const message = normalizeError(error);
                    startupMark("scopeprobe:public:error", { message });
                    setPublicResult({ status: "error", error: message });
                    throw error;
                }
            };

            const openPrivate = async () => {
                startupMark("scopeprobe:private:start", {
                    persisted,
                    replicate: plan.replicatePrivate,
                    messages: plan.privateMessages,
                });
                try {
                    const scope = await getPrivateScope(
                        peer,
                        {
                            replicate: plan.replicatePrivate,
                            messages: plan.privateMessages,
                        }
                    );
                    startupMark("scopeprobe:private:end", {
                        address: scope.address,
                    });
                    setPrivateResult({
                        status: "open",
                        address: scope.address,
                    });
                    return scope;
                } catch (error) {
                    const message = normalizeError(error);
                    startupMark("scopeprobe:private:error", { message });
                    setPrivateResult({ status: "error", error: message });
                    throw error;
                }
            };

            startupMark("scopeprobe:start", {
                mode: props.mode,
                persisted,
                peerHash: peer.identity.publicKey.hashcode(),
            });

            if (plan.serial) {
                if (plan.privateFirst) {
                    if (plan.runPrivate) await openPrivate();
                    if (plan.runPublic) await openPublic();
                } else {
                    if (plan.runPublic) await openPublic();
                    if (plan.runPrivate) await openPrivate();
                }
            } else {
                await Promise.allSettled([
                    plan.runPublic ? openPublic() : Promise.resolve(undefined),
                    plan.runPrivate ? openPrivate() : Promise.resolve(undefined),
                ]);
            }

            startupMark("scopeprobe:done", { mode: props.mode });
            publishStartupPerfSnapshot("scopeprobe:done");
        };

        void run();
    }, [peer, persisted, plan, props.mode, runKey]);

    return (
        <div
            className="min-h-screen p-6 text-sm flex flex-col gap-3"
            data-testid="scopeprobe-root"
        >
            <h1 className="text-lg font-semibold">Relay Scope Probe</h1>
            <div data-testid="scopeprobe-mode">mode:{props.mode}</div>
            <div data-testid="scopeprobe-peer-status">peer-status:{status}</div>
            <div data-testid="scopeprobe-peer-hash">
                peer-hash:{String(snapshot.peerHash)}
            </div>
            <div data-testid="scopeprobe-persisted">
                persisted:{String(snapshot.persisted)}
            </div>
            <div data-testid="scopeprobe-public-status">
                public:{publicResult.status}
            </div>
            <div data-testid="scopeprobe-public-address">
                public-address:{publicResult.address ?? ""}
            </div>
            <div data-testid="scopeprobe-public-error">
                public-error:{publicResult.error ?? ""}
            </div>
            <div data-testid="scopeprobe-private-status">
                private:{privateResult.status}
            </div>
            <div data-testid="scopeprobe-private-address">
                private-address:{privateResult.address ?? ""}
            </div>
            <div data-testid="scopeprobe-private-error">
                private-error:{privateResult.error ?? ""}
            </div>
            <pre data-testid="scopeprobe-json">
                {JSON.stringify(snapshot, null, 2)}
            </pre>
        </div>
    );
};
