import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";

// import your named export
import { BOOTSTRAP_ADDRS } from "../src/bootstrap";

function toOptions(multiaddr: Multiaddr) {
    var opts: { family: string; host: string; port: number } = {
        family: '',
        host: '',
        port: 0
    };
    var parsed = multiaddr.toString().split('/')
    opts.family = parsed[1] === 'ip4' ? 'ipv4' : 'ipv6'
    opts.host = parsed[2]
    opts.port = Number(parsed[4])
    return opts
}

// --- helpers ---
function toHostPortScheme(ma: Multiaddr) {
    const { host, port } = toOptions(ma);
    const s = ma.toString();
    const secure = s.includes("/tls") || s.includes("/wss");
    const scheme = secure ? "https" : "http"; // maps WS to HTTP scheme
    return { host, port, scheme, secure };
}

const uniq = <T>(arr: T[]) => [...new Set(arr)];

function generateTags(addrs: string[]): string {
    const parsed = addrs
        .filter((a) => a.includes("/dns4/") || a.includes("/dns6/"))
        .map((a) => multiaddr(a));

    // dns-prefetch: just hosts
    const hosts = uniq(
        parsed.map((m) => toHostPortScheme(m).host).filter(Boolean)
    );
    const prefetchTags = hosts.map(
        (h) => `<link rel="dns-prefetch" href="//${h}">`
    );

    // preconnect: distinct scheme://host:port
    const seen = new Set<string>();
    const preconnectTags: string[] = [];
    for (const m of parsed) {
        const { host, port, scheme } = toHostPortScheme(m);
        if (!host || !port) continue;
        const key = `${scheme}://${host}:${port}`;
        if (seen.has(key)) continue;
        seen.add(key);
        preconnectTags.push(
            `<link rel="preconnect" href="${key}" crossorigin>`
        );
    }

    return [...prefetchTags, ...preconnectTags].join("\n");
}

function updateIndexHtml(indexPath: string, block: string) {
    const START = "<!-- BOOTSTRAP_PREFETCH_START -->";
    const END = "<!-- BOOTSTRAP_PREFETCH_END -->";
    const html = readFileSync(indexPath, "utf8");
    const pattern = new RegExp(`${START}[\\s\\S]*?${END}`, "m");
    if (!pattern.test(html)) {
        throw new Error(
            `Markers not found in ${indexPath}. Please add:\n${START}\n${END}`
        );
    }
    const replacement = `${START}\n<!-- (auto-generated; do not edit by hand) -->\n${block}\n${END}`;
    writeFileSync(indexPath, html.replace(pattern, replacement), "utf8");
}

function main() {
    try {
        const tags = generateTags(BOOTSTRAP_ADDRS);
        const indexPath = resolve(process.cwd(), "index.html"); // adjust if needed
        updateIndexHtml(indexPath, tags);
        console.log(
            `✔ Updated ${indexPath} from ${BOOTSTRAP_ADDRS.length} bootstrap addr(s).`
        );
    } catch (error) {
        console.error("✘ Error updating prefetch tags:", error);
        process.exit(1);
    }
}

main();
