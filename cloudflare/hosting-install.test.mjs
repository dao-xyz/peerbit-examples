import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
    hostingInstallArgs,
    installHostingWorkspace,
} from "../scripts/install-hosting-workspace.mjs";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const allowed = [
    "better-sqlite3",
    "classic-level",
    "core-js",
    "esbuild",
    "node-datachannel",
    "nx",
    "protobufjs",
];
const retained = allowed.filter((name) => name !== "node-datachannel");
const policy = { "only-built-dependencies": allowed };
const flags = retained.map(
    (name) => `--config.only-built-dependencies=${name}`
);

test("hosting excludes only Node WebRTC, preserving the source allowlist", () => {
    const input = structuredClone(policy);
    assert.deepEqual(hostingInstallArgs(input), flags);
    assert.deepEqual(input, policy);
    assert.deepEqual(
        hostingInstallArgs({
            "only-built-dependencies": [...allowed, "@example/native-tool"],
        }),
        [...flags, "--config.only-built-dependencies=@example/native-tool"]
    );
});

test("missing, ambiguous, and unsupported policies fail closed", () => {
    for (const candidate of [
        {},
        { "only-built-dependencies": "node-datachannel" },
        { "only-built-dependencies": [] },
        { "only-built-dependencies": ["node-datachannel"] },
        { "only-built-dependencies": retained },
        { "only-built-dependencies": [...allowed, "esbuild"] },
        { "only-built-dependencies": [...allowed, "node-datachannel@0.32.3"] },
        { "only-built-dependencies": [...allowed, "unsafe;command"] },
        { ...policy, "only-built-dependencies-file": "other.json" },
        { ...policy, "never-built-dependencies": [] },
        { ...policy, "allow-builds": { "node-datachannel": true } },
        { ...policy, "dangerously-allow-all-builds": true },
    ]) {
        assert.throws(() => hostingInstallArgs(candidate));
    }
    assert.deepEqual(
        hostingInstallArgs({
            ...policy,
            "dangerously-allow-all-builds": false,
        }),
        flags
    );
});

const fakePnpm = ({ effective = retained, current = policy } = {}) => {
    const calls = [];
    const run = (args, options) => {
        calls.push({ args, options });
        const command = args.find((arg) => !arg.startsWith("--config."));
        if (command === "install") return "";
        assert.equal(command, "config");
        const key = args.at(-2);
        const value = args[0].startsWith("--config.")
            ? effective
            : current[key];
        return value === undefined ? "" : JSON.stringify(value);
    };
    return { calls, run };
};

test("install checks effective pnpm policy and performs one frozen install", () => {
    const { run, calls } = fakePnpm();
    assert.deepEqual(installHostingWorkspace({ run }), retained);
    assert.deepEqual(calls.at(-2).args, [
        ...flags,
        "config",
        "get",
        "only-built-dependencies",
        "--json",
    ]);
    assert.deepEqual(calls.at(-1), {
        args: [...flags, "install", "--frozen-lockfile"],
        options: { capture: false },
    });
    assert.equal(
        calls.filter(({ args }) => args.includes("install")).length,
        1
    );
});

test("read-only check verifies effective policy without installing", () => {
    const { run, calls } = fakePnpm();
    assert.deepEqual(
        installHostingWorkspace({ run, checkOnly: true }),
        retained
    );
    assert.ok(calls.every(({ args }) => !args.includes("install")));
});

test("unapplied policy and command failures never reach installation", () => {
    const ignoredOverride = fakePnpm({ effective: allowed });
    assert.throws(
        () => installHostingWorkspace({ run: ignoredOverride.run }),
        /did not apply/
    );
    assert.ok(
        ignoredOverride.calls.every(({ args }) => !args.includes("install"))
    );
    assert.throws(() => installHostingWorkspace({ run: () => "not JSON" }));
    assert.throws(
        () =>
            installHostingWorkspace({
                run: () => {
                    throw new Error("pnpm failed");
                },
            }),
        /pnpm failed/
    );
});

test("only browser hosting jobs opt in; runtime CI keeps normal installation", () => {
    const read = (name) => readFileSync(path.join(repoRoot, name), "utf8");
    const workspace = read("pnpm-workspace.yaml");
    assert.match(workspace, /^  - node-datachannel$/m);
    const helper = "node scripts/install-hosting-workspace.mjs";
    for (const [file, count] of [
        ["cloudflare-preview.yml", 1],
        ["cloudflare-production.yml", 2],
    ]) {
        const workflow = read(`.github/workflows/${file}`);
        assert.equal(workflow.split(helper).length - 1, count);
        for (const check of [
            "pnpm run build",
            "pnpm run test:hosted-apps",
            "git diff --exit-code",
            "--dry-run",
        ])
            assert.ok(workflow.includes(check), `${file} retains ${check}`);
    }
    const runtime = read(".github/workflows/shared-fs-ci.yml");
    assert.ok(!runtime.includes(helper));
    assert.ok(runtime.includes("pnpm install --frozen-lockfile"));
});
