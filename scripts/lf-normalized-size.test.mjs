import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { lfNormalizedSize, lfUnpackedSize } from "./lf-normalized-size.mjs";

const text = (value) => Buffer.from(value, "utf8");

// The PNG signature holds a CRLF pair, and its first chunk length holds NULs.
const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52,
]);

const packedTextPaths = [
    "LICENSE",
    "README.md",
    "package.json",
    "lib/esm/index.d.ts",
    "lib/esm/index.js",
    "lib/esm/index.js.map",
    "scripts/postinstall.mjs",
    "src/index.ts",
];

test("counts CRLF text with LF line endings", () => {
    for (const filePath of packedTextPaths) {
        assert.equal(
            lfNormalizedSize(filePath, text("one\r\ntwo\r\n\r\nthree")),
            text("one\ntwo\n\nthree").length,
            filePath
        );
    }
});

test("leaves LF text unchanged", () => {
    const contents = text("export const value = 41;\n\n// done\n");
    for (const filePath of packedTextPaths) {
        assert.equal(
            lfNormalizedSize(filePath, contents),
            contents.length,
            filePath
        );
    }
});

test("removes only the CR of each CRLF pair", () => {
    // A lone CR, an LF CR, and a CR CR LF that holds one pair.
    assert.equal(lfNormalizedSize("README.md", text("a\rb\n\rc\r\r\n")), 8);
});

test("leaves binary files unchanged", () => {
    assert.equal(lfNormalizedSize("assets/logo.png", png), png.length);
    // A text name does not make a file with a NUL byte text...
    assert.equal(lfNormalizedSize("lib/esm/data.js", png), png.length);
    // ...even when the NUL comes long after the first CRLF pairs...
    const lateNul = Buffer.concat([
        text("line\r\n".repeat(10_000)),
        Buffer.from([0]),
    ]);
    assert.equal(lfNormalizedSize("src/data.ts", lateNul), lateNul.length);
    // ...and a file without a text name counts its CRLF bytes as is.
    assert.equal(lfNormalizedSize("lib/adapter.node", text("a\r\nb\r\n")), 6);
});

const writePackage = async (root, files) => {
    for (const [file, contents] of Object.entries(files)) {
        const target = path.join(root, ...file.split("/"));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, contents);
    }
    return Object.entries(files).map(([file, contents]) => ({
        path: file,
        size: contents.length,
    }));
};

test("sums a package manifest with LF line endings", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "lf-normalized-size-"));
    try {
        const files = await writePackage(temporary, {
            LICENSE: text("License\r\ntext\r\n"),
            "README.md": text("# Title\n\nBody\n"),
            "assets/logo.png": png,
            "lib/esm/index.js": text(
                "export {};\r\n//# sourceMappingURL=x\r\n"
            ),
            "src/index.ts": text("export {};\n"),
        });
        const checkedOutBytes = files.reduce(
            (total, file) => total + file.size,
            0
        );

        assert.equal(
            await lfUnpackedSize(temporary, files),
            checkedOutBytes - 4
        );
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});

test("rejects a file that differs from what npm pack measured", async () => {
    const temporary = await mkdtemp(path.join(tmpdir(), "lf-normalized-size-"));
    try {
        const [file] = await writePackage(temporary, {
            "src/index.ts": text("export {};\n"),
        });

        await assert.rejects(
            lfUnpackedSize(temporary, [{ ...file, size: file.size - 1 }]),
            /^Error: src\/index\.ts has 11 bytes, but npm pack reported 10$/u
        );
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});
