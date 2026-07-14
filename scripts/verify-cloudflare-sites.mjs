import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, "cloudflare/sites.json"), "utf8")
);

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index];
    const value = process.argv[index + 1];
    if (!key?.startsWith("--") || value == null) {
        throw new Error(
            "Usage: verify-cloudflare-sites.mjs --mode production [--commit SHA] [--target apps|all] [--site ID]"
        );
    }
    args.set(key.slice(2), value);
}
const mode = args.get("mode");
if (mode !== "production") {
    throw new Error("Public preview verification is disabled");
}
const expectedCommit = args.get("commit");
if (expectedCommit && !/^[0-9a-f]{40}$/i.test(expectedCommit)) {
    throw new Error("--commit must be a full Git commit hash");
}
const target = args.get("target") || "all";
if (!["apps", "all"].includes(target)) {
    throw new Error("--target must be apps or all");
}
const requestedSite = args.get("site");
if (requestedSite && args.has("target")) {
    throw new Error("--site and --target are mutually exclusive");
}
const allSites = [...manifest.staticSites, ...manifest.redirects];
if (
    requestedSite &&
    (!/^[a-z0-9-]+$/.test(requestedSite) ||
        !allSites.some((entry) => entry.id === requestedSite))
) {
    throw new Error(`Unknown Cloudflare site: ${requestedSite}`);
}

const request = async (url, init = {}) => {
    try {
        const response = await fetch(url, {
            ...init,
            signal: AbortSignal.timeout(15_000),
        });
        if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
        return response;
    } catch (error) {
        throw new Error(`${url}: ${error}`);
    }
};
// A newly deployed Worker and its asset metadata can take more than a minute
// to converge at the data center used by the verifier. Keep retrying long
// enough to distinguish propagation from a persistent range-handling defect.
const VERIFY_ATTEMPTS = 150;
const VERIFY_RETRY_DELAY_MS = 2_000;
const verifyEventually = async (label, check) => {
    let lastError;
    for (let attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1) {
        try {
            await check();
            return;
        } catch (error) {
            lastError = error;
            if (attempt < VERIFY_ATTEMPTS) {
                await new Promise((resolve) =>
                    setTimeout(resolve, VERIFY_RETRY_DELAY_MS)
                );
            }
        }
    }
    throw new Error(`${label} did not converge: ${lastError}`);
};
const originsFor = (entry) =>
    entry.domains.map((domain) => `https://${domain}`);

const selectedStaticSites = requestedSite
    ? manifest.staticSites.filter((site) => site.id === requestedSite)
    : manifest.staticSites;
for (const site of selectedStaticSites) {
    for (const origin of originsFor(site)) {
        await verifyEventually(origin, async () => {
            const root = await request(`${origin}/`);
            if (root.status !== 200)
                throw new Error(`${origin}/: HTTP ${root.status}`);
            const html = await root.text();
            if (!html.includes(`<title>${site.title}</title>`)) {
                throw new Error(`${origin}/: unexpected title`);
            }
            if (root.headers.get("x-content-type-options") !== "nosniff") {
                throw new Error(`${origin}/: missing nosniff header`);
            }
            if (
                root.headers.get("referrer-policy") !==
                "strict-origin-when-cross-origin"
            ) {
                throw new Error(`${origin}/: missing referrer policy`);
            }
            if (!/max-age=0/.test(root.headers.get("cache-control") || "")) {
                throw new Error(`${origin}/: HTML must revalidate`);
            }

            const releaseResponse = await request(`${origin}/release.json`);
            if (releaseResponse.status !== 200) {
                throw new Error(
                    `${origin}/release.json: HTTP ${releaseResponse.status}`
                );
            }
            const release = await releaseResponse.json();
            if (release.site !== site.id)
                throw new Error(`${origin}: wrong release site id`);
            if (site.accountAuth && release.accountAuth !== site.accountAuth) {
                throw new Error(
                    `${origin}: expected account auth ${site.accountAuth}, found ${release.accountAuth}`
                );
            }
            if (expectedCommit && release.commit !== expectedCommit) {
                throw new Error(
                    `${origin}: expected release ${expectedCommit}, found ${release.commit}`
                );
            }

            const assetPath = html.match(
                /(?:src|href)=["'](\/assets\/[^"']+)/
            )?.[1];
            if (!assetPath) {
                throw new Error(
                    `${origin}: index has no hashed asset reference`
                );
            }
            const asset = await request(`${origin}${assetPath}`);
            if (asset.status !== 200)
                throw new Error(`${origin}${assetPath}: HTTP ${asset.status}`);
            if (!/immutable/.test(asset.headers.get("cache-control") || "")) {
                throw new Error(
                    `${origin}${assetPath}: hashed asset is not immutable`
                );
            }
            const etag = asset.headers.get("etag");
            if (!etag) throw new Error(`${origin}${assetPath}: missing ETag`);
            const conditional = await request(`${origin}${assetPath}`, {
                headers: { "If-None-Match": etag },
            });
            if (conditional.status !== 304) {
                throw new Error(
                    `${origin}${assetPath}: conditional request returned ${conditional.status}`
                );
            }

            const missing = await request(
                `${origin}/missing-peerbit-asset-${site.id}-62999`
            );
            if (missing.status !== 404)
                throw new Error(
                    `${origin}: missing asset returned ${missing.status}`
                );
            const hiddenHeaders = await request(`${origin}/_headers`);
            if (hiddenHeaders.status !== 404)
                throw new Error(`${origin}: _headers is publicly served`);

            for (const mediaPath of site.workerFirst || []) {
                const fixture = readFileSync(
                    path.join(repoRoot, site.directory, mediaPath)
                );
                const media = await request(`${origin}${mediaPath}`, {
                    headers: { Range: "bytes=0-1023" },
                });
                if (media.status !== 206) {
                    throw new Error(
                        `${origin}${mediaPath}: range request returned ${media.status}`
                    );
                }
                const expectedContentRange = `bytes 0-1023/${fixture.length}`;
                if (
                    media.headers.get("content-range") !== expectedContentRange
                ) {
                    throw new Error(
                        `${origin}${mediaPath}: invalid Content-Range header`
                    );
                }
                if (media.headers.get("content-length") !== "1024") {
                    throw new Error(
                        `${origin}${mediaPath}: invalid range Content-Length`
                    );
                }
                const acceptRanges = media.headers.get("accept-ranges");
                if (acceptRanges && acceptRanges !== "bytes") {
                    throw new Error(
                        `${origin}${mediaPath}: invalid Accept-Ranges header`
                    );
                }
                if (!media.headers.get("etag")) {
                    throw new Error(`${origin}${mediaPath}: missing ETag`);
                }
                const rangeBody = Buffer.from(await media.arrayBuffer());
                if (!rangeBody.equals(fixture.subarray(0, 1024))) {
                    throw new Error(
                        `${origin}${mediaPath}: range body differs from source`
                    );
                }

                const cachedRange = await request(`${origin}${mediaPath}`, {
                    headers: { Range: "bytes=1024-2047" },
                });
                if (cachedRange.status !== 206) {
                    throw new Error(
                        `${origin}${mediaPath}: second range returned ${cachedRange.status}`
                    );
                }
                if (
                    cachedRange.headers.get("content-range") !==
                    `bytes 1024-2047/${fixture.length}`
                ) {
                    throw new Error(
                        `${origin}${mediaPath}: invalid cached Content-Range header`
                    );
                }
                if (cachedRange.headers.get("content-length") !== "1024") {
                    throw new Error(
                        `${origin}${mediaPath}: invalid cached range Content-Length`
                    );
                }
                const cachedAcceptRanges =
                    cachedRange.headers.get("accept-ranges");
                if (cachedAcceptRanges && cachedAcceptRanges !== "bytes") {
                    throw new Error(
                        `${origin}${mediaPath}: cached range has an invalid Accept-Ranges header`
                    );
                }
                if (cachedRange.headers.get("cf-cache-status") !== "HIT") {
                    throw new Error(
                        `${origin}${mediaPath}: second range was not a cache hit`
                    );
                }
                const cachedBody = Buffer.from(await cachedRange.arrayBuffer());
                if (!cachedBody.equals(fixture.subarray(1024, 2048))) {
                    throw new Error(
                        `${origin}${mediaPath}: cached range differs from source`
                    );
                }

                const unsatisfiable = await request(`${origin}${mediaPath}`, {
                    headers: { Range: `bytes=${fixture.length}-` },
                });
                if (
                    unsatisfiable.status !== 416 ||
                    unsatisfiable.headers.get("content-range") !==
                        `bytes */${fixture.length}`
                ) {
                    throw new Error(
                        `${origin}${mediaPath}: invalid unsatisfiable range response`
                    );
                }
            }
        });

        console.log(`${site.id}: verified ${origin}`);
    }
}

const selectedRedirects = requestedSite
    ? manifest.redirects.filter((redirect) => redirect.id === requestedSite)
    : target === "apps"
      ? []
      : manifest.redirects;
for (const redirect of selectedRedirects) {
    for (const origin of originsFor(redirect)) {
        await verifyEventually(origin, async () => {
            const response = await request(`${origin}/retired/path?ignored=1`, {
                redirect: "manual",
            });
            if (response.status !== redirect.status) {
                throw new Error(
                    `${origin}: expected redirect ${redirect.status}, found ${response.status}`
                );
            }
            if (response.headers.get("location") !== redirect.location) {
                throw new Error(`${origin}: unexpected redirect target`);
            }
        });
        console.log(`${redirect.id}: verified ${origin}`);
    }
}
