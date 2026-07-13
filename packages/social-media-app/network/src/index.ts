// Build-time preconnect hint only. Runtime clients resolve the authoritative
// bootstrap list from bootstrap.peerbit.org instead of relying on this mirror.
export const BOOTSTRAP_ADDRS: string[] = [
    "/dns4/c1a6d282da315d303a152b32946c0b87eaae7b62.peerchecker.com/tcp/4003/wss/p2p/12D3KooWKj1J1hHxrYyB37qDDGCi9aU2vcHzDZhtMk7te7dEmqqT",
];

export type BootstrapMode = "prod" | "local" | "offline";
