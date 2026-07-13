import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import { BOOTSTRAP_ADDRS } from "@giga-app/network";
import type { Plugin } from "vite";

function toOptions(multiaddr: Multiaddr) {
    var opts: { family: string; host: string; port: number } = {
        family: "",
        host: "",
        port: 0,
    };
    var parsed = multiaddr.toString().split("/");
    opts.family = parsed[1] === "ip4" ? "ipv4" : "ipv6";
    opts.host = parsed[2];
    opts.port = Number(parsed[4]);
    return opts;
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

export function generateTags(addrs: string[]): string {
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

export function renderBootstrapPrefetch(
    html: string,
    addrs: string[] = BOOTSTRAP_ADDRS
) {
    const START = "<!-- BOOTSTRAP_PREFETCH_START -->";
    const END = "<!-- BOOTSTRAP_PREFETCH_END -->";
    const pattern = new RegExp(`${START}[\\s\\S]*?${END}`, "m");
    if (!pattern.test(html)) {
        throw new Error(
            `Bootstrap prefetch markers are missing. Add:\n${START}\n${END}`
        );
    }
    const replacement = `${START}\n<!-- Generated from @giga-app/network; do not edit by hand. -->\n${generateTags(addrs)}\n${END}`;
    return html.replace(pattern, replacement);
}

export const bootstrapPrefetchPlugin = (): Plugin => ({
    name: "peerbit-bootstrap-prefetch",
    transformIndexHtml(html) {
        return renderBootstrapPrefetch(html);
    },
});
