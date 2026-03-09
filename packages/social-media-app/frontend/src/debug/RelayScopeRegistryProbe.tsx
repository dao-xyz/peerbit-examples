import { useEffect, useMemo } from "react";
import { usePeer } from "@peerbit/react";
import { PrivateScope, PublicScope } from "../canvas/useScope";

type Snapshot = {
    mode: string;
    peerHash: string | number | null;
    persisted: boolean | null;
    public: { status: string; address?: string };
    private: { status: string; address?: string };
};

export const RelayScopeRegistryProbe = (props: { mode: string }) => {
    const { peer, persisted, status } = usePeer();
    const usePublic = props.mode.includes("public");
    const usePrivate = props.mode.includes("private");

    const publicScope = usePublic ? PublicScope.useScope() : undefined;
    const privateScope = usePrivate ? PrivateScope.useScope() : undefined;

    const snapshot: Snapshot = useMemo(
        () => ({
            mode: props.mode,
            peerHash: peer?.identity?.publicKey?.hashcode?.() ?? null,
            persisted: peer ? persisted : null,
            public: usePublic
                ? {
                      status: publicScope?.address ? "open" : "pending",
                      address: publicScope?.address,
                  }
                : { status: "skipped" },
            private: usePrivate
                ? {
                      status: privateScope?.address ? "open" : "pending",
                      address: privateScope?.address,
                  }
                : { status: "skipped" },
        }),
        [
            props.mode,
            peer?.identity?.publicKey?.hashcode?.(),
            persisted,
            usePublic,
            usePrivate,
            publicScope?.address,
            privateScope?.address,
        ]
    );

    useEffect(() => {
        try {
            (window as any).__scopeRegistryProbe = snapshot;
            window.dispatchEvent(
                new CustomEvent("scope-registry-probe:update", {
                    detail: snapshot,
                })
            );
        } catch {
            // ignore
        }
    }, [snapshot]);

    return (
        <div
            className="min-h-screen p-6 text-sm flex flex-col gap-3"
            data-testid="scope-registry-probe-root"
        >
            <h1 className="text-lg font-semibold">Relay Scope Registry Probe</h1>
            <div data-testid="scope-registry-probe-mode">
                mode:{props.mode}
            </div>
            <div data-testid="scope-registry-probe-peer-status">
                peer-status:{status}
            </div>
            <pre data-testid="scope-registry-probe-json">
                {JSON.stringify(snapshot, null, 2)}
            </pre>
        </div>
    );
};
