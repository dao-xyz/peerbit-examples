import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadCloudflareDeploymentData } from "../scripts/cloudflare-deployment-policy.mjs";
import {
    CloudflareWorkersApiError,
    createCloudflareWorkersApi,
} from "../scripts/cloudflare-workers-api.mjs";
import {
    PROVISIONING_CONFIRMATION_PREFIXES,
    PROVISIONING_PLAN_STATE_SENTINEL,
    createProvisioningVersionTag,
    inspectProductionProvisioning,
    parseProductionProvisioningArgs,
    productionProvisioningConfirmation,
    provisionProductionEntries as runProvisionProductionEntriesWithReceipt,
} from "../scripts/provision-cloudflare-production.mjs";
import {
    CLOUDFLARE_ARTIFACT_DIGEST_BINDING,
    artifactBoundVersionMessage,
} from "../scripts/cloudflare-artifact-manifest.mjs";
import { accountZoneInventorySha256 } from "../scripts/deploy-cloudflare-production.mjs";

const COMMIT = "a".repeat(40);
const OTHER_COMMIT = "b".repeat(40);
const ACCOUNT_ID = "c".repeat(32);
const ZONE_ID = "d".repeat(32);
const HIDDEN_ZONE_ID = "e".repeat(32);
const EXPECTED_ZONE_INVENTORY_SHA256 = accountZoneInventorySha256([
    { zoneId: ZONE_ID, zoneName: "peerbit.org" },
]);
const API_TOKEN = "cloudflare-test-token";
const LEGACY_NONCE = "1".repeat(32);
const PLAN_DIGEST = "2".repeat(64);
const clone = (value) => structuredClone(value);
const { entries } = loadCloudflareDeploymentData();
const artifactDigestFor = (siteId) =>
    createHash("sha256").update(`artifact:${siteId}`).digest("hex");
const artifacts = new Map(
    entries.map(({ site, policy }) => {
        const sha256 = createHash("sha256")
            .update(`module:${site.id}`)
            .digest("hex");
        return [
            site.id,
            {
                siteId: site.id,
                workerName: policy.productionWorker,
                commit: COMMIT,
                digest: artifactDigestFor(site.id),
                manifest: {
                    module: {
                        path: "module.js",
                        contentType: "application/javascript+module",
                        size: site.id.length,
                        sha256,
                    },
                },
            },
        ];
    })
);
const configs = new Map(
    entries.map(({ site, policy }) => [
        site.id,
        {
            file: `/reviewed/${site.id}.json`,
            config: {
                name: policy.productionWorker,
                workers_dev: false,
                preview_urls: false,
                ...(site.id === "stream"
                    ? {
                          cache: {
                              enabled: true,
                              cross_version_cache: false,
                          },
                      }
                    : {}),
                routes: policy.productionHostnames.map((hostname) => ({
                    pattern: hostname,
                    custom_domain: true,
                })),
            },
        },
    ])
);

const provisionProductionEntriesWithReceipt = (input) =>
    runProvisionProductionEntriesWithReceipt({
        accountId: ACCOUNT_ID,
        artifacts,
        expectedZoneInventorySha256: EXPECTED_ZONE_INVENTORY_SHA256,
        ...input,
    });

const provisionProductionEntries = async (input) => {
    if (input.mode !== "apply" || input.plannedStateDigest != null) {
        return provisionProductionEntriesWithReceipt(input);
    }
    const reviewed = await provisionProductionEntriesWithReceipt({
        ...input,
        mode: "plan",
        log: () => {},
    });
    return provisionProductionEntriesWithReceipt({
        ...input,
        plannedStateDigest: reviewed.stateDigest,
    });
};

const versionIdFor = (index) => {
    const part = String(index + 1).padStart(8, "0");
    return `${part}-1111-4111-8111-${String(index + 1).padStart(12, "0")}`;
};

const expectedMessage = (siteId, commit = COMMIT) =>
    artifactBoundVersionMessage({
        siteId,
        expectedCommit: commit,
        artifactManifestDigest: artifactDigestFor(siteId),
    });

const versionCacheOptions = (siteId) =>
    siteId === "stream"
        ? { enabled: true, cross_version_cache: false }
        : undefined;

const versionResources = (siteId, suffix = "baseline") => ({
    bindings: [
        {
            name: CLOUDFLARE_ARTIFACT_DIGEST_BINDING,
            type: "plain_text",
            text: artifactDigestFor(siteId),
        },
    ],
    script: {
        etag: `etag-${siteId}-${suffix}`,
        handlers: ["fetch"],
        named_handlers: [],
    },
    script_runtime: {
        compatibility_flags: [],
        limits: {},
        usage_model: "standard",
    },
});

const createHarness = () => {
    const scripts = new Map();
    const domains = [];
    const subdomains = new Map();
    const deployments = new Map();
    const versions = new Map();
    const queueConsumerInventory = [];
    const zoneRouteInventory = [
        {
            zoneId: ZONE_ID,
            zoneName: "peerbit.org",
            status: "active",
            type: "full",
            routes: [],
        },
    ];
    const calls = [];
    let uploadGeneration = 0;

    const entryForWorker = (workerName) =>
        entries.find(({ policy }) => policy.productionWorker === workerName);
    const versionsFor = (workerName) => {
        let workerVersions = versions.get(workerName);
        if (!workerVersions) {
            workerVersions = new Map();
            versions.set(workerName, workerVersions);
        }
        return workerVersions;
    };
    const addWorker = ({
        entry,
        enabled = false,
        previewsEnabled = false,
        workerTag = `worker-tag-${entry.site.id}`,
    }) => {
        scripts.set(entry.policy.productionWorker, {
            tag: workerTag,
            routes: [],
            tailConsumers: [],
            logpush: false,
        });
        subdomains.set(entry.policy.productionWorker, {
            enabled,
            previewsEnabled,
        });
        deployments.set(entry.policy.productionWorker, []);
        versionsFor(entry.policy.productionWorker);
        return workerTag;
    };
    const addPreview = ({
        entry,
        enabled = false,
        previewsEnabled = false,
        workerTag = `preview-worker-tag-${entry.site.id}`,
        routes = [],
    }) => {
        scripts.set(entry.policy.previewWorker, {
            tag: workerTag,
            routes: clone(routes),
            tailConsumers: [],
            logpush: false,
        });
        subdomains.set(entry.policy.previewWorker, {
            enabled,
            previewsEnabled,
        });
        return workerTag;
    };
    const addExactVersion = ({ entry, active = false, commit = COMMIT }) => {
        if (!scripts.has(entry.policy.productionWorker)) addWorker({ entry });
        const index = entries.findIndex(
            ({ site }) => site.id === entry.site.id
        );
        const versionId = versionIdFor(index);
        versionsFor(entry.policy.productionWorker).set(versionId, {
            id: versionId,
            annotations: {
                "workers/tag": createProvisioningVersionTag({
                    siteId: entry.site.id,
                    expectedCommit: commit,
                    invocationNonce: LEGACY_NONCE,
                }),
                "workers/message": expectedMessage(entry.site.id, commit),
            },
            resources: versionResources(entry.site.id),
            ...(versionCacheOptions(entry.site.id)
                ? { cache_options: versionCacheOptions(entry.site.id) }
                : {}),
        });
        if (active) {
            deployments.set(entry.policy.productionWorker, [
                {
                    versions: [{ version_id: versionId, percentage: 100 }],
                },
            ]);
        }
        return versionId;
    };
    const attachExactDomain = (entry) => {
        domains.push({
            id: `domain-${entry.site.id}`,
            hostname: entry.policy.productionHostnames[0],
            service: entry.policy.productionWorker,
            environment: "production",
            zoneId: ZONE_ID,
            zoneName: "peerbit.org",
        });
    };
    const seedExact = ({
        entry,
        active = true,
        domain = active,
        enabled = false,
        previewsEnabled = false,
    }) => {
        addWorker({ entry, enabled, previewsEnabled });
        const versionId = addExactVersion({ entry, active });
        if (domain) attachExactDomain(entry);
        return versionId;
    };

    const operations = {
        listWorkerScripts: async () => {
            calls.push(["list-scripts"]);
            return new Map(
                [...scripts].map(([name, metadata]) => [name, clone(metadata)])
            );
        },
        listZoneRouteInventory: async () => {
            calls.push(["list-zone-routes"]);
            return clone(zoneRouteInventory);
        },
        listWorkerDomains: async () => {
            calls.push(["list-domains"]);
            return clone(domains);
        },
        getWorkerSubdomain: async (workerName) => {
            calls.push(["get-subdomain", workerName]);
            const state = subdomains.get(workerName);
            if (!state) throw new Error("missing Worker subdomain state");
            return clone(state);
        },
        listWorkerSchedules: async (workerName) => {
            calls.push(["list-schedules", workerName]);
            return [];
        },
        listQueueConsumerInventory: async () => {
            calls.push(["list-queue-consumers"]);
            return clone(queueConsumerInventory);
        },
        getWorkerDeployments: async (workerName) => {
            calls.push(["get-deployments", workerName]);
            return clone(deployments.get(workerName) ?? []);
        },
        listDeployableWorkerVersions: async (workerName) => {
            calls.push(["list-versions", workerName]);
            return [...(versions.get(workerName)?.keys() ?? [])];
        },
        getWorkerVersion: async (workerName, versionId) => {
            calls.push(["get-version", workerName, versionId]);
            const version = versions.get(workerName)?.get(versionId);
            if (!version) throw new Error("missing Worker version");
            return clone(version);
        },
        getWorkerVersionModule: async (workerName, versionId) => {
            calls.push(["get-version-module", workerName, versionId]);
            const entry = entryForWorker(workerName);
            assert.ok(entry);
            const module = artifacts.get(entry.site.id).manifest.module;
            return {
                name: "module.js",
                contentType: "application/javascript+module",
                size: module.size,
                sha256: module.sha256,
            };
        },
        upload: async ({
            site,
            policy,
            expectedCommit,
            versionTag,
            artifact,
        }) => {
            calls.push(["upload", site.id]);
            const workerTag =
                scripts.get(policy.productionWorker)?.tag ??
                addWorker({
                    entry: { site, policy },
                    enabled: true,
                    previewsEnabled: true,
                });
            const index = entries.findIndex(
                ({ site: value }) => value.id === site.id
            );
            uploadGeneration += 1;
            const versionId = versionIdFor(
                index + entries.length * uploadGeneration
            );
            versionsFor(policy.productionWorker).set(versionId, {
                id: versionId,
                annotations: {
                    "workers/tag": versionTag,
                    "workers/message": expectedMessage(site.id, expectedCommit),
                },
                resources: versionResources(site.id, versionTag),
                ...(versionCacheOptions(site.id)
                    ? { cache_options: versionCacheOptions(site.id) }
                    : {}),
            });
            return {
                workerName: policy.productionWorker,
                workerTag,
                versionId,
                artifactManifestDigest: artifact.digest,
            };
        },
        disableWorkerSubdomain: async (workerName) => {
            calls.push(["disable-subdomain", workerName]);
            subdomains.set(workerName, {
                enabled: false,
                previewsEnabled: false,
            });
            return clone(subdomains.get(workerName));
        },
        activate: async ({ workerName, versionId }) => {
            calls.push(["activate", workerName, versionId]);
            deployments.set(workerName, [
                {
                    versions: [{ version_id: versionId, percentage: 100 }],
                },
            ]);
            return clone(deployments.get(workerName)[0]);
        },
        attachDomain: async ({ workerName, hostname }) => {
            calls.push(["attach-domain", workerName, hostname]);
            const entry = entryForWorker(workerName);
            assert.ok(entry);
            const attachment = {
                id: `domain-${entry.site.id}`,
                hostname,
                service: workerName,
                environment: "production",
                zoneId: ZONE_ID,
                zoneName: "peerbit.org",
            };
            domains.push(attachment);
            return clone(attachment);
        },
        verify: async ({ site, expectedCommit }) => {
            calls.push(["verify", site.id, expectedCommit]);
        },
    };
    return {
        scripts,
        domains,
        subdomains,
        deployments,
        versions,
        queueConsumerInventory,
        zoneRouteInventory,
        calls,
        operations,
        addWorker,
        addPreview,
        addExactVersion,
        attachExactDomain,
        seedExact,
    };
};

const mutationCalls = (calls) =>
    calls.filter(([name]) =>
        ["upload", "disable-subdomain", "activate", "attach-domain"].includes(
            name
        )
    );

test("provisioning CLI requires mode-specific explicit confirmation", () => {
    const planConfirmation = productionProvisioningConfirmation({
        mode: "plan",
        plannedCommit: COMMIT,
    });
    const applyConfirmation = productionProvisioningConfirmation({
        mode: "apply",
        plannedCommit: COMMIT,
        plannedStateDigest: PLAN_DIGEST,
    });
    assert.deepEqual(
        parseProductionProvisioningArgs([
            "--mode",
            "plan",
            "--commit",
            COMMIT,
            "--planned-commit",
            COMMIT,
            "--planned-state-digest",
            PROVISIONING_PLAN_STATE_SENTINEL,
            "--confirm",
            planConfirmation,
        ]),
        {
            mode: "plan",
            expectedCommit: COMMIT,
            plannedCommit: COMMIT,
            plannedStateDigest: PROVISIONING_PLAN_STATE_SENTINEL,
        }
    );
    assert.deepEqual(
        parseProductionProvisioningArgs([
            "--confirm",
            applyConfirmation,
            "--mode",
            "apply",
            "--commit",
            COMMIT,
            "--planned-commit",
            COMMIT,
            "--planned-state-digest",
            PLAN_DIGEST,
        ]),
        {
            mode: "apply",
            expectedCommit: COMMIT,
            plannedCommit: COMMIT,
            plannedStateDigest: PLAN_DIGEST,
        }
    );
    for (const [name, argv, pattern] of [
        [
            "missing receipt",
            [
                "--mode",
                "apply",
                "--commit",
                COMMIT,
                "--confirm",
                applyConfirmation,
            ],
            /Usage/,
        ],
        [
            "short receipt",
            [
                "--mode",
                "apply",
                "--commit",
                COMMIT,
                "--planned-commit",
                COMMIT.slice(0, 12),
                "--planned-state-digest",
                PLAN_DIGEST,
                "--confirm",
                applyConfirmation,
            ],
            /full planned commit receipt/,
        ],
        [
            "different receipt",
            [
                "--mode",
                "apply",
                "--commit",
                COMMIT,
                "--planned-commit",
                OTHER_COMMIT,
                "--planned-state-digest",
                PLAN_DIGEST,
                "--confirm",
                productionProvisioningConfirmation({
                    mode: "apply",
                    plannedCommit: OTHER_COMMIT,
                    plannedStateDigest: PLAN_DIGEST,
                }),
            ],
            /must equal the checked-out commit/,
        ],
        [
            "generic confirmation",
            [
                "--mode",
                "apply",
                "--commit",
                COMMIT,
                "--planned-commit",
                COMMIT,
                "--planned-state-digest",
                PLAN_DIGEST,
                "--confirm",
                PROVISIONING_CONFIRMATION_PREFIXES.apply,
            ],
            /SHA-bound confirmation phrase/,
        ],
        [
            "confirmation for another SHA",
            [
                "--mode",
                "plan",
                "--commit",
                COMMIT,
                "--planned-commit",
                COMMIT,
                "--planned-state-digest",
                PROVISIONING_PLAN_STATE_SENTINEL,
                "--confirm",
                productionProvisioningConfirmation({
                    mode: "plan",
                    plannedCommit: OTHER_COMMIT,
                }),
            ],
            /SHA-bound confirmation phrase/,
        ],
    ]) {
        assert.throws(
            () => parseProductionProvisioningArgs(argv),
            pattern,
            name
        );
    }
});

test("read-only plan proposes all seven exact targets without mutations", async () => {
    const harness = createHarness();
    const logs = [];
    const plan = await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: (line) => logs.push(line),
    });
    assert.equal(plan.length, 7);
    assert.deepEqual(
        plan.map(({ site, worker, hostname }) => [site, worker, hostname]),
        entries.map(({ site, policy }) => [
            site.id,
            policy.productionWorker,
            policy.productionHostnames[0],
        ])
    );
    assert.ok(
        plan.every(({ actions }) =>
            actions.includes("attach-reviewed-custom-domain")
        )
    );
    assert.deepEqual(
        plan.map(({ previewWorker, previewExists, previewActions }) => [
            previewWorker,
            previewExists,
            previewActions,
        ]),
        entries.map(({ policy }) => [policy.previewWorker, false, []])
    );
    assert.equal(
        harness.calls.some(
            ([name, worker]) =>
                ["get-subdomain", "disable-subdomain"].includes(name) &&
                entries.some(({ policy }) => policy.previewWorker === worker)
        ),
        false
    );
    assert.deepEqual(mutationCalls(harness.calls), []);
    assert.match(logs.at(-1), /no Cloudflare mutations were dispatched/);
});

test("provisioning requires the independently reviewed zone fingerprint", async (t) => {
    for (const fixture of [
        { name: "missing", value: undefined },
        { name: "non-string", value: { toString: () => "a".repeat(64) } },
        { name: "uppercase", value: "A".repeat(64) },
        { name: "short", value: "a".repeat(63) },
    ]) {
        await t.test(fixture.name, async () => {
            const harness = createHarness();
            await assert.rejects(
                provisionProductionEntriesWithReceipt({
                    entries,
                    configs,
                    expectedCommit: COMMIT,
                    expectedZoneInventorySha256: fixture.value,
                    mode: "plan",
                    operations: harness.operations,
                    log: () => {},
                }),
                /CLOUDFLARE_ACCOUNT_ZONE_INVENTORY_SHA256 must be an exact lowercase SHA-256 digest/
            );
            assert.deepEqual(mutationCalls(harness.calls), []);
        });
    }
});

test("permission-filtered 200 zone inventory cannot authorize provisioning", async () => {
    const harness = createHarness();
    const requests = [];
    const api = createCloudflareWorkersApi({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        request: async (url, init) => {
            requests.push({ url, init });
            const parsed = new URL(url);
            if (parsed.pathname.endsWith("/zones")) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: [
                            {
                                id: ZONE_ID,
                                name: "peerbit.org",
                                account: { id: ACCOUNT_ID },
                                status: "active",
                                type: "full",
                            },
                        ],
                        result_info: {
                            count: 1,
                            page: 1,
                            per_page: 50,
                            total_count: 1,
                            total_pages: 1,
                        },
                    }),
                    { status: 200 }
                );
            }
            assert.match(parsed.pathname, /\/workers\/routes$/);
            return new Response(JSON.stringify({ success: true, result: [] }), {
                status: 200,
            });
        },
    });
    harness.operations.listZoneRouteInventory = api.listZoneRouteInventory;
    const independentlyReviewed = accountZoneInventorySha256([
        { zoneId: ZONE_ID, zoneName: "peerbit.org" },
        { zoneId: HIDDEN_ZONE_ID, zoneName: "hidden.example" },
    ]);
    let failure;
    try {
        await provisionProductionEntriesWithReceipt({
            entries,
            configs,
            expectedCommit: COMMIT,
            expectedZoneInventorySha256: independentlyReviewed,
            mode: "plan",
            operations: harness.operations,
            log: () => {},
        });
    } catch (error) {
        failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(
        failure.message,
        /does not match the independently reviewed fingerprint/
    );
    assert.doesNotMatch(failure.message, new RegExp(independentlyReviewed));
    assert.equal(requests.length, 4);
    assert.ok(requests.every(({ init }) => init.method === "GET"));
    assert.deepEqual(mutationCalls(harness.calls), []);
});

test("provisioning rejects a well-formed but wrong zone fingerprint", async () => {
    const harness = createHarness();
    await assert.rejects(
        provisionProductionEntriesWithReceipt({
            entries,
            configs,
            expectedCommit: COMMIT,
            expectedZoneInventorySha256: "0".repeat(64),
            mode: "plan",
            operations: harness.operations,
            log: () => {},
        }),
        /does not match the independently reviewed fingerprint/
    );
    assert.deepEqual(mutationCalls(harness.calls), []);
});

test("missing inline routes defer to exact authoritative per-zone truth", async () => {
    const harness = createHarness();
    const target = entries[0];
    harness.addWorker({ entry: target });
    harness.scripts.get(target.policy.productionWorker).routes = null;
    harness.zoneRouteInventory[0].routes.push({
        id: "scriptless-route",
        pattern: "unrelated.example.com/*",
        script: null,
    });

    const plan = await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    assert.equal(plan.length, entries.length);
    assert.deepEqual(mutationCalls(harness.calls), []);
});

test("authoritative hidden routes and inline disagreements fail closed", async (t) => {
    await t.test("hidden route on managed Worker", async () => {
        const harness = createHarness();
        const target = entries[0];
        harness.addWorker({ entry: target });
        harness.scripts.get(target.policy.productionWorker).routes = null;
        harness.zoneRouteInventory[0].routes.push({
            id: "hidden-managed-route",
            pattern: "unrelated.example.com/*",
            script: target.policy.productionWorker,
        });
        await assert.rejects(
            provisionProductionEntries({
                entries,
                configs,
                expectedCommit: COMMIT,
                mode: "plan",
                operations: harness.operations,
                log: () => {},
            }),
            /unreviewed traditional Worker route attachment/
        );
        assert.deepEqual(mutationCalls(harness.calls), []);
    });

    await t.test("inline route does not exist authoritatively", async () => {
        const harness = createHarness();
        harness.scripts.set("unrelated-worker", {
            tag: "unrelated-tag",
            routes: [
                {
                    id: "inline-only-route",
                    pattern: "unrelated.example.com/*",
                    script: "unrelated-worker",
                },
            ],
            tailConsumers: [],
            logpush: false,
        });
        await assert.rejects(
            provisionProductionEntries({
                entries,
                configs,
                expectedCommit: COMMIT,
                mode: "plan",
                operations: harness.operations,
                log: () => {},
            }),
            /do not exactly match the authoritative per-zone route inventory/
        );
        assert.deepEqual(mutationCalls(harness.calls), []);
    });

    await t.test(
        "authoritative route references an unknown script",
        async () => {
            const harness = createHarness();
            harness.zoneRouteInventory[0].routes.push({
                id: "unknown-script-route",
                pattern: "unrelated.example.com/*",
                script: "unknown-worker",
            });
            await assert.rejects(
                provisionProductionEntries({
                    entries,
                    configs,
                    expectedCommit: COMMIT,
                    mode: "plan",
                    operations: harness.operations,
                    log: () => {},
                }),
                /references unknown script unknown-worker/
            );
            assert.deepEqual(mutationCalls(harness.calls), []);
        }
    );
});

test("reviewed fingerprint and state digest bind every authoritative zone and route field", async (t) => {
    for (const [name, mutate, pattern] of [
        [
            "zone ID",
            (inventory) => (inventory[0].zoneId = "e".repeat(32)),
            /independently reviewed fingerprint/,
        ],
        [
            "zone name",
            (inventory) => (inventory[0].zoneName = "changed.org"),
            /independently reviewed fingerprint/,
        ],
        [
            "zone status",
            (inventory) => (inventory[0].status = "pending"),
            /state changed after review/,
        ],
        [
            "zone type",
            (inventory) => (inventory[0].type = "partial"),
            /state changed after review/,
        ],
        [
            "route ID",
            (inventory) => (inventory[0].routes[0].id = "changed-route"),
            /state changed after review/,
        ],
        [
            "route pattern",
            (inventory) =>
                (inventory[0].routes[0].pattern = "changed.example.com/*"),
            /state changed after review/,
        ],
        [
            "route script",
            (inventory) => (inventory[0].routes[0].script = "external-worker"),
            /state changed after review/,
        ],
        [
            "route removal",
            (inventory) => inventory[0].routes.splice(0),
            /state changed after review/,
        ],
        [
            "zone addition",
            (inventory) =>
                inventory.push({
                    zoneId: "e".repeat(32),
                    zoneName: "peerchecker.com",
                    status: "active",
                    type: "full",
                    routes: [],
                }),
            /independently reviewed fingerprint/,
        ],
    ]) {
        await t.test(name, async () => {
            const harness = createHarness();
            harness.scripts.set("external-worker", {
                tag: "external-tag",
                routes: null,
                tailConsumers: [],
                logpush: false,
            });
            harness.zoneRouteInventory[0].routes.push({
                id: "scriptless-route",
                pattern: "unrelated.example.com/*",
                script: null,
            });
            const reviewed = await provisionProductionEntriesWithReceipt({
                entries,
                configs,
                expectedCommit: COMMIT,
                mode: "plan",
                operations: harness.operations,
                log: () => {},
            });
            mutate(harness.zoneRouteInventory);
            await assert.rejects(
                provisionProductionEntriesWithReceipt({
                    entries,
                    configs,
                    expectedCommit: COMMIT,
                    mode: "apply",
                    plannedStateDigest: reviewed.stateDigest,
                    operations: harness.operations,
                    log: () => {},
                }),
                pattern
            );
            assert.deepEqual(mutationCalls(harness.calls), []);
        });
    }
});

test("authoritative route drift after upload trips the invocation fence", async () => {
    const harness = createHarness();
    const reviewed = await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    const upload = harness.operations.upload;
    harness.operations.upload = async (input) => {
        const evidence = await upload(input);
        harness.zoneRouteInventory[0].routes.push({
            id: "concurrent-scriptless-route",
            pattern: "concurrent.example.com/*",
            script: null,
        });
        return evidence;
    };
    await assert.rejects(
        provisionProductionEntriesWithReceipt({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            plannedStateDigest: reviewed.stateDigest,
            operations: harness.operations,
            log: () => {},
        }),
        /authoritative account zone or Worker route inventory changed|post-upload proof/
    );
    assert.equal(
        harness.calls.some(([name]) => name === "activate"),
        false
    );
});

test("independent zone identity fingerprint is rechecked after upload", async () => {
    const harness = createHarness();
    harness.zoneRouteInventory.push({
        zoneId: HIDDEN_ZONE_ID,
        zoneName: "hidden.example",
        status: "active",
        type: "internal",
        routes: [],
    });
    const expectedZoneInventorySha256 = accountZoneInventorySha256(
        harness.zoneRouteInventory
    );
    const reviewed = await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        expectedZoneInventorySha256,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    const upload = harness.operations.upload;
    harness.operations.upload = async (input) => {
        const evidence = await upload(input);
        harness.zoneRouteInventory.splice(1, 1);
        return evidence;
    };
    await assert.rejects(
        provisionProductionEntriesWithReceipt({
            entries,
            configs,
            expectedCommit: COMMIT,
            expectedZoneInventorySha256,
            mode: "apply",
            plannedStateDigest: reviewed.stateDigest,
            operations: harness.operations,
            log: () => {},
        }),
        /does not match the independently reviewed fingerprint|post-upload proof/
    );
    assert.equal(
        harness.calls.some(([name]) => name === "upload"),
        true
    );
    assert.equal(
        harness.calls.some(([name]) => name === "activate"),
        false
    );
});

test("reviewed provisioning receipt cannot be reused with a swapped zone fingerprint", async () => {
    const harness = createHarness();
    const reviewed = await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    harness.zoneRouteInventory.push({
        zoneId: HIDDEN_ZONE_ID,
        zoneName: "hidden.example",
        status: "active",
        type: "internal",
        routes: [],
    });
    await assert.rejects(
        provisionProductionEntriesWithReceipt({
            entries,
            configs,
            expectedCommit: COMMIT,
            expectedZoneInventorySha256: accountZoneInventorySha256(
                harness.zoneRouteInventory
            ),
            mode: "apply",
            plannedStateDigest: reviewed.stateDigest,
            operations: harness.operations,
            log: () => {},
        }),
        /state changed after review/
    );
    assert.deepEqual(mutationCalls(harness.calls), []);
});

test("preview planning derives exact policy identities and handles every public flag combination", async () => {
    const harness = createHarness();
    const states = [
        { enabled: true, previewsEnabled: false },
        { enabled: false, previewsEnabled: true },
        { enabled: true, previewsEnabled: true },
        { enabled: false, previewsEnabled: false },
    ];
    states.forEach((state, index) =>
        harness.addPreview({ entry: entries[index], ...state })
    );

    const plan = await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    assert.deepEqual(
        plan.map(({ previewWorker, previewExists, previewActions }) => [
            previewWorker,
            previewExists,
            previewActions,
        ]),
        entries.map(({ policy }, index) => [
            policy.previewWorker,
            index < states.length,
            index < 3 ? ["disable-public-subdomains"] : [],
        ])
    );
    assert.deepEqual(mutationCalls(harness.calls), []);

    harness.calls.length = 0;
    await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        operations: harness.operations,
        log: () => {},
    });
    const previewWorkers = new Set(
        entries.map(({ policy }) => policy.previewWorker)
    );
    assert.deepEqual(
        harness.calls
            .filter(
                ([name, worker]) =>
                    name === "disable-subdomain" && previewWorkers.has(worker)
            )
            .map(([, worker]) => worker),
        entries.slice(0, 3).map(({ policy }) => policy.previewWorker)
    );
    for (const entry of entries.slice(0, states.length)) {
        assert.deepEqual(harness.subdomains.get(entry.policy.previewWorker), {
            enabled: false,
            previewsEnabled: false,
        });
    }
    for (const entry of entries.slice(states.length)) {
        assert.equal(harness.scripts.has(entry.policy.previewWorker), false);
        assert.equal(
            harness.calls.some(
                ([name, worker]) =>
                    name === "disable-subdomain" &&
                    worker === entry.policy.previewWorker
            ),
            false
        );
    }
});

test("all preview disable GET postconditions precede the first production mutation", async () => {
    const harness = createHarness();
    for (const entry of entries) {
        harness.addPreview({
            entry,
            enabled: true,
            previewsEnabled: true,
        });
    }
    await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        operations: harness.operations,
        log: () => {},
    });

    const productionWorkers = new Set(
        entries.map(({ policy }) => policy.productionWorker)
    );
    const firstProductionMutation = harness.calls.findIndex(
        ([name, worker]) =>
            ["upload", "activate", "attach-domain"].includes(name) ||
            (name === "disable-subdomain" && productionWorkers.has(worker))
    );
    assert.ok(firstProductionMutation >= 0);
    for (const { policy } of entries) {
        const disabledAt = harness.calls.findIndex(
            ([name, worker]) =>
                name === "disable-subdomain" && worker === policy.previewWorker
        );
        assert.ok(disabledAt >= 0 && disabledAt < firstProductionMutation);
        const provedAt = harness.calls.findIndex(
            ([name, worker], index) =>
                index > disabledAt &&
                name === "get-subdomain" &&
                worker === policy.previewWorker
        );
        assert.ok(provedAt > disabledAt && provedAt < firstProductionMutation);
        assert.deepEqual(harness.subdomains.get(policy.previewWorker), {
            enabled: false,
            previewsEnabled: false,
        });
    }
});

test("all existing production public URLs are disabled and proved before the first upload", async () => {
    const harness = createHarness();
    const states = [
        { enabled: true, previewsEnabled: false },
        { enabled: false, previewsEnabled: true },
        { enabled: true, previewsEnabled: true },
    ];
    states.forEach((state, index) =>
        harness.seedExact({ entry: entries[index], ...state })
    );

    await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        operations: harness.operations,
        log: () => {},
    });
    const firstUpload = harness.calls.findIndex(([name]) => name === "upload");
    assert.ok(firstUpload >= 0);
    for (const entry of entries.slice(0, states.length)) {
        const worker = entry.policy.productionWorker;
        const disabledAt = harness.calls.findIndex(
            ([name, identity]) =>
                name === "disable-subdomain" && identity === worker
        );
        const provedAt = harness.calls.findIndex(
            ([name, identity], index) =>
                index > disabledAt &&
                name === "get-subdomain" &&
                identity === worker
        );
        assert.ok(disabledAt >= 0 && disabledAt < firstUpload);
        assert.ok(provedAt > disabledAt && provedAt < firstUpload);
        assert.deepEqual(harness.subdomains.get(worker), {
            enabled: false,
            previewsEnabled: false,
        });
    }
});

test("provisioning rejects a rendered config that could publish a preview URL", async () => {
    const harness = createHarness();
    const unsafeConfigs = clone(configs);
    unsafeConfigs.get("stream").config.preview_urls = true;
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs: unsafeConfigs,
            expectedCommit: COMMIT,
            mode: "plan",
            operations: harness.operations,
            log: () => {},
        }),
        /preview_urls must be disabled/
    );
    assert.deepEqual(harness.calls, []);
});

test("preview identities are independently pinned before every account read", async (t) => {
    for (const [name, entryIndex, substitute] of [
        ["duplicate", 1, entries[0].policy.previewWorker],
        ["unreviewed", 1, "peerbit-examples-music-shadow-preview"],
        ["retired legacy", 0, "peerbit-examples-legacy-stream-preview"],
    ]) {
        await t.test(name, async () => {
            const harness = createHarness();
            const invalidEntries = clone(entries);
            invalidEntries[entryIndex].policy.previewWorker = substitute;
            await assert.rejects(
                inspectProductionProvisioning({
                    entries: invalidEntries,
                    configs,
                    artifacts,
                    expectedCommit: COMMIT,
                    expectedZoneInventorySha256: EXPECTED_ZONE_INVENTORY_SHA256,
                    operations: harness.operations,
                }),
                /reviewed seven-application allowlist/
            );
            assert.deepEqual(harness.calls, []);
        });
    }
});

test("every confirmed apply uploads and activates seven fresh nonce-bound versions", async () => {
    const harness = createHarness();
    await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        operations: harness.operations,
        log: () => {},
    });
    assert.equal(harness.calls.filter(([name]) => name === "upload").length, 7);
    assert.equal(
        harness.calls.filter(([name]) => name === "disable-subdomain").length,
        7
    );
    assert.equal(
        harness.calls.filter(([name]) => name === "activate").length,
        7
    );
    assert.equal(
        harness.calls.filter(([name]) => name === "attach-domain").length,
        7
    );
    assert.equal(harness.calls.filter(([name]) => name === "verify").length, 7);
    for (const { policy } of entries) {
        assert.deepEqual(harness.subdomains.get(policy.productionWorker), {
            enabled: false,
            previewsEnabled: false,
        });
        assert.equal(harness.scripts.has(policy.previewWorker), false);
        assert.equal(
            harness.calls.some(
                ([name, worker]) =>
                    name === "disable-subdomain" &&
                    worker === policy.previewWorker
            ),
            false
        );
        assert.equal(
            harness.deployments.get(policy.productionWorker)[0].versions[0]
                .percentage,
            100
        );
    }

    harness.calls.length = 0;
    await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        operations: harness.operations,
        log: () => {},
    });
    assert.equal(harness.calls.filter(([name]) => name === "upload").length, 7);
    assert.equal(
        harness.calls.filter(([name]) => name === "activate").length,
        7
    );
    assert.equal(
        harness.calls.filter(([name]) => name === "attach-domain").length,
        0
    );
    assert.equal(harness.calls.filter(([name]) => name === "verify").length, 7);
});

test("partial state quarantines old versions and uploads seven fresh versions", async () => {
    const harness = createHarness();
    const partial = entries[0];
    harness.addWorker({
        entry: partial,
        enabled: true,
        previewsEnabled: true,
    });
    harness.addExactVersion({ entry: partial, active: false });
    for (const entry of entries.slice(1)) harness.seedExact({ entry });

    await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        operations: harness.operations,
        log: () => {},
    });
    assert.deepEqual(
        harness.calls
            .filter(([name]) => name === "upload")
            .map(([, site]) => site),
        entries.map(({ site }) => site.id)
    );
    assert.deepEqual(
        harness.calls
            .filter(([name]) => name === "activate")
            .map(([, worker]) => worker),
        entries.map(({ policy }) => policy.productionWorker)
    );
    assert.deepEqual(
        harness.calls
            .filter(([name]) => name === "attach-domain")
            .map(([, worker]) => worker),
        [partial.policy.productionWorker]
    );
});

test("apply requires the exact canonical state digest from a reviewed plan", async () => {
    const harness = createHarness();
    const reviewed = await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    assert.match(reviewed.stateDigest, /^[0-9a-f]{64}$/);
    await assert.rejects(
        provisionProductionEntriesWithReceipt({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        /requires the exact state digest/
    );
    await assert.rejects(
        provisionProductionEntriesWithReceipt({
            entries,
            configs,
            expectedCommit: COMMIT,
            accountId: "e".repeat(32),
            mode: "apply",
            plannedStateDigest: reviewed.stateDigest,
            operations: harness.operations,
            log: () => {},
        }),
        /state changed after review/
    );
    harness.addWorker({ entry: entries[0] });
    await assert.rejects(
        provisionProductionEntriesWithReceipt({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            plannedStateDigest: reviewed.stateDigest,
            operations: harness.operations,
            log: () => {},
        }),
        /state changed after review/
    );
    assert.deepEqual(mutationCalls(harness.calls), []);
});

test("reviewed state receipts bind every pre-credential artifact digest", async () => {
    const harness = createHarness();
    const reviewed = await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    const changedArtifacts = new Map(artifacts);
    changedArtifacts.set("stream", {
        ...changedArtifacts.get("stream"),
        digest: createHash("sha256")
            .update("different reviewed stream artifact")
            .digest("hex"),
    });
    await assert.rejects(
        provisionProductionEntriesWithReceipt({
            entries,
            configs,
            artifacts: changedArtifacts,
            expectedCommit: COMMIT,
            mode: "apply",
            plannedStateDigest: reviewed.stateDigest,
            operations: harness.operations,
            log: () => {},
        }),
        /state changed after review/
    );
    assert.deepEqual(mutationCalls(harness.calls), []);
});

test("reviewed state receipts bind tags, versions, domains, and public flags", async (t) => {
    for (const [name, arrange, drift] of [
        [
            "immutable Worker tag",
            (harness) => harness.addWorker({ entry: entries[0] }),
            (harness) => {
                harness.scripts.get(entries[0].policy.productionWorker).tag =
                    "replacement-worker-tag";
            },
        ],
        [
            "deployable version inventory",
            (harness) => harness.seedExact({ entry: entries[0] }),
            (harness) => {
                const versionId = versionIdFor(600);
                harness.versions
                    .get(entries[0].policy.productionWorker)
                    .set(versionId, {
                        id: versionId,
                        annotations: {},
                        resources: versionResources("forged"),
                    });
            },
        ],
        [
            "custom domain",
            (harness) => harness.seedExact({ entry: entries[0] }),
            (harness) => harness.domains.splice(0),
        ],
        [
            "public subdomain flags",
            (harness) => harness.addPreview({ entry: entries[0] }),
            (harness) =>
                harness.subdomains.set(entries[0].policy.previewWorker, {
                    enabled: true,
                    previewsEnabled: false,
                }),
        ],
        [
            "account Queue consumer inventory",
            (harness) =>
                harness.queueConsumerInventory.push({
                    queueId: "queue-a",
                    queueName: "first-queue",
                    consumers: [],
                }),
            (harness) =>
                harness.queueConsumerInventory[0].consumers.push({
                    consumerId: "consumer-a",
                    type: "http_pull",
                    scriptName: null,
                    queueName: "first-queue",
                    deadLetterQueue: "",
                    settings: {},
                }),
        ],
    ]) {
        await t.test(name, async () => {
            const harness = createHarness();
            arrange(harness);
            const reviewed = await provisionProductionEntriesWithReceipt({
                entries,
                configs,
                expectedCommit: COMMIT,
                mode: "plan",
                operations: harness.operations,
                log: () => {},
            });
            drift(harness);
            await assert.rejects(
                provisionProductionEntriesWithReceipt({
                    entries,
                    configs,
                    expectedCommit: COMMIT,
                    mode: "apply",
                    plannedStateDigest: reviewed.stateDigest,
                    operations: harness.operations,
                    log: () => {},
                }),
                /state changed after review/
            );
            assert.deepEqual(mutationCalls(harness.calls), []);
        });
    }
});

test("tail consumers, Logpush, and Cron schedules all block before mutation", async (t) => {
    for (const [name, mutate, pattern] of [
        [
            "tail consumer",
            (harness) => {
                harness.addWorker({ entry: entries[0] });
                harness.scripts
                    .get(entries[0].policy.productionWorker)
                    .tailConsumers.push({ service: "tail-worker" });
            },
            /Tail Worker consumers or Logpush/,
        ],
        [
            "Logpush",
            (harness) => {
                harness.addWorker({ entry: entries[0] });
                harness.scripts.get(
                    entries[0].policy.productionWorker
                ).logpush = true;
            },
            /Tail Worker consumers or Logpush/,
        ],
        [
            "Cron Trigger",
            (harness) => {
                harness.addWorker({ entry: entries[0] });
                const original = harness.operations.listWorkerSchedules;
                harness.operations.listWorkerSchedules = async (workerName) =>
                    workerName === entries[0].policy.productionWorker
                        ? ["* * * * *"]
                        : original(workerName);
            },
            /Cron Trigger schedules must be empty/,
        ],
        [
            "inbound service binding",
            (harness) => {
                const workerName = "unrelated-account-worker";
                const versionId = versionIdFor(500);
                harness.scripts.set(workerName, {
                    tag: "unrelated-tag",
                    routes: [],
                    tailConsumers: [],
                    logpush: false,
                });
                harness.deployments.set(workerName, [
                    {
                        versions: [{ version_id: versionId, percentage: 100 }],
                    },
                ]);
                harness.versions.set(
                    workerName,
                    new Map([
                        [
                            versionId,
                            {
                                id: versionId,
                                resources: {
                                    ...versionResources("unrelated"),
                                    bindings: [
                                        {
                                            name: "TARGET",
                                            type: "service",
                                            service:
                                                entries[0].policy
                                                    .productionWorker,
                                        },
                                    ],
                                },
                            },
                        ],
                    ])
                );
            },
            /unreviewed inbound attachment/,
        ],
        [
            "managed queue binding",
            (harness) => {
                const entry = entries[0];
                const versionId = harness.seedExact({ entry });
                harness.versions
                    .get(entry.policy.productionWorker)
                    .get(versionId)
                    .resources.bindings.push({
                        name: "QUEUE",
                        type: "queue",
                        queue_name: "unreviewed",
                    });
            },
            /unreviewed queue or service binding/,
        ],
        [
            "managed queue handler",
            (harness) => {
                const entry = entries[0];
                const versionId = harness.seedExact({ entry });
                harness.versions
                    .get(entry.policy.productionWorker)
                    .get(versionId).resources.script.handlers = ["queue"];
            },
            /unreviewed queue, scheduled, email, tail, or other event handler/,
        ],
    ]) {
        await t.test(name, async () => {
            const harness = createHarness();
            mutate(harness);
            await assert.rejects(
                provisionProductionEntriesWithReceipt({
                    entries,
                    configs,
                    expectedCommit: COMMIT,
                    mode: "plan",
                    operations: harness.operations,
                    log: () => {},
                }),
                pattern
            );
            assert.deepEqual(mutationCalls(harness.calls), []);
        });
    }
});

test("separate Queue consumer attachments to production or preview Workers block before mutation", async (t) => {
    for (const [name, scriptName] of [
        ["production Worker", entries[0].policy.productionWorker],
        ["preview Worker", entries[0].policy.previewWorker],
    ]) {
        await t.test(name, async () => {
            const harness = createHarness();
            harness.queueConsumerInventory.push({
                queueId: "queue-a",
                queueName: "first-queue",
                consumers: [
                    {
                        consumerId: "consumer-a",
                        type: "worker",
                        scriptName,
                        queueName: "first-queue",
                        deadLetterQueue: "",
                        settings: {},
                    },
                ],
            });
            await assert.rejects(
                provisionProductionEntriesWithReceipt({
                    entries,
                    configs,
                    expectedCommit: COMMIT,
                    mode: "plan",
                    operations: harness.operations,
                    log: () => {},
                }),
                /unreviewed Cloudflare Queue consumer attachment/
            );
            assert.deepEqual(mutationCalls(harness.calls), []);
        });
    }
});

test("forged uploaded resources and bindings cannot authorize activation", async (t) => {
    for (const [name, mutate, targetSiteId = "stream"] of [
        [
            "unexpected cache options",
            (version) =>
                (version.cache_options = {
                    enabled: true,
                    cross_version_cache: false,
                }),
            "music",
        ],
        [
            "missing reviewed cache options",
            (version) => delete version.cache_options,
        ],
        [
            "cross-version cache enabled",
            (version) => (version.cache_options.cross_version_cache = true),
        ],
        [
            "unreviewed nonempty resource limits",
            (version) =>
                (version.resources.script_runtime.limits = { cpu_ms: 50 }),
        ],
        [
            "unknown resource limit",
            (version) =>
                (version.resources.script_runtime.limits = {
                    future_limit: 1,
                }),
        ],
        [
            "null resource limits",
            (version) => (version.resources.script_runtime.limits = null),
        ],
        [
            "array resource limits",
            (version) => (version.resources.script_runtime.limits = []),
        ],
        [
            "non-plain resource limits",
            (version) =>
                (version.resources.script_runtime.limits = new Date(0)),
        ],
        [
            "unreviewed Durable Object migration",
            (version) =>
                (version.resources.script_runtime.migration_tag = "v1"),
        ],
        [
            "unreviewed placement",
            (version) =>
                (version.resources.script.placement = { mode: "smart" }),
        ],
        [
            "unreviewed usage model",
            (version) =>
                (version.resources.script_runtime.usage_model = "unbound"),
        ],
        [
            "unknown runtime field",
            (version) => (version.resources.script_runtime.unreviewed = true),
        ],
        [
            "unknown script field",
            (version) => (version.resources.script.unreviewed = true),
        ],
        [
            "unknown resource field",
            (version) => (version.resources.unreviewed = true),
        ],
        [
            "missing script etag",
            (version) => delete version.resources.script.etag,
        ],
        [
            "queue event handler",
            (version) => (version.resources.script.handlers = ["queue"]),
        ],
        [
            "named event handler",
            (version) =>
                (version.resources.script.named_handlers = ["namedFetch"]),
        ],
        [
            "service binding",
            (version) =>
                version.resources.bindings.push({
                    name: "UNREVIEWED",
                    type: "service",
                    service: "other-worker",
                }),
        ],
        [
            "queue binding",
            (version) =>
                version.resources.bindings.push({
                    name: "UNREVIEWED",
                    type: "queue",
                    queue_name: "other-queue",
                }),
        ],
        [
            "assets binding",
            (version) =>
                version.resources.bindings.push({
                    name: "ASSETS",
                    type: "assets",
                }),
        ],
        [
            "plain text substitution",
            (version) =>
                version.resources.bindings.push({
                    name: "FORGED",
                    type: "plain_text",
                    text: "forged",
                }),
        ],
    ]) {
        await t.test(name, async () => {
            const harness = createHarness();
            const reviewed = await provisionProductionEntriesWithReceipt({
                entries,
                configs,
                expectedCommit: COMMIT,
                mode: "plan",
                operations: harness.operations,
                log: () => {},
            });
            const upload = harness.operations.upload;
            harness.operations.upload = async (input) => {
                const evidence = await upload(input);
                if (input.site.id === targetSiteId) {
                    mutate(
                        harness.versions
                            .get(input.policy.productionWorker)
                            .get(evidence.versionId)
                    );
                }
                return evidence;
            };
            await assert.rejects(
                provisionProductionEntriesWithReceipt({
                    entries,
                    configs,
                    expectedCommit: COMMIT,
                    mode: "apply",
                    plannedStateDigest: reviewed.stateDigest,
                    operations: harness.operations,
                    log: () => {},
                }),
                /resource evidence|event handlers|unreviewed service, queue, secret, storage|assets binding|plain-text bindings|cache options|limits|migrations|placement|usage model|unreviewed fields/
            );
            assert.equal(
                harness.calls.some(
                    ([operation, workerName]) =>
                        operation === "activate" &&
                        workerName ===
                            entries.find(({ site }) => site.id === targetSiteId)
                                .policy.productionWorker
                ),
                false
            );
        });
    }
});

test("omitted and plain-empty default limits keep one fingerprint through every candidate fence", async () => {
    const harness = createHarness();
    const reviewed = await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    const candidateIds = new Set();
    const upload = harness.operations.upload;
    harness.operations.upload = async (input) => {
        const evidence = await upload(input);
        candidateIds.add(evidence.versionId);
        return evidence;
    };
    const getWorkerVersion = harness.operations.getWorkerVersion;
    let emptyReads = 0;
    let omittedReads = 0;
    harness.operations.getWorkerVersion = async (workerName, versionId) => {
        const version = await getWorkerVersion(workerName, versionId);
        if (candidateIds.has(versionId)) {
            if ((emptyReads + omittedReads) % 2 === 0) {
                emptyReads += 1;
                assert.deepEqual(version.resources.script_runtime.limits, {});
            } else {
                omittedReads += 1;
                delete version.resources.script_runtime.limits;
            }
        }
        return version;
    };

    await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        plannedStateDigest: reviewed.stateDigest,
        operations: harness.operations,
        log: () => {},
    });
    assert.ok(emptyReads > 0);
    assert.ok(omittedReads > 0);
    assert.equal(
        harness.calls.filter(([operation]) => operation === "activate").length,
        entries.length
    );
});

test("an explicitly reviewed limits object still requires an exact match", async (t) => {
    for (const [name, actualLimits, succeeds] of [
        ["exact", { cpu_ms: 25 }, true],
        ["different", { cpu_ms: 50 }, false],
        ["missing", undefined, false],
    ]) {
        await t.test(name, async () => {
            const harness = createHarness();
            const limitedConfigs = new Map(
                [...configs].map(([siteId, rendered]) => [
                    siteId,
                    clone(rendered),
                ])
            );
            limitedConfigs.get("stream").config.limits = { cpu_ms: 25 };
            const reviewed = await provisionProductionEntriesWithReceipt({
                entries,
                configs: limitedConfigs,
                expectedCommit: COMMIT,
                mode: "plan",
                operations: harness.operations,
                log: () => {},
            });
            const upload = harness.operations.upload;
            harness.operations.upload = async (input) => {
                const evidence = await upload(input);
                if (input.site.id === "stream") {
                    const runtime = harness.versions
                        .get(input.policy.productionWorker)
                        .get(evidence.versionId).resources.script_runtime;
                    if (actualLimits === undefined) delete runtime.limits;
                    else runtime.limits = clone(actualLimits);
                }
                return evidence;
            };
            const apply = provisionProductionEntriesWithReceipt({
                entries,
                configs: limitedConfigs,
                expectedCommit: COMMIT,
                mode: "apply",
                plannedStateDigest: reviewed.stateDigest,
                operations: harness.operations,
                log: () => {},
            });
            if (succeeds) {
                await apply;
                assert.equal(
                    harness.calls.filter(
                        ([operation]) => operation === "activate"
                    ).length,
                    entries.length
                );
            } else {
                await assert.rejects(apply, /limits do not match/);
                assert.equal(
                    harness.calls.some(
                        ([operation, workerName]) =>
                            operation === "activate" &&
                            workerName ===
                                entries.find(({ site }) => site.id === "stream")
                                    .policy.productionWorker
                    ),
                    false
                );
            }
        });
    }
});

test("an exact uploaded version resource substitution is caught before activation", async () => {
    const harness = createHarness();
    const reviewed = await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    const upload = harness.operations.upload;
    let uploadedVersionId;
    harness.operations.upload = async (input) => {
        const evidence = await upload(input);
        if (input.site.id === "stream") uploadedVersionId = evidence.versionId;
        return evidence;
    };
    const getVersion = harness.operations.getWorkerVersion;
    let candidateReads = 0;
    harness.operations.getWorkerVersion = async (workerName, versionId) => {
        const version = await getVersion(workerName, versionId);
        if (versionId === uploadedVersionId && ++candidateReads >= 2) {
            version.resources.script.etag = "substituted-resource-etag";
        }
        return version;
    };
    await assert.rejects(
        provisionProductionEntriesWithReceipt({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            plannedStateDigest: reviewed.stateDigest,
            operations: harness.operations,
            log: () => {},
        }),
        /resource fingerprint changed/
    );
    assert.equal(
        harness.calls.some(([operation]) => operation === "activate"),
        false
    );
});

test("a concurrent same-Worker version addition is never learned with the upload", async () => {
    const harness = createHarness();
    const reviewed = await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    const upload = harness.operations.upload;
    harness.operations.upload = async (input) => {
        const evidence = await upload(input);
        if (input.site.id === "stream") {
            const externalVersionId = versionIdFor(700);
            harness.versions
                .get(input.policy.productionWorker)
                .set(externalVersionId, {
                    id: externalVersionId,
                    annotations: {},
                    resources: versionResources("external"),
                });
        }
        return evidence;
    };
    await assert.rejects(
        provisionProductionEntriesWithReceipt({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            plannedStateDigest: reviewed.stateDigest,
            operations: harness.operations,
            log: () => {},
        }),
        /exact inactive uploaded Worker\/version transition was not observed/
    );
    assert.equal(
        harness.calls.some(([operation]) => operation === "activate"),
        false
    );
});

test("Queue consumer drift after upload is caught by the mutation-time ledger before activation", async () => {
    const harness = createHarness();
    const reviewed = await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    const upload = harness.operations.upload;
    harness.operations.upload = async (input) => {
        const evidence = await upload(input);
        if (input.site.id === "stream") {
            harness.queueConsumerInventory.push({
                queueId: "queue-a",
                queueName: "first-queue",
                consumers: [
                    {
                        consumerId: "consumer-a",
                        type: "http_pull",
                        scriptName: null,
                        queueName: "first-queue",
                        deadLetterQueue: "",
                        settings: {},
                    },
                ],
            });
        }
        return evidence;
    };
    await assert.rejects(
        provisionProductionEntriesWithReceipt({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            plannedStateDigest: reviewed.stateDigest,
            operations: harness.operations,
            log: () => {},
        }),
        /Queue consumer attachment inventory changed/
    );
    assert.equal(
        harness.calls.some(([operation]) => operation === "activate"),
        false
    );
});

test("a lost upload response can never be adopted by a later apply", async () => {
    const harness = createHarness();
    const firstPlan = await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    const upload = harness.operations.upload;
    harness.operations.upload = async (input) => {
        await upload(input);
        throw new Error("lost response after Cloudflare stored the version");
    };
    await assert.rejects(
        provisionProductionEntriesWithReceipt({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            plannedStateDigest: firstPlan.stateDigest,
            operations: harness.operations,
            log: () => {},
        }),
        /same-invocation structured Wrangler upload evidence is missing/
    );
    const streamWorker = entries[0].policy.productionWorker;
    const leftover = [...harness.versions.get(streamWorker).keys()];
    assert.equal(leftover.length, 1);

    harness.operations.upload = upload;
    harness.calls.length = 0;
    const secondPlan = await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "plan",
        operations: harness.operations,
        log: () => {},
    });
    assert.deepEqual(secondPlan[0].quarantinedVersionIds, leftover);
    await provisionProductionEntriesWithReceipt({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        plannedStateDigest: secondPlan.stateDigest,
        operations: harness.operations,
        log: () => {},
    });
    const activated = harness.calls.find(
        ([operation, worker]) =>
            operation === "activate" && worker === streamWorker
    )[2];
    assert.notEqual(activated, leftover[0]);
    assert.equal(harness.calls.filter(([name]) => name === "upload").length, 7);
});

test("each rerun uses a distinct unpredictable version tag", async () => {
    const harness = createHarness();
    await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        operations: harness.operations,
        log: () => {},
    });
    await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        operations: harness.operations,
        log: () => {},
    });
    for (const { site, policy } of entries) {
        const tags = [
            ...harness.versions.get(policy.productionWorker).values(),
        ].map((version) => version.annotations["workers/tag"]);
        assert.equal(new Set(tags).size, 2);
        assert.ok(
            tags.every((tag) =>
                new RegExp(
                    `^peerbit_bootstrap_${site.id}_${COMMIT.slice(0, 12)}_[0-9a-f]{32}$`
                ).test(tag)
            )
        );
    }
});

test("an existing Worker is disabled and proved both before and after upload", async () => {
    const harness = createHarness();
    const target = entries[0];
    harness.addWorker({
        entry: target,
        enabled: true,
        previewsEnabled: true,
    });
    for (const entry of entries.slice(1)) harness.seedExact({ entry });

    await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        operations: harness.operations,
        log: () => {},
    });
    const relevant = harness.calls
        .filter(
            ([name, workerOrSite]) =>
                (name === "upload" && workerOrSite === target.site.id) ||
                (["disable-subdomain", "activate"].includes(name) &&
                    workerOrSite === target.policy.productionWorker)
        )
        .map(([name]) => name);
    assert.deepEqual(relevant, [
        "disable-subdomain",
        "upload",
        "disable-subdomain",
        "activate",
    ]);
});

test("unexpected namespace, route, domain, and release state fail before preview remediation", async (t) => {
    const cases = [
        [
            "retired Worker",
            (harness) => {
                harness.scripts.set("peerbit-examples-legacy-stream-preview", {
                    tag: "legacy-tag",
                    routes: [],
                });
            },
        ],
        [
            "unknown managed Worker",
            (harness) => {
                harness.scripts.set("peerbit-examples-unreviewed", {
                    tag: "unknown-tag",
                    routes: [],
                });
            },
        ],
        [
            "allowlisted preview route",
            (harness) => {
                const preview = entries[0].policy.previewWorker;
                harness.scripts.get(preview).routes.push({
                    id: "preview-route",
                    pattern: "preview.peerbit.org/*",
                    script: preview,
                });
                harness.zoneRouteInventory[0].routes.push({
                    id: "preview-route",
                    pattern: "preview.peerbit.org/*",
                    script: preview,
                });
            },
        ],
        [
            "managed route",
            (harness) => {
                harness.scripts.set("unrelated-worker", {
                    tag: "unrelated-tag",
                    routes: [
                        {
                            id: "route-1",
                            pattern: "files.apps.peerbit.org/*",
                            script: "unrelated-worker",
                        },
                    ],
                });
                harness.zoneRouteInventory[0].routes.push({
                    id: "route-1",
                    pattern: "files.apps.peerbit.org/*",
                    script: "unrelated-worker",
                });
            },
        ],
        [
            "allowlisted preview custom domain",
            (harness) => {
                harness.domains.push({
                    id: "preview-domain",
                    hostname: "preview.peerbit.org",
                    service: entries[0].policy.previewWorker,
                    environment: "production",
                    zoneId: ZONE_ID,
                    zoneName: "peerbit.org",
                });
            },
        ],
        [
            "wrong domain owner",
            (harness) => {
                harness.scripts.set("unrelated-worker", {
                    tag: "unrelated-tag",
                    routes: [],
                });
                harness.domains.push({
                    id: "wrong-domain",
                    hostname: "files.apps.peerbit.org",
                    service: "unrelated-worker",
                    environment: "production",
                    zoneId: ZONE_ID,
                    zoneName: "peerbit.org",
                });
            },
        ],
    ];
    for (const [name, mutate] of cases) {
        await t.test(name, async () => {
            const harness = createHarness();
            for (const entry of entries) {
                harness.addPreview({
                    entry,
                    enabled: true,
                    previewsEnabled: true,
                });
            }
            mutate(harness);
            await assert.rejects(
                provisionProductionEntries({
                    entries,
                    configs,
                    expectedCommit: COMMIT,
                    mode: "apply",
                    operations: harness.operations,
                    log: () => {},
                })
            );
            assert.deepEqual(mutationCalls(harness.calls), []);
        });
    }
});

test("a reviewed different active baseline is replaced only by a fresh proved version", async () => {
    const harness = createHarness();
    for (const entry of entries) harness.seedExact({ entry });
    const target = entries[0];
    harness.addExactVersion({
        entry: target,
        active: true,
        commit: OTHER_COMMIT,
    });
    await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        operations: harness.operations,
        log: () => {},
    });
    assert.equal(harness.calls.filter(([name]) => name === "upload").length, 7);
    assert.equal(
        harness.calls.filter(([name]) => name === "activate").length,
        7
    );
});

test("a production Worker missing initially cannot appear before its owned upload", async () => {
    const harness = createHarness();
    const target = entries[0];
    const originalList = harness.operations.listWorkerScripts;
    let reads = 0;
    harness.operations.listWorkerScripts = async () => {
        reads += 1;
        if (reads === 2) harness.addWorker({ entry: target });
        return originalList();
    };
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        /Cloudflare provisioning state changed after review/
    );
    assert.deepEqual(mutationCalls(harness.calls), []);
});

test("a cross-site Worker replacement after upload is never rebaselined", async () => {
    const harness = createHarness();
    const target = entries[0];
    const victim = entries[1];
    for (const entry of entries.slice(1)) harness.seedExact({ entry });
    const originalUpload = harness.operations.upload;
    harness.operations.upload = async (input) => {
        const evidence = await originalUpload(input);
        harness.scripts.set(victim.policy.productionWorker, {
            tag: "replacement-cross-site-worker-tag",
            routes: [],
        });
        return evidence;
    };
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        /invocation production ledger changed workerTag/
    );
    assert.deepEqual(mutationCalls(harness.calls), [
        ["upload", target.site.id],
        ["disable-subdomain", target.policy.productionWorker],
    ]);
    assert.deepEqual(harness.subdomains.get(target.policy.productionWorker), {
        enabled: false,
        previewsEnabled: false,
    });
    assert.equal(
        harness.calls.some(([name]) =>
            ["activate", "attach-domain"].includes(name)
        ),
        false
    );
});

test("an earlier production public URL re-enable blocks every later domain mutation", async () => {
    const harness = createHarness();
    for (const entry of entries) {
        harness.seedExact({ entry, active: true, domain: false });
    }
    const earlier = entries[0];
    const originalAttach = harness.operations.attachDomain;
    const originalList = harness.operations.listWorkerScripts;
    let armed = false;
    let readsAfterFirstAttachment = 0;
    harness.operations.attachDomain = async (input) => {
        const attachment = await originalAttach(input);
        if (input.workerName === earlier.policy.productionWorker) armed = true;
        return attachment;
    };
    harness.operations.listWorkerScripts = async () => {
        if (armed) {
            readsAfterFirstAttachment += 1;
            if (readsAfterFirstAttachment === 2) {
                harness.subdomains.set(earlier.policy.productionWorker, {
                    enabled: true,
                    previewsEnabled: false,
                });
            }
        }
        return originalList();
    };
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        /existing production Worker must have workers\.dev and Preview URLs disabled before a custom-domain attachment/
    );
    assert.deepEqual(
        harness.calls
            .filter(([name]) => name === "attach-domain")
            .map(([, worker]) => worker),
        [earlier.policy.productionWorker]
    );
});

test("ambiguous upload, subdomain, activation, and domain responses require exact GET postconditions", async () => {
    const harness = createHarness();
    const logs = [];
    for (const [operationName, methodName] of [
        ["upload", "upload"],
        ["disable-subdomain", "disableWorkerSubdomain"],
        ["activate", "activate"],
        ["attach-domain", "attachDomain"],
    ]) {
        const original = harness.operations[methodName];
        harness.operations[methodName] = async (...args) => {
            const evidence = await original(...args);
            const error = new Error(
                `${operationName} response lost after dispatch`
            );
            if (methodName === "upload") {
                error.deploymentEvidence = evidence;
            }
            throw error;
        };
    }
    await provisionProductionEntries({
        entries,
        configs,
        expectedCommit: COMMIT,
        mode: "apply",
        operations: harness.operations,
        log: (line) => logs.push(line),
    });
    assert.ok(logs.some((line) => /ambiguous upload response/.test(line)));
    assert.ok(
        logs.some((line) => /ambiguous public-subdomain response/.test(line))
    );
    assert.ok(logs.some((line) => /ambiguous activation response/.test(line)));
    assert.ok(logs.some((line) => /ambiguous domain response/.test(line)));
});

test("every ambiguous preview disable response resumes only after an exact disabled GET", async (t) => {
    for (const responseKind of [
        "transport failure",
        "well-formed 400",
        "500",
        "malformed 200",
        "empty 200",
    ]) {
        await t.test(responseKind, async () => {
            const harness = createHarness();
            for (const entry of entries) harness.seedExact({ entry });
            const target = entries[0];
            harness.addPreview({
                entry: target,
                enabled: true,
                previewsEnabled: true,
            });
            const originalDisable = harness.operations.disableWorkerSubdomain;
            harness.operations.disableWorkerSubdomain = async (workerName) => {
                await originalDisable(workerName);
                throw new Error(`${responseKind} after mutation dispatch`);
            };
            const logs = [];
            await provisionProductionEntries({
                entries,
                configs,
                expectedCommit: COMMIT,
                mode: "apply",
                operations: harness.operations,
                log: (line) => logs.push(line),
            });
            const disabledAt = harness.calls.findIndex(
                ([name, worker]) =>
                    name === "disable-subdomain" &&
                    worker === target.policy.previewWorker
            );
            const provedAt = harness.calls.findIndex(
                ([name, worker], index) =>
                    index > disabledAt &&
                    name === "get-subdomain" &&
                    worker === target.policy.previewWorker
            );
            assert.ok(disabledAt >= 0 && provedAt > disabledAt);
            assert.deepEqual(
                harness.subdomains.get(target.policy.previewWorker),
                { enabled: false, previewsEnabled: false }
            );
            assert.ok(
                logs.some((line) =>
                    /ambiguous public-subdomain response/.test(line)
                )
            );
            assert.equal(
                harness.calls.filter(([name]) => name === "upload").length,
                7
            );
            assert.equal(
                harness.calls.filter(([name]) => name === "activate").length,
                7
            );
        });
    }
});

test("an unproved preview disable ambiguity stops before every production mutation", async () => {
    const harness = createHarness();
    for (const entry of entries) harness.seedExact({ entry });
    const target = entries[0];
    harness.addPreview({
        entry: target,
        enabled: true,
        previewsEnabled: true,
    });
    harness.operations.disableWorkerSubdomain = async (workerName) => {
        harness.calls.push(["disable-subdomain", workerName]);
        throw new Error("transport failure without proved application");
    };
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        /do not retry mutations blindly/
    );
    assert.deepEqual(mutationCalls(harness.calls), [
        ["disable-subdomain", target.policy.previewWorker],
    ]);
    assert.deepEqual(harness.subdomains.get(target.policy.previewWorker), {
        enabled: true,
        previewsEnabled: true,
    });
});

test("a preview Worker identity replacement during fencing blocks production", async () => {
    const harness = createHarness();
    for (const entry of entries) harness.seedExact({ entry });
    const target = entries[0];
    harness.addPreview({
        entry: target,
        enabled: true,
        previewsEnabled: true,
    });
    const originalDisable = harness.operations.disableWorkerSubdomain;
    harness.operations.disableWorkerSubdomain = async (workerName) => {
        const result = await originalDisable(workerName);
        harness.scripts.set(workerName, {
            tag: "replacement-preview-worker-tag",
            routes: [],
        });
        return result;
    };
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        /preview Worker identity changed/
    );
    assert.deepEqual(mutationCalls(harness.calls), [
        ["disable-subdomain", target.policy.previewWorker],
    ]);
});

test("a preview Worker re-enabled during upload blocks activation", async () => {
    const harness = createHarness();
    const target = entries[0];
    harness.addPreview({
        entry: target,
        enabled: true,
        previewsEnabled: true,
    });
    const originalUpload = harness.operations.upload;
    harness.operations.upload = async (input) => {
        const evidence = await originalUpload(input);
        harness.subdomains.set(target.policy.previewWorker, {
            enabled: true,
            previewsEnabled: false,
        });
        return evidence;
    };
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        /existing preview Worker must have .* Preview URLs disabled after a route-free version upload/
    );
    assert.deepEqual(
        mutationCalls(harness.calls).map(([name, identity]) => [
            name,
            identity,
        ]),
        [
            ["disable-subdomain", target.policy.previewWorker],
            ["upload", target.site.id],
            ["disable-subdomain", target.policy.productionWorker],
        ]
    );
    assert.deepEqual(harness.subdomains.get(target.policy.productionWorker), {
        enabled: false,
        previewsEnabled: false,
    });
    assert.equal(
        harness.calls.some(([name]) => name === "activate"),
        false
    );
});

test("an unproved ambiguous upload stops before activation and domain mutation", async () => {
    const harness = createHarness();
    const target = entries[0];
    harness.operations.upload = async ({ site }) => {
        harness.calls.push(["upload", site.id]);
        throw new Error("lost response without applying upload");
    };
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        /do not retry mutations blindly/
    );
    assert.deepEqual(mutationCalls(harness.calls), [
        ["upload", target.site.id],
        ["disable-subdomain", target.policy.productionWorker],
    ]);
    assert.equal(
        harness.calls.some(([name]) => name === "activate"),
        false
    );
    assert.equal(
        harness.calls.some(([name]) => name === "attach-domain"),
        false
    );
});

test("an applied new upload without Wrangler evidence cannot establish Worker identity", async () => {
    const harness = createHarness();
    const target = entries[0];
    const originalUpload = harness.operations.upload;
    harness.operations.upload = async (input) => {
        await originalUpload(input);
        throw new Error("lost response after applying upload");
    };
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        (error) => {
            assert.match(
                error.message,
                /upload response: lost response after applying upload/
            );
            assert.match(error.message, /post-upload proof:/);
            assert.match(
                error.message,
                /exact-name public-URL failure cleanup was proved false\/false by GET/
            );
            assert.match(
                error.message,
                /post-cleanup invocation fence was proved/
            );
            return true;
        }
    );
    assert.deepEqual(mutationCalls(harness.calls), [
        ["upload", target.site.id],
        ["disable-subdomain", target.policy.productionWorker],
    ]);
    assert.deepEqual(harness.subdomains.get(target.policy.productionWorker), {
        enabled: false,
        previewsEnabled: false,
    });
    assert.equal(
        harness.calls.some(([name]) =>
            ["activate", "attach-domain"].includes(name)
        ),
        false
    );
});

test("successful upload output must match exact GET-confirmed ownership", async () => {
    const harness = createHarness();
    const target = entries[0];
    const originalUpload = harness.operations.upload;
    harness.operations.upload = async (input) => {
        const evidence = await originalUpload(input);
        return { ...evidence, workerTag: "wrong-worker-tag" };
    };
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        (error) => {
            assert.match(
                error.message,
                /Wrangler upload evidence does not match/
            );
            assert.match(
                error.message,
                /exact-name public-URL failure cleanup was proved false\/false by GET/
            );
            return true;
        }
    );
    assert.deepEqual(mutationCalls(harness.calls), [
        ["upload", target.site.id],
        ["disable-subdomain", target.policy.productionWorker],
    ]);
    assert.deepEqual(harness.subdomains.get(target.policy.productionWorker), {
        enabled: false,
        previewsEnabled: false,
    });
    assert.equal(
        harness.calls.some(([name]) =>
            ["activate", "attach-domain"].includes(name)
        ),
        false
    );
});

test("a post-upload inspection failure still closes the exact public URL surfaces", async () => {
    const harness = createHarness();
    const target = entries[0];
    const originalUpload = harness.operations.upload;
    const originalList = harness.operations.listWorkerScripts;
    let failNextInventoryRead = false;
    harness.operations.upload = async (input) => {
        const evidence = await originalUpload(input);
        failNextInventoryRead = true;
        return evidence;
    };
    harness.operations.listWorkerScripts = async () => {
        if (failNextInventoryRead) {
            failNextInventoryRead = false;
            throw new Error("post-upload Worker inventory read failed");
        }
        return originalList();
    };

    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        (error) => {
            assert.match(
                error.message,
                /post-upload proof: post-upload Worker inventory read failed/
            );
            assert.match(
                error.message,
                /exact-name public-URL failure cleanup was proved false\/false by GET/
            );
            assert.match(
                error.message,
                /post-cleanup invocation fence was proved/
            );
            return true;
        }
    );
    assert.deepEqual(mutationCalls(harness.calls), [
        ["upload", target.site.id],
        ["disable-subdomain", target.policy.productionWorker],
    ]);
    assert.deepEqual(harness.subdomains.get(target.policy.productionWorker), {
        enabled: false,
        previewsEnabled: false,
    });
    assert.equal(
        harness.calls.some(([name]) =>
            ["activate", "attach-domain"].includes(name)
        ),
        false
    );
});

test("a failed upload preserves both the primary and public-URL cleanup diagnostics", async () => {
    const harness = createHarness();
    const target = entries[0];
    const originalUpload = harness.operations.upload;
    const originalDisable = harness.operations.disableWorkerSubdomain;
    harness.operations.upload = async (input) => {
        await originalUpload(input);
        throw new Error("original upload response diagnostic");
    };
    harness.operations.disableWorkerSubdomain = async (workerName) => {
        if (workerName === target.policy.productionWorker) {
            harness.calls.push(["disable-subdomain", workerName]);
            throw new Error("failure cleanup dispatch diagnostic");
        }
        return originalDisable(workerName);
    };

    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        (error) => {
            assert.match(
                error.message,
                /upload response: original upload response diagnostic/
            );
            assert.match(
                error.message,
                /exact-name public-URL failure cleanup was not proved:.*failure cleanup dispatch diagnostic/
            );
            assert.match(
                error.message,
                /post-cleanup invocation fence was not proved/
            );
            return true;
        }
    );
    assert.deepEqual(mutationCalls(harness.calls), [
        ["upload", target.site.id],
        ["disable-subdomain", target.policy.productionWorker],
    ]);
    assert.equal(
        harness.calls.some(([name]) =>
            ["activate", "attach-domain"].includes(name)
        ),
        false
    );
});

test("live verification and its final policy fence are required for success", async () => {
    const harness = createHarness();
    for (const entry of entries) harness.seedExact({ entry });
    const originalVerify = harness.operations.verify;
    harness.operations.verify = async (input) => {
        await originalVerify(input);
        if (input.site.id === "files") {
            harness.domains.find(
                ({ hostname }) => hostname === "files.apps.peerbit.org"
            ).service = "unrelated-worker";
        }
    };
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        /outside the exact provisioning policy|not exactly owned|custom domains must exactly equal/
    );
    assert.equal(harness.calls.filter(([name]) => name === "upload").length, 7);
    assert.equal(
        harness.calls.filter(([name]) => name === "activate").length,
        7
    );
});

test("wrong exact-version module bytes require manual recovery before any later mutation", async () => {
    const harness = createHarness();
    const getWorkerVersionModule = harness.operations.getWorkerVersionModule;
    harness.operations.getWorkerVersionModule = async (
        workerName,
        versionId
    ) => {
        const observed = await getWorkerVersionModule(workerName, versionId);
        const activeVersion = harness.deployments
            .get(workerName)?.[0]
            ?.versions?.find(
                ({ percentage }) => percentage === 100
            )?.version_id;
        return workerName === entries[0].policy.productionWorker &&
            activeVersion === versionId
            ? { ...observed, sha256: "f".repeat(64) }
            : observed;
    };
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        /exact 100% activation could not be proved.*do not retry mutations blindly/
    );
    assert.equal(
        harness.calls.filter(([name]) => name === "activate").length,
        1
    );
    assert.equal(
        harness.calls.some(([name]) => name === "attach-domain"),
        false
    );
    assert.equal(
        harness.calls.some(
            ([name, siteId]) => name === "upload" && siteId !== "stream"
        ),
        false
    );
});

test("final verification rechecks every existing preview Worker", async () => {
    const harness = createHarness();
    for (const entry of entries) {
        harness.seedExact({ entry });
        harness.addPreview({ entry });
    }
    const drifted = entries[0].policy.previewWorker;
    const originalVerify = harness.operations.verify;
    harness.operations.verify = async (input) => {
        await originalVerify(input);
        if (input.site.id === "files") {
            harness.subdomains.set(drifted, {
                enabled: false,
                previewsEnabled: true,
            });
        }
    };
    await assert.rejects(
        provisionProductionEntries({
            entries,
            configs,
            expectedCommit: COMMIT,
            mode: "apply",
            operations: harness.operations,
            log: () => {},
        }),
        /workers\.dev and (?:Worker )?Preview URLs must both be disabled|existing preview Worker must have workers\.dev and Preview URLs disabled after provisioning/
    );
    assert.equal(harness.calls.filter(([name]) => name === "upload").length, 7);
    assert.equal(
        harness.calls.filter(([name]) => name === "activate").length,
        7
    );
    for (const { policy } of entries) {
        assert.ok(
            harness.calls.some(
                ([name, worker]) =>
                    name === "get-subdomain" && worker === policy.previewWorker
            )
        );
    }
});

test("manual-recovery diagnostics redact token, account, and workers.dev slug", async () => {
    const harness = createHarness();
    const oldToken = process.env.CLOUDFLARE_API_TOKEN;
    const oldAccount = process.env.CLOUDFLARE_ACCOUNT_ID;
    process.env.CLOUDFLARE_API_TOKEN = API_TOKEN;
    process.env.CLOUDFLARE_ACCOUNT_ID = ACCOUNT_ID;
    harness.operations.upload = async ({ site }) => {
        harness.calls.push(["upload", site.id]);
        throw new Error(
            `${API_TOKEN} ${ACCOUNT_ID} https://v-worker.private-account.workers.dev./path`
        );
    };
    try {
        await assert.rejects(
            provisionProductionEntries({
                entries,
                configs,
                expectedCommit: COMMIT,
                mode: "apply",
                operations: harness.operations,
                log: () => {},
            }),
            (error) => {
                assert.doesNotMatch(error.message, new RegExp(API_TOKEN));
                assert.doesNotMatch(error.message, new RegExp(ACCOUNT_ID));
                assert.doesNotMatch(error.message, /private-account/i);
                assert.doesNotMatch(error.message, /workers\.dev/i);
                return true;
            }
        );
    } finally {
        if (oldToken == null) delete process.env.CLOUDFLARE_API_TOKEN;
        else process.env.CLOUDFLARE_API_TOKEN = oldToken;
        if (oldAccount == null) delete process.env.CLOUDFLARE_ACCOUNT_ID;
        else process.env.CLOUDFLARE_ACCOUNT_ID = oldAccount;
    }
});

test("Cloudflare provisioning adapters use exact documented endpoints and bodies", async () => {
    const workerName = entries[0].policy.productionWorker;
    const hostname = entries[0].policy.productionHostnames[0];
    const requests = [];
    const api = createCloudflareWorkersApi({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        request: async (url, init) => {
            requests.push([url, init.method, init.body]);
            if (url.endsWith("/deployments")) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: { deployments: [] },
                    })
                );
            }
            if (url.endsWith("/versions?deployable=true")) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: {
                            items: [{ id: versionIdFor(0), number: 1 }],
                        },
                    })
                );
            }
            if (url.endsWith("/subdomain")) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: {
                            enabled: false,
                            previews_enabled: false,
                        },
                    })
                );
            }
            if (url.endsWith("/schedules")) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: { schedules: [] },
                    })
                );
            }
            if (url.endsWith("/workers/domains")) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: {
                            id: "domain-stream",
                            hostname,
                            service: workerName,
                            environment: "production",
                            zone_id: ZONE_ID,
                            zone_name: "peerbit.org",
                        },
                    })
                );
            }
            return new Response("not found", { status: 404 });
        },
    });
    assert.deepEqual(await api.getWorkerDeployments(workerName), []);
    assert.deepEqual(await api.listWorkerSchedules(workerName), []);
    assert.deepEqual(await api.listDeployableWorkerVersions(workerName), [
        versionIdFor(0),
    ]);
    assert.deepEqual(await api.disableWorkerSubdomain(workerName), {
        enabled: false,
        previewsEnabled: false,
    });
    assert.equal(
        (await api.attachWorkerDomain({ workerName, hostname })).hostname,
        hostname
    );
    const root = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/workers`;
    assert.deepEqual(requests, [
        [`${root}/scripts/${workerName}/deployments`, "GET", undefined],
        [`${root}/scripts/${workerName}/schedules`, "GET", undefined],
        [
            `${root}/scripts/${workerName}/versions?deployable=true`,
            "GET",
            undefined,
        ],
        [
            `${root}/scripts/${workerName}/subdomain`,
            "POST",
            JSON.stringify({ enabled: false, previews_enabled: false }),
        ],
        [
            `${root}/domains`,
            "PUT",
            JSON.stringify({
                hostname,
                service: workerName,
                environment: "production",
            }),
        ],
    ]);
});

test("Worker list preserves absent and null inline routes as non-authoritative", async () => {
    const api = createCloudflareWorkersApi({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        request: async () =>
            new Response(
                JSON.stringify({
                    success: true,
                    result: [
                        { id: "worker-with-omitted-routes", tag: "tag-a" },
                        {
                            id: "worker-with-null-routes",
                            tag: "tag-b",
                            routes: null,
                        },
                        {
                            id: "worker-with-implicit-route-script",
                            tag: "tag-c",
                            routes: [
                                {
                                    id: "implicit-inline-route",
                                    pattern: "example.com/*",
                                },
                                {
                                    id: "null-inline-route",
                                    pattern: "example.com/null/*",
                                    script: null,
                                },
                            ],
                        },
                    ],
                })
            ),
    });
    assert.deepEqual(
        [...(await api.listWorkerScripts())],
        [
            [
                "worker-with-omitted-routes",
                {
                    tag: "tag-a",
                    routes: null,
                    tailConsumers: [],
                    logpush: false,
                },
            ],
            [
                "worker-with-null-routes",
                {
                    tag: "tag-b",
                    routes: null,
                    tailConsumers: [],
                    logpush: false,
                },
            ],
            [
                "worker-with-implicit-route-script",
                {
                    tag: "tag-c",
                    routes: [
                        {
                            id: "implicit-inline-route",
                            pattern: "example.com/*",
                            script: "worker-with-implicit-route-script",
                        },
                        {
                            id: "null-inline-route",
                            pattern: "example.com/null/*",
                            script: "worker-with-implicit-route-script",
                        },
                    ],
                    tailConsumers: [],
                    logpush: false,
                },
            ],
        ]
    );

    const malformed = createCloudflareWorkersApi({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        request: async () =>
            new Response(
                JSON.stringify({
                    success: true,
                    result: [{ id: "worker", routes: {} }],
                })
            ),
    });
    await assert.rejects(
        malformed.listWorkerScripts(),
        CloudflareWorkersApiError
    );

    const substituted = createCloudflareWorkersApi({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        request: async () =>
            new Response(
                JSON.stringify({
                    success: true,
                    result: [
                        {
                            id: "parent-worker",
                            routes: [
                                {
                                    id: "substituted-route",
                                    pattern: "example.com/*",
                                    script: "different-worker",
                                },
                            ],
                        },
                    ],
                })
            ),
    });
    await assert.rejects(
        substituted.listWorkerScripts(),
        CloudflareWorkersApiError
    );
});

test("authoritative zone routes paginate the exact account and require two complete stable snapshots", async () => {
    const OTHER_ZONE_ID = "e".repeat(32);
    const requests = [];
    const zone = ({ id, name, status = "active", type = "full" }) => ({
        id,
        name,
        status,
        type,
        account: { id: ACCOUNT_ID, name: "redacted-test-account" },
    });
    const api = createCloudflareWorkersApi({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        request: async (url, init) => {
            requests.push([url, init.method, init.headers.Authorization]);
            const parsed = new URL(url);
            if (parsed.pathname === "/client/v4/zones") {
                assert.equal(parsed.searchParams.get("account.id"), ACCOUNT_ID);
                assert.equal(parsed.searchParams.get("per_page"), "50");
                assert.equal(
                    parsed.searchParams.get("type"),
                    "full,partial,secondary,internal"
                );
                const page = Number(parsed.searchParams.get("page"));
                return new Response(
                    JSON.stringify({
                        success: true,
                        result:
                            page === 1
                                ? [zone({ id: ZONE_ID, name: "peerbit.org" })]
                                : [
                                      zone({
                                          id: OTHER_ZONE_ID,
                                          name: "peerchecker.com",
                                          status: "pending",
                                          type: "partial",
                                      }),
                                  ],
                        result_info: {
                            count: 1,
                            page,
                            per_page: 1,
                            total_count: 2,
                            total_pages: 2,
                        },
                    })
                );
            }
            if (parsed.pathname.endsWith(`/${ZONE_ID}/workers/routes`)) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: [
                            {
                                id: "scriptless-route",
                                pattern: "peerbit.org/disabled/*",
                            },
                        ],
                    })
                );
            }
            if (parsed.pathname.endsWith(`/${OTHER_ZONE_ID}/workers/routes`)) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: [
                            {
                                id: "external-route",
                                pattern: "peerchecker.com/*",
                                script: "external-worker",
                            },
                        ],
                    })
                );
            }
            return new Response("not found", { status: 404 });
        },
    });

    assert.deepEqual(await api.listZoneRouteInventory(), [
        {
            zoneId: ZONE_ID,
            zoneName: "peerbit.org",
            status: "active",
            type: "full",
            routes: [
                {
                    id: "scriptless-route",
                    pattern: "peerbit.org/disabled/*",
                    script: null,
                },
            ],
        },
        {
            zoneId: OTHER_ZONE_ID,
            zoneName: "peerchecker.com",
            status: "pending",
            type: "partial",
            routes: [
                {
                    id: "external-route",
                    pattern: "peerchecker.com/*",
                    script: "external-worker",
                },
            ],
        },
    ]);
    assert.equal(requests.length, 8);
    assert.ok(requests.every(([, method]) => method === "GET"));
    assert.ok(
        requests.every(
            ([, , authorization]) => authorization === `Bearer ${API_TOKEN}`
        )
    );
});

test("authoritative zone-route inventory fails closed on scope, pagination, identity, and drift errors", async (t) => {
    const zone = (
        id = ZONE_ID,
        name = "peerbit.org",
        account = ACCOUNT_ID
    ) => ({
        id,
        name,
        status: "active",
        type: "full",
        account: { id: account, name: "test-account" },
    });
    const zonePage = (zones, overrides = {}) => ({
        success: true,
        result: zones,
        result_info: {
            count: zones.length,
            page: 1,
            per_page: 50,
            total_count: zones.length,
            total_pages: zones.length === 0 ? 0 : 1,
            ...overrides,
        },
    });
    const invoke = (request) =>
        createCloudflareWorkersApi({
            accountId: ACCOUNT_ID,
            apiToken: API_TOKEN,
            request,
        }).listZoneRouteInventory();

    await t.test("wrong account", async () => {
        await assert.rejects(
            invoke(
                async () =>
                    new Response(
                        JSON.stringify(
                            zonePage([
                                zone(ZONE_ID, "peerbit.org", "f".repeat(32)),
                            ])
                        )
                    )
            ),
            /wrong-account zone identity/
        );
    });

    await t.test("Workers Routes token scope failure", async () => {
        await assert.rejects(
            invoke(
                async (url) =>
                    new Response(
                        JSON.stringify(
                            url.includes("/workers/routes")
                                ? {
                                      success: false,
                                      errors: [
                                          {
                                              code: 10000,
                                              message:
                                                  "Workers Routes Read is required",
                                          },
                                      ],
                                  }
                                : zonePage([zone()])
                        ),
                        { status: url.includes("/workers/routes") ? 403 : 200 }
                    )
            ),
            (error) =>
                error instanceof CloudflareWorkersApiError &&
                error.details.status === 403 &&
                error.details.indeterminateMutation === false
        );
    });

    await t.test("incomplete pagination", async () => {
        await assert.rejects(
            invoke(async (url) => {
                const page = Number(new URL(url).searchParams.get("page"));
                return new Response(
                    JSON.stringify(
                        page === 1
                            ? zonePage([zone()], {
                                  per_page: 1,
                                  total_count: 2,
                                  total_pages: 2,
                              })
                            : zonePage([], {
                                  page: 2,
                                  per_page: 1,
                                  total_count: 2,
                                  total_pages: 2,
                              })
                    )
                );
            }),
            /incomplete account-zone inventory/
        );
    });

    for (const direction of ["deleted", "added"]) {
        await t.test(`${direction} zone between snapshots`, async () => {
            let zoneReads = 0;
            await assert.rejects(
                invoke(async (url) => {
                    if (url.includes("/workers/routes")) {
                        return new Response(
                            JSON.stringify({ success: true, result: [] })
                        );
                    }
                    zoneReads += 1;
                    const include =
                        direction === "deleted"
                            ? zoneReads === 1
                            : zoneReads > 1;
                    return new Response(
                        JSON.stringify(zonePage(include ? [zone()] : []))
                    );
                }),
                /changed between complete snapshots/
            );
        });
    }

    await t.test("route drift between snapshots", async () => {
        let routeReads = 0;
        await assert.rejects(
            invoke(
                async (url) =>
                    new Response(
                        JSON.stringify(
                            url.includes("/workers/routes")
                                ? {
                                      success: true,
                                      result: [
                                          {
                                              id: "route-a",
                                              pattern: `peerbit.org/${++routeReads}`,
                                              script: null,
                                          },
                                      ],
                                  }
                                : zonePage([zone()])
                        )
                    )
            ),
            /changed between complete snapshots/
        );
    });

    await t.test("duplicate route pattern", async () => {
        await assert.rejects(
            invoke(
                async (url) =>
                    new Response(
                        JSON.stringify(
                            url.includes("/workers/routes")
                                ? {
                                      success: true,
                                      result: [
                                          {
                                              id: "route-a",
                                              pattern: "peerbit.org/*",
                                              script: null,
                                          },
                                          {
                                              id: "route-b",
                                              pattern: "peerbit.org/*",
                                              script: null,
                                          },
                                      ],
                                  }
                                : zonePage([zone()])
                        )
                    )
            ),
            /duplicate, or ambiguous authoritative Worker route/
        );
    });
});

test("Cron schedule inventory accepts only Cloudflare's exact documented envelope", async (t) => {
    const workerName = entries[0].policy.productionWorker;
    const invoke = async (result) => {
        const api = createCloudflareWorkersApi({
            accountId: ACCOUNT_ID,
            apiToken: API_TOKEN,
            request: async () =>
                new Response(JSON.stringify({ success: true, result })),
        });
        return api.listWorkerSchedules(workerName);
    };

    assert.deepEqual(
        await invoke({
            schedules: [{ cron: "5 * * * *" }, { cron: "* * * * *" }],
        }),
        ["* * * * *", "5 * * * *"]
    );
    assert.deepEqual(await invoke({ schedules: [] }), []);

    for (const [name, result] of [
        ["legacy top-level array", []],
        ["missing schedules", {}],
        ["non-array schedules", { schedules: {} }],
        ["extra envelope field", { schedules: [], extra: true }],
        ["null envelope", null],
    ]) {
        await t.test(name, async () => {
            await assert.rejects(invoke(result), CloudflareWorkersApiError);
        });
    }
});

test("Queue consumer inventory paginates the account and canonicalizes two complete snapshots", async () => {
    const root = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues`;
    const requests = [];
    let queueAConsumerReads = 0;
    const api = createCloudflareWorkersApi({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        request: async (url, init) => {
            requests.push([url, init.method]);
            if (url === `${root}?page=1&per_page=100`) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: [
                            {
                                queue_id: "queue-b",
                                queue_name: "second-queue",
                                consumers_total_count: 1,
                            },
                        ],
                        result_info: {
                            count: 1,
                            page: 1,
                            per_page: 1,
                            total_count: 2,
                            total_pages: 2,
                        },
                    })
                );
            }
            if (url === `${root}?page=2&per_page=100`) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: [
                            {
                                queue_id: "queue-a",
                                queue_name: "first-queue",
                                consumers_total_count: 1,
                            },
                        ],
                        result_info: {
                            count: 1,
                            page: 2,
                            per_page: 1,
                            total_count: 2,
                            total_pages: 2,
                        },
                    })
                );
            }
            if (url === `${root}/queue-a/consumers`) {
                const reverseKeys = queueAConsumerReads++ > 0;
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: [
                            {
                                consumer_id: "consumer-a",
                                type: "worker",
                                queue_name: "first-queue",
                                script_name: "external-worker",
                                dead_letter_queue: "failed-queue",
                                settings: reverseKeys
                                    ? { max_batch_size: 10, max_retries: 3 }
                                    : { max_retries: 3, max_batch_size: 10 },
                            },
                        ],
                    })
                );
            }
            if (url === `${root}/queue-b/consumers`) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        result: [
                            {
                                consumer_id: "consumer-b",
                                type: "http_pull",
                                queue_name: "second-queue",
                                settings: {},
                            },
                        ],
                    })
                );
            }
            return new Response("not found", { status: 404 });
        },
    });

    assert.deepEqual(await api.listQueueConsumerInventory(), [
        {
            queueId: "queue-a",
            queueName: "first-queue",
            consumers: [
                {
                    consumerId: "consumer-a",
                    type: "worker",
                    scriptName: "external-worker",
                    queueName: "first-queue",
                    deadLetterQueue: "failed-queue",
                    settings: { max_batch_size: 10, max_retries: 3 },
                },
            ],
        },
        {
            queueId: "queue-b",
            queueName: "second-queue",
            consumers: [
                {
                    consumerId: "consumer-b",
                    type: "http_pull",
                    scriptName: null,
                    queueName: "second-queue",
                    deadLetterQueue: "",
                    settings: {},
                },
            ],
        },
    ]);
    assert.deepEqual(requests, [
        [`${root}?page=1&per_page=100`, "GET"],
        [`${root}/queue-b/consumers`, "GET"],
        [`${root}?page=2&per_page=100`, "GET"],
        [`${root}/queue-a/consumers`, "GET"],
        [`${root}?page=1&per_page=100`, "GET"],
        [`${root}/queue-b/consumers`, "GET"],
        [`${root}?page=2&per_page=100`, "GET"],
        [`${root}/queue-a/consumers`, "GET"],
    ]);
});

test("Queue consumer inventory fails closed on malformed, incomplete, duplicate, or unstable reads", async (t) => {
    const root = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/queues`;
    const queuePage = (queues, overrides = {}) => ({
        success: true,
        result: queues,
        result_info: {
            count: queues.length,
            page: 1,
            per_page: 100,
            total_count: queues.length,
            total_pages: queues.length === 0 ? 0 : 1,
            ...overrides,
        },
    });
    const queue = {
        queue_id: "queue-a",
        queue_name: "first-queue",
        consumers_total_count: 1,
    };
    const workerConsumer = {
        consumer_id: "consumer-a",
        type: "worker",
        queue_name: "first-queue",
        script_name: "external-worker",
        settings: {},
    };
    const invoke = async (request) => {
        const api = createCloudflareWorkersApi({
            accountId: ACCOUNT_ID,
            apiToken: API_TOKEN,
            request,
        });
        return api.listQueueConsumerInventory();
    };

    await t.test("malformed pagination", async () => {
        await assert.rejects(
            invoke(
                async () =>
                    new Response(
                        JSON.stringify(queuePage([queue], { count: 2 }))
                    )
            ),
            CloudflareWorkersApiError
        );
    });

    await t.test("consumer count mismatch", async () => {
        await assert.rejects(
            invoke(
                async (url) =>
                    new Response(
                        JSON.stringify(
                            url.includes("/consumers")
                                ? { success: true, result: [] }
                                : queuePage([queue])
                        )
                    )
            ),
            CloudflareWorkersApiError
        );
    });

    await t.test("duplicate Queue identity", async () => {
        const duplicates = [
            queue,
            {
                ...queue,
                queue_name: "different-name",
                consumers_total_count: 0,
            },
        ];
        await assert.rejects(
            invoke(
                async (url) =>
                    new Response(
                        JSON.stringify(
                            url.includes("/consumers")
                                ? { success: true, result: [workerConsumer] }
                                : queuePage(duplicates)
                        )
                    )
            ),
            CloudflareWorkersApiError
        );
    });

    await t.test("malformed consumer", async () => {
        await assert.rejects(
            invoke(
                async (url) =>
                    new Response(
                        JSON.stringify(
                            url.includes("/consumers")
                                ? {
                                      success: true,
                                      result: [
                                          {
                                              ...workerConsumer,
                                              script_name: "../managed",
                                          },
                                      ],
                                  }
                                : queuePage([queue])
                        )
                    )
            ),
            CloudflareWorkersApiError
        );
    });

    await t.test("inventory never stabilizes", async () => {
        let consumerReads = 0;
        await assert.rejects(
            invoke(
                async (url) =>
                    new Response(
                        JSON.stringify(
                            url.includes("/consumers")
                                ? {
                                      success: true,
                                      result: [
                                          {
                                              ...workerConsumer,
                                              settings: {
                                                  max_batch_size:
                                                      ++consumerReads,
                                              },
                                          },
                                      ],
                                  }
                                : queuePage([queue])
                        )
                    )
            ),
            /did not remain stable/
        );
        assert.equal(consumerReads, 3);
    });
});

test("exact Worker version module adapter hashes the complete multipart set", async () => {
    const workerName = entries[0].policy.productionWorker;
    const versionId = versionIdFor(0);
    const bytes = Buffer.from(
        "export default { fetch() { return new Response('ok') } };"
    );
    const form = new FormData();
    form.set(
        "module.js",
        new Blob([bytes], { type: "application/javascript+module" }),
        "module.js"
    );
    let requestedUrl;
    const api = createCloudflareWorkersApi({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        request: async (url) => {
            requestedUrl = url;
            return new Response(form, {
                headers: { "cf-entrypoint": "module.js" },
            });
        },
    });
    assert.deepEqual(await api.getWorkerVersionModule(workerName, versionId), {
        name: "module.js",
        contentType: "application/javascript+module",
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    assert.match(
        requestedUrl,
        new RegExp(`/content/v2\\?version=${versionId}$`)
    );
});

test("exact Worker version module adapter rejects every ambiguous or auxiliary part", async (t) => {
    const workerName = entries[0].policy.productionWorker;
    const versionId = versionIdFor(0);
    const moduleBytes = Buffer.from("export default { fetch() {} };\n");
    const invoke = async ({ configure, entrypoint = "module.js" }) => {
        const form = new FormData();
        form.set(
            "module.js",
            new Blob([moduleBytes], {
                type: "application/javascript+module",
            }),
            "module.js"
        );
        configure?.(form);
        const api = createCloudflareWorkersApi({
            accountId: ACCOUNT_ID,
            apiToken: API_TOKEN,
            request: async () =>
                new Response(form, {
                    headers: entrypoint ? { "cf-entrypoint": entrypoint } : {},
                }),
        });
        return api.getWorkerVersionModule(workerName, versionId);
    };

    await t.test("missing cf-entrypoint", async () => {
        await assert.rejects(
            invoke({ entrypoint: "" }),
            /no unambiguous exact Worker version entrypoint/
        );
    });
    await t.test("auxiliary Wasm module", async () => {
        await assert.rejects(
            invoke({
                configure: (form) =>
                    form.set(
                        "rogue.wasm",
                        new Blob([Buffer.from([0, 97, 115, 109])], {
                            type: "application/wasm",
                        }),
                        "rogue.wasm"
                    ),
            }),
            /additional, missing, or malformed exact Worker version module/
        );
    });
    await t.test("unexpected metadata part", async () => {
        await assert.rejects(
            invoke({
                configure: (form) =>
                    form.set(
                        "metadata",
                        JSON.stringify({ main_module: "module.js" })
                    ),
            }),
            /additional, missing, or malformed exact Worker version module/
        );
    });
    await t.test("wrong module MIME", async () => {
        await assert.rejects(
            invoke({
                configure: (form) =>
                    form.set(
                        "module.js",
                        new Blob([moduleBytes], {
                            type: "application/javascript",
                        }),
                        "module.js"
                    ),
            }),
            /additional, missing, or malformed exact Worker version module/
        );
    });
});

test("every provisioning mutation response failure is indeterminate", async (t) => {
    const workerName = entries[0].policy.productionWorker;
    const hostname = entries[0].policy.productionHostnames[0];
    const adapters = [
        {
            name: "subdomain",
            invoke: (api) => api.disableWorkerSubdomain(workerName),
            invalidEvidence: {
                success: true,
                result: { enabled: true, previews_enabled: false },
            },
        },
        {
            name: "domain",
            invoke: (api) => api.attachWorkerDomain({ workerName, hostname }),
            invalidEvidence: {
                success: true,
                result: {
                    id: "domain-stream",
                    hostname,
                    service: "wrong-worker",
                    environment: "production",
                    zone_id: ZONE_ID,
                    zone_name: "peerbit.org",
                },
            },
        },
    ];
    const responses = [
        [
            "well-formed 400",
            () =>
                new Response(
                    JSON.stringify({
                        success: false,
                        errors: [{ code: 1000, message: "failed" }],
                    }),
                    { status: 400 }
                ),
        ],
        [
            "500",
            () =>
                new Response(
                    JSON.stringify({
                        success: false,
                        errors: [{ code: 1000, message: "failed" }],
                    }),
                    { status: 500 }
                ),
        ],
        ["malformed 200", () => new Response("{")],
        ["empty 200", () => new Response("")],
    ];
    for (const adapter of adapters) {
        await t.test(adapter.name, async (adapterTest) => {
            for (const [name, response] of [
                ...responses,
                [
                    "invalid exact evidence",
                    () => new Response(JSON.stringify(adapter.invalidEvidence)),
                ],
            ]) {
                await adapterTest.test(name, async () => {
                    const api = createCloudflareWorkersApi({
                        accountId: ACCOUNT_ID,
                        apiToken: API_TOKEN,
                        request: async () => response(),
                    });
                    await assert.rejects(adapter.invoke(api), (error) => {
                        assert.ok(error instanceof CloudflareWorkersApiError);
                        assert.equal(error.indeterminateMutation, true);
                        return true;
                    });
                });
            }
            await adapterTest.test("transport failure", async () => {
                const api = createCloudflareWorkersApi({
                    accountId: ACCOUNT_ID,
                    apiToken: API_TOKEN,
                    request: async () => {
                        throw new Error("connection lost");
                    },
                });
                await assert.rejects(adapter.invoke(api), (error) => {
                    assert.ok(error instanceof CloudflareWorkersApiError);
                    assert.equal(error.indeterminateMutation, true);
                    return true;
                });
            });
        });
    }
});

test("provisioning mutation local validation dispatches nothing", async () => {
    let requests = 0;
    const api = createCloudflareWorkersApi({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        request: async () => {
            requests += 1;
            throw new Error("must not dispatch");
        },
    });
    await assert.rejects(api.disableWorkerSubdomain("../wrong"));
    await assert.rejects(
        api.attachWorkerDomain({
            workerName: entries[0].policy.productionWorker,
            hostname: "files.apps.peerbit.org.",
        })
    );
    assert.equal(requests, 0);
});

test("malformed account Worker identities fail closed", async () => {
    const api = createCloudflareWorkersApi({
        accountId: ACCOUNT_ID,
        apiToken: API_TOKEN,
        request: async () =>
            new Response(
                JSON.stringify({
                    success: true,
                    result: [
                        {
                            id: "../../not-a-worker",
                            tag: "tag",
                            routes: [],
                        },
                    ],
                })
            ),
    });
    await assert.rejects(api.listWorkerScripts(), (error) => {
        assert.ok(error instanceof CloudflareWorkersApiError);
        assert.equal(error.indeterminateMutation, false);
        return true;
    });
});

test("malformed Tail, Logpush, and Cron inventory responses fail closed", async (t) => {
    for (const [name, result] of [
        [
            "Tail consumers",
            [
                {
                    id: entries[0].policy.productionWorker,
                    tag: "tag",
                    routes: [],
                    tail_consumers: {},
                },
            ],
        ],
        [
            "Logpush",
            [
                {
                    id: entries[0].policy.productionWorker,
                    tag: "tag",
                    routes: [],
                    logpush: "yes",
                },
            ],
        ],
    ]) {
        await t.test(name, async () => {
            const api = createCloudflareWorkersApi({
                accountId: ACCOUNT_ID,
                apiToken: API_TOKEN,
                request: async () =>
                    new Response(JSON.stringify({ success: true, result })),
            });
            await assert.rejects(api.listWorkerScripts());
        });
    }
    await t.test("Cron schedules", async () => {
        const api = createCloudflareWorkersApi({
            accountId: ACCOUNT_ID,
            apiToken: API_TOKEN,
            request: async () =>
                new Response(
                    JSON.stringify({
                        success: true,
                        result: {
                            schedules: [
                                { cron: "* * * * *" },
                                { cron: "* * * * *" },
                            ],
                        },
                    })
                ),
        });
        await assert.rejects(
            api.listWorkerSchedules(entries[0].policy.productionWorker)
        );
    });
});

test("inspection exposes only exact policy-derived actions", async () => {
    const harness = createHarness();
    for (const entry of entries) {
        harness.addPreview({ entry, enabled: true });
    }
    const inspection = await inspectProductionProvisioning({
        entries,
        configs,
        artifacts,
        expectedCommit: COMMIT,
        expectedZoneInventorySha256: EXPECTED_ZONE_INVENTORY_SHA256,
        operations: harness.operations,
    });
    assert.equal(
        inspection.expectedZoneInventorySha256,
        EXPECTED_ZONE_INVENTORY_SHA256
    );
    assert.ok(
        inspection.plans.every(
            (plan) =>
                plan.expectedZoneInventorySha256 ===
                EXPECTED_ZONE_INVENTORY_SHA256
        )
    );
    assert.deepEqual(
        inspection.plans.map(({ site, workerName, hostname }) => [
            site.id,
            workerName,
            hostname,
        ]),
        entries.map(({ site, policy }) => [
            site.id,
            policy.productionWorker,
            policy.productionHostnames[0],
        ])
    );
    assert.deepEqual(
        inspection.previewPlans.map(
            ({ site, workerName, workerExists, actions }) => [
                site.id,
                workerName,
                workerExists,
                actions,
            ]
        ),
        entries.map(({ site, policy }) => [
            site.id,
            policy.previewWorker,
            true,
            ["disable-public-subdomains"],
        ])
    );
});
