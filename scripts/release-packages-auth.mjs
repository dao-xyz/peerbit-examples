// How the release authenticates `npm publish`.
//
// npm trusted publishing needs no secret. In a GitHub Actions job granted
// `id-token: write`, the runner sets ACTIONS_ID_TOKEN_REQUEST_URL and
// ACTIONS_ID_TOKEN_REQUEST_TOKEN, and npm 11.5.1 or later exchanges the job's
// OIDC id-token for a short-lived token that publishes one package. This
// works only for a package whose trusted publisher on npmjs.com names this
// repository and workflow file, has no environment, and allows npm publish.
//
// An npm token in NPM_TOKEN or NODE_AUTH_TOKEN is an optional fallback: npm
// tries the exchange first and, when the exchange fails, publishes with the
// configured token without a warning, for example for a package without a
// trusted publisher (npm/cli lib/utils/oidc.js). In GitHub Actions a missing
// secret reads as an empty string, which counts as no token.

/** The first npm release that publishes with trusted publishing. */
export const TRUSTED_PUBLISHING_NPM_VERSION = "11.5.1";

const parseVersion = (version) =>
    /^v?(\d+)\.(\d+)\.(\d+)/
        .exec(version?.trim() ?? "")
        ?.slice(1)
        .map(Number);

/**
 * Whether an npm version can publish with trusted publishing.
 *
 * @param {string | undefined} version what `npm --version` printed
 * @returns {boolean}
 */
export const npmCanUseTrustedPublishing = (version) => {
    const actual = parseVersion(version);
    if (!actual) {
        return false;
    }
    const required = parseVersion(TRUSTED_PUBLISHING_NPM_VERSION);
    const differs = actual.findIndex((part, index) => part !== required[index]);
    return differs === -1 || actual[differs] > required[differs];
};

/**
 * How `npm publish` can authenticate, or why it cannot.
 *
 * @param {Record<string, string | undefined>} env the environment
 * @param {string | undefined} npmVersion what `npm --version` printed
 * @returns {{ ok: true, trustedPublishing: boolean, summary: string }
 *     | { ok: false, reason: string }}
 */
export const npmPublishAuth = (env, npmVersion) => {
    const token = Boolean(env.NPM_TOKEN || env.NODE_AUTH_TOKEN);
    const idToken = Boolean(
        env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
    );
    const npm = `npm ${npmVersion || "(unknown version)"}`;

    if (idToken && npmCanUseTrustedPublishing(npmVersion)) {
        return {
            ok: true,
            trustedPublishing: true,
            summary: token
                ? `npm trusted publishing (${npm}), with the npm token as fallback`
                : `npm trusted publishing (${npm})`,
        };
    }
    if (token) {
        return {
            ok: true,
            trustedPublishing: false,
            summary: idToken
                ? `the npm token: ${npm} predates trusted publishing (${TRUSTED_PUBLISHING_NPM_VERSION})`
                : "the npm token",
        };
    }
    if (idToken) {
        return {
            ok: false,
            reason: `${npm} cannot use npm trusted publishing, which needs npm ${TRUSTED_PUBLISHING_NPM_VERSION} or later (Node 24.5.0 and later bundle one). Publish with a newer npm or set NPM_TOKEN or NODE_AUTH_TOKEN.`,
        };
    }
    return {
        ok: false,
        reason: `Publishing needs npm trusted publishing or an npm token. Trusted publishing runs in GitHub Actions with \`permissions: id-token: write\`, npm ${TRUSTED_PUBLISHING_NPM_VERSION} or later and a trusted publisher on npmjs.com for each package; a token goes in NPM_TOKEN or NODE_AUTH_TOKEN.`,
    };
};
