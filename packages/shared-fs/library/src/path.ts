export const ROOT_NODE_ID = "root";
export const CONFLICTS_DIR = ".peerbit-conflicts";

/** The longest file or directory name, in UTF-8 bytes (NAME_MAX). */
export const MAX_NAME_BYTES = 255;

const utf8 = new TextEncoder();
// C0 controls, DEL, and lone surrogates (they have no UTF-8 form).
const BAD_NAME_CHAR = /[\u0000-\u001f\u007f]|\p{Cs}/u;

/**
 * Why `name` cannot name a file or directory, or undefined when it can:
 * ENAMETOOLONG past MAX_NAME_BYTES, EINVAL when empty, "." or "..", or
 * holding "/" or a BAD_NAME_CHAR. Ingest and local writes share it.
 */
export const fsNameError = (name: string) =>
    name.length > MAX_NAME_BYTES ||
    utf8.encode(name).byteLength > MAX_NAME_BYTES
        ? ("ENAMETOOLONG" as const)
        : name === "" ||
            name === "." ||
            name === ".." ||
            name.includes("/") ||
            BAD_NAME_CHAR.test(name)
          ? ("EINVAL" as const)
          : undefined;

/** The message for fsNameError's `code`. */
export const fsNameErrorMessage = (
    code: "ENAMETOOLONG" | "EINVAL",
    name: string
) =>
    code === "ENAMETOOLONG"
        ? `Name is longer than ${MAX_NAME_BYTES} bytes of UTF-8: ${name.slice(0, 32)}...`
        : `Name is empty, "." or "..", or holds "/" or a control character: ${JSON.stringify(name)}`;

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
