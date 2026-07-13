import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const bootstrapUrl = "https://bootstrap.peerbit.org/bootstrap-5.env";
const productionRules = new Map([
    [
        "packages/media-streaming/video-streaming/frontend/src/App.tsx",
        ['? "local" : "remote"'],
    ],
    [
        "packages/media-streaming/music-library/frontend/src/App.tsx",
        [': "remote"'],
    ],
    ["packages/social-media-app/frontend/src/App.tsx", ['{ type: "remote" }']],
    [
        "packages/social-media-app/bots/joke-bot-cli/src/cli.ts",
        ["await client.bootstrap();"],
    ],
    [
        "packages/social-media-app/bots/news-bot-cli/src/cli.ts",
        ["await client.bootstrap();"],
    ],
    [
        "packages/social-media-app/bots/news-bot-cli/src/__tests__/prod-smoke.e2e.test.ts",
        [
            "await resolveBootstrapAddresses();",
            "await client.bootstrap(bootstrapAddrs);",
        ],
    ],
]);
const mirrorPath = "packages/social-media-app/network/src/index.ts";
const forbiddenHosts = [
    "9b97941c59a57bfe1cb9326c0adec2a1348e6940.peerchecker.com",
    "72e2dee3b6cc99167ecfb6114874cd9bf02f49e3.peerchecker.com",
    "0d028beb98c16f8eca4e1c9fb069dffd7a5a59ec.peerchecker.com",
];
const multiaddrPattern =
    /\/dns4\/[a-z0-9.-]+\/tcp\/4003\/wss\/p2p\/[1-9A-HJ-NP-Za-km-z]+/g;
const multiaddrLinePattern =
    /^\/dns4\/[a-z0-9.-]+\/tcp\/4003\/wss\/p2p\/[1-9A-HJ-NP-Za-km-z]+$/;

const productionSources = new Map(
    [...productionRules].map(([file]) => [
        file,
        readFileSync(path.join(repoRoot, file), "utf8"),
    ])
);
for (const [file, fragments] of productionRules) {
    const fileSource = productionSources.get(file);
    for (const fragment of fragments) {
        if (!fileSource.includes(fragment)) {
            throw new Error(
                `${file}: missing required runtime bootstrap path ${JSON.stringify(fragment)}`
            );
        }
    }
    if (fileSource.includes("BOOTSTRAP_ADDRS")) {
        throw new Error(
            `${file}: runtime code must not use the build-time bootstrap mirror`
        );
    }
}

const mirrorSource = readFileSync(path.join(repoRoot, mirrorPath), "utf8");
const source = [...productionSources.values(), mirrorSource].join("\n");
for (const host of forbiddenHosts) {
    if (source.includes(host))
        throw new Error(`Production source references retired relay ${host}`);
}

let response;
let lastError;
for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
        response = await fetch(bootstrapUrl, {
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        break;
    } catch (error) {
        lastError = error;
        if (attempt < 3)
            await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
}
if (!response?.ok)
    throw new Error(`Unable to read ${bootstrapUrl}: ${lastError}`);

const published = (await response.text()).split(/\r?\n/).filter(Boolean);
if (
    published.length === 0 ||
    published.some((line) => !multiaddrLinePattern.test(line))
) {
    throw new Error(`${bootstrapUrl} returned an invalid bootstrap list`);
}
const publishedSet = new Set(published);
const mirrored = [
    ...source.matchAll(new RegExp(multiaddrPattern.source, "g")),
].map((match) => match[0]);
if (mirrored.length === 0)
    throw new Error("Expected at least one reviewed build-time relay mirror");
for (const address of mirrored) {
    if (!publishedSet.has(address)) {
        throw new Error(
            `Source relay is not in the authoritative list: ${address}`
        );
    }
}

console.log(
    `Validated ${mirrored.length} source relay mirror(s) against ${bootstrapUrl}`
);
