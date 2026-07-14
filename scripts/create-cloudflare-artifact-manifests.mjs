import { execFileSync } from "node:child_process";
import path from "node:path";
import {
    loadCloudflareDeploymentData,
    repoRoot,
    validateRenderedCloudflareConfigSet,
} from "./cloudflare-deployment-policy.mjs";
import {
    CLOUDFLARE_ARTIFACT_DIRECTORY,
    createCloudflareArtifactManifest,
} from "./cloudflare-artifact-manifest.mjs";

const expectedCommit = (
    process.env.COMMIT_HASH ||
    execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
    })
).trim();

if (!/^[0-9a-f]{40}$/i.test(expectedCommit)) {
    throw new Error("Cloudflare artifact manifests require a full Git commit");
}

const { entries } = loadCloudflareDeploymentData();
const configs = validateRenderedCloudflareConfigSet({
    directory: path.join(repoRoot, ".wrangler-config"),
    entries,
    mode: "production",
});

for (const { site, policy } of entries) {
    const rendered = configs.get(site.id);
    const artifact = createCloudflareArtifactManifest({
        site,
        policy,
        configFile: rendered.file,
        renderedConfig: rendered.config,
        expectedCommit,
        artifactRoot: CLOUDFLARE_ARTIFACT_DIRECTORY,
    });
    console.log(
        `${site.id}: ARTIFACT_MANIFEST_SHA256=${artifact.digest} (${artifact.manifest.assets.length} asset inputs)`
    );
}
