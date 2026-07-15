// Concrete all-hex labels directly under peerchecker.com are retired relay
// leases. Current operational leases use p-<hex>.nodes.peerchecker.com, while
// canonical bootstrap and DNS APIs use named hosts.
const STATIC_PEERCHECKER_RELAY_HOST_PATTERN =
    /(?:^|%2f|[^a-z0-9-])([0-9a-f]{1,63}\.peerchecker\.com)(?![a-z0-9.-])/i;

export const findStaticPeercheckerRelayHost = (source) =>
    source.match(STATIC_PEERCHECKER_RELAY_HOST_PATTERN)?.[1];
