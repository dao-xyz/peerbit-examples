import { spawnSync } from "node:child_process";

const API_BASE_URL = "https://api.github.com";
const API_VERSION = "2022-11-28";

function runCapture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    ...options,
  });
  if (result.error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.error.message}`);
  }
  const code = typeof result.status === "number" ? result.status : 1;
  if (code !== 0) {
    const stderr = (result.stderr || "").trim();
    const stdout = (result.stdout || "").trim();
    throw new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr || stdout || "no output"}`);
  }
  return (result.stdout || "").trim();
}

export function parseGitHubRemote(remoteUrl) {
  const url = String(remoteUrl || "").trim();
  if (!url) return null;

  const httpsMatch = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (httpsMatch) {
    return { owner: httpsMatch[1], repo: httpsMatch[2] };
  }

  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  if (sshMatch) {
    return { owner: sshMatch[1], repo: sshMatch[2] };
  }

  return null;
}

export function detectRepoFromGit() {
  try {
    const origin = runCapture("git", ["remote", "get-url", "origin"]);
    return parseGitHubRemote(origin);
  } catch {
    return null;
  }
}

export function getGitHubTokens() {
  const tokens = [];
  const fromEnv = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (fromEnv) {
    tokens.push(fromEnv);
  }
  try {
    const cleanEnv = { ...process.env };
    delete cleanEnv.GH_TOKEN;
    delete cleanEnv.GITHUB_TOKEN;
    const token = runCapture("gh", ["auth", "token"], { env: cleanEnv }).trim();
    if (token && !tokens.includes(token)) {
      tokens.push(token);
    }
  } catch {
    // ignore
  }
  return tokens;
}

async function githubRequest(token, method, path, body) {
  const url = `${API_BASE_URL}${path}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": API_VERSION,
  };
  const init = {
    method,
    headers,
  };
  if (body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    const error = new Error(`${method} ${path} failed (${response.status}): ${text || response.statusText}`);
    error.status = response.status;
    error.body = text;
    throw error;
  }
  if (response.status === 204) return null;
  const text = await response.text().catch(() => "");
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function githubRequestWithTokens(tokens, method, path, body) {
  let lastError = null;
  for (const token of tokens) {
    try {
      return await githubRequest(token, method, path, body);
    } catch (error) {
      lastError = error;
      const status = typeof error?.status === "number" ? error.status : null;
      if (status === 401 || status === 403) {
        continue;
      }
      throw error;
    }
  }
  throw lastError || new Error(`${method} ${path} failed (no GitHub token available)`);
}

export function explainPatAccessIssue(error) {
  const status = typeof error?.status === "number" ? error.status : null;
  const body = typeof error?.body === "string" ? error.body : "";
  if (status !== 403) return null;
  if (!body.includes("Resource not accessible by personal access token")) return null;

  return [
    "GitHub returned 403: Resource not accessible by personal access token.",
    "This usually means your PAT isn't allowed for this org/repo (fine-grained PAT not approved/SSO-authorized) or it lacks required access.",
    "Fix options:",
    "- Use a classic PAT with `repo` scope, or",
    "- Ensure the fine-grained PAT is approved for the org + has repo access + Actions write permission, or",
    "- Run `gh auth login` and remove GH_TOKEN so the script uses your gh token.",
  ].join("\n");
}

export async function getRunnerRegistrationToken(tokens, owner, repo) {
  const data = await githubRequestWithTokens(tokens, "POST", `/repos/${owner}/${repo}/actions/runners/registration-token`);
  if (!data || typeof data.token !== "string" || !data.token.trim()) {
    throw new Error("GitHub API did not return a runner registration token.");
  }
  return data.token.trim();
}

export async function listRunners(tokens, owner, repo) {
  const data = await githubRequestWithTokens(tokens, "GET", `/repos/${owner}/${repo}/actions/runners?per_page=100`);
  return Array.isArray(data?.runners) ? data.runners : [];
}

export async function findRunnerId(tokens, owner, repo, runnerName) {
  const runners = await listRunners(tokens, owner, repo);
  const match = runners.find((runner) => runner?.name === runnerName);
  return match?.id ?? null;
}

export async function deleteRunner(tokens, owner, repo, runnerId) {
  await githubRequestWithTokens(tokens, "DELETE", `/repos/${owner}/${repo}/actions/runners/${runnerId}`);
}

export async function upsertRepoVariable(tokens, owner, repo, name, value) {
  const encoded = encodeURIComponent(name);
  try {
    await githubRequestWithTokens(tokens, "PATCH", `/repos/${owner}/${repo}/actions/variables/${encoded}`, { name, value });
    return "updated";
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : null;
    if (status !== 404) {
      throw error;
    }
  }

  await githubRequestWithTokens(tokens, "POST", `/repos/${owner}/${repo}/actions/variables`, { name, value });
  return "created";
}

export async function deleteRepoVariable(tokens, owner, repo, name) {
  const encoded = encodeURIComponent(name);
  try {
    await githubRequestWithTokens(tokens, "DELETE", `/repos/${owner}/${repo}/actions/variables/${encoded}`);
  } catch (error) {
    const status = typeof error?.status === "number" ? error.status : null;
    if (status !== 404) {
      throw error;
    }
  }
}
