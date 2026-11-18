// Shared FS Native Smoke and Shared FS Native Cross-OS Interop install WinFsp
// with the same "Install WinFsp" step: scripts/install-winfsp.ps1, given the
// release MSI's version, URL, size and digest pinned in the step's env.
// Checks that both workflows keep that step identical, that the pins are
// well formed and agree with each other, and that the step passes each one
// to a parameter the script declares. No network.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const WORKFLOWS = [
    "shared-fs-native-smoke.yml",
    "shared-fs-native-cross-os-interop.yml",
];
const PINS = {
    Version: "WINFSP_VERSION",
    Url: "WINFSP_MSI_URL",
    Size: "WINFSP_MSI_SIZE",
    Digest: "WINFSP_MSI_DIGEST",
};

// The step named `name`, as written, up to the next step or the job's end.
const stepText = (workflow, name) => {
    const lines = workflow.replace(/\r\n/gu, "\n").split("\n");
    const indentOf = (line) => line.length - line.trimStart().length;
    const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
    assert.notEqual(start, -1, `step "${name}" not found`);
    const step = [lines[start]];
    for (const line of lines.slice(start + 1)) {
        if (line.trim() && indentOf(line) <= indentOf(lines[start])) break;
        step.push(line);
    }
    return step.join("\n").trimEnd();
};

const installSteps = () =>
    Promise.all(
        WORKFLOWS.map(async (file) => {
            const workflow = await readFile(
                new URL(`../.github/workflows/${file}`, import.meta.url),
                "utf8"
            );
            return { file, step: stepText(workflow, "Install WinFsp") };
        })
    );

// The value the step's env gives `name`, without its quotes.
const envValue = (step, name) => {
    const match = step.match(new RegExp(`^ +${name}: (.+)$`, "mu"));
    assert.ok(match, `the step's env does not set ${name}`);
    return match[1].replace(/^"(.*)"$/u, "$1");
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

test("both workflows install WinFsp with the same step", async () => {
    const [first, ...rest] = await installSteps();
    for (const { file, step } of rest) {
        assert.equal(step, first.step, `${file} differs from ${first.file}`);
    }
});

test("the step pins one release MSI", async () => {
    const [{ step }] = await installSteps();
    const version = envValue(step, PINS.Version);
    assert.match(version, /^\d+\.\d+\.\d+$/u);
    assert.match(
        envValue(step, PINS.Url),
        new RegExp(
            `^https://github\\.com/winfsp/winfsp/releases/download/[^/]+/winfsp-${escapeRegExp(version)}\\.msi$`,
            "u"
        )
    );
    assert.match(envValue(step, PINS.Size), /^[1-9]\d*$/u);
    assert.match(envValue(step, PINS.Digest), /^sha256:[0-9a-f]{64}$/u);
});

test("the step passes each pin to a parameter of the install script", async () => {
    const [{ step }] = await installSteps();
    assert.match(step, /^ +scripts\/install-winfsp\.ps1 `$/mu);
    const script = (
        await readFile(new URL("install-winfsp.ps1", import.meta.url), "utf8")
    ).replace(/\r\n/gu, "\n");
    const params = script.match(/^param\(\n([\s\S]*?)^\)$/mu);
    assert.ok(params, "install-winfsp.ps1 has no param block");
    for (const [parameter, name] of Object.entries(PINS)) {
        assert.match(
            step,
            new RegExp(`^ +-${parameter} \\$env:${name}( \`)?$`, "mu")
        );
        assert.match(
            params[1],
            new RegExp(`\\]\\$${parameter}\\b`, "u"),
            `install-winfsp.ps1 does not declare -${parameter}`
        );
    }
});
