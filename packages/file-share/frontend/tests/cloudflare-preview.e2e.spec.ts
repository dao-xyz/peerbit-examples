import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { createSpace, rootUrl } from "./helpers";

const ENABLED = process.env.PW_CLOUDFLARE_SMOKE === "1";
const RANGE_START = 1024 * 1024;
const RANGE_END = RANGE_START + 4095;
const NOISE_SHA256 =
    "f0ebd6501f9e987ddb23e5633b2b702f953fff3ed0427cddae3c5b1065558978";

const requiredUrl = (name: string) => {
    const value = process.env[name]?.replace(/\/$/, "");
    if (!value || !/^https:\/\//.test(value)) {
        throw new Error(`${name} must be an HTTPS origin`);
    }
    return value;
};

const pageErrors = (page: Page) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    return errors;
};

test.describe("Cloudflare preview runtime smoke", () => {
    test.skip(!ENABLED, "Set PW_CLOUDFLARE_SMOKE=1 to run preview smoke");
    test.describe.configure({ mode: "serial" });

    test("Giga loads JS/WASM and opens a public program over the relay", async ({
        page,
    }) => {
        test.setTimeout(180_000);
        const origin = requiredUrl("PW_GIGA_URL");
        const errors = pageErrors(page);
        const javascript = new Set<string>();
        const wasm = new Set<string>();

        page.on("response", (response) => {
            const url = response.url();
            if (new URL(url).origin !== origin || response.status() !== 200) {
                return;
            }
            if (/\.(?:m?js)(?:\?|$)/.test(url)) javascript.add(url);
            const contentType = response.headers()["content-type"];
            if (
                /\.wasm(?:\?|$)/.test(url) &&
                contentType?.startsWith("application/wasm")
            ) {
                wasm.add(url);
            }
        });

        const startedAt = Date.now();
        await page.goto(
            `${origin}/?ephemeral=true&scopeprobe=public-only&perf=1#/`,
            { waitUntil: "domcontentloaded", timeout: 120_000 }
        );
        await expect(page.getByTestId("scopeprobe-peer-status")).toHaveText(
            "peer-status:connected",
            { timeout: 120_000 }
        );
        await expect(page.getByTestId("scopeprobe-public-status")).toHaveText(
            "public:open",
            { timeout: 120_000 }
        );
        await expect(page.getByTestId("scopeprobe-private-status")).toHaveText(
            "private:skipped"
        );

        const snapshot = await page.evaluate(
            () => (window as any).__scopeProbe
        );
        expect(snapshot).toMatchObject({
            mode: "public-only",
            public: { status: "open" },
            private: { status: "skipped" },
        });
        expect(snapshot.peerHash).not.toBeNull();
        expect(snapshot.public.address).toEqual(expect.any(String));
        expect(snapshot.public.address.length).toBeGreaterThan(0);
        expect(javascript.size).toBeGreaterThan(0);
        expect(wasm.size).toBeGreaterThan(0);
        expect(errors).toEqual([]);

        console.log(
            `Giga relay smoke passed in ${Date.now() - startedAt} ms (${javascript.size} JS, ${wasm.size} WASM)`
        );
    });

    test("Giga exposes no account auth or Supabase traffic", async ({
        page,
    }) => {
        test.setTimeout(180_000);
        const origin = requiredUrl("PW_GIGA_URL");
        const supabaseRequests: string[] = [];
        page.on("request", (request) => {
            const url = new URL(request.url());
            if (
                url.hostname.endsWith(".supabase.co") ||
                url.hostname.endsWith(".supabase.in")
            ) {
                supabaseRequests.push(request.url());
            }
        });

        await page.goto(`${origin}/?ephemeral=true&bootstrap=offline#/auth`, {
            waitUntil: "domcontentloaded",
            timeout: 120_000,
        });
        await expect(page).toHaveURL(/#\/$/, { timeout: 120_000 });
        await expect(page.getByLabel("Email")).toHaveCount(0);

        const profile = page.getByTestId("header-profile-area");
        await expect(profile).toBeVisible({ timeout: 120_000 });
        await profile.locator("button").first().click();
        await expect(
            page.getByRole("menuitem", { name: /^(?:Sign in|Account)$/ })
        ).toHaveCount(0);
        expect(supabaseRequests).toEqual([]);
    });

    test("file-share boots and connects to an authoritative relay", async ({
        page,
        request,
    }) => {
        test.setTimeout(240_000);
        const origin = requiredUrl("PW_BASE_URL");
        const errors = pageErrors(page);
        const bootstrapResponse = await request.get(
            "https://bootstrap.peerbit.org/bootstrap-5.env"
        );
        expect(bootstrapResponse.ok()).toBe(true);
        const relayPeers = new Set(
            (await bootstrapResponse.text())
                .split(/\r?\n/)
                .map((line) => line.match(/\/p2p\/([^/\s]+)$/)?.[1])
                .filter((peer): peer is string => Boolean(peer))
        );
        expect(relayPeers.size).toBeGreaterThan(0);

        try {
            await createSpace(
                page,
                rootUrl(origin),
                `cloudflare-smoke-${Date.now()}`
            );
            await expect
                .poll(
                    async () => {
                        const diagnostics = await page.evaluate(async () => {
                            const hooks = (window as any)
                                .__peerbitFileShareTestHooks;
                            return hooks?.getDiagnostics
                                ? hooks.getDiagnostics()
                                : null;
                        });
                        return Boolean(
                            diagnostics?.peerStatus === "connected" &&
                            diagnostics?.connectionCount >= 1 &&
                            typeof diagnostics?.programAddress === "string" &&
                            diagnostics.programAddress.length > 0 &&
                            diagnostics?.programClosed === false &&
                            diagnostics?.programHookError == null &&
                            diagnostics?.programBlockPresent === true &&
                            diagnostics.connectionPeers?.some((peer: string) =>
                                relayPeers.has(peer)
                            )
                        );
                    },
                    {
                        timeout: 180_000,
                        message:
                            "file-share did not connect to a published relay",
                    }
                )
                .toBe(true);
            expect(errors).toEqual([]);
        } finally {
            await page
                .evaluate(async () => {
                    await (
                        window as any
                    ).__peerbitFileShareTestHooks?.shutdown?.();
                })
                .catch(() => {});
        }
    });

    test("streaming preview serves exact MP4 byte ranges", async ({
        request,
    }) => {
        const origin = requiredUrl("PW_STREAM_URL");
        const fixturePath = path.resolve(
            path.dirname(fileURLToPath(import.meta.url)),
            "../../../media-streaming/video-streaming/frontend/public/noise.mp4"
        );
        const fixture = await readFile(fixturePath);
        expect(createHash("sha256").update(fixture).digest("hex")).toBe(
            NOISE_SHA256
        );

        const response = await request.get(`${origin}/noise.mp4`, {
            headers: {
                Range: `bytes=${RANGE_START}-${RANGE_END}`,
                "Accept-Encoding": "identity",
            },
        });
        expect(response.status()).toBe(206);
        expect(response.headers()["content-type"]).toBe("video/mp4");
        expect(response.headers()["content-range"]).toBe(
            `bytes ${RANGE_START}-${RANGE_END}/${fixture.length}`
        );
        const body = await response.body();
        expect(body.length).toBe(RANGE_END - RANGE_START + 1);
        expect(body.equals(fixture.subarray(RANGE_START, RANGE_END + 1))).toBe(
            true
        );
    });
});
