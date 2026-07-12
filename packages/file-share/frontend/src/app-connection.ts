export type PeerOverrideAction =
    | "wait-for-peer"
    | "ready-without-explicit-dial"
    | "dial-explicit-peers";

export type PeerDialStatus = "pending" | "fulfilled" | "rejected";
export type PeerDialOutcome = "pending" | "ready" | "failed";

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
