// Runs the seed job's "Start seed peer" and "Wait for all OS peers" steps
// from .github/workflows/shared-fs-cross-os-interop.yml the way GitHub runs a
// `shell: bash` step (bash --noprofile --norc -eo pipefail <file>), with the
// seed CLI replaced by a stub that exits with a chosen status. The status
// must reach the wait step, which fails with it: a lost status left the wait
// step polling for an exit file that never came. No network.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
    mkdir,
    mkdtemp,
    open,
    readFile,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

const workflowUrl = new URL(
    "../.github/workflows/shared-fs-cross-os-interop.yml",
    import.meta.url
);
// Each step ends within seconds once it has the seed's status.
const STEP_BOUND_MS = 30_000;

// The `run: |` block of the step named `name`, dedented as YAML reads it.
const stepScript = (workflow, name) => {
    const lines = workflow.replace(/\r\n/gu, "\n").split("\n");
    const indentOf = (line) => line.length - line.trimStart().length;
    const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
    assert.notEqual(start, -1, `step "${name}" not found`);
    const step = [];
    for (const line of lines.slice(start + 1)) {
        if (line.trim() && indentOf(line) <= indentOf(lines[start])) break;
        step.push(line);
    }
    assert.ok(
        step.some((line) => line.trim() === "shell: bash"),
        `step "${name}" does not use shell: bash`
    );
    const run = step.findIndex((line) => line.trim() === "run: |");
    assert.notEqual(run, -1, `step "${name}" has no "run: |" block`);
    const body = [];
    for (const line of step.slice(run + 1)) {
        if (line.trim() && indentOf(line) <= indentOf(step[run])) break;
        body.push(line);
    }
    const bodyIndent = indentOf(body.find((line) => line.trim()));
    const script = `${body
        .map((line) => line.slice(bodyIndent))
        .join("\n")
        .trimEnd()}\n`;
    assert.doesNotMatch(script, /\$\{\{/u, `step "${name}" uses an expression`);
    return script;
};

// Stands in for packages/shared-fs/cli/lib/esm/cross-os-interop.js: writes
// the seed address, then exits with STUB_EXIT or is killed by STUB_SIGNAL.
const SEED_STUB = `
const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
fs.writeFileSync(value("--address-file"), "stub-address\\n");
console.error("stub seed: machine=" + value("--machine") + " expected=" + value("--expected"));
setTimeout(() => {
    if (process.env.STUB_SIGNAL) {
        process.kill(process.pid, process.env.STUB_SIGNAL);
    } else {
        process.exitCode = Number(process.env.STUB_EXIT);
    }
}, 100);
`;

// Runs a step script in its own process group, so that a step still running
// at the bound is killed with everything it started.
const runStep = async (workspace, file, script, env) => {
    const scriptPath = path.join(workspace, file);
    const outputPath = `${scriptPath}.out`;
    await writeFile(scriptPath, script);
    const output = await open(outputPath, "w");
    let timer;
    try {
        const child = spawn(
            "bash",
            ["--noprofile", "--norc", "-eo", "pipefail", scriptPath],
            {
                cwd: workspace,
                env,
                detached: true,
                stdio: ["ignore", output.fd, output.fd],
            }
        );
        const result = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code) => resolve({ code, timedOut: false }));
            timer = setTimeout(() => {
                try {
                    process.kill(-child.pid, "SIGKILL");
                } catch {
                    // The group exited in the meantime.
                }
                resolve({ code: null, timedOut: true });
            }, STEP_BOUND_MS);
        });
        return {
            ...result,
            group: child.pid,
            output: await readFile(outputPath, "utf8"),
        };
    } finally {
        clearTimeout(timer);
        await output.close();
    }
};

const scenarios = [
    {
        title: "a seed that exits 0 passes the wait step",
        env: { STUB_EXIT: "0" },
        status: 0,
    },
    {
        title: "a seed that exits 1 fails the wait step instead of hanging it",
        env: { STUB_EXIT: "1" },
        status: 1,
    },
    {
        title: "a seed killed by a signal fails the wait step with its status",
        env: { STUB_SIGNAL: "SIGKILL" },
        status: 128 + 9,
    },
];

for (const scenario of scenarios) {
    test(
        scenario.title,
        {
            skip:
                process.platform === "win32" &&
                "needs bash and POSIX process groups",
        },
        async () => {
            const workflow = await readFile(workflowUrl, "utf8");
            const workspace = await mkdtemp(
                path.join(tmpdir(), "shared-fs-interop-seed-")
            );
            let seedGroup;
            try {
                const cli = path.join(
                    workspace,
                    "packages/shared-fs/cli/lib/esm"
                );
                await mkdir(cli, { recursive: true });
                await writeFile(
                    path.join(cli, "package.json"),
                    '{ "type": "commonjs" }\n'
                );
                await writeFile(
                    path.join(cli, "cross-os-interop.js"),
                    SEED_STUB
                );
                const env = {
                    ...process.env,
                    INTEROP_EXPECTED_MACHINES: "linux,macos",
                    INTEROP_TIMEOUT_MINUTES: "1",
                    ...scenario.env,
                };

                const start = await runStep(
                    workspace,
                    "start-seed-peer.sh",
                    stepScript(workflow, "Start seed peer"),
                    env
                );
                // The seed's subshell runs in this step's process group.
                seedGroup = start.group;
                assert.deepEqual(
                    { code: start.code, timedOut: start.timedOut },
                    { code: 0, timedOut: false },
                    `"Start seed peer" failed:\n${start.output}`
                );

                const wait = await runStep(
                    workspace,
                    "wait-for-all-os-peers.sh",
                    stepScript(workflow, "Wait for all OS peers"),
                    env
                );
                const exitFile = await readFile(
                    path.join(workspace, "interop-logs/linux-seed.exit"),
                    "utf8"
                ).then(
                    (text) => text.trim(),
                    () => null
                );
                assert.equal(
                    wait.timedOut,
                    false,
                    `"Wait for all OS peers" was still polling after ${STEP_BOUND_MS} ms (interop-logs/linux-seed.exit: ${exitFile ?? "missing"})`
                );
                assert.equal(exitFile, String(scenario.status));
                assert.equal(
                    wait.code,
                    scenario.status,
                    `"Wait for all OS peers" exit code:\n${wait.output}`
                );
                // The step prints the seed's log.
                assert.match(
                    wait.output,
                    /stub seed: machine=linux expected=linux,macos/u
                );
            } finally {
                if (seedGroup !== undefined) {
                    try {
                        process.kill(-seedGroup, "SIGKILL");
                    } catch {
                        // Nothing of the seed is left running.
                    }
                }
                await rm(workspace, { recursive: true, force: true });
            }
        }
    );
}
