import { sha256Sync } from "@peerbit/crypto";

export const ROOT_NODE_ID = "root";
export const CONFLICTS_DIR = ".peerbit-conflicts";

/** The longest file or directory name, in UTF-8 bytes (NAME_MAX). */
export const MAX_NAME_BYTES = 255;

const utf8 = new TextEncoder();
// C0 controls, DEL, a backslash (a path reads it as "/"), and lone
// surrogates (they have no UTF-8 form).
// eslint-disable-next-line no-control-regex
const BAD_NAME_CHAR = /[\u0000-\u001f\u007f\\]|\p{Cs}/u;

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
        : `Name is empty, "." or "..", or holds "/", "\\", a control character or a lone surrogate: ${JSON.stringify(name)}`;

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

/** What names an entry of a mount's conflict tree (see conflictEntryNames). */
export type ConflictEntryNameParts = {
    /** "content", or the naming conflict's type. */
    kind: string;
    /** The conflict's (best-effort) path. */
    path: string;
    /** The writer: its machine label, else its key. */
    machineLabel: string;
    authorKey: string;
    /** When the writer made it: milliseconds on its clock. */
    time: bigint;
    /** The version, or for a node entry the node, the entry shows. */
    id: string;
    /** A directory entry takes no extension. */
    directory?: boolean;
};

/** Room for a conflict-tree path under Windows' 260-character MAX_PATH. */
const CONFLICT_NAME_MAX_BYTES = 160;
const RESERVED_NAME_CHARS = '/\\:*?"<>|';
const FULLWIDTH_NAME_CHARS =
    "\uff0f\uff3c\uff1a\uff0a\uff1f\uff02\uff1c\uff1e\uff5c";

/**
 * `text` with what no name may hold on Windows, macOS or Linux replaced:
 * "/" and the characters Windows reserves by their fullwidth forms, control
 * characters by their U+2400 pictures, lone surrogates by U+FFFD.
 */
const nameText = (text: string) =>
    // eslint-disable-next-line no-control-regex
    text.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]|\p{Cs}/gu, (char) => {
        const code = char.charCodeAt(0);
        const reserved = RESERVED_NAME_CHARS.indexOf(char);
        return reserved >= 0
            ? FULLWIDTH_NAME_CHARS[reserved]
            : code < 0x20
              ? String.fromCharCode(0x2400 + code)
              : code === 0x7f
                ? "\u2421"
                : "\ufffd";
    });

const byteLength = (text: string) => utf8.encode(text).byteLength;

/** At most `max` UTF-8 bytes of `text`: its end or start, "…" at the cut. */
const fitText = (text: string, max: number, keepEnd: boolean) => {
    if (byteLength(text) <= max) return text;
    const chars = [...text];
    let fitted = "";
    let bytes = 3;
    for (const char of keepEnd ? chars.reverse() : chars) {
        bytes += byteLength(char);
        if (bytes > max) break;
        fitted = keepEnd ? char + fitted : fitted + char;
    }
    return keepEnd ? `…${fitted}` : `${fitted}…`;
};

const hashHex = (text: string) =>
    Array.from(sha256Sync(utf8.encode(text)), (byte) =>
        byte.toString(16).padStart(2, "0")
    ).join("");

/**
 * Names for the entries of a mount's conflict tree, one per entry, each
 * distinct (kind, id): `<kind> <path> <writer> <time> <hash>[.<ext>]`.
 * Every name is valid on Windows, macOS and Linux and at most 160 bytes of
 * UTF-8; it depends only on its own entry, so it is stable while that entry
 * lasts. The path drops its leading "/", is cut at its start to fit, and
 * shows characters no name may hold as lookalikes (see nameText); the writer
 * is the machine label (spaces as "_", at most 32 bytes), else a hash of
 * the key; the time is UTC (YYYYMMDDTHHMMSSZ); the hash is `digits` hex
 * digits of SHA-256 of the kind and id, or all 64 when two names would
 * otherwise be equal ignoring case; the extension is the original name's,
 * when it is 1-16 ASCII letters, digits, "_" or "-".
 */
export const conflictEntryNames = (
    entries: ConflictEntryNameParts[],
    digits = 12
): string[] => {
    const nameOf = (entry: ConflictEntryNameParts, hashDigits: number) => {
        const label = nameText(entry.machineLabel).replace(/\s/g, "_");
        const writer = label
            ? fitText(label, 32, false)
            : entry.authorKey
              ? `key-${hashHex(entry.authorKey).slice(0, 8)}`
              : "unknown";
        const date = new Date(Number(entry.time));
        const time = Number.isNaN(date.getTime())
            ? "unknown-time"
            : date.toISOString().replace(/[-:]|\.\d+/g, "");
        const extension = entry.directory
            ? undefined
            : /[^.]\.([A-Za-z0-9_-]{1,16})$/.exec(basename(entry.path))?.[1];
        const hash = hashHex(`${entry.kind}\n${entry.id}`).slice(0, hashDigits);
        const end = ` ${writer} ${time} ${hash}${extension ? `.${extension}` : ""}`;
        const path = nameText(entry.path.replace(/^\/+/, "")) || "\uff0f";
        const room =
            CONFLICT_NAME_MAX_BYTES - byteLength(`${entry.kind} ${end}`);
        return `${entry.kind} ${fitText(path, room, true)}${end}`;
    };
    const names = entries.map((entry) => nameOf(entry, digits));
    const folded = new Map<string, number>();
    for (const name of names) {
        const key = name.toLowerCase();
        folded.set(key, (folded.get(key) ?? 0) + 1);
    }
    return names.map((name, i) =>
        folded.get(name.toLowerCase())! > 1 ? nameOf(entries[i], 64) : name
    );
};

/**
 * The hash in `name` when conflictEntryNames could have made it (a kind,
 * a space, ..., a space, 12 or 64 hex digits, an extension), else
 * undefined: a mount answers other names without looking.
 */
export const conflictEntryNameHash = (name: string) =>
    /^(?:content|delete-vs-edit|duplicate-name|multi-head|unreachable) .+ ([0-9a-f]{12}|[0-9a-f]{64})(?:\.[\w-]{1,16})?$/.exec(
        name
    )?.[1];
