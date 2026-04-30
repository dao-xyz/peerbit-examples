type PeerLike = {
    getMultiaddrs?: () => unknown[];
    libp2p?: {
        getMultiaddrs?: () => unknown[];
    };
};

export const getPeerDialAddresses = (peer: unknown): string[] => {
    const peerLike = peer as PeerLike | undefined;
    const addresses =
        peerLike?.getMultiaddrs?.() ??
        peerLike?.libp2p?.getMultiaddrs?.() ??
        [];
    const unique = new Set<string>();
    for (const address of addresses) {
        const value = address?.toString?.() ?? String(address ?? "");
        const trimmed = value.trim();
        if (trimmed) {
            unique.add(trimmed);
        }
    }
    return [...unique];
};

const getHashSearchParams = (url: URL) => {
    const queryIndex = url.hash.indexOf("?");
    return queryIndex === -1
        ? new URLSearchParams()
        : new URLSearchParams(url.hash.slice(queryIndex + 1));
};

const hasBootstrapOverride = (url: URL) =>
    url.searchParams.has("bootstrap") ||
    getHashSearchParams(url).has("bootstrap");

export const withSharePeerHints = (
    href: string,
    peerAddresses: string[],
    options: { skipWhenBootstrapPresent?: boolean } = {}
) => {
    const unique = [
        ...new Set(peerAddresses.map((address) => address.trim())),
    ].filter(Boolean);
    if (unique.length === 0) {
        return href;
    }

    const url = new URL(href);
    if (options.skipWhenBootstrapPresent && hasBootstrapOverride(url)) {
        return href;
    }

    url.searchParams.set("peer", unique.join(","));
    return url.toString();
};
