// routes.tsx
import { Routes, Route } from "react-router";
import { Home } from "./Home";
import { fromBase64URL, PublicSignKey, toBase64URL } from "@peerbit/crypto";
import { serialize } from "@dao-xyz/borsh";
import { Canvas as CanvasDB, Scope } from "@giga-app/interface";
import { CreateRoot } from "./canvas/CreateRoot";
import { MissingProfile } from "./profile/MissingProfile";
import { ConnectDevices } from "./identity/ConnectDevices";
import { NavigationEffects } from "./NavigationEffects";
import { useRecordLocation } from "./useNavHistory";
import { Drafts } from "./canvas/draft/DraftsPage";

const textDecoder = new TextDecoder();

/* ────────────────────────────────────────────────────────────────
 * Node helpers
 * ──────────────────────────────────────────────────────────────── */

export const getStreamPath = (node: PublicSignKey) =>
    "/s/" + toBase64URL(serialize(node));

export const getChatPath = (node: PublicSignKey) =>
    "/k/" + toBase64URL(serialize(node));

export const getAdressFromKey = (key: string) =>
    textDecoder.decode(fromBase64URL(key));

export const getNameFromPath = (name: string) => decodeURIComponent(name);

/* ────────────────────────────────────────────────────────────────
 * Canvas URL helpers
 * Path: /c/:id   (id = base64url(canvas.id))
 * Query: scopes, view, mode
 * ──────────────────────────────────────────────────────────────── */

export const getCanvasPath = (
    canvas: CanvasDB,
    opts?: {
        scopes?: (Scope | string)[];
        view?: string;
        mode?: "fullscreen" | "regular";
    }
) => {
    const idB64Url = toBase64URL(canvas.id);
    const params = new URLSearchParams();

    if (opts?.scopes?.length) {
        const addrs = opts.scopes.map((s) =>
            typeof s === "string" ? s : s.address
        );
        params.set("scopes", addrs.join(","));
    }
    if (opts?.view) params.set("view", opts.view);
    if (opts?.mode) params.set("mode", opts.mode);

    const q = params.toString();
    return `/c/${idB64Url}${q ? `?${q}` : ""}`;
};

export const getCanvasIdFromPath = (path: string) => {
    const parts = path.split("?")[0].split("/").filter(Boolean);
    const idx = parts.indexOf("c");
    const string = idx >= 0 ? parts[idx + 1] : undefined;
    return getCanvasIdFromPart(string);
};

export const getCanvasIdFromPart = (
    path: string | undefined
): Uint8Array | undefined => {
    if (!path) return undefined;
    try {
        return fromBase64URL(path);
    } catch (error) {
        console.error("Invalid canvas ID in path:", path, error);
        return undefined;
    }
};

export const getCanvasIdParam = (path: string) => {
    const parts = path.split("?")[0].split("/").filter(Boolean);
    const idx = parts.indexOf("c");
    return idx >= 0 ? parts[idx + 1] : undefined;
};

export const getCanvasIdBytes = (path: string): Uint8Array | undefined => {
    const id = getCanvasIdParam(path);
    if (!id) return undefined;
    try {
        try {
            return fromBase64URL(id);
        } catch {
            return undefined;
        }
    } catch (error) {
        console.error("Invalid canvas ID in path:", path, error);
        return undefined;
    }
};

export const getScopeAddrsFromSearch = (search: string): string[] => {
    const params = new URLSearchParams(
        search.startsWith("?") ? search : `?${search}`
    );
    const raw = params.get("scopes");
    if (!raw) return [];
    return raw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
};

export const getCanvasAddressByPath = (path: string) => getCanvasIdParam(path);

/* ────────────────────────────────────────────────────────────────
 * Routes
 * ──────────────────────────────────────────────────────────────── */

export const MISSING_PROFILE = "/missing-profile";
export const NEW_ROOT = "/new-root";
export const CONNECT_DEVICES = "/connect";
export const USER_BY_KEY_NAME = "/k/:key";
export const NEW_SPACE = "/new";
export const DRAFTS = "/drafts";

export function BaseRoutes() {
    useRecordLocation();
    return (
        <>
            <NavigationEffects />
            <Routes>
                {/* Identity / onboarding */}
                <Route path={CONNECT_DEVICES} element={<ConnectDevices />} />
                <Route path={MISSING_PROFILE} element={<MissingProfile />} />
                <Route path={NEW_ROOT} element={<CreateRoot />} />
                <Route path={DRAFTS} element={<Drafts />} />

                {/* Canvas routes */}
                <Route path="/c/:id" element={<Home />} />
                <Route path="/c/:id/*" element={<Home />} />

                {/* Optional: short user paths */}
                {/* <Route path={USER_BY_KEY_NAME} element={<UserPage />} /> */}

                {/* Fallback */}
                <Route path="/*" element={<Home />} />
            </Routes>
        </>
    );
}

/* ────────────────────────────────────────────────────────────────
 * External app constants
 * ──────────────────────────────────────────────────────────────── */

export const STREAMING_APP = ["development", "staging"].includes(
    import.meta.env.MODE
)
    ? "https://stream.test.xyz:5801/#"
    : "https://stream.dao.xyz/#";

export const CHAT_APP = ["development", "staging"].includes(
    import.meta.env.MODE
)
    ? "https://chat.test.xyz:5802/#"
    : "https://chat.dao.xyz/#";

export const TEXT_APP = ["development", "staging"].includes(
    import.meta.env.MODE
)
    ? "https://text.test.xyz:5803/#"
    : "https://text.dao.xyz/#";
