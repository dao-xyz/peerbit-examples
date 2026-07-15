// Direct all-hex labels under peerchecker.com are forbidden as static app pins.
// This policy does not claim that those hosts are offline and intentionally
// leaves named runtime bootstrap hosts untouched. Managed lease host/API shapes
// are reserved for planned support; a non-match here does not make them live.
const FORBIDDEN_STATIC_PEERCHECKER_HOST_PATTERN =
    /(?:^|%2f|[^a-z0-9-])([0-9a-f]{1,63}\.peerchecker\.com)(?![a-z0-9.-])/i;

export const findForbiddenStaticPeercheckerHost = (source) =>
    source.match(FORBIDDEN_STATIC_PEERCHECKER_HOST_PATTERN)?.[1];
