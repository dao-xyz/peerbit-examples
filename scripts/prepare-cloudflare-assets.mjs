import { execFileSync } from "node:child_process";
import {
    lstatSync,
    mkdirSync,
    readFileSync,
    readdirSync,
    realpathSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    findForbiddenStaticPeercheckerHost,
    hasAuthoritativeBootstrapEndpoint,
} from "./static-relay-policy.mjs";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, "cloudflare/sites.json"), "utf8")
);

const MAX_FILES = 20_000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set([".html", ".js", ".mjs", ".json", ".css"]);
const HEADERS = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin

/assets/*
  Cache-Control: public, max-age=31556952, immutable
`;

const commit = (
    process.env.COMMIT_HASH ||
    execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
    })
).trim();

if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(
        `Expected a full Git commit hash, received ${JSON.stringify(commit)}`
    );
}

const assertInsideRepo = (candidate) => {
    const relative = path.relative(repoRoot, candidate);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`Path escapes repository: ${candidate}`);
    }
};

const walk = (directory) => {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        const stat = lstatSync(fullPath);
        if (stat.isSymbolicLink()) {
            throw new Error(
                `Cloudflare assets may not contain symlinks: ${fullPath}`
            );
        }
        if (stat.isDirectory()) files.push(...walk(fullPath));
        else if (stat.isFile()) files.push({ path: fullPath, size: stat.size });
        else throw new Error(`Unsupported asset type: ${fullPath}`);
    }
    return files;
};

const localReferences = (html) =>
    [...html.matchAll(/(?:src|href)=["'](\/(?!\/)[^"'#?]*)/g)].map((match) =>
        decodeURIComponent(match[1])
    );

for (const site of manifest.staticSites) {
    const outputDirectory = path.resolve(repoRoot, site.directory);
    assertInsideRepo(outputDirectory);
    const canonicalOutput = realpathSync(outputDirectory);
    assertInsideRepo(canonicalOutput);

    const indexPath = path.join(canonicalOutput, "index.html");
    const indexHtml = readFileSync(indexPath, "utf8");
    if (!indexHtml.includes(`<title>${site.title}</title>`)) {
        throw new Error(
            `${site.id}: expected title ${JSON.stringify(site.title)}`
        );
    }

    for (const reference of localReferences(indexHtml)) {
        const referencedPath = path.join(canonicalOutput, reference.slice(1));
        assertInsideRepo(referencedPath);
        try {
            realpathSync(referencedPath);
        } catch {
            throw new Error(
                `${site.id}: missing local HTML asset ${reference}`
            );
        }
    }

    writeFileSync(path.join(canonicalOutput, "_headers"), HEADERS, "utf8");
    writeFileSync(
        path.join(canonicalOutput, "release.json"),
        `${JSON.stringify({
            commit,
            site: site.id,
            ...(site.accountAuth ? { accountAuth: site.accountAuth } : {}),
        })}\n`,
        "utf8"
    );

    const files = walk(canonicalOutput);
    if (files.length > MAX_FILES) {
        throw new Error(
            `${site.id}: ${files.length} files exceeds ${MAX_FILES}`
        );
    }
    const oversized = files.find((file) => file.size > MAX_FILE_BYTES);
    if (oversized) {
        throw new Error(
            `${site.id}: ${path.relative(repoRoot, oversized.path)} is ${oversized.size} bytes; Cloudflare allows ${MAX_FILE_BYTES}`
        );
    }
    if (!files.some((file) => path.extname(file.path) === ".wasm")) {
        throw new Error(
            `${site.id}: build is missing required WebAssembly assets`
        );
    }

    let searchable = "";
    for (const file of files) {
        if (
            TEXT_EXTENSIONS.has(path.extname(file.path)) &&
            file.size <= 8 * 1024 * 1024
        ) {
            searchable += readFileSync(file.path, "utf8");
        }
    }
    const forbiddenStaticHost = findForbiddenStaticPeercheckerHost(searchable);
    if (forbiddenStaticHost) {
        throw new Error(
            `${site.id}: build contains forbidden direct peerchecker host pin ${forbiddenStaticHost}`
        );
    }
    if (!hasAuthoritativeBootstrapEndpoint(searchable)) {
        throw new Error(
            `${site.id}: build is missing the authoritative bootstrap endpoint`
        );
    }

    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    const largest = files.reduce((max, file) =>
        file.size > max.size ? file : max
    );
    console.log(
        `${site.id}: ${files.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MiB, largest ${(
            largest.size /
            1024 /
            1024
        ).toFixed(2)} MiB`
    );
}
