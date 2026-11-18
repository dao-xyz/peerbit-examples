#!/usr/bin/env node
/**
 * A deterministic, offline npm project for the shared-fs local overlay
 * smokes:
 *
 *     node scripts/shared-fs-npm-fixture.mjs <out>
 *
 * writes <out>/tarballs/*.tgz (one per package version, built here: ustar
 * and gzip with fixed times, owners and gzip OS byte), <out>/app (a
 * package.json and a lockfile v3 whose registry URLs are never fetched: npm
 * reads each tarball from its cache by integrity), <out>/checks.cjs, which
 * checks an installed tree, and empty npmrcs, and prints a summary.
 * `fillNpmCache` adds the tarballs to a cache and `runNpm` runs the npm next
 * to this Node offline against it, e.g. `npm ci` in <out>/app.
 *
 * The project: 280 packages with chains of dependencies, 20 of which pin an
 * old major of a package the root hoists (so 20 nested copies), 10 scoped
 * packages, 41 bins (20 shipped without an exec bit, 13 with a CRLF
 * shebang npm rewrites in place) and one postinstall script.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** npm's normalized tarball time (1985-10-26T08:15:00Z), in seconds. */
const MTIME = 499162500;
const REGULAR = 280;
/** Per package: package.json, index.js, README.md, LICENSE, 18 lib files, 2 more. */
const LIB_FILES = 18;
const REGISTRY = "https://registry.npmjs.org/";

const pad3 = (n) => String(n).padStart(3, "0");

// ---- a minimal deterministic ustar writer --------------------------------

const octal = (value, width) =>
    value.toString(8).padStart(width - 1, "0") + "\0";

const tarHeader = (name, size, mode) => {
    if (Buffer.byteLength(name) > 100) {
        throw new Error(`tar name too long: ${name}`);
    }
    const block = Buffer.alloc(512, 0);
    block.write(name, 0, "utf8");
    block.write(octal(mode, 8), 100, "ascii");
    block.write(octal(0, 8), 108, "ascii"); // uid
    block.write(octal(0, 8), 116, "ascii"); // gid
    block.write(octal(size, 12), 124, "ascii");
    block.write(octal(MTIME, 12), 136, "ascii");
    block.fill(" ", 148, 156); // checksum, counted as spaces
    block.write("0", 156, "ascii"); // a regular file
    block.write("ustar\0", 257, "ascii");
    block.write("00", 263, "ascii");
    let sum = 0;
    for (const byte of block) sum += byte;
    block.write(octal(sum, 7) + " ", 148, "ascii");
    return block;
};

const tarball = (files) => {
    const blocks = [];
    for (const { name, content, mode } of files) {
        const body = Buffer.from(content, "utf8");
        blocks.push(tarHeader(`package/${name}`, body.length, mode));
        blocks.push(body);
        const pad = (512 - (body.length % 512)) % 512;
        if (pad) blocks.push(Buffer.alloc(pad, 0));
    }
    blocks.push(Buffer.alloc(1024, 0));
    const gz = gzipSync(Buffer.concat(blocks), { level: 9 });
    // zlib writes its build's OS into the header (3 on Unix, 10 on
    // Windows): the same on every host.
    gz[9] = 3;
    return gz;
};

// ---- the package graph ---------------------------------------------------

const regular = (i) => `ov-pkg-${pad3(i)}`;
const scoped = (i) => `@ov/scoped-${pad3(i)}`;

const packageList = () => {
    const packages = [];
    for (let i = 0; i < REGULAR; i++) {
        const deps = {};
        // A sparse chain: hoisted, never nested.
        if (i % 7 === 0 && i + 1 < REGULAR) deps[regular(i + 1)] = "^1.0.0";
        // The old major of a hoisted package: nested copies.
        if (i % 14 === 3) deps["ov-shared"] = "^1.0.0";
        if (i % 31 === 5) deps[scoped(i % 10)] = "^1.0.0";
        const pkg = { name: regular(i), version: "1.0.0", deps };
        if (i % 7 === 2) {
            const k = (i - 2) / 7;
            pkg.bin = { [`ov-bin-${pad3(i)}`]: "bin/cli.js" };
            // Half ship without the exec bit: npm adds it.
            pkg.binMode = i % 2 ? 0o755 : 0o644;
            // npm rewrites a CRLF shebang through a temporary file and a
            // rename in node_modules.
            pkg.crlf = k % 3 === 1;
        }
        if (i === 4) pkg.postinstall = true;
        packages.push(pkg);
    }
    packages.push({ name: "ov-shared", version: "1.0.0", deps: {} });
    packages.push({
        name: "ov-shared",
        version: "2.0.0",
        deps: {},
        bin: { "ov-shared": "bin/cli.js" },
        binMode: 0o755,
        crlf: false,
    });
    for (let i = 0; i < 10; i++) {
        packages.push({ name: scoped(i), version: "1.0.0", deps: {} });
    }
    return packages;
};

const filesOf = (pkg) => {
    const manifest = {
        name: pkg.name,
        version: pkg.version,
        description: `shared-fs local overlay fixture ${pkg.name}`,
        main: "index.js",
        license: "MIT",
        ...(Object.keys(pkg.deps).length ? { dependencies: pkg.deps } : {}),
        ...(pkg.bin ? { bin: pkg.bin } : {}),
        ...(pkg.postinstall
            ? { scripts: { postinstall: "node postinstall.js" } }
            : {}),
    };
    const files = [
        {
            name: "package.json",
            content: JSON.stringify(manifest, null, 2) + "\n",
            mode: 0o644,
        },
        {
            name: "index.js",
            content:
                `"use strict";\n` +
                `const deps = ${JSON.stringify(Object.keys(pkg.deps))};\n` +
                `module.exports = {\n` +
                `    name: ${JSON.stringify(pkg.name)},\n` +
                `    version: ${JSON.stringify(pkg.version)},\n` +
                `    deps: Object.fromEntries(deps.map((d) => [d, require(d).version])),\n` +
                `    lib: require("./lib/f00.js"),\n` +
                `};\n`,
            mode: 0o644,
        },
        {
            name: "README.md",
            content: `# ${pkg.name}\n\nA shared-fs local overlay fixture package.\n`,
            mode: 0o644,
        },
        { name: "LICENSE", content: "MIT\n", mode: 0o644 },
    ];
    for (let f = 0; f < LIB_FILES; f++) {
        files.push({
            name: `lib/f${String(f).padStart(2, "0")}.js`,
            content:
                `module.exports = ${JSON.stringify(`${pkg.name}@${pkg.version}/${f}`)};\n`.repeat(
                    1 + (f % 5)
                ),
            mode: 0o644,
        });
    }
    files.push({
        name: "lib/sub/deep.js",
        content: "module.exports = 1;\n",
        mode: 0o644,
    });
    files.push({
        name: "data/info.json",
        content: JSON.stringify({ pkg: pkg.name }) + "\n",
        mode: 0o644,
    });
    if (pkg.bin) {
        const eol = pkg.crlf ? "\r\n" : "\n";
        files.push({
            name: "bin/cli.js",
            content: `#!/usr/bin/env node${eol}console.log(${JSON.stringify(`${pkg.name}@${pkg.version} bin ok`)});${eol}`,
            mode: pkg.binMode,
        });
    }
    if (pkg.postinstall) {
        files.push({
            name: "postinstall.js",
            content: `require("fs").writeFileSync("postinstall.txt", "ok\\n");\n`,
            mode: 0o644,
        });
    }
    return files;
};

export const tarballName = (name, version) =>
    `${name.replace("@", "").replace("/", "-")}-${version}.tgz`;

const sorted = (object) =>
    Object.fromEntries(
        Object.entries(object).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    );

/**
 * Write the fixture into `outDir` (replacing it) and return its summary:
 * what an install of it holds.
 */
export const generateNpmFixture = (outDir) => {
    const packages = packageList();
    rmSync(outDir, { recursive: true, force: true });
    mkdirSync(path.join(outDir, "tarballs"), { recursive: true });
    mkdirSync(path.join(outDir, "app"), { recursive: true });

    const built = new Map(); // name@version -> { pkg, files, integrity, resolved }
    for (const pkg of packages) {
        const files = filesOf(pkg);
        const bytes = tarball(files);
        writeFileSync(
            path.join(outDir, "tarballs", tarballName(pkg.name, pkg.version)),
            bytes
        );
        const base = pkg.name.startsWith("@")
            ? pkg.name.split("/")[1]
            : pkg.name;
        built.set(`${pkg.name}@${pkg.version}`, {
            pkg,
            files: files.length,
            integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
            resolved: `${REGISTRY}${pkg.name}/-/${base}-${pkg.version}.tgz`,
        });
    }

    const lockEntry = (pkg) => {
        const { integrity, resolved } = built.get(`${pkg.name}@${pkg.version}`);
        return {
            version: pkg.version,
            resolved,
            integrity,
            ...(pkg.postinstall ? { hasInstallScript: true } : {}),
            license: "MIT",
            ...(Object.keys(pkg.deps).length ? { dependencies: pkg.deps } : {}),
            ...(pkg.bin ? { bin: pkg.bin } : {}),
        };
    };
    // The root takes every package at its exact version but ov-shared 1:
    // ov-shared 2 is hoisted and 1 nests under each package that needs it.
    const sharedV1 = packages.find(
        (pkg) => pkg.name === "ov-shared" && pkg.version === "1.0.0"
    );
    const hoisted = packages.filter((pkg) => pkg !== sharedV1);
    const rootDeps = sorted(
        Object.fromEntries(hoisted.map((pkg) => [pkg.name, pkg.version]))
    );
    const app = {
        name: "overlay-fixture-app",
        version: "1.0.0",
        private: true,
        scripts: {
            // LF and 0644, CRLF and 0755, CRLF and 0644.
            "bin-check": "ov-bin-002 && ov-bin-009 && ov-bin-030",
        },
        dependencies: rootDeps,
    };
    const lockPackages = {
        "": {
            name: app.name,
            version: app.version,
            dependencies: rootDeps,
        },
    };
    for (const pkg of hoisted) {
        lockPackages[`node_modules/${pkg.name}`] = lockEntry(pkg);
    }
    const nestedUnder = hoisted.filter((pkg) => pkg.deps["ov-shared"]);
    for (const pkg of nestedUnder) {
        lockPackages[`node_modules/${pkg.name}/node_modules/ov-shared`] =
            lockEntry(sharedV1);
    }
    writeFileSync(
        path.join(outDir, "app", "package.json"),
        JSON.stringify(app, null, 2) + "\n"
    );
    writeFileSync(
        path.join(outDir, "app", "package-lock.json"),
        JSON.stringify(
            {
                name: app.name,
                version: app.version,
                lockfileVersion: 3,
                requires: true,
                packages: sorted(lockPackages),
            },
            null,
            2
        ) + "\n"
    );

    const filesAt = (pkg) => built.get(`${pkg.name}@${pkg.version}`).files;
    const bins = hoisted.filter((pkg) => pkg.bin);
    const summary = {
        tarballs: packages.length,
        installedPackages: hoisted.length + nestedUnder.length,
        // Every installed tarball file, postinstall.js included.
        installedFiles:
            hoisted.reduce((sum, pkg) => sum + filesAt(pkg), 0) +
            nestedUnder.length * filesAt(sharedV1),
        bins: bins.length,
        binsWithoutExecBit: bins.filter((pkg) => pkg.binMode === 0o644).length,
        crlfBins: bins.filter((pkg) => pkg.crlf).length,
        scoped: packages.filter((pkg) => pkg.name.startsWith("@")).length,
        nested: nestedUnder.length,
        postinstall: packages.filter((pkg) => pkg.postinstall).length,
        // After `npm install --no-save` of ov-shared 1 over the hoisted 2.
        swappedPackages: hoisted.length,
    };
    writeFileSync(fixturePaths(outDir).userConfig, "");
    writeFileSync(fixturePaths(outDir).globalConfig, "");
    writeFileSync(
        fixturePaths(outDir).checks,
        checksSource({
            installed: summary.installedPackages,
            swapped: summary.swappedPackages,
            crlfBins: bins
                .filter((pkg) => pkg.crlf)
                .map((pkg) => `${pkg.name}/bin/cli.js`),
            nestedUnder: nestedUnder.map((pkg) => pkg.name),
        })
    );
    return summary;
};

/**
 * checks.cjs, run as `node <fixture>/checks.cjs <mode>` in the app
 * directory: installed, swapped, exdev (on a mount only) or probe.
 */
const checksSource = (expected) => `"use strict";
// Generated by scripts/shared-fs-npm-fixture.mjs.
const fs = require("node:fs");
const path = require("node:path");
const expected = ${JSON.stringify(expected)};
const windows = process.platform === "win32";
const failures = [];
const check = (ok, message) => {
    if (!ok) failures.push(message);
};
const exists = (file) => {
    try {
        fs.lstatSync(file);
        return true;
    } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
    }
};
const countPackages = (dir) => {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (entry.name.startsWith("@")) {
            for (const inner of fs.readdirSync(full, { withFileTypes: true })) {
                if (inner.isDirectory()) count += countPackage(path.join(full, inner.name));
            }
        } else {
            count += countPackage(full);
        }
    }
    return count;
};
const countPackage = (dir) => {
    if (!exists(path.join(dir, "package.json"))) return 0;
    const nested = path.join(dir, "node_modules");
    return 1 + (exists(nested) ? countPackages(nested) : 0);
};
const version = (location) =>
    JSON.parse(fs.readFileSync(path.join(location, "package.json"), "utf8")).version;
const bin = (name) => path.join("node_modules", ".bin", name);

const modes = {
    installed() {
        const count = countPackages("node_modules");
        check(count === expected.installed, "installed packages: " + count + ", expected " + expected.installed);
        const root = require(path.resolve("node_modules/ov-pkg-000"));
        check(root.deps["ov-pkg-001"] === "1.0.0", "ov-pkg-000 does not reach ov-pkg-001");
        check(require(path.resolve("node_modules/@ov/scoped-005")).name === "@ov/scoped-005", "@ov/scoped-005 does not load");
        check(version("node_modules/ov-shared") === "2.0.0", "hoisted ov-shared is not 2.0.0");
        for (const name of expected.nestedUnder) {
            const nested = path.join("node_modules", name, "node_modules", "ov-shared");
            check(exists(nested) && version(nested) === "1.0.0", name + " has no nested ov-shared 1.0.0");
        }
        for (const file of expected.crlfBins) {
            const first = fs.readFileSync(path.join("node_modules", file), "utf8").split("\\n")[0];
            check(!first.endsWith("\\r"), file + " still has a CRLF shebang");
        }
        check(fs.readFileSync("node_modules/ov-pkg-004/postinstall.txt", "utf8") === "ok\\n", "postinstall did not run");
        check(exists("node_modules/.package-lock.json"), "node_modules/.package-lock.json is missing");
        if (windows) {
            check(exists(bin("ov-bin-002.cmd")), ".bin/ov-bin-002.cmd is missing");
        } else {
            const link = bin("ov-bin-002");
            check(fs.lstatSync(link).isSymbolicLink(), ".bin/ov-bin-002 is not a symlink");
            check(fs.readlinkSync(link) === "../ov-pkg-002/bin/cli.js", ".bin/ov-bin-002 -> " + fs.readlinkSync(link));
            check((fs.statSync(link).mode & 0o111) !== 0, "ov-pkg-002/bin/cli.js has no exec bit");
        }
        return { packages: count };
    },
    swapped() {
        const count = countPackages("node_modules");
        check(count === expected.swapped, "installed packages: " + count + ", expected " + expected.swapped);
        check(version("node_modules/ov-shared") === "1.0.0", "hoisted ov-shared is not 1.0.0");
        for (const name of expected.nestedUnder) {
            check(!exists(path.join("node_modules", name, "node_modules", "ov-shared")), name + " still has a nested ov-shared");
        }
        for (const name of windows ? ["ov-shared", "ov-shared.cmd", "ov-shared.ps1"] : ["ov-shared"]) {
            check(!exists(bin(name)), ".bin/" + name + " is still there");
        }
        return { packages: count };
    },
    exdev() {
        const moves = [
            ["node_modules/ov-pkg-000/index.js", "moved.js"],
            ["package.json", "node_modules/package.json"],
        ];
        const result = {};
        for (const [from, to] of moves) {
            const before = fs.readFileSync(from);
            let code;
            try {
                fs.renameSync(from, to);
                code = "none";
            } catch (error) {
                code = error.code;
            }
            result[from] = code;
            check(code === "EXDEV", "rename " + from + " to " + to + ": " + code + ", expected EXDEV");
            check(exists(from) && fs.readFileSync(from).equals(before), from + " changed");
            check(!exists(to), to + " exists");
        }
        return result;
    },
    probe() {
        const probe = path.join("node_modules", ".ovl-probe");
        const read = (fd) => {
            const buffer = Buffer.alloc(8);
            return buffer.toString("utf8", 0, fs.readSync(fd, buffer, 0, 8, 0));
        };
        const fd = fs.openSync(probe, "w+");
        fs.writeSync(fd, "a");
        fs.unlinkSync(probe);
        check(read(fd) === "a", "an unlinked open file did not read back");
        fs.closeSync(fd);
        fs.writeFileSync(probe, "b");
        check(fs.readFileSync(probe, "utf8") === "b", "the name did not take new bytes");
        fs.unlinkSync(probe);
        // Reported, never failed: WinFsp keeps an unlinked open name
        // pending until its last handle closes.
        const first = fs.openSync(probe, "w+");
        fs.unlinkSync(probe);
        let recreateWhileOpen;
        try {
            fs.writeFileSync(probe, "c");
            fs.unlinkSync(probe);
            recreateWhileOpen = "ok";
        } catch (error) {
            recreateWhileOpen = error.code;
        } finally {
            fs.closeSync(first);
        }
        return { recreateWhileOpen };
    },
};

const mode = process.argv[2];
if (!modes[mode]) {
    console.error("usage: node checks.cjs <" + Object.keys(modes).join("|") + ">");
    process.exit(2);
}
const result = modes[mode]();
console.log(JSON.stringify({ mode, ok: failures.length === 0, ...result, failures }));
if (failures.length) process.exit(1);
`;

/** Where the generated fixture keeps each part. */
export const fixturePaths = (outDir) => ({
    app: path.join(outDir, "app"),
    tarballs: path.join(outDir, "tarballs"),
    checks: path.join(outDir, "checks.cjs"),
    /** Empty npmrcs for --userconfig and --globalconfig (npm refuses one for both). */
    userConfig: path.join(outDir, "user.npmrc"),
    globalConfig: path.join(outDir, "global.npmrc"),
});

/** Where npm's own CLI script is, next to the running Node. */
export const npmCliPath = () => {
    const nodeDirectory = path.dirname(process.execPath);
    const candidate =
        process.platform === "win32"
            ? path.join(
                  nodeDirectory,
                  "node_modules",
                  "npm",
                  "bin",
                  "npm-cli.js"
              )
            : path.join(
                  nodeDirectory,
                  "..",
                  "lib",
                  "node_modules",
                  "npm",
                  "bin",
                  "npm-cli.js"
              );
    if (!existsSync(candidate)) {
        throw new Error(`npm-cli.js is not next to ${process.execPath}`);
    }
    return candidate;
};

/** The environment npm runs in: no npm_config_* from an outer npm or pnpm. */
export const npmEnvironment = (env = process.env) =>
    Object.fromEntries(
        Object.entries(env).filter(([name]) => !/^npm_config_/i.test(name))
    );

/**
 * Run a command to its exit, collecting its output. Resolves with its exit
 * code even when it fails; rejects only when it is still running after
 * `giveUpMs` (a give-up bound, never a pass condition), after killing it.
 */
export const runCommand = (command, args, { cwd, env, giveUpMs, label }) =>
    new Promise((resolve, reject) => {
        const started = Date.now();
        const child = spawn(command, args, {
            cwd,
            env,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        const stdout = [];
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`gave up after ${giveUpMs} ms: ${label}`));
        }, giveUpMs);
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code, signal) => {
            clearTimeout(timer);
            resolve({
                label,
                code,
                signal,
                ms: Date.now() - started,
                stdout: Buffer.concat(stdout).toString("utf8"),
                stderr: Buffer.concat(stderr).toString("utf8"),
            });
        });
    });

/**
 * Run npm, the one next to this Node and without a shell, in `cwd`: offline
 * from `cache`, with the fixture's empty user and global configs and no
 * audit, fund or update checks.
 */
export const runNpm = (fixture, args, { cwd, cache, giveUpMs }) => {
    const { userConfig, globalConfig } = fixturePaths(fixture);
    return runCommand(
        process.execPath,
        [
            npmCliPath(),
            ...args,
            "--offline",
            "--cache",
            cache,
            "--no-audit",
            "--no-fund",
            "--no-update-notifier",
            "--userconfig",
            userConfig,
            "--globalconfig",
            globalConfig,
        ],
        {
            cwd,
            env: npmEnvironment(),
            giveUpMs,
            label: `npm ${args.join(" ")}`,
        }
    );
};

/**
 * Fill `cache` with every fixture tarball. The names are relative to the
 * tarballs directory, which keeps a Windows command line short.
 */
export const fillNpmCache = (fixture, { cache, giveUpMs }) => {
    const { tarballs } = fixturePaths(fixture);
    const names = readdirSync(tarballs)
        .filter((name) => name.endsWith(".tgz"))
        .sort()
        .map((name) => `./${name}`);
    return runNpm(fixture, ["cache", "add", ...names], {
        cwd: tarballs,
        cache,
        giveUpMs,
    });
};

/**
 * Run `checks.cjs <mode>` with `cwd` (the installed app) as its working
 * directory; `result` is what it printed, parsed.
 */
export const runChecks = async (fixture, mode, { cwd, giveUpMs }) => {
    const run = await runCommand(
        process.execPath,
        [fixturePaths(fixture).checks, mode],
        { cwd, env: process.env, giveUpMs, label: `checks.cjs ${mode}` }
    );
    let result;
    try {
        result = JSON.parse(run.stdout.trim().split("\n").pop());
    } catch {
        result = undefined;
    }
    return { ...run, result };
};

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    const out = process.argv[2];
    if (!out) {
        console.error("usage: node scripts/shared-fs-npm-fixture.mjs <out>");
        process.exit(2);
    }
    console.log(JSON.stringify(generateNpmFixture(path.resolve(out)), null, 2));
}
