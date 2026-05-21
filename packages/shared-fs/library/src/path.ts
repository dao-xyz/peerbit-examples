export const ROOT_NODE_ID = "root";
export const CONFLICTS_DIR = ".peerbit-conflicts";

export const normalizeFsPath = (input: string) => {
    const raw = input || "/";
    const parts = raw
        .replaceAll("\\", "/")
        .split("/")
        .filter((part) => part.length > 0 && part !== ".");
    const stack: string[] = [];
    for (const part of parts) {
        if (part === "..") {
            stack.pop();
        } else {
            stack.push(part);
        }
    }
    return "/" + stack.join("/");
};

export const pathSegments = (input: string) => {
    const normalized = normalizeFsPath(input);
    return normalized === "/"
        ? []
        : normalized.slice(1).split("/").filter(Boolean);
};

export const dirname = (input: string) => {
    const segments = pathSegments(input);
    segments.pop();
    return "/" + segments.join("/");
};

export const basename = (input: string) => {
    const segments = pathSegments(input);
    return segments.at(-1) ?? "";
};

export const joinFsPath = (...parts: string[]) => {
    return normalizeFsPath(parts.join("/"));
};

export const encodeConflictPathName = (path: string) =>
    encodeURIComponent(normalizeFsPath(path)).replaceAll("%", "~");

export const decodeConflictPathName = (name: string) =>
    normalizeFsPath(decodeURIComponent(name.replaceAll("~", "%")));
