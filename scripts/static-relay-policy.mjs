// Direct all-hex labels under peerchecker.com are forbidden as static app pins.
// This policy does not claim that those hosts are offline and intentionally
// leaves named runtime bootstrap hosts untouched. Managed lease host/API shapes
// are reserved for planned support; a non-match here does not make them live.
const FORBIDDEN_STATIC_PEERCHECKER_HOST_PATTERN =
    /(?:^|%2f|[^a-z0-9-])([0-9a-f]{1,63}\.peerchecker\.com)(?![a-z0-9.-])/i;

export const findForbiddenStaticPeercheckerHost = (source) =>
    source.match(FORBIDDEN_STATIC_PEERCHECKER_HOST_PATTERN)?.[1];

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const hasAuthoritativeBootstrapEndpoint = (source) => {
    if (source.includes("https://bootstrap.peerbit.org/bootstrap")) {
        return true;
    }

    // Newer Peerbit clients validate a version before composing the filename,
    // so bundlers retain a linked filename variable rather than one contiguous
    // URL literal. Accept only that exact bootstrap*.env template when the same
    // identifier is interpolated into the authoritative HTTPS origin.
    const filename = source.match(
        /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*`bootstrap\$\{[^`]*\}\.env`/
    );
    if (!filename) {
        return false;
    }
    const identifier = escapeRegExp(filename[1]);
    return new RegExp(
        `https:\\/\\/bootstrap\\.peerbit\\.org\\/\\$\\{${identifier}\\}`
    ).test(source);
};
