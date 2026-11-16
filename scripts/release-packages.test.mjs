// Runs scripts/release-packages.mjs as a subprocess. The script must check
// npm publish authentication before it builds anything or calls GitHub.
// Stub `npm` and `pnpm` come first on PATH, and a preloaded module blocks
// fetch, so nothing reaches a registry or GitHub.
//
// The stub npm prints STUB_NPM_VERSION for `npm --version`. Its `npm view`
// reports every package version as published, except those of
// STUB_UNPUBLISHED. The stub pnpm succeeds, except for the call that equals
// STUB_PNPM_FAIL. The stubs and the fetch blocker log each call.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(
    new URL("./release-packages.mjs", import.meta.url)
);

const npmStub = `#!/bin/sh
printf 'npm %s\\n' "$*" >> "$STUB_LOG"
case "$1" in
--version) echo "$STUB_NPM_VERSION" ;;
view)
    [ "\${2%@*}" != "$STUB_UNPUBLISHED" ] || exit 1
    printf '"%s"\\n' "\${2##*@}"
    ;;
*) exit 1 ;;
esac
`;

const pnpmStub = `#!/bin/sh
printf 'pnpm %s\\n' "$*" >> "$STUB_LOG"
[ "$*" != "$STUB_PNPM_FAIL" ]
`;

const blockFetch = `import { appendFileSync } from "node:fs";
globalThis.fetch = async (url) => {
    appendFileSync(process.env.STUB_LOG, "fetch " + url + "\\n");
    throw new Error("This test blocks fetch.");
};
`;

// A package the script publishes that is not part of shared-fs, so the
// script neither looks for the native adapter release on GitHub nor runs the
// shared-fs validations.
const otherPackage = "@peerbit/please";
// What a GitHub Actions job granted `id-token: write` sees.
const idToken = {
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://token.actions.example/request",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "request-token",
};
// What the Release workflow passes when the NPM_TOKEN secret is not set.
const noToken = { NPM_TOKEN: "", NODE_AUTH_TOKEN: "" };

const pnpmCalls = (result) =>
    result.calls.filter((call) => call.startsWith("pnpm "));
const output = (result) => `${result.stdout}${result.stderr}`;

const skip =
    process.platform === "win32" && "the stubs are POSIX shell scripts";

// The cases run at the same time, each with its own call log.
describe("release-packages.mjs", { skip, concurrency: true }, () => {
    let temporary;
    let runs = 0;

    before(async () => {
        temporary = await mkdtemp(join(tmpdir(), "release-packages-test-"));
        await mkdir(join(temporary, "bin"));
        await writeFile(join(temporary, "bin", "npm"), npmStub, {
            mode: 0o755,
        });
        await writeFile(join(temporary, "bin", "pnpm"), pnpmStub, {
            mode: 0o755,
        });
        await writeFile(join(temporary, "block-fetch.mjs"), blockFetch);
    });

    after(async () => {
        await rm(temporary, { recursive: true, force: true });
    });

    const runRelease = async (env) => {
        runs += 1;
        const log = join(temporary, `calls-${runs}.log`);
        await writeFile(log, "");
        const preload = pathToFileURL(join(temporary, "block-fetch.mjs"));
        const child = spawn(
            process.execPath,
            ["--import", preload.href, script],
            {
                // Only PATH comes from this process, so no npm token,
                // id-token or GitHub variable leaks in.
                env: {
                    PATH: `${join(temporary, "bin")}${delimiter}${process.env.PATH}`,
                    STUB_LOG: log,
                    ...env,
                },
                timeout: 60_000,
            }
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
            stderr += chunk;
        });
        const [status, signal] = await once(child, "close");
        assert.equal(signal, null, `the release script was killed\n${stderr}`);
        return {
            status,
            stdout,
            stderr,
            calls: (await readFile(log, "utf8")).split("\n").filter(Boolean),
        };
    };

    test("refuses without an id-token or an npm token, before it builds", async () => {
        const result = await runRelease({
            ...noToken,
            STUB_NPM_VERSION: "11.19.1",
            STUB_UNPUBLISHED: otherPackage,
        });
        assert.notEqual(result.status, 0, output(result));
        assert.match(
            result.stderr,
            /needs npm trusted publishing or an npm token/
        );
        assert.deepEqual(pnpmCalls(result), []);
    });

    test("refuses trusted publishing with npm 10 and no npm token, before it builds", async () => {
        const result = await runRelease({
            ...idToken,
            ...noToken,
            STUB_NPM_VERSION: "10.9.9",
            STUB_UNPUBLISHED: otherPackage,
        });
        assert.notEqual(result.status, 0, output(result));
        assert.match(
            result.stderr,
            /npm 10\.9\.9 cannot use npm trusted publishing/
        );
        assert.deepEqual(pnpmCalls(result), []);
    });

    test("publishes with npm trusted publishing when the job can request an id-token", async () => {
        const result = await runRelease({
            ...idToken,
            ...noToken,
            STUB_NPM_VERSION: "11.19.1",
            STUB_UNPUBLISHED: otherPackage,
        });
        assert.equal(result.status, 0, output(result));
        assert.match(
            result.stdout,
            /^Publishing with npm trusted publishing \(npm 11\.19\.1\)\.$/m
        );
        assert.match(
            result.stdout,
            /^Unpublished package versions: @peerbit\/please@/m
        );
        assert.equal(pnpmCalls(result).at(-1), "pnpm changeset publish");
    });

    test("refuses before it looks for the native adapter release on GitHub", async () => {
        const result = await runRelease({
            ...noToken,
            STUB_NPM_VERSION: "11.19.1",
            STUB_UNPUBLISHED: "@peerbit/shared-fs-cli",
        });
        assert.notEqual(result.status, 0, output(result));
        // Neither fetch nor pnpm.
        assert.deepEqual(
            result.calls.filter((call) => !call.startsWith("npm ")),
            []
        );
        assert.match(
            result.stderr,
            /needs npm trusted publishing or an npm token/
        );
    });

    test("says what to check when a trusted publish fails", async () => {
        const result = await runRelease({
            ...idToken,
            ...noToken,
            STUB_NPM_VERSION: "11.19.1",
            STUB_UNPUBLISHED: otherPackage,
            STUB_PNPM_FAIL: "changeset publish",
        });
        assert.notEqual(result.status, 0, output(result));
        assert.match(
            result.stderr,
            /Still unpublished after failed publish: @peerbit\/please@/
        );
        assert.match(result.stderr, /trusted publisher/);
        assert.match(result.stderr, /no environment/);
        assert.match(result.stderr, /allow npm publish/);
    });
});
