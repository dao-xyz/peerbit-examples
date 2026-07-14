import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
    findUnsafeOwnedDomainReferences,
    findUnsafeOwnedDomainTreeReferences,
    isAllowedHistoricalReference,
} from "../scripts/validate-owned-domains.mjs";

const find = (file, contents) =>
    findUnsafeOwnedDomainReferences(file, contents);

test("allows owned app origins and dao-xyz package and repository namespaces", () => {
    assert.deepEqual(
        find(
            "package.json",
            JSON.stringify({
                author: "Peerbit contributors",
                repository: "https://github.com/dao-xyz/peerbit-examples",
                dependencies: { "@dao-xyz/borsh": "^6.0.0" },
                homepage: "https://files.apps.peerbit.org",
            })
        ),
        []
    );
});

test("rejects unowned author metadata and live retired URLs", () => {
    const metadata = find(
        "packages/example/package.json",
        '{"author":"dao.xyz"}'
    );
    assert.equal(metadata.length, 1);
    assert.match(metadata[0], /metadata identity dao\.xyz/);

    const urls = find(
        "packages/example/config.ts",
        [
            'export const api = "https://files.dao.xyz";',
            'export const fallback = "https://giga.place";',
        ].join("\n")
    );
    assert.equal(urls.length, 2);
    assert.match(urls[0], /dao\.xyz/);
    assert.match(urls[1], /giga\.place/);
});

test("rejects active Giga imports, source paths, Workers, and origins", () => {
    assert.match(
        find(
            "packages/example/src/index.ts",
            'import { AppProvider } from "@giga-app/sdk";'
        )[0],
        /retired Giga package namespace/
    );
    assert.match(
        find("packages/social-media-app/frontend/src/App.tsx", "export {};")[0],
        /retired Giga source tree/
    );
    assert.match(
        find(
            "cloudflare/sites.json",
            '{"worker":"peerbit-examples-giga","domains":["giga.apps.peerbit.org"]}'
        ).join("\n"),
        /retired Giga Worker/
    );
    assert.match(
        find(
            "cloudflare/sites.json",
            '{"worker":"peerbit-examples-giga","domains":["giga.apps.peerbit.org"]}'
        ).join("\n"),
        /retired Giga production origin/
    );
});

test("rejects retired source paths even when their files are binary", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "peerbit-domain-policy-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const retiredAsset = path.join(
        root,
        "packages/social-media-app/assets/logo.png"
    );
    mkdirSync(path.dirname(retiredAsset), { recursive: true });
    writeFileSync(retiredAsset, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    assert.deepEqual(findUnsafeOwnedDomainTreeReferences(root), [
        "packages/social-media-app/assets/logo.png: path contains retired Giga source tree packages/social-media-app",
    ]);
});

test("scans active Go, PowerShell, patch, module, and shader formats", (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "peerbit-domain-policy-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));

    const forbiddenFiles = [
        ["native/main.go", 'const endpoint = "https://files.dao.xyz"'],
        ["native/go.mod", "module dao.xyz/native"],
        ["native/go.sum", "dao.xyz/native v1.0.0 h1:checksum"],
        ["patches/legacy.patch", "+endpoint=https://files.dao.xyz"],
        ["scripts/deploy.ps1", '$endpoint = "https://files.dao.xyz"'],
        ["shaders/player.wgsl", "// https://files.dao.xyz"],
    ];
    for (const [relativeFile, contents] of forbiddenFiles) {
        const absoluteFile = path.join(root, relativeFile);
        mkdirSync(path.dirname(absoluteFile), { recursive: true });
        writeFileSync(absoluteFile, contents);
    }

    const findings = findUnsafeOwnedDomainTreeReferences(root);
    assert.equal(findings.length, forbiddenFiles.length);
    for (const [relativeFile] of forbiddenFiles) {
        assert.ok(
            findings.some((finding) =>
                finding.startsWith(`${relativeFile}:1: contains`)
            ),
            `expected a forbidden reference in ${relativeFile}`
        );
    }
});

test("allows only exact historical copyright lines", () => {
    const copyrightReference = {
        allowance: "historical-copyright",
    };
    assert.equal(
        isAllowedHistoricalReference(
            "LICENSE",
            "Copyright (c) 2022 dao.xyz",
            copyrightReference
        ),
        true
    );
    assert.deepEqual(
        find(
            "LICENSE",
            [
                "Copyright (c) 2022 dao.xyz",
                "Copyright (c) 2022 dao.xyz; endpoint=https://files.dao.xyz",
            ].join("\n")
        ),
        ["LICENSE:2: contains unowned host or metadata identity dao.xyz"]
    );
    assert.equal(
        find("packages/example/package.json", '{"author":"dao.xyz"}').length,
        1
    );
});

test("allows exact Giga dependency history only in changelogs", () => {
    const historical = "    - @giga-app/sdk@2.0.1";
    assert.deepEqual(find("packages/example/CHANGELOG.md", historical), []);
    assert.equal(find("packages/example/README.md", historical).length, 1);
    assert.equal(
        find(
            "packages/example/CHANGELOG.md",
            'import sdk from "@giga-app/sdk";'
        ).length,
        1
    );
    assert.equal(
        find(
            "packages/example/package.json",
            '{"dependencies":{"@giga-app/sdk":"2.0.1"}}'
        ).length,
        1
    );
});

test("allows retired-reference literals only in the exact policy fixtures", () => {
    const fixture = [
        "https://files.dao.xyz",
        "https://giga.place",
        'import "@giga-app/sdk";',
    ].join("\n");
    assert.deepEqual(find("scripts/validate-owned-domains.mjs", fixture), []);
    assert.deepEqual(
        find("cloudflare/owned-domain-policy.test.mjs", fixture),
        []
    );
    assert.equal(find("scripts/other-validator.mjs", fixture).length, 3);
});
