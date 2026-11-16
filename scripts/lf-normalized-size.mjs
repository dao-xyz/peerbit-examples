// Package size budgets measure the tarball that is published, which is
// packed on Linux from an LF checkout. Windows runners check text files out
// with CRLF line endings (core.autocrlf; the repository has no
// .gitattributes), so the same package measures one byte per line larger
// there. Counting each packed text file with LF line endings gives the same
// size on every OS.
//
// A file counts as text when its name has a known text type and its bytes
// hold no NUL; it then loses one byte per CRLF pair. Any other file counts
// byte for byte, so a binary is never altered.

import { readFile } from "node:fs/promises";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([
    ".cjs",
    ".css",
    ".cts",
    ".html",
    ".js",
    ".json",
    ".jsx",
    ".map",
    ".md",
    ".mjs",
    ".mts",
    ".ps1",
    ".sh",
    ".ts",
    ".tsx",
    ".txt",
    ".yaml",
    ".yml",
]);

const TEXT_FILE_NAMES = new Set([
    "COPYING",
    "LICENCE",
    "LICENSE",
    "NOTICE",
    "README",
]);

const CRLF = Buffer.from("\r\n");

const hasTextName = (filePath) => {
    const name = path.posix.basename(filePath.replaceAll("\\", "/"));
    return (
        TEXT_EXTENSIONS.has(path.posix.extname(name).toLowerCase()) ||
        TEXT_FILE_NAMES.has(name.toUpperCase())
    );
};

const countCrlf = (contents) => {
    let count = 0;
    for (
        let index = contents.indexOf(CRLF);
        index !== -1;
        index = contents.indexOf(CRLF, index + CRLF.length)
    ) {
        count += 1;
    }
    return count;
};

/**
 * The size of one packed file with LF line endings.
 *
 * @param {string} filePath the file's path in the package
 * @param {Buffer} contents the file's bytes
 * @returns {number}
 */
export const lfNormalizedSize = (filePath, contents) =>
    hasTextName(filePath) && !contents.includes(0)
        ? contents.length - countCrlf(contents)
        : contents.length;

/**
 * The unpacked size of an npm pack manifest with LF line endings. Each file
 * is read from the package directory and must still have the size npm pack
 * reported for it.
 *
 * @param {string} packageRoot the package directory
 * @param {{ path: string, size: number }[]} files the manifest's files
 * @returns {Promise<number>}
 */
export const lfUnpackedSize = async (packageRoot, files) => {
    let total = 0;
    for (const file of files) {
        const contents = await readFile(path.join(packageRoot, file.path));
        if (contents.length !== file.size) {
            throw new Error(
                `${file.path} has ${contents.length} bytes, but npm pack reported ${file.size}`
            );
        }
        total += lfNormalizedSize(file.path, contents);
    }
    return total;
};
