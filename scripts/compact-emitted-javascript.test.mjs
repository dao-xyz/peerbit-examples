import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
    mkdir,
    mkdtemp,
    chmod,
    readFile,
    readdir,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
    assertNoStaleCompactionDirectories,
    compactEmittedJavaScript,
    inspectEsmSurfaces,
    verifyCompactedOutput,
} from "./compact-emitted-javascript.mjs";

const sourceMap = (file, source) =>
    `${JSON.stringify({
        version: 3,
        file,
        sourceRoot: "",
        sources: [source],
        sourcesContent: ["// source fixture\n"],
        names: [],
        mappings: "AAAA;AAAA;AAAA;AAAA;AAAA;AAAA",
    })}\n`;

const fixtureFiles = {
    "bin.js": `#!/usr/bin/env node
import { answer } from "./index.js";
console.log(answer);
//# sourceMappingURL=bin.js.map
`,
    "bin.js.map": sourceMap("bin.js", "../../src/bin.ts"),
    "bin.d.ts": "#!/usr/bin/env node\nexport {};\n",
    "index.js": `import "first-side-effect";
import "second-side-effect";
import     {     value     }     from     "./value.js";
export     const     answer     =     value     +     1;
export default function readAnswer() {
            return                         answer;
}
//# sourceMappingURL=index.js.map
`,
    "index.js.map": sourceMap("index.js", "../../src/index.ts"),
    "index.d.ts": `export declare const answer: number;
export default function readAnswer(): number;
`,
    "value.js": `export const value = 41;
//# sourceMappingURL=value.js.map
`,
    "value.js.map": sourceMap("value.js", "../../src/value.ts"),
    "value.d.ts": "export declare const value = 41;\n",
    "nested/reexport.js": `export { answer as nestedAnswer } from "../index.js";
//# sourceMappingURL=reexport.js.map
`,
    "nested/reexport.js.map": sourceMap(
        "reexport.js",
        "../../../src/nested/reexport.ts"
    ),
    "nested/reexport.d.ts":
        'export { answer as nestedAnswer } from "../index.js";\n',
};

const sources = {
    "bin.ts": 'import { answer } from "./index.js";\nconsole.log(answer);\n',
    "index.ts": `import { value } from "./value.js";
export const answer = value + 1;
export default function readAnswer() { return answer; }
`,
    "value.ts": "export const value = 41;\n",
    "nested/reexport.ts":
        'export { answer as nestedAnswer } from "../index.js";\n',
};

const writeFixtureFile = async (root, file, contents) => {
    const target = path.join(root, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
};

const createFixture = async (parent, name) => {
    const root = path.join(parent, name);
    const output = path.join(root, "lib", "esm");
    const source = path.join(root, "src");
    await Promise.all([
        mkdir(output, { recursive: true }),
        mkdir(source, { recursive: true }),
    ]);
    await Promise.all([
        ...Object.entries(fixtureFiles).map(([file, contents]) =>
            writeFixtureFile(output, file, contents)
        ),
        ...Object.entries(sources).map(([file, contents]) =>
            writeFixtureFile(source, file, contents)
        ),
    ]);
    await Promise.all([
        chmod(path.join(output, "bin.js"), 0o755),
        chmod(path.join(output, "bin.js.map"), 0o640),
    ]);
    return output;
};

const snapshot = async (root) => {
    const files = {};

    const visit = async (relativeDirectory) => {
        const entries = await readdir(path.join(root, relativeDirectory), {
            withFileTypes: true,
        });
        for (const entry of entries.sort((left, right) =>
            left.name.localeCompare(right.name)
        )) {
            const relativePath = path.join(relativeDirectory, entry.name);
            if (entry.isDirectory()) {
                await visit(relativePath);
                continue;
            }
            assert.equal(entry.isFile(), true);
            const contents = await readFile(path.join(root, relativePath));
            files[relativePath.replaceAll("\\", "/")] = createHash("sha256")
                .update(contents)
                .digest("hex");
        }
    };

    await visit("");
    return files;
};

test("compacts deterministically without changing declarations or ESM shape", async () => {
    const temporary = await mkdtemp(
        path.join(tmpdir(), "shared-fs-compaction-")
    );
    try {
        const first = await createFixture(temporary, "first");
        const second = await createFixture(temporary, "second");
        const declarationsBefore = {
            "bin.d.ts": await readFile(path.join(first, "bin.d.ts"), "utf8"),
            "index.d.ts": await readFile(
                path.join(first, "index.d.ts"),
                "utf8"
            ),
            "value.d.ts": await readFile(
                path.join(first, "value.d.ts"),
                "utf8"
            ),
            "nested/reexport.d.ts": await readFile(
                path.join(first, "nested", "reexport.d.ts"),
                "utf8"
            ),
        };
        const surfacesBefore = await inspectEsmSurfaces(first);
        const modesBefore = {
            bin: (await stat(path.join(first, "bin.js"))).mode & 0o777,
            map: (await stat(path.join(first, "bin.js.map"))).mode & 0o777,
        };
        assert.deepEqual(
            surfacesBefore["index.js"].imports.map((entry) => entry.path),
            ["first-side-effect", "second-side-effect", "./value.js"]
        );
        const originalJavaScriptBytes = Object.entries(fixtureFiles)
            .filter(([file]) => file.endsWith(".js"))
            .reduce(
                (total, [, contents]) =>
                    total + Buffer.byteLength(contents, "utf8"),
                0
            );

        await compactEmittedJavaScript({ outputDirectory: first });
        await compactEmittedJavaScript({ outputDirectory: second });

        assert.deepEqual(await snapshot(first), await snapshot(second));
        assert.deepEqual(await inspectEsmSurfaces(first), surfacesBefore);
        for (const [file, contents] of Object.entries(declarationsBefore)) {
            assert.equal(
                await readFile(path.join(first, file), "utf8"),
                contents
            );
        }
        const compactJavaScriptBytes = (
            await Promise.all(
                ["bin.js", "index.js", "value.js", "nested/reexport.js"].map(
                    async (file) =>
                        Buffer.byteLength(
                            await readFile(path.join(first, file), "utf8")
                        )
                )
            )
        ).reduce((total, bytes) => total + bytes, 0);
        assert.ok(compactJavaScriptBytes < originalJavaScriptBytes);
        assert.match(
            await readFile(path.join(first, "bin.js"), "utf8"),
            /^#!\/usr\/bin\/env node\n/u
        );
        assert.equal(
            (await stat(path.join(first, "bin.js"))).mode & 0o777,
            modesBefore.bin
        );
        assert.equal(
            (await stat(path.join(first, "bin.js.map"))).mode & 0o777,
            modesBefore.map
        );
        if (process.platform !== "win32") {
            assert.deepEqual(modesBefore, { bin: 0o755, map: 0o640 });
        }
        const expectedSources = {
            bin: "../../src/bin.ts",
            index: "../../src/index.ts",
            value: "../../src/value.ts",
            "nested/reexport": "../../../src/nested/reexport.ts",
        };
        for (const [file, expectedSource] of Object.entries(expectedSources)) {
            const javascript = await readFile(
                path.join(first, `${file}.js`),
                "utf8"
            );
            const basename = path.basename(file);
            assert.match(
                javascript,
                new RegExp(
                    `//# sourceMappingURL=${basename}\\.js\\.map\\n$`,
                    "u"
                )
            );
            const map = JSON.parse(
                await readFile(path.join(first, `${file}.js.map`), "utf8")
            );
            assert.equal(Object.hasOwn(map, "sourcesContent"), false);
            assert.deepEqual(map.sources, [expectedSource]);
        }
        await verifyCompactedOutput({
            outputDirectory: first,
            expectedShebangs: { "bin.js": "#!/usr/bin/env node" },
        });
        await assertNoStaleCompactionDirectories(first);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});

test("a pre-swap failure leaves the TypeScript output byte-identical", async () => {
    const temporary = await mkdtemp(
        path.join(tmpdir(), "shared-fs-compaction-failure-")
    );
    try {
        const output = await createFixture(temporary, "fixture");
        const before = await snapshot(output);
        await assert.rejects(
            compactEmittedJavaScript({
                outputDirectory: output,
                beforeSwap: async () => {
                    throw new Error("injected pre-swap failure");
                },
            }),
            /injected pre-swap failure/u
        );
        assert.deepEqual(await snapshot(output), before);
        await assertNoStaleCompactionDirectories(output);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});

test("the verifier rejects source maps that escape the packed src tree", async () => {
    const temporary = await mkdtemp(
        path.join(tmpdir(), "shared-fs-compaction-map-escape-")
    );
    try {
        const output = await createFixture(temporary, "fixture");
        await compactEmittedJavaScript({ outputDirectory: output });

        const packageRoot = path.resolve(output, "..", "..");
        await writeFile(path.join(packageRoot, "outside.ts"), "export {};\n");
        const mapPath = path.join(output, "index.js.map");
        const map = JSON.parse(await readFile(mapPath, "utf8"));
        map.sources = ["../../outside.ts"];
        await writeFile(mapPath, `${JSON.stringify(map)}\n`);

        await assert.rejects(
            verifyCompactedOutput({
                outputDirectory: output,
                expectedShebangs: { "bin.js": "#!/usr/bin/env node" },
            }),
            /outside the packed src tree/u
        );
        await assertNoStaleCompactionDirectories(output);
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
});
