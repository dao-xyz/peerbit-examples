#!/usr/bin/env node

import { build as esbuild } from "esbuild";
import { createHash, randomUUID } from "node:crypto";
import {
    access,
    chmod,
    cp,
    mkdir,
    readFile,
    realpath,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const JAVASCRIPT_PATTERN = /\.js$/;
const JAVASCRIPT_SOURCE_MAP_PATTERN = /\.js\.map$/;
const DECLARATION_PATTERN = /\.d\.[cm]?ts$/;
const SOURCE_MAP_COMMENT_PATTERN =
    /\/\/[#@]\s*sourceMappingURL=([^\s]+)\s*$/gmu;

const normalizePath = (value) => value.replaceAll("\\", "/");

const comparePaths = (left, right) =>
    left < right ? -1 : left > right ? 1 : 0;

const digest = (value) => createHash("sha256").update(value).digest("hex");

const fail = (message) => {
    throw new Error(`shared-fs emitted-JS compaction: ${message}`);
};

const listFiles = async (root) => {
    const files = [];

    const visit = async (relativeDirectory) => {
        const directory = path.join(root, relativeDirectory);
        const entries = await readdir(directory, { withFileTypes: true });
        entries.sort((left, right) => comparePaths(left.name, right.name));

        for (const entry of entries) {
            const relativePath = path.join(relativeDirectory, entry.name);
            if (entry.isDirectory()) {
                await visit(relativePath);
            } else if (entry.isFile()) {
                files.push(normalizePath(relativePath));
            } else {
                fail(`unsupported output entry ${normalizePath(relativePath)}`);
            }
        }
    };

    await visit("");
    return files;
};

const snapshotFiles = async (root, relativePaths) => {
    const snapshot = new Map();
    for (const relativePath of relativePaths) {
        const absolutePath = path.join(root, relativePath);
        const [contents, metadata] = await Promise.all([
            readFile(absolutePath),
            stat(absolutePath),
        ]);
        snapshot.set(relativePath, {
            bytes: contents.byteLength,
            digest: digest(contents),
            mode: metadata.mode & 0o777,
        });
    }
    return snapshot;
};

const snapshotBytes = (snapshot) =>
    [...snapshot.values()].reduce((total, file) => total + file.bytes, 0);

const snapshotSubset = (snapshot, predicate) =>
    Object.fromEntries(
        [...snapshot.entries()]
            .filter(([relativePath]) => predicate(relativePath))
            .map(([relativePath, value]) => [relativePath, value])
    );

const assertEqual = (actual, expected, message) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        fail(message);
    }
};

const compactionArtifactPrefix = (outputDirectory) =>
    `.${path.basename(outputDirectory)}.compact-`;

export const assertNoStaleCompactionDirectories = async (outputDirectory) => {
    const absoluteOutput = await realpath(path.resolve(outputDirectory));
    const parent = path.dirname(absoluteOutput);
    const prefix = compactionArtifactPrefix(absoluteOutput);
    const entries = await readdir(parent, { withFileTypes: true });
    const stale = entries
        .filter((entry) => entry.name.startsWith(prefix))
        .map((entry) => entry.name)
        .sort(comparePaths);
    if (stale.length > 0) {
        fail(`stale sibling artifacts remain: ${stale.join(", ")}`);
    }
};

const moduleImportShape = (moduleImport) => ({
    path: moduleImport.path,
    kind: moduleImport.kind,
    external: moduleImport.external === true,
    ...(moduleImport.with ? { with: moduleImport.with } : {}),
});

export const inspectEsmSurfaces = async (outputDirectory) => {
    const absoluteOutput = await realpath(path.resolve(outputDirectory));
    const files = await listFiles(absoluteOutput);
    const javascript = files.filter((file) => JAVASCRIPT_PATTERN.test(file));
    if (javascript.length === 0) {
        fail(`${absoluteOutput} contains no emitted JavaScript`);
    }

    const analysis = await esbuild({
        absWorkingDir: absoluteOutput,
        entryPoints: javascript.map((file) => `./${normalizePath(file)}`),
        outbase: absoluteOutput,
        outdir: path.join(absoluteOutput, ".surface-analysis"),
        bundle: false,
        format: "esm",
        platform: "neutral",
        target: "es2022",
        write: false,
        metafile: true,
        logLevel: "silent",
    });

    const surfaces = {};
    for (const output of Object.values(analysis.metafile.outputs)) {
        if (!output.entryPoint) {
            continue;
        }
        const relativePath = normalizePath(
            path.relative(
                absoluteOutput,
                path.resolve(absoluteOutput, output.entryPoint)
            )
        );
        const input = analysis.metafile.inputs[output.entryPoint];
        surfaces[relativePath] = {
            format: input?.format ?? null,
            exports: [...output.exports].sort(comparePaths),
            imports: output.imports.map(moduleImportShape),
        };
    }

    return Object.fromEntries(
        Object.entries(surfaces).sort(([left], [right]) =>
            comparePaths(left, right)
        )
    );
};

const copyDirectoryContents = async (source, destination) => {
    await mkdir(destination);
    const entries = await readdir(source);
    for (const entry of entries) {
        await cp(path.join(source, entry), path.join(destination, entry), {
            recursive: true,
            preserveTimestamps: true,
        });
    }
};

const appendSourceMapLinks = async (candidate, javascript) => {
    for (const relativePath of javascript) {
        const javascriptPath = path.join(candidate, relativePath);
        const contents = await readFile(javascriptPath, "utf8");
        SOURCE_MAP_COMMENT_PATTERN.lastIndex = 0;
        const comments = [...contents.matchAll(SOURCE_MAP_COMMENT_PATTERN)];
        const expectedReference = `${path.basename(relativePath)}.map`;
        if (comments.length === 1 && comments[0][1] === expectedReference) {
            continue;
        }
        if (comments.length > 0) {
            fail(`${relativePath} retained an unexpected source-map link`);
        }
        const separator = contents.endsWith("\n") ? "" : "\n";
        await writeFile(
            javascriptPath,
            `${contents}${separator}//# sourceMappingURL=${expectedReference}\n`
        );
    }
};

const assertFreshTypeScriptOutput = async (outputDirectory, javascript) => {
    for (const relativePath of javascript) {
        const javascriptPath = path.join(outputDirectory, relativePath);
        const contents = await readFile(javascriptPath, "utf8");
        SOURCE_MAP_COMMENT_PATTERN.lastIndex = 0;
        const comments = [...contents.matchAll(SOURCE_MAP_COMMENT_PATTERN)];
        const expectedReference = `${path.basename(relativePath)}.map`;
        if (comments.length !== 1 || comments[0][1] !== expectedReference) {
            fail(
                `${relativePath} is not fresh TypeScript output with one local source-map link`
            );
        }

        let sourceMap;
        try {
            sourceMap = JSON.parse(
                await readFile(
                    path.join(path.dirname(javascriptPath), expectedReference),
                    "utf8"
                )
            );
        } catch (error) {
            fail(
                `${relativePath} does not have a readable TypeScript source map: ${error instanceof Error ? error.message : error}`
            );
        }
        if (sourceMap.file !== path.basename(relativePath)) {
            fail(
                `${relativePath} source map is not fresh TypeScript output; run the package build from its clean step`
            );
        }
    }
};

const buildCandidate = async ({
    source,
    destination,
    javascript,
    originalSnapshot,
}) => {
    await copyDirectoryContents(source, destination);
    await esbuild({
        absWorkingDir: source,
        entryPoints: javascript.map((file) => `./${normalizePath(file)}`),
        outbase: source,
        outdir: destination,
        bundle: false,
        format: "esm",
        platform: "neutral",
        target: "es2022",
        sourcemap: "external",
        sourcesContent: false,
        minifyWhitespace: true,
        minifyIdentifiers: false,
        minifySyntax: false,
        lineLimit: 80,
        charset: "utf8",
        write: true,
        logLevel: "silent",
    });
    await appendSourceMapLinks(destination, javascript);

    for (const relativePath of javascript) {
        await chmod(
            path.join(destination, relativePath),
            originalSnapshot.get(relativePath).mode
        );
        const sourceMapPath = `${relativePath}.map`;
        await chmod(
            path.join(destination, sourceMapPath),
            originalSnapshot.get(sourceMapPath).mode
        );
    }
};

const sourceMapReference = (sourceRoot, source) => {
    const combined = sourceRoot ? `${sourceRoot}/${source}` : source;
    return combined.replaceAll("/", path.sep);
};

const verifySourceMaps = async (outputDirectory, javascript) => {
    const sourceDirectory = await realpath(
        path.resolve(outputDirectory, "..", "..", "src")
    );
    for (const relativePath of javascript) {
        const javascriptPath = path.join(outputDirectory, relativePath);
        const contents = await readFile(javascriptPath, "utf8");
        SOURCE_MAP_COMMENT_PATTERN.lastIndex = 0;
        const comments = [...contents.matchAll(SOURCE_MAP_COMMENT_PATTERN)];
        if (comments.length !== 1) {
            fail(
                `${relativePath} has ${comments.length} source-map links instead of one`
            );
        }

        const mapReference = comments[0][1];
        if (/^[a-z]+:/iu.test(mapReference) || path.isAbsolute(mapReference)) {
            fail(`${relativePath} uses a non-local source-map link`);
        }
        const mapPath = path.resolve(
            path.dirname(javascriptPath),
            mapReference
        );
        await access(mapPath);

        let sourceMap;
        try {
            sourceMap = JSON.parse(await readFile(mapPath, "utf8"));
        } catch (error) {
            fail(
                `${relativePath} has an invalid source map: ${error instanceof Error ? error.message : error}`
            );
        }
        if (sourceMap.version !== 3 || !Array.isArray(sourceMap.sources)) {
            fail(`${relativePath} has an invalid source-map schema`);
        }
        if (Object.hasOwn(sourceMap, "sourcesContent")) {
            fail(`${relativePath} embeds sourcesContent`);
        }
        if (sourceMap.sources.length === 0) {
            fail(`${relativePath} source map has no source targets`);
        }

        for (const source of sourceMap.sources) {
            if (/^[a-z]+:/iu.test(source)) {
                fail(
                    `${relativePath} source map has a non-local source target`
                );
            }
            const sourcePath = path.resolve(
                path.dirname(mapPath),
                sourceMapReference(sourceMap.sourceRoot ?? "", source)
            );
            const portableReference = normalizePath(
                path.normalize(
                    sourceMapReference(sourceMap.sourceRoot ?? "", source)
                )
            );
            const shortestReference = normalizePath(
                path.relative(path.dirname(mapPath), sourcePath)
            );
            if (portableReference !== shortestReference) {
                fail(
                    `${relativePath} source map has a non-portable source target: ${source}`
                );
            }
            try {
                await access(sourcePath);
            } catch {
                fail(
                    `${relativePath} source map target does not exist: ${normalizePath(
                        path.relative(outputDirectory, sourcePath)
                    )}`
                );
            }
            const canonicalSource = await realpath(sourcePath);
            const sourceRelative = path.relative(
                sourceDirectory,
                canonicalSource
            );
            if (
                sourceRelative === ".." ||
                sourceRelative.startsWith(`..${path.sep}`) ||
                path.isAbsolute(sourceRelative)
            ) {
                fail(
                    `${relativePath} source map target is outside the packed src tree: ${source}`
                );
            }
        }
    }
};

const readShebangs = async (outputDirectory, relativePaths) => {
    const shebangs = {};
    for (const relativePath of relativePaths) {
        if (!JAVASCRIPT_PATTERN.test(relativePath)) {
            continue;
        }
        const contents = await readFile(
            path.join(outputDirectory, relativePath),
            "utf8"
        );
        if (contents.startsWith("#!")) {
            shebangs[relativePath] = contents.split(/\r?\n/u, 1)[0];
        }
    }
    return shebangs;
};

const verifyCandidate = async ({
    candidate,
    files,
    javascript,
    originalSnapshot,
    originalSurfaces,
    originalShebangs,
}) => {
    const candidateFiles = await listFiles(candidate);
    if (JSON.stringify(candidateFiles) !== JSON.stringify(files)) {
        const originalSet = new Set(files);
        const candidateSet = new Set(candidateFiles);
        fail(
            `candidate changed the output file set (removed: ${
                files.filter((file) => !candidateSet.has(file)).join(", ") ||
                "none"
            }; added: ${
                candidateFiles
                    .filter((file) => !originalSet.has(file))
                    .join(", ") || "none"
            })`
        );
    }

    const candidateSnapshot = await snapshotFiles(candidate, candidateFiles);
    assertEqual(
        Object.fromEntries(
            [...candidateSnapshot].map(([file, value]) => [file, value.mode])
        ),
        Object.fromEntries(
            [...originalSnapshot].map(([file, value]) => [file, value.mode])
        ),
        "candidate changed output file modes"
    );
    assertEqual(
        snapshotSubset(
            candidateSnapshot,
            (file) =>
                !JAVASCRIPT_PATTERN.test(file) &&
                !JAVASCRIPT_SOURCE_MAP_PATTERN.test(file)
        ),
        snapshotSubset(
            originalSnapshot,
            (file) =>
                !JAVASCRIPT_PATTERN.test(file) &&
                !JAVASCRIPT_SOURCE_MAP_PATTERN.test(file)
        ),
        "candidate changed a non-JavaScript output"
    );
    assertEqual(
        snapshotSubset(candidateSnapshot, (file) =>
            DECLARATION_PATTERN.test(file)
        ),
        snapshotSubset(originalSnapshot, (file) =>
            DECLARATION_PATTERN.test(file)
        ),
        "candidate changed declaration checksums"
    );
    assertEqual(
        await readShebangs(candidate, candidateFiles),
        originalShebangs,
        "candidate changed an emitted shebang"
    );

    await verifySourceMaps(candidate, javascript);
    assertEqual(
        await inspectEsmSurfaces(candidate),
        originalSurfaces,
        "candidate changed the ESM import/export surface"
    );

    return candidateSnapshot;
};

const replaceDirectory = async ({ current, candidate, backup }) => {
    await rename(current, backup);
    try {
        await rename(candidate, current);
    } catch (swapError) {
        try {
            await rename(backup, current);
        } catch (restoreError) {
            throw new AggregateError(
                [swapError, restoreError],
                "could not install the candidate or restore the original output"
            );
        }
        throw swapError;
    }

    try {
        await rm(backup, { recursive: true });
    } catch (cleanupError) {
        try {
            await rename(current, candidate);
            await rename(backup, current);
        } catch (restoreError) {
            throw new AggregateError(
                [cleanupError, restoreError],
                "could not remove the backup or restore the original output"
            );
        }
        throw cleanupError;
    }
};

export const verifyCompactedOutput = async ({
    outputDirectory,
    expectedShebangs = {},
}) => {
    const absoluteOutput = await realpath(path.resolve(outputDirectory));
    const files = await listFiles(absoluteOutput);
    const javascript = files.filter((file) => JAVASCRIPT_PATTERN.test(file));
    if (javascript.length === 0) {
        fail(`${absoluteOutput} contains no emitted JavaScript`);
    }
    await verifySourceMaps(absoluteOutput, javascript);
    await inspectEsmSurfaces(absoluteOutput);
    const actualShebangs = await readShebangs(absoluteOutput, files);
    assertEqual(
        actualShebangs,
        expectedShebangs,
        "emitted shebang set changed unexpectedly"
    );
    await assertNoStaleCompactionDirectories(absoluteOutput);

    return {
        files: files.length,
        javascript: javascript.length,
    };
};

export const compactEmittedJavaScript = async ({
    outputDirectory,
    beforeSwap = async () => undefined,
}) => {
    const absoluteOutput = await realpath(path.resolve(outputDirectory));
    const metadata = await stat(absoluteOutput);
    if (!metadata.isDirectory()) {
        fail(`${absoluteOutput} is not a directory`);
    }
    await assertNoStaleCompactionDirectories(absoluteOutput);

    const parent = path.dirname(absoluteOutput);
    const prefix = compactionArtifactPrefix(absoluteOutput);
    const candidate = path.join(parent, `${prefix}staging-${randomUUID()}`);
    const duplicate = path.join(parent, `${prefix}verify-${randomUUID()}`);
    const backup = path.join(parent, `${prefix}backup-${randomUUID()}`);

    const files = await listFiles(absoluteOutput);
    const javascript = files.filter((file) => JAVASCRIPT_PATTERN.test(file));
    if (javascript.length === 0) {
        fail(`${absoluteOutput} contains no emitted JavaScript`);
    }
    await assertFreshTypeScriptOutput(absoluteOutput, javascript);
    const originalSnapshot = await snapshotFiles(absoluteOutput, files);
    const originalSurfaces = await inspectEsmSurfaces(absoluteOutput);
    const originalShebangs = await readShebangs(absoluteOutput, files);

    try {
        await buildCandidate({
            source: absoluteOutput,
            destination: candidate,
            javascript,
            originalSnapshot,
        });
        await buildCandidate({
            source: absoluteOutput,
            destination: duplicate,
            javascript,
            originalSnapshot,
        });

        const candidateSnapshot = await verifyCandidate({
            candidate,
            files,
            javascript,
            originalSnapshot,
            originalSurfaces,
            originalShebangs,
        });
        const duplicateSnapshot = await verifyCandidate({
            candidate: duplicate,
            files,
            javascript,
            originalSnapshot,
            originalSurfaces,
            originalShebangs,
        });
        assertEqual(
            Object.fromEntries(candidateSnapshot),
            Object.fromEntries(duplicateSnapshot),
            "esbuild output is not deterministic"
        );

        await beforeSwap({ candidate, duplicate });
        await rm(duplicate, { recursive: true });
        await replaceDirectory({
            current: absoluteOutput,
            candidate,
            backup,
        });

        return {
            files: files.length,
            javascript: javascript.length,
            beforeBytes: snapshotBytes(originalSnapshot),
            afterBytes: snapshotBytes(candidateSnapshot),
        };
    } finally {
        await Promise.all([
            rm(candidate, { recursive: true, force: true }),
            rm(duplicate, { recursive: true, force: true }),
        ]);
    }
};

const isDirectExecution =
    process.argv[1] &&
    pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectExecution) {
    if (process.argv.length !== 3) {
        console.error(
            "usage: node scripts/compact-emitted-javascript.mjs <output-directory>"
        );
        process.exitCode = 2;
    } else {
        const result = await compactEmittedJavaScript({
            outputDirectory: process.argv[2],
        });
        console.log(
            `compacted ${result.javascript} JavaScript files: ${result.beforeBytes} -> ${result.afterBytes} emitted bytes`
        );
    }
}
