import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenStaticPeercheckerHost } from "./static-relay-policy.mjs";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const productionRules = new Map([
    [
        "packages/media-streaming/video-streaming/frontend/src/App.tsx",
        ['? "local" : "remote"'],
    ],
    [
        "packages/media-streaming/music-library/frontend/src/App.tsx",
        [': "remote"'],
    ],
]);
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
            `${file}: runtime code must not use build-time bootstrap addresses`
        );
    }
}

const source = [...productionSources.values()].join("\n");
const forbiddenStaticHost = findForbiddenStaticPeercheckerHost(source);
if (forbiddenStaticHost) {
    throw new Error(
        `Production source contains forbidden direct peerchecker host pin ${forbiddenStaticHost}`
    );
}

console.log(
    `Validated ${productionRules.size} production app bootstrap configurations`
);
