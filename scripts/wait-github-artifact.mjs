#!/usr/bin/env node

const [artifactName, timeoutMsRaw = "600000"] = process.argv.slice(2);

if (!artifactName) {
    throw new Error(
        "usage: wait-github-artifact.mjs <artifact-name> [timeout-ms]"
    );
}

const repository = process.env.GITHUB_REPOSITORY;
const runId = process.env.GITHUB_RUN_ID;
const token = process.env.GITHUB_TOKEN;

if (!repository || !runId || !token) {
    throw new Error(
        "GITHUB_REPOSITORY, GITHUB_RUN_ID, and GITHUB_TOKEN are required"
    );
}

const timeoutMs = Number(timeoutMsRaw);
const deadline =
    Date.now() + (Number.isFinite(timeoutMs) ? timeoutMs : 600_000);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

while (Date.now() < deadline) {
    const response = await fetch(
        `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
        {
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "X-GitHub-Api-Version": "2022-11-28",
            },
        }
    );
    if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(
            `Artifact lookup failed (${response.status}): ${text || response.statusText}`
        );
    }
    const body = await response.json();
    const artifact = (body.artifacts ?? []).find(
        (candidate) => candidate?.name === artifactName && !candidate?.expired
    );
    if (artifact) {
        console.log(`Artifact ready: ${artifactName}`);
        process.exit(0);
    }
    await sleep(5_000);
}

throw new Error(`Timed out waiting for artifact: ${artifactName}`);
