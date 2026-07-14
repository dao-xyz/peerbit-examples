import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
const forbiddenHosts = [
    "9b97941c59a57bfe1cb9326c0adec2a1348e6940.peerchecker.com",
    "72e2dee3b6cc99167ecfb6114874cd9bf02f49e3.peerchecker.com",
    "0d028beb98c16f8eca4e1c9fb069dffd7a5a59ec.peerchecker.com",
];
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
for (const host of forbiddenHosts) {
    if (source.includes(host))
        throw new Error(`Production source references retired relay ${host}`);
}

console.log(
    `Validated ${productionRules.size} production app bootstrap configurations`
);
