const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!/^[0-9a-f]{32}$/i.test(accountId || "")) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID is missing or invalid");
}
if (!token) throw new Error("CLOUDFLARE_API_TOKEN is missing");

const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`,
    {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
    }
);
const payload = await response.json();
if (!response.ok || payload.success !== true || !payload.result?.subdomain) {
    throw new Error(
        `Unable to read Workers subdomain (HTTP ${response.status})`
    );
}
if (!/^[a-z0-9-]+$/i.test(payload.result.subdomain)) {
    throw new Error("Cloudflare returned an invalid Workers subdomain");
}
process.stdout.write(`subdomain=${payload.result.subdomain}\n`);
