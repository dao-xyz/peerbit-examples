export type PeerOverrideAction =
    | "wait-for-peer"
    | "ready-without-explicit-dial"
    | "dial-explicit-peers";

export type PeerDialStatus = "pending" | "fulfilled" | "rejected";
export type PeerDialOutcome = "pending" | "ready" | "failed";
export type LocalShareFallbackOutcome = "ready-local" | "failed";

export type PeerHintSource = "peer" | "bootstrap" | null;

export type PeerAddressConfiguration = {
    source: PeerHintSource;
    peers: string[] | undefined;
};

const getHashSearchParams = (url: URL) => {
    const queryIndex = url.hash.indexOf("?");
    return queryIndex === -1
        ? new URLSearchParams()
        : new URLSearchParams(url.hash.slice(queryIndex + 1));
};

export const getShareAddressFromHref = (href: string): string | undefined => {
    try {
        const url = new URL(href);
        const hashPath = url.hash.slice(1).split("?", 1)[0];
        const match = /^\/s\/([^/]+)\/?$/.exec(hashPath);
        if (!match) {
            return undefined;
        }
        const address = decodeURIComponent(match[1]);
        return address && !address.includes("/") ? address : undefined;
    } catch {
        return undefined;
    }
};

export const getPeerAddressConfiguration = (
    href: string
): PeerAddressConfiguration => {
    const url = new URL(href);
    const hashParams = getHashSearchParams(url);
    const peer = url.searchParams.get("peer") ?? hashParams.get("peer");
    const bootstrap =
        url.searchParams.get("bootstrap") ?? hashParams.get("bootstrap");
    const value = peer ?? bootstrap;
    const source: PeerHintSource =
        peer != null ? "peer" : bootstrap != null ? "bootstrap" : null;
    if (value == null) {
        return { source, peers: undefined };
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === "" || normalized === "offline") {
        return { source, peers: [] };
    }
    return {
        source,
        peers: value
            .split(",")
            .map((address) => address.trim())
            .filter(Boolean),
    };
};

export const getPeerOverrideAction = (
    peerAvailable: boolean,
    peers: readonly string[] | undefined
): PeerOverrideAction => {
    if (!peerAvailable) {
        return "wait-for-peer";
    }
    return peers != null && peers.length > 0
        ? "dial-explicit-peers"
        : "ready-without-explicit-dial";
};

export const getPeerDialOutcome = (
    results: readonly { status: PeerDialStatus }[]
): PeerDialOutcome => {
    if (results.some((result) => result.status === "pending")) {
        return "pending";
    }
    return results.some((result) => result.status === "fulfilled")
        ? "ready"
        : "failed";
};

export const getLocalShareFallbackOutcome = ({
    source,
    shareAddress,
    localProgramAvailable,
}: {
    source: PeerHintSource;
    shareAddress: string | undefined;
    localProgramAvailable: boolean;
}): LocalShareFallbackOutcome =>
    source === "peer" && shareAddress && localProgramAvailable
        ? "ready-local"
        : "failed";

type DialOptions = {
    dialTimeoutMs: number;
    signal: AbortSignal;
};

export type PeerDial = (
    address: string,
    options: DialOptions
) => Promise<unknown>;

export class PeerDialTimeoutError extends Error {
    constructor(address: string, timeoutMs: number) {
        super(`Timed out dialing ${address} after ${timeoutMs} ms`);
        this.name = "PeerDialTimeoutError";
    }
}

export const dialPeerWithTimeout = (
    dial: PeerDial,
    address: string,
    timeoutMs: number,
    parentSignal?: AbortSignal
): Promise<unknown> => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let rejectOnAbort: ((reason: unknown) => void) | undefined;

    const abortFromParent = () => {
        const reason =
            parentSignal?.reason ?? new DOMException("Aborted", "AbortError");
        controller.abort(reason);
        rejectOnAbort?.(reason);
    };
    if (parentSignal?.aborted) {
        abortFromParent();
        return Promise.reject(
            parentSignal.reason ?? new DOMException("Aborted", "AbortError")
        );
    }
    parentSignal?.addEventListener("abort", abortFromParent, { once: true });

    const timeoutPromise = new Promise<never>((_, reject) => {
        rejectOnAbort = reject;
        timeout = setTimeout(() => {
            const error = new PeerDialTimeoutError(address, timeoutMs);
            controller.abort(error);
            reject(error);
        }, timeoutMs);
    });
    const dialPromise = Promise.resolve().then(() =>
        dial(address, {
            dialTimeoutMs: timeoutMs,
            signal: controller.signal,
        })
    );

    return Promise.race([dialPromise, timeoutPromise]).finally(() => {
        if (timeout) {
            clearTimeout(timeout);
        }
        parentSignal?.removeEventListener("abort", abortFromParent);
        rejectOnAbort = undefined;
    });
};
