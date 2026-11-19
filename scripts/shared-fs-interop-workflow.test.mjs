// Checks the settings of .github/workflows/shared-fs-cross-os-interop.yml
// that no interop run would show to be wrong, and that Shared FS CI checks
// the interop files. Shared FS CI's formatting job runs it, since a change
// to either workflow or to an interop script runs that job. No network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

/**
 * Reads the block YAML that these workflows are written in: mappings,
 * sequences, block scalars, plain and quoted scalars, and comments. Every
 * scalar stays a string, and a flow collection such as `[master]` stays
 * the text it is written as.
 */
const parseYaml = (text) => {
    const lines = text.replace(/\r\n/gu, "\n").split("\n");
    const indentOf = (line) => line.length - line.trimStart().length;
    const isItem = (line) => /^\s*-(?: |$)/u.test(line);
    let at = 0;
    // The next line with content: blank and comment lines are skipped.
    const next = () => {
        while (at < lines.length && /^\s*(?:#.*)?$/u.test(lines[at])) {
            at += 1;
        }
        return lines[at];
    };
    // The value written after "key:" or "- " on a line at `indent`.
    const value = (written, indent) => {
        if (written.startsWith('"')) {
            return JSON.parse(/^"(?:[^"\\]|\\.)*"/u.exec(written)[0]);
        }
        if (written.startsWith("'")) {
            return /^'((?:[^']|'')*)'/u.exec(written)[1].replaceAll("''", "'");
        }
        const plain = written.replace(/(?:^|\s+)#.*$/u, "");
        const block = /^([|>])([+-]?)$/u.exec(plain);
        if (block) {
            const body = [];
            while (
                at < lines.length &&
                (!lines[at].trim() || indentOf(lines[at]) > indent)
            ) {
                body.push(lines[at].trim() ? lines[at] : "");
                at += 1;
            }
            const first = body.find(Boolean);
            const text = body
                .map((line) => line.slice(first ? indentOf(first) : 0))
                .join("\n");
            // ">" folds a line break between two lines into a space, and
            // drops one of a run of them.
            const folded =
                block[1] === ">"
                    ? text.replace(
                          /(?<=[^\n])\n(\n*)(?=\S)/gu,
                          (_, breaks) => breaks || " "
                      )
                    : text;
            const content = folded.replace(/\n+$/u, "");
            return (
                { "-": content, "+": `${folded}\n` }[block[2]] ?? `${content}\n`
            );
        }
        if (plain) {
            return plain;
        }
        const line = next();
        return line !== undefined &&
            (indentOf(line) > indent ||
                (indentOf(line) === indent && isItem(line)))
            ? node(indentOf(line))
            : null;
    };
    const node = (indent) => {
        if (isItem(next())) {
            const items = [];
            while (
                next() !== undefined &&
                indentOf(lines[at]) === indent &&
                isItem(lines[at])
            ) {
                const written = lines[at].slice(indent + 1);
                if (/^[^\s"'#][^:]*:(?: |$)/u.test(written.trim())) {
                    // "- key: value" starts a mapping whose keys line up
                    // with this first one.
                    const keyIndent = indent + 1 + indentOf(written);
                    lines[at] = " ".repeat(keyIndent) + written.trim();
                    items.push(node(keyIndent));
                } else {
                    at += 1;
                    items.push(value(written.trim(), indent));
                }
            }
            return items;
        }
        const map = {};
        while (
            next() !== undefined &&
            indentOf(lines[at]) === indent &&
            !isItem(lines[at])
        ) {
            const entry = /^\s*([^\s#][^:]*?):(?: +(.*))?$/u.exec(lines[at]);
            assert.ok(entry, `cannot read line ${at + 1}: ${lines[at]}`);
            at += 1;
            map[value(entry[1], indent)] = value(entry[2] ?? "", indent);
        }
        return map;
    };
    const root = node(0);
    assert.equal(next(), undefined, `cannot read line ${at + 1}`);
    return root;
};

const read = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
const interop = parseYaml(
    read("../.github/workflows/shared-fs-cross-os-interop.yml")
);
const ci = parseYaml(read("../.github/workflows/shared-fs-ci.yml"));
const rendezvousScript = read("./shared-fs-interop-rendezvous.mjs");

const step = (workflow, job, name) => {
    const steps = (workflow.jobs[job]?.steps ?? []).filter(
        (entry) => entry.name === name
    );
    assert.equal(steps.length, 1, `job ${job} has one step named "${name}"`);
    return steps[0];
};

// The words of a shell command, across its line continuations.
const words = (command) => command.replace(/\\\n/gu, " ").trim().split(/\s+/u);

// The default that the rendezvous script gives `option`, in its own unit.
const scriptDefault = (option) => {
    const match = new RegExp(`seconds\\(\\s*"${option}",\\s*(\\d+)`, "u").exec(
        rendezvousScript
    );
    assert.ok(match, `the rendezvous script has a default for ${option}`);
    return Number(match[1]);
};

// The whole minutes that `script`, the plan's "Size time budgets" step,
// sets `variable` to.
const planned = (script, variable) => {
    const match = new RegExp(`^${variable}=(\\d+)$`, "mu").exec(script);
    assert.ok(match, `"Size time budgets" sets ${variable}`);
    return Number(match[1]);
};

// Runs `script` as GitHub runs a `shell: bash` step, with the default
// interop window and arrival budget, and returns the outputs it sets.
const sizeBudgets = (script) => {
    const dir = mkdtempSync(path.join(tmpdir(), "shared-fs-interop-plan-"));
    try {
        const file = path.join(dir, "size-time-budgets.sh");
        const output = path.join(dir, "output");
        writeFileSync(file, script);
        writeFileSync(output, "");
        const result = spawnSync(
            "bash",
            ["--noprofile", "--norc", "-eo", "pipefail", file],
            {
                env: {
                    ...process.env,
                    INTEROP_TIMEOUT_MINUTES: "10",
                    INTEROP_ARRIVAL_TIMEOUT_MINUTES: "45",
                    GITHUB_OUTPUT: output,
                },
                encoding: "utf8",
                timeout: 10_000,
            }
        );
        assert.equal(
            result.status,
            0,
            `"Size time budgets" failed:\n${result.stdout}${result.stderr}`
        );
        return Object.fromEntries(
            readFileSync(output, "utf8")
                .split("\n")
                .filter(Boolean)
                .map((line) => line.split("="))
                .map(([key, minutes]) => [key, Number(minutes)])
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

// Whether `file` matches `pattern`, in which * stands for any characters
// but "/", and ** for any characters.
const matches = (pattern, file) =>
    new RegExp(
        `^${pattern
            .split(/(\*\*|\*)/u)
            .map((part) =>
                part === "**"
                    ? ".*"
                    : part === "*"
                      ? "[^/]*"
                      : part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
            )
            .join("")}$`,
        "u"
    ).test(file);

test("a new push to a pull request cancels the interop run it supersedes", () => {
    // One group per pull request, or per ref for a manual run, which waits
    // for the run before it instead of cancelling it.
    assert.deepEqual(interop.concurrency, {
        group: "shared-fs-cross-os-interop-${{ github.event.pull_request.number || github.ref }}",
        "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });
});

test("the peer jobs' install and build steps have the limits that the plan adds up", () => {
    const budgets = step(interop, "interop-plan", "Size time budgets").run;
    for (const job of ["seed-linux", "join"]) {
        for (const [name, variable] of [
            ["Install dependencies", "install"],
            ["Build shared-fs packages", "build"],
        ]) {
            assert.equal(
                Number(step(interop, job, name)["timeout-minutes"]),
                planned(budgets, variable),
                `${job}: "${name}" is limited to the plan's ${variable}`
            );
        }
    }
});

test("the plan holds the period that every peer waits past the arrival deadline", () => {
    const budgets = step(interop, "interop-plan", "Size time budgets").run;
    const settleSeconds = scriptDefault("--settle-seconds");
    assert.ok(
        planned(budgets, "settle") * 60 >= settleSeconds,
        `the plan's settle minutes hold the rendezvous script's --settle-seconds default, ${settleSeconds}`
    );
    for (const job of ["seed-linux", "join"]) {
        assert.ok(
            !words(
                step(interop, job, "Wait until every peer is ready").run
            ).includes("--settle-seconds"),
            `${job}: the wait keeps the script's --settle-seconds default`
        );
    }
});

test(
    "the peer jobs' limit adds the install and build limits and the settle period once each",
    {
        skip: process.platform === "win32" && "needs bash",
    },
    () => {
        const budgets = step(interop, "interop-plan", "Size time budgets").run;
        const limit = sizeBudgets(budgets).peer_job_timeout_minutes;
        for (const variable of ["install", "build", "settle"]) {
            const raised = budgets.replace(
                new RegExp(`^${variable}=\\d+$`, "mu"),
                `${variable}=${planned(budgets, variable) + 7}`
            );
            assert.equal(
                sizeBudgets(raised).peer_job_timeout_minutes,
                limit + 7,
                `7 more minutes of ${variable} raise the peer jobs' limit by 7`
            );
        }
    }
);

test("a joiner waits for the seed's address with the rendezvous script, which watches the seed's job", () => {
    const download = step(interop, "join", "Download seed address");
    const args = words(download.run);
    assert.deepEqual(
        args.slice(0, 2),
        ["node", "scripts/shared-fs-interop-rendezvous.mjs"],
        `"Download seed address" runs the rendezvous script:\n${download.run}`
    );
    const option = (name) =>
        args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
    // The script finds the seed's job by the "(<machine>)" that ends its
    // name, and stops waiting once that job has finished.
    const seedJob = interop.jobs["seed-linux"].name;
    assert.ok(
        seedJob.endsWith(`(${option("--seed")})`),
        `--seed ${option("--seed")} names the seed's job, ${seedJob}`
    );
    assert.ok(
        words(step(interop, "join", "Join shared filesystem").run)
            .join(" ")
            .includes(`--address-file ${option("--seed-address")}/address.txt`),
        "the joiner reads the address from where the script downloads it"
    );
    // The script gives up, with its own message, before the step's limit
    // stops it.
    assert.equal(option("--address-timeout-minutes"), undefined);
    assert.ok(
        scriptDefault("--address-timeout-minutes") <
            Number(download["timeout-minutes"]),
        "the script's --address-timeout-minutes default is under the step's limit"
    );
});

test("Shared FS CI checks the interop files' formatting and runs when they change", () => {
    const files = [
        ".github/workflows/shared-fs-cross-os-interop.yml",
        ...readdirSync(new URL("./", import.meta.url))
            .filter((name) => /^shared-fs-interop-.+\.mjs$/u.test(name))
            .map((name) => `scripts/${name}`),
    ];
    const command = words(step(ci, "format", "Check formatting").run);
    assert.deepEqual(command.slice(0, 4), [
        "pnpm",
        "exec",
        "prettier",
        "--check",
    ]);
    const checked = command.slice(4);
    for (const file of files) {
        assert.ok(
            checked.some((entry) =>
                entry.includes("*")
                    ? matches(entry, file)
                    : file === entry || file.startsWith(`${entry}/`)
            ),
            `prettier --check covers ${file}`
        );
        for (const event of ["pull_request", "push"]) {
            assert.ok(
                ci.on[event].paths.some((pattern) => matches(pattern, file)),
                `a change to ${file} runs Shared FS CI on ${event}`
            );
        }
    }
});
