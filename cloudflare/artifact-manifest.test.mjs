import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
    CLOUDFLARE_ARTIFACT_DIGEST_BINDING,
    CLOUDFLARE_ARTIFACT_PUBLIC_PATH,
    artifactBoundVersionMessage,
    createCloudflareArtifactManifest,
    readReviewedCloudflareArtifactAsset,
    revalidateCloudflareArtifactManifest,
    validateActiveWorkerModule,
    verifyLiveCloudflareArtifact,
} from "../scripts/cloudflare-artifact-manifest.mjs";
import { repoRoot } from "../scripts/cloudflare-deployment-policy.mjs";
import {
    createRouteFreeWranglerConfig,
    runWranglerVersionUpload,
} from "../scripts/deploy-cloudflare-production.mjs";

const COMMIT = "a".repeat(40);
const MODULE_BYTES = Buffer.from(
    "export default { fetch() { return new Response('reviewed') } };\n"
);

const createFixture = () => {
    const root = mkdtempSync(
        path.join(repoRoot, ".cloudflare-artifact-manifest-test-")
    );
    const assetsDirectory = path.join(root, "assets");
    const artifactRoot = path.join(root, "artifacts");
    const artifactDirectory = path.join(artifactRoot, "test-site");
    mkdirSync(path.join(assetsDirectory, "assets"), { recursive: true });
    mkdirSync(artifactDirectory, { recursive: true });
    writeFileSync(path.join(artifactDirectory, "worker.mjs"), MODULE_BYTES);
    writeFileSync(
        path.join(assetsDirectory, "index.html"),
        "<h1>reviewed</h1>\n"
    );
    writeFileSync(
        path.join(assetsDirectory, "release.json"),
        `${JSON.stringify({ site: "test-site", commit: COMMIT })}\n`
    );
    writeFileSync(path.join(assetsDirectory, "assets/app.js"), "app();\n");
    writeFileSync(
        path.join(assetsDirectory, "_headers"),
        "/*\n  X-Test: yes\n"
    );
    const configFile = path.join(root, "production.jsonc");
    const renderedConfig = {
        name: "peerbit-examples-test-site",
        main: "../source-worker.mjs",
        compatibility_date: "2026-07-14",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: false,
        preview_urls: false,
        upload_source_maps: false,
        routes: [
            {
                pattern: "test.apps.peerbit.org",
                custom_domain: true,
            },
        ],
        assets: {
            directory: "./assets",
            binding: "ASSETS",
            run_worker_first: ["/media/*"],
        },
        vars: { RELEASE_CHANNEL: "production" },
    };
    writeFileSync(configFile, `${JSON.stringify(renderedConfig)}\n`);
    const site = { id: "test-site" };
    const policy = {
        id: site.id,
        productionWorker: renderedConfig.name,
    };
    const artifact = createCloudflareArtifactManifest({
        site,
        policy,
        configFile,
        renderedConfig,
        expectedCommit: COMMIT,
        artifactRoot,
    });
    return {
        root,
        assetsDirectory,
        artifactRoot,
        configFile,
        renderedConfig,
        site,
        policy,
        artifact,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
};

test("pre-credential artifact receipt binds exact module, route-free config, and every asset", () => {
    const fixture = createFixture();
    try {
        const { artifact, renderedConfig, configFile, policy } = fixture;
        assert.match(artifact.digest, /^[0-9a-f]{64}$/);
        assert.ok(Object.isFrozen(artifact.manifest));
        assert.ok(Object.isFrozen(artifact.manifest.module));
        assert.ok(Object.isFrozen(artifact.manifest.assets));
        assert.deepEqual(artifact.manifest.module, {
            path: "worker.mjs",
            size: MODULE_BYTES.length,
            sha256: createHash("sha256").update(MODULE_BYTES).digest("hex"),
            contentType: "application/javascript+module",
        });
        assert.deepEqual(
            artifact.manifest.assets.map(
                ({ path: assetPath, public: isPublic }) => [assetPath, isPublic]
            ),
            [
                ["_headers", false],
                ["assets/app.js", true],
                ["index.html", true],
                ["release.json", true],
            ]
        );
        assert.equal(artifact.manifest.deploymentConfig.routes, undefined);
        assert.equal(artifact.manifest.deploymentConfig.no_bundle, true);
        assert.equal(
            artifact.manifest.deploymentConfig.find_additional_modules,
            false
        );
        assert.equal(
            artifact.manifest.deploymentConfig.upload_source_maps,
            false
        );
        assert.equal(artifact.manifest.deploymentConfig.main, "worker.mjs");
        assert.equal(
            artifact.manifest.deploymentConfig.assets.directory,
            "<reviewed-static-assets>"
        );

        const privateConfig = createRouteFreeWranglerConfig({
            configFile,
            renderedConfig,
            workerName: policy.productionWorker,
            artifact,
        });
        assert.equal(privateConfig.main, artifact.moduleFile);
        assert.equal(privateConfig.no_bundle, true);
        assert.equal(privateConfig.find_additional_modules, false);
        assert.equal(privateConfig.upload_source_maps, false);
        assert.equal(privateConfig.routes, undefined);
        assert.equal(
            privateConfig.vars[CLOUDFLARE_ARTIFACT_DIGEST_BINDING],
            artifact.digest
        );
        assert.match(
            artifactBoundVersionMessage({
                siteId: fixture.site.id,
                expectedCommit: COMMIT,
                artifactManifestDigest: artifact.digest,
            }),
            new RegExp(`artifact-sha256:${artifact.digest}$`)
        );
        assert.equal(revalidateCloudflareArtifactManifest(artifact), artifact);
    } finally {
        fixture.cleanup();
    }
});

test("reviewed artifact reads return the exact manifest-bound buffer", () => {
    const fixture = createFixture();
    try {
        const expected = Buffer.from("/*\n  X-Test: yes\n", "utf8");
        const observed = readReviewedCloudflareArtifactAsset({
            artifact: fixture.artifact,
            relativePath: "_headers",
        });
        assert.ok(Buffer.isBuffer(observed));
        assert.deepEqual(observed, expected);

        writeFileSync(
            path.join(fixture.assetsDirectory, "_headers"),
            "/*\n  X-Test: substituted\n"
        );
        assert.throws(
            () =>
                readReviewedCloudflareArtifactAsset({
                    artifact: fixture.artifact,
                    relativePath: "_headers",
                }),
            /reviewed artifact asset bytes changed/
        );
        assert.deepEqual(observed, expected);
    } finally {
        fixture.cleanup();
    }
});

test("a compromised credentialed upload cannot silently substitute reviewed config or module inputs", () => {
    const fixture = createFixture();
    try {
        assert.throws(
            () =>
                createRouteFreeWranglerConfig({
                    configFile: fixture.configFile,
                    renderedConfig: {
                        ...fixture.renderedConfig,
                        compatibility_date: "2026-07-15",
                    },
                    workerName: fixture.policy.productionWorker,
                    artifact: fixture.artifact,
                }),
            /reviewed route-free runtime\/config changed/
        );
        assert.throws(
            () =>
                createRouteFreeWranglerConfig({
                    configFile: fixture.configFile,
                    renderedConfig: {
                        ...fixture.renderedConfig,
                        assets: {
                            ...fixture.renderedConfig.assets,
                            run_worker_first: ["/unreviewed/*"],
                        },
                    },
                    workerName: fixture.policy.productionWorker,
                    artifact: fixture.artifact,
                }),
            /reviewed route-free runtime\/config changed/
        );
        assert.throws(
            () =>
                createRouteFreeWranglerConfig({
                    configFile: fixture.configFile,
                    renderedConfig: {
                        ...fixture.renderedConfig,
                        find_additional_modules: true,
                    },
                    workerName: fixture.policy.productionWorker,
                    artifact: fixture.artifact,
                }),
            /forbids Wrangler auxiliary-module discovery/
        );
        assert.throws(
            () =>
                createRouteFreeWranglerConfig({
                    configFile: fixture.configFile,
                    renderedConfig: {
                        ...fixture.renderedConfig,
                        upload_source_maps: true,
                    },
                    workerName: fixture.policy.productionWorker,
                    artifact: fixture.artifact,
                }),
            /requires Wrangler source-map upload to be explicitly disabled/
        );
        assert.throws(
            () =>
                createRouteFreeWranglerConfig({
                    configFile: fixture.configFile,
                    renderedConfig: {
                        ...fixture.renderedConfig,
                        wasm_modules: { ROGUE: "./rogue.wasm" },
                    },
                    workerName: fixture.policy.productionWorker,
                    artifact: fixture.artifact,
                }),
            /forbids auxiliary-module setting wasm_modules/
        );
        chmodSync(fixture.artifact.moduleFile, 0o644);
        writeFileSync(
            fixture.artifact.moduleFile,
            "export default { fetch() { return new Response('substituted') } };\n"
        );
        assert.throws(
            () => revalidateCloudflareArtifactManifest(fixture.artifact),
            /reviewed main-module bytes changed/
        );
    } finally {
        fixture.cleanup();
    }
});

test("the reviewed dry-run receipt fails closed on every auxiliary runtime module", () => {
    const fixture = createFixture();
    try {
        writeFileSync(
            path.join(path.dirname(fixture.artifact.moduleFile), "rogue.wasm"),
            Buffer.from([0, 97, 115, 109])
        );
        assert.throws(
            () => revalidateCloudflareArtifactManifest(fixture.artifact),
            /exactly one Wrangler runtime-module output/
        );
    } finally {
        fixture.cleanup();
    }
});

test("the exact Wrangler invocation carries the artifact digest in config, message, and evidence", () => {
    const fixture = createFixture();
    try {
        const versionId = "11111111-1111-4111-8111-111111111111";
        const versionTag = "peerbit_test_site_aaaaaaaaaaaa_receipt";
        let invokedArguments;
        const evidence = runWranglerVersionUpload({
            wrangler: "/tools/wrangler",
            configFile: fixture.configFile,
            renderedConfig: fixture.renderedConfig,
            site: fixture.site,
            expectedCommit: COMMIT,
            workerName: fixture.policy.productionWorker,
            versionTag,
            artifact: fixture.artifact,
            environment: {
                CLOUDFLARE_API_TOKEN: "test-token",
                CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
            },
            runtime: {
                runLogged: (_command, args, environment) => {
                    invokedArguments = args;
                    const privateConfig = JSON.parse(
                        readFileSync(args[args.indexOf("--config") + 1], "utf8")
                    );
                    assert.equal(
                        privateConfig.main,
                        fixture.artifact.moduleFile
                    );
                    assert.equal(privateConfig.no_bundle, true);
                    assert.equal(privateConfig.find_additional_modules, false);
                    assert.equal(privateConfig.upload_source_maps, false);
                    assert.equal(
                        privateConfig.vars[CLOUDFLARE_ARTIFACT_DIGEST_BINDING],
                        fixture.artifact.digest
                    );
                    writeFileSync(
                        environment.WRANGLER_OUTPUT_FILE_PATH,
                        `${JSON.stringify({
                            type: "version-upload",
                            version: 1,
                            worker_name: fixture.policy.productionWorker,
                            worker_tag: "worker-tag",
                            version_id: versionId,
                            worker_name_overridden: false,
                        })}\n`
                    );
                },
            },
        });
        assert.deepEqual(evidence, {
            workerName: fixture.policy.productionWorker,
            workerTag: "worker-tag",
            versionId,
            artifactManifestDigest: fixture.artifact.digest,
        });
        assert.ok(invokedArguments.includes("--no-bundle"));
        assert.equal(
            invokedArguments[invokedArguments.indexOf("--message") + 1],
            artifactBoundVersionMessage({
                siteId: fixture.site.id,
                expectedCommit: COMMIT,
                artifactManifestDigest: fixture.artifact.digest,
            })
        );
    } finally {
        fixture.cleanup();
    }
});

test("changed static asset inputs fail before upload", () => {
    const fixture = createFixture();
    try {
        writeFileSync(
            path.join(fixture.assetsDirectory, "assets/app.js"),
            "substituted();\n"
        );
        assert.throws(
            () => revalidateCloudflareArtifactManifest(fixture.artifact),
            /reviewed static-asset bytes changed/
        );
    } finally {
        fixture.cleanup();
    }
});

test("active module and exhaustive live asset proofs accept only reviewed bytes", async () => {
    const fixture = createFixture();
    try {
        const { artifact, assetsDirectory } = fixture;
        validateActiveWorkerModule({
            artifact,
            observed: {
                name: "worker.mjs",
                contentType: "application/javascript+module",
                size: MODULE_BYTES.length,
                sha256: createHash("sha256").update(MODULE_BYTES).digest("hex"),
            },
        });
        assert.throws(
            () =>
                validateActiveWorkerModule({
                    artifact,
                    observed: {
                        name: "worker.mjs",
                        contentType: "application/javascript+module",
                        size: MODULE_BYTES.length,
                        sha256: "f".repeat(64),
                    },
                }),
            /exact Worker version module set does not match/
        );

        const requested = [];
        const serveReviewed = async (url, init) => {
            assert.equal(init.redirect, "manual");
            const pathname = decodeURIComponent(new URL(url).pathname);
            requested.push(pathname);
            if (pathname === CLOUDFLARE_ARTIFACT_PUBLIC_PATH) {
                return new Response(readFileSync(artifact.manifestFile));
            }
            return new Response(
                readFileSync(path.join(assetsDirectory, pathname.slice(1)))
            );
        };
        await verifyLiveCloudflareArtifact({
            origin: "https://test.apps.peerbit.org",
            artifact,
            request: serveReviewed,
            concurrency: 2,
        });
        assert.deepEqual(
            requested.sort(),
            [
                CLOUDFLARE_ARTIFACT_PUBLIC_PATH,
                ...artifact.manifest.assets
                    .filter(({ public: isPublic }) => isPublic)
                    .map(({ path: assetPath }) => `/${assetPath}`),
            ].sort()
        );

        await assert.rejects(
            verifyLiveCloudflareArtifact({
                origin: "https://test.apps.peerbit.org",
                artifact,
                request: async (url) => {
                    const pathname = decodeURIComponent(new URL(url).pathname);
                    if (pathname === CLOUDFLARE_ARTIFACT_PUBLIC_PATH) {
                        return new Response(
                            readFileSync(artifact.manifestFile)
                        );
                    }
                    if (pathname === "/assets/app.js") {
                        return new Response("wrong live asset\n");
                    }
                    return new Response(
                        readFileSync(
                            path.join(assetsDirectory, pathname.slice(1))
                        )
                    );
                },
            }),
            /live bytes do not match the reviewed artifact manifest/
        );
    } finally {
        fixture.cleanup();
    }
});
