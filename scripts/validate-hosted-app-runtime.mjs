import { execFileSync } from "node:child_process";
import {
    createReadStream,
    existsSync,
    readFileSync,
    readdirSync,
    statSync,
} from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    ".."
);
const manifest = JSON.parse(
    readFileSync(path.join(repoRoot, "cloudflare/sites.json"), "utf8")
);

const ROOT_TIMEOUT_MS = 45_000;
const SETTLE_MS = 5_000;
const FATAL_CONSOLE_PATTERNS = [
    /failed to open/i,
    /indexed type .*missing @variant/i,
    /missing @variant/i,
    /uncaught (?:error|exception)/i,
];
const MIME_TYPES = new Map([
    [".css", "text/css; charset=utf-8"],
    [".html", "text/html; charset=utf-8"],
    [".ico", "image/x-icon"],
    [".jpeg", "image/jpeg"],
    [".jpg", "image/jpeg"],
    [".js", "text/javascript; charset=utf-8"],
    [".json", "application/json; charset=utf-8"],
    [".mjs", "text/javascript; charset=utf-8"],
    [".mp3", "audio/mpeg"],
    [".mp4", "video/mp4"],
    [".png", "image/png"],
    [".svg", "image/svg+xml"],
    [".wasm", "application/wasm"],
    [".webmanifest", "application/manifest+json"],
    [".woff", "font/woff"],
    [".woff2", "font/woff2"],
]);

const walkJavaScript = (directory) => {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) files.push(...walkJavaScript(candidate));
        else if (
            entry.isFile() &&
            [".js", ".mjs"].includes(path.extname(entry.name))
        ) {
            files.push(candidate);
        }
    }
    return files;
};

const validateJavaScriptSyntax = (site, directory) => {
    const assetsDirectory = path.join(directory, "assets");
    if (!existsSync(assetsDirectory)) {
        throw new Error(
            `${site.id}: build is missing its Vite assets directory`
        );
    }
    for (const file of walkJavaScript(assetsDirectory)) {
        try {
            execFileSync(process.execPath, ["--check", file], {
                stdio: ["ignore", "ignore", "pipe"],
                maxBuffer: 16 * 1024 * 1024,
            });
        } catch (error) {
            const detail = String(error.stderr || error.message)
                .trim()
                .split("\n")
                .slice(-4)
                .join("\n");
            throw new Error(
                `${site.id}: invalid JavaScript in ${path.relative(repoRoot, file)}\n${detail}`
            );
        }
    }
};

const safeAssetPath = (directory, pathname) => {
    const decoded = decodeURIComponent(pathname);
    const candidate = path.resolve(directory, `.${decoded}`);
    if (
        candidate !== directory &&
        !candidate.startsWith(`${directory}${path.sep}`)
    ) {
        return undefined;
    }

    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    if (!path.extname(decoded)) {
        const fallback = path.join(directory, "index.html");
        if (existsSync(fallback)) return fallback;
    }
    return undefined;
};

const serve = (directory) =>
    new Promise((resolve, reject) => {
        const server = createServer((request, response) => {
            let asset;
            try {
                asset = safeAssetPath(
                    directory,
                    new URL(request.url || "/", "http://localhost").pathname
                );
            } catch {
                response.writeHead(400).end("Bad request");
                return;
            }
            if (!asset) {
                response.writeHead(404).end("Not found");
                return;
            }

            response.writeHead(200, {
                "Content-Type":
                    MIME_TYPES.get(path.extname(asset)) ||
                    "application/octet-stream",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "strict-origin-when-cross-origin",
            });
            createReadStream(asset).pipe(response);
        });
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close();
                reject(new Error("Failed to allocate local smoke-test port"));
                return;
            }
            resolve({ server, origin: `http://127.0.0.1:${address.port}` });
        });
    });

const isFatalConsoleMessage = (message) =>
    FATAL_CONSOLE_PATTERNS.some((pattern) => pattern.test(message));

const assertChatRoomReady = async (page) => {
    const openRoom = page.getByRole("button", {
        name: "Open room",
        exact: true,
    });
    await openRoom.waitFor({ state: "visible", timeout: ROOT_TIMEOUT_MS });
    await page.waitForFunction(
        () => {
            const button = [...document.querySelectorAll("button")].find(
                (candidate) => candidate.textContent?.trim() === "Open room"
            );
            return button instanceof HTMLButtonElement && !button.disabled;
        },
        undefined,
        { timeout: ROOT_TIMEOUT_MS }
    );
    await openRoom.click();
    await page.waitForURL((url) => url.hash.startsWith("#/k/"), {
        timeout: ROOT_TIMEOUT_MS,
    });
    await page
        .getByTestId("chat-room-ready")
        .waitFor({ state: "visible", timeout: ROOT_TIMEOUT_MS });

    const composer = page.getByRole("textbox", { name: "Send message" });
    await composer.waitFor({ state: "visible", timeout: ROOT_TIMEOUT_MS });
    if (!(await composer.isEnabled())) {
        throw new Error(
            "chat: room opened without an enabled message composer"
        );
    }
};

const assertSiteReady = async (site, page) => {
    if (site.id === "chat") await assertChatRoomReady(page);
};

const smokeSite = async (browser, site, directory) => {
    const { server, origin } = await serve(directory);
    const context = await browser.newContext();
    const page = await context.newPage();
    const runtimeErrors = [];
    page.on("pageerror", (error) =>
        runtimeErrors.push(error.stack || error.message)
    );
    page.on("console", (message) => {
        if (
            message.type() === "error" &&
            isFatalConsoleMessage(message.text())
        ) {
            runtimeErrors.push(message.text());
        }
    });

    try {
        const response = await page.goto(origin, {
            waitUntil: "domcontentloaded",
            timeout: ROOT_TIMEOUT_MS,
        });
        if (!response || response.status() !== 200) {
            throw new Error(
                `${site.id}: root returned HTTP ${response?.status()}`
            );
        }
        await page.waitForFunction(
            () => {
                const root = document.querySelector("#root");
                if (!root) return false;
                const style = getComputedStyle(root);
                if (style.display === "none" || style.visibility === "hidden") {
                    return false;
                }
                return Boolean(
                    root.textContent?.trim() ||
                    root.querySelector(
                        "button, canvas, input, progress, svg, textarea, video"
                    )
                );
            },
            undefined,
            { timeout: ROOT_TIMEOUT_MS }
        );
        await assertSiteReady(site, page);
        await page.waitForTimeout(SETTLE_MS);
        if (runtimeErrors.length) {
            throw new Error(
                `${site.id}: browser runtime error\n${runtimeErrors.join("\n")}`
            );
        }
    } finally {
        await context.close();
        await new Promise((resolve) => server.close(resolve));
    }
};

const sites = manifest.staticSites.map((site) => ({
    site,
    directory: path.resolve(repoRoot, site.directory),
}));

for (const { site, directory } of sites) {
    if (!existsSync(path.join(directory, "index.html"))) {
        throw new Error(
            `${site.id}: missing built frontend at ${path.relative(repoRoot, directory)}`
        );
    }
    validateJavaScriptSyntax(site, directory);
    console.log(`${site.id}: Vite bundles parse`);
}

let browser;
try {
    browser = await chromium.launch({ headless: true });
    for (const { site, directory } of sites) {
        await smokeSite(browser, site, directory);
        console.log(`${site.id}: Chromium startup passed`);
    }
} catch (error) {
    if (/Executable doesn't exist/i.test(String(error))) {
        throw new Error(
            `${error}\nInstall the locked browser with: pnpm exec playwright install chromium`
        );
    }
    throw error;
} finally {
    await browser?.close();
}
