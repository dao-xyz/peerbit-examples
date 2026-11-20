import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { gunzipSync } from "node:zlib";
import {
    fillNpmCache,
    fixturePaths,
    generateNpmFixture,
    runChecks,
    runNpm,
    tarballName,
} from "./shared-fs-npm-fixture.mjs";

/** What the fixture is pinned to; the mount smokes rely on these numbers. */
const PINNED = {
    tarballs: 292,
    installedPackages: 311,
    // 7,505 tarball files and the postinstall script.
    installedFiles: 7506,
    bins: 41,
    binsWithoutExecBit: 20,
    crlfBins: 13,
    scoped: 10,
    nested: 20,
    postinstall: 1,
    swappedPackages: 291,
};

/** Give-up bound for one npm command; never a pass condition. */
const NPM_GIVE_UP_MS = 10 * 60_000;

const temporaryDirectory = (label) =>
    mkdtemp(join(tmpdir(), `shared-fs-npm-fixture-${label}-`));

const remove = (directory) =>
    rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200,
    });

/** Every file under `root`, by its relative path, with its bytes. */
const filesUnder = (root) => {
    const files = new Map();
    const walk = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const full = join(directory, entry.name);
            if (entry.isDirectory()) walk(full);
            else files.set(relative(root, full), readFileSync(full));
        }
    };
    walk(root);
    return files;
};

const field = (header, start, end) =>
    header.toString("utf8", start, end).replace(/\0[\s\S]*$/, "");

/** The entries of a gzipped tarball, with their modes and bytes. */
const tarEntries = (gz) => {
    const tar = gunzipSync(gz);
    const entries = [];
    for (let offset = 0; offset + 512 <= tar.length; ) {
        const header = tar.subarray(offset, offset + 512);
        if (header.every((byte) => byte === 0)) break;
        const size = parseInt(field(header, 124, 136).trim(), 8);
        entries.push({
            name: field(header, 0, 100),
            mode: parseInt(field(header, 100, 108).trim(), 8),
            type: String.fromCharCode(header[156]),
            body: tar.subarray(offset + 512, offset + 512 + size),
        });
        offset += 512 + Math.ceil(size / 512) * 512;
    }
    return entries;
};

/** The lockfile's installed packages, each with its tarball's entries. */
const installed = (fixture) => {
    const { app, tarballs } = fixturePaths(fixture);
    const lock = JSON.parse(
        readFileSync(join(app, "package-lock.json"), "utf8")
    );
    return Object.entries(lock.packages)
        .filter(([location]) => location !== "")
        .map(([location, entry]) => {
            const name = location.slice(
                location.lastIndexOf("node_modules/") + "node_modules/".length
            );
            const file = join(tarballs, tarballName(name, entry.version));
            const bytes = readFileSync(file);
            return {
                location,
                name,
                entry,
                file,
                bytes,
                files: tarEntries(bytes),
            };
        });
};

test("generates the same bytes on every run", async () => {
    const first = await temporaryDirectory("first");
    const second = await temporaryDirectory("second");
    try {
        generateNpmFixture(first);
        generateNpmFixture(second);
        const a = filesUnder(first);
        const b = filesUnder(second);
        assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
        for (const [file, bytes] of a) {
            assert.ok(bytes.equals(b.get(file)), `${file} differs`);
        }
    } finally {
        await remove(first);
        await remove(second);
    }
});

test("builds the pinned project, counted from its lockfile and tarballs", async () => {
    const fixture = await temporaryDirectory("shape");
    try {
        assert.deepEqual(generateNpmFixture(fixture), PINNED);
        const packages = installed(fixture);
        const bins = packages.flatMap(({ entry, files }) =>
            Object.values(entry.bin ?? {}).map((target) =>
                files.find((file) => file.name === `package/${target}`)
            )
        );
        const counted = {
            tarballs: readdirSync(fixturePaths(fixture).tarballs).length,
            installedPackages: packages.length,
            installedFiles: packages.reduce(
                (sum, { files }) =>
                    sum + files.filter((file) => file.type === "0").length,
                0
            ),
            bins: bins.length,
            binsWithoutExecBit: bins.filter((bin) => (bin.mode & 0o111) === 0)
                .length,
            crlfBins: bins.filter((bin) =>
                bin.body.toString("utf8").split("\n")[0].endsWith("\r")
            ).length,
            scoped: packages.filter(({ location }) =>
                location.startsWith("node_modules/@ov/")
            ).length,
            nested: packages.filter(({ location }) =>
                /node_modules\/.+\/node_modules\//.test(location)
            ).length,
            postinstall: packages.filter(
                ({ entry }) => entry.hasInstallScript === true
            ).length,
        };
        counted.swappedPackages = counted.installedPackages - counted.nested;
        assert.deepEqual(counted, PINNED);
        // The nested copies are ov-shared 1.0.0 under a hoisted 2.0.0.
        for (const { location, entry } of packages) {
            if (location.endsWith("/node_modules/ov-shared")) {
                assert.equal(entry.version, "1.0.0", location);
            }
        }
        assert.equal(
            packages.find(
                ({ location }) => location === "node_modules/ov-shared"
            ).entry.version,
            "2.0.0"
        );
    } finally {
        await remove(fixture);
    }
});

test("locks every tarball by its sha512 and writes one gzip header on every host", async () => {
    const fixture = await temporaryDirectory("integrity");
    try {
        generateNpmFixture(fixture);
        const packages = installed(fixture);
        for (const { location, entry, bytes } of packages) {
            assert.equal(
                entry.integrity,
                `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
                location
            );
        }
        // Every tarball is installed somewhere.
        assert.deepEqual(
            [...new Set(packages.map(({ file }) => file))].sort(),
            readdirSync(fixturePaths(fixture).tarballs)
                .map((name) => join(fixturePaths(fixture).tarballs, name))
                .sort()
        );
        for (const name of readdirSync(fixturePaths(fixture).tarballs)) {
            const gz = readFileSync(join(fixturePaths(fixture).tarballs, name));
            assert.equal(gz[9], 3, `${name}: gzip OS byte`);
            for (const file of tarEntries(gz)) {
                assert.ok(file.name.startsWith("package/"), file.name);
                assert.equal(file.type, "0", file.name);
            }
        }
    } finally {
        await remove(fixture);
    }
});

test(
    "installs offline with npm ci and replaces the nested copies with npm install --no-save",
    { timeout: 4 * NPM_GIVE_UP_MS },
    async () => {
        const fixture = await temporaryDirectory("npm");
        const cache = await temporaryDirectory("npm-cache");
        try {
            generateNpmFixture(fixture);
            const { app, tarballs } = fixturePaths(fixture);
            const npm = async (args) => {
                const run = await runNpm(fixture, args, {
                    cwd: app,
                    cache,
                    giveUpMs: NPM_GIVE_UP_MS,
                });
                assert.equal(run.code, 0, `${run.label}:\n${run.stderr}`);
                return run;
            };
            const checks = async (mode) => {
                const run = await runChecks(fixture, mode, {
                    cwd: app,
                    giveUpMs: NPM_GIVE_UP_MS,
                });
                assert.equal(
                    run.code,
                    0,
                    `${run.label}:\n${run.stdout}${run.stderr}`
                );
                return run.result;
            };
            const filled = await fillNpmCache(fixture, {
                cache,
                giveUpMs: NPM_GIVE_UP_MS,
            });
            assert.equal(filled.code, 0, filled.stderr);

            await npm(["ci"]);
            assert.equal(
                (await checks("installed")).packages,
                PINNED.installedPackages
            );
            const bins = await npm(["run", "bin-check"]);
            for (const name of ["ov-pkg-002", "ov-pkg-009", "ov-pkg-030"]) {
                assert.match(bins.stdout, new RegExp(`${name}@1.0.0 bin ok`));
            }
            await npm([
                "install",
                "--no-save",
                join(tarballs, "ov-shared-1.0.0.tgz"),
            ]);
            assert.equal(
                (await checks("swapped")).packages,
                PINNED.swappedPackages
            );
        } finally {
            await remove(fixture);
            await remove(cache);
        }
    }
);
