import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
    conflictEntryNameHash,
    conflictEntryNames,
    type ConflictEntryNameParts,
} from "../index.js";

const utf8 = new TextEncoder();

// Windows device names, reserved with any extension; ¹²³ count as digits.
const RESERVED_DEVICE =
    /^(con|prn|aux|nul|conin\$|conout\$|(com|lpt)[0-9¹²³])$/i;

/**
 * Why `name` cannot be a file name on Windows, macOS or Linux, if it
 * cannot: NAME_MAX bytes (Linux) and 255 UTF-16 units (Windows), "/" and
 * NUL anywhere, Windows' reserved and control characters, a trailing dot
 * or space (Windows drops them), a device name before the first dot, and
 * text that is not valid Unicode (macOS stores names as UTF-8).
 */
const invalidBecause = (name: string) => {
    const base = name.split(".")[0].replace(/[ .]+$/, "");
    if (name === "" || name === "." || name === "..") return "empty or dot";
    if (utf8.encode(name).byteLength > 255) return "over 255 bytes";
    if (name.length > 255) return "over 255 UTF-16 units";
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f<>:"/\\|?*]/.test(name)) return "reserved char";
    if (/\p{Cs}/u.test(name)) return "lone surrogate";
    if (/[. ]$/.test(name)) return "trailing dot or space";
    if (RESERVED_DEVICE.test(base)) return "device name";
    return undefined;
};

const sha256Hex = (text: string) =>
    createHash("sha256").update(text).digest("hex");

const entry = (
    overrides: Partial<ConflictEntryNameParts> = {}
): ConflictEntryNameParts => ({
    kind: "content",
    path: "/docs/notes.txt",
    machineLabel: "laptop",
    authorKey: "author-key",
    time: 1_763_290_000_000n, // 2025-11-16T10:46:40Z
    id: "version:abc",
    ...overrides,
});

const hostilePaths = [
    '/a<b>:c"d/e\\f|g?h*i.txt',
    "/CON",
    "/nul.txt",
    "/com1",
    "/LPT9.log",
    "/aux.",
    "/trailing dot.",
    "/trailing space ",
    "/dots...",
    "/tab\there\nnew.txt",
    // Valid names that a regular expression's "." does not match.
    "/line\u2028sep.txt",
    "/para\u2029dir/sub/notes.txt",
    "/\u0000nul\u007fdel",
    "/\ud800lone.txt",
    "/emoji-" + "\u{1f600}".repeat(200) + ".png",
    "/" + "deep/".repeat(100) + "名前".repeat(100) + ".md",
    "/",
    "",
    "/a.tar.gz",
    "/.bashrc",
    "/x.verylongextension12345",
    "/名前.テキスト",
];
const hostileLabels = [
    "laptop",
    "my laptop: work/home",
    "CON",
    "nul",
    "a".repeat(300),
    "名前".repeat(50),
    "",
    "tab\tlabel\u0001",
    "trailing.",
];
const hostileTimes = [
    0n,
    -1n,
    1_763_290_000_000n,
    253_402_300_800_000n, // year 10000
    8_640_000_000_000_001n, // past what a Date can hold
    2n ** 70n,
];
const kinds = [
    "content",
    "multi-head",
    "duplicate-name",
    "delete-vs-edit",
    "unreachable",
];

describe("conflict tree entry names", () => {
    it("say kind, path, writer and UTC time, then a hash of the entry", () => {
        expect(conflictEntryNames([entry()])).toEqual([
            `content docs／notes.txt laptop 20251116T104640Z ${sha256Hex(
                "content\nversion:abc"
            ).slice(0, 12)}.txt`,
        ]);
        // A directory takes no extension; a missing label shows the key.
        expect(
            conflictEntryNames([
                entry({
                    kind: "unreachable",
                    path: "/photos",
                    machineLabel: "",
                    id: "dir:x",
                    directory: true,
                }),
            ])
        ).toEqual([
            `unreachable photos key-${sha256Hex("author-key").slice(0, 8)} 20251116T104640Z ${sha256Hex(
                "unreachable\ndir:x"
            ).slice(0, 12)}`,
        ]);
        expect(
            conflictEntryNames([
                entry({ machineLabel: "", authorKey: "", time: 2n ** 70n }),
            ])[0]
        ).toMatch(/^content docs／notes\.txt unknown unknown-time /);
        // Spaces in a label become "_", so the name splits on spaces.
        expect(
            conflictEntryNames([entry({ machineLabel: "my laptop" })])[0]
        ).toContain(" my_laptop ");
    });

    it("are valid on Windows, macOS and Linux for hostile paths, labels and times, and give back their hash", () => {
        const entries: ConflictEntryNameParts[] = [];
        for (const path of hostilePaths) {
            for (const machineLabel of hostileLabels) {
                for (const time of hostileTimes) {
                    for (const directory of [false, true]) {
                        entries.push(
                            entry({
                                kind: kinds[entries.length % kinds.length],
                                path,
                                machineLabel,
                                time,
                                directory,
                                id: `id:${entries.length}`,
                            })
                        );
                    }
                }
            }
        }
        const names = conflictEntryNames(entries);
        const invalid = names.flatMap((name) => {
            const why = invalidBecause(name);
            return why ? [[name, why]] : [];
        });
        expect(invalid).toEqual([]);
        for (const name of names) {
            expect(utf8.encode(name).byteLength).toBeLessThanOrEqual(160);
        }
        // Unique even where names compare ignoring case and normalization
        // (Windows, macOS).
        expect(
            new Set(names.map((name) => name.normalize("NFD").toLowerCase()))
                .size
        ).toBe(entries.length);
        // A mount finds an entry by the hash its name holds.
        const unparsed = names.filter((name, i) => {
            const hash = sha256Hex(`${entries[i].kind}\n${entries[i].id}`);
            const digits = name.includes(hash) ? hash : hash.slice(0, 12);
            return conflictEntryNameHash(name) !== digits;
        });
        expect(unparsed).toEqual([]);
    });

    it("keep a cut path's end and only a plain original extension", () => {
        const [long] = conflictEntryNames([
            entry({
                path: "/" + "deep/".repeat(100) + "report-final.pdf",
            }),
        ]);
        expect(long).toMatch(
            /^content …[^ ]*deep／report-final\.pdf laptop 20251116T104640Z [0-9a-f]{12}\.pdf$/
        );
        const extensionOf = (path: string) =>
            conflictEntryNames([entry({ path })])[0].match(
                /[0-9a-f]{12}(\..*)?$/
            )![1];
        expect(extensionOf("/a.tar.gz")).toBe(".gz");
        expect(extensionOf("/.bashrc")).toBeUndefined();
        expect(extensionOf("/file.")).toBeUndefined();
        expect(extensionOf("/x.verylongextension12345")).toBeUndefined();
        expect(extensionOf("/名前.テキスト")).toBe(undefined);
    });

    it("depend only on their own entry, unless two would be equal ignoring case", () => {
        const a = entry({ id: "version:a" });
        const b = entry({ id: "version:b", path: "/other.txt" });
        const [alone] = conflictEntryNames([a]);
        expect(conflictEntryNames([b, a])[1]).toBe(alone);
        expect(conflictEntryNames([a, b])[0]).toBe(alone);

        // Names that would be equal ignoring case take the whole hash.
        const twins = [
            entry({ id: "version:upper", path: "/Notes.txt" }),
            entry({ id: "version:lower", path: "/notes.txt" }),
        ];
        const names = conflictEntryNames(twins, 0);
        expect(names[0].toLowerCase()).not.toBe(names[1].toLowerCase());
        expect(names).toEqual(
            twins.map((twin) =>
                expect.stringMatching(
                    new RegExp(` ${sha256Hex(`content\n${twin.id}`)}\\.txt$`)
                )
            )
        );
        expect(names.map((name) => conflictEntryNameHash(name))).toEqual(
            twins.map((twin) => sha256Hex(`content\n${twin.id}`))
        );
    });
});
