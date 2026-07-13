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
            "Usage: verify-cloudflare-sites.mjs --mode preview|production [--subdomain NAME] [--commit SHA]"
        );
    }
    args.set(key.slice(2), value);
}
const mode = args.get("mode");
if (mode !== "preview" && mode !== "production") {
    throw new Error("--mode must be preview or production");
}
const subdomain = args.get("subdomain");
if (mode === "preview" && !/^[a-z0-9-]+$/i.test(subdomain || "")) {
    throw new Error("Preview verification requires --subdomain");
}
const expectedCommit = args.get("commit");
if (expectedCommit && !/^[0-9a-f]{40}$/i.test(expectedCommit)) {
    throw new Error("--commit must be a full Git commit hash");
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
const verifyEventually = async (label, check) => {
    let lastError;
    for (let attempt = 1; attempt <= 30; attempt += 1) {
        try {
            await check();
            return;
        } catch (error) {
            lastError = error;
            if (attempt < 30)
                await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
    }
    throw new Error(`${label} did not converge: ${lastError}`);
};
const originsFor = (entry) =>
    mode === "preview"
        ? [`https://${entry.worker}-preview.${subdomain}.workers.dev`]
        : entry.domains.map((domain) => `https://${domain}`);

for (const site of manifest.staticSites) {
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

            if (site.id === "stream") {
                const media = await request(`${origin}/bird.mp4`, {
                    headers: { Range: "bytes=0-1023" },
                });
                if (media.status !== 206) {
                    throw new Error(
                        `${origin}/bird.mp4: range request returned ${media.status}`
                    );
                }
                if (
                    !/^bytes 0-1023\/\d+$/.test(
                        media.headers.get("content-range") || ""
                    )
                ) {
                    throw new Error(
                        `${origin}/bird.mp4: invalid Content-Range header`
                    );
                }
                if ((await media.arrayBuffer()).byteLength !== 1024) {
                    throw new Error(
                        `${origin}/bird.mp4: range body has the wrong size`
                    );
                }
            }
        });

        console.log(`${site.id}: verified ${origin}`);
    }
}

for (const redirect of manifest.redirects) {
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
