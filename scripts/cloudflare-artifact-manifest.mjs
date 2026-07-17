import { createHash } from "node:crypto";
import {
    lstatSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import path from "node:path";
import { repoRoot } from "./cloudflare-deployment-policy.mjs";

const FULL_GIT_COMMIT = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_SITE_ID = /^[a-z][a-z0-9-]*$/;
const SAFE_WORKER_NAME = /^(?=.{1,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SAFE_RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\\\0]+$/;
const MAX_FILES = 20_000;
const WORKER_MODULE_CONTENT_TYPE = "application/javascript+module";
const FORBIDDEN_AUXILIARY_MODULE_CONFIG_KEYS = Object.freeze([
    "base_dir",
    "data_blobs",
    "preserve_file_names",
    "python_modules",
    "rules",
    "text_blobs",
    "unsafe",
    "wasm_modules",
]);

export const CLOUDFLARE_ARTIFACT_DIRECTORY = path.join(
    repoRoot,
    ".wrangler-dry-run"
);
export const CLOUDFLARE_ARTIFACT_MANIFEST_FILE =
    "deployment-artifact-manifest.json";
export const CLOUDFLARE_ARTIFACT_PUBLIC_PATH =
    "/peerbit-deployment-manifest.json";
export const CLOUDFLARE_ARTIFACT_DIGEST_BINDING =
    "PEERBIT_ARTIFACT_MANIFEST_SHA256";

const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, canonicalize(value[key])])
        );
    }
    return value;
};

const canonicalBytes = (value) =>
    Buffer.from(`${JSON.stringify(canonicalize(value))}\n`, "utf8");

const sameCanonicalValue = (left, right) =>
    JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));

const deepFreeze = (value) => {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) deepFreeze(child);
        Object.freeze(value);
    }
    return value;
};

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const assertInside = (root, candidate, label) => {
    const relative = path.relative(root, candidate);
    if (
        relative.length === 0 ||
        relative.startsWith("..") ||
        path.isAbsolute(relative)
    ) {
        throw new Error(`${label} must resolve inside ${root}`);
    }
    return candidate;
};

const resolveConfigPath = ({ configFile, value, label }) => {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${label} is missing`);
    }
    return assertInside(
        repoRoot,
        path.resolve(path.dirname(configFile), value),
        label
    );
};

const posixRelative = (root, file) => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    if (!SAFE_RELATIVE_PATH.test(relative)) {
        throw new Error(`Unsafe artifact path ${JSON.stringify(relative)}`);
    }
    return relative;
};

const assertRegularFile = (file) => {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(
            `Cloudflare artifact input must be a regular file: ${file}`
        );
    }
};

const fileRecordFromBytes = (root, file, bytes, extra = {}) => {
    if (!Buffer.isBuffer(bytes)) {
        throw new Error(
            `Cloudflare artifact input must be a regular file: ${file}`
        );
    }
    return {
        path: posixRelative(root, file),
        size: bytes.length,
        sha256: sha256(bytes),
        ...extra,
    };
};

const fileRecord = (root, file, extra = {}) => {
    assertRegularFile(file);
    const bytes = readFileSync(file);
    return fileRecordFromBytes(root, file, bytes, extra);
};

const walk = (root, directory = root) => {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
        (left, right) => left.name.localeCompare(right.name)
    )) {
        const file = path.join(directory, entry.name);
        const stat = lstatSync(file);
        if (stat.isSymbolicLink()) {
            throw new Error(
                `Cloudflare artifact inputs may not be symlinks: ${file}`
            );
        }
        if (stat.isDirectory()) files.push(...walk(root, file));
        else if (stat.isFile()) files.push(file);
        else throw new Error(`Unsupported Cloudflare artifact input: ${file}`);
    }
    if (files.length > MAX_FILES) {
        throw new Error(`Cloudflare artifact input exceeds ${MAX_FILES} files`);
    }
    return files;
};

const normalizeRouteFreeConfig = ({ renderedConfig, modulePath }) => {
    if (
        !renderedConfig ||
        typeof renderedConfig !== "object" ||
        Array.isArray(renderedConfig) ||
        renderedConfig.workers_dev !== false ||
        renderedConfig.preview_urls !== false ||
        !Array.isArray(renderedConfig.routes) ||
        renderedConfig.routes.length !== 1 ||
        renderedConfig.vars?.[CLOUDFLARE_ARTIFACT_DIGEST_BINDING] != null
    ) {
        throw new Error(
            "Artifact manifest requires an exact private production config without the reserved digest binding"
        );
    }
    if (renderedConfig.upload_source_maps !== false) {
        throw new Error(
            "Artifact manifest requires Wrangler source-map upload to be explicitly disabled"
        );
    }
    if (
        renderedConfig.find_additional_modules != null &&
        renderedConfig.find_additional_modules !== false
    ) {
        throw new Error(
            "Artifact manifest forbids Wrangler auxiliary-module discovery"
        );
    }
    for (const key of FORBIDDEN_AUXILIARY_MODULE_CONFIG_KEYS) {
        if (key in renderedConfig) {
            throw new Error(
                `Artifact manifest forbids auxiliary-module setting ${key}`
            );
        }
    }
    const config = structuredClone(renderedConfig);
    delete config.$schema;
    delete config.routes;
    delete config.route;
    delete config.domains;
    config.main = modulePath;
    config.no_bundle = true;
    // Wrangler defaults this to true when no_bundle is true. The reviewed
    // applications intentionally upload one self-contained ES module, so the
    // false value must be explicit and artifact-bound.
    config.find_additional_modules = false;
    if (!config.assets || typeof config.assets !== "object") {
        throw new Error("Artifact manifest requires a static-assets directory");
    }
    config.assets.directory = "<reviewed-static-assets>";
    return canonicalize(config);
};

const validateManifestShape = (manifest) => {
    if (
        !manifest ||
        typeof manifest !== "object" ||
        Array.isArray(manifest) ||
        manifest.schema !== 1 ||
        !SAFE_SITE_ID.test(manifest.site || "") ||
        !SAFE_WORKER_NAME.test(manifest.worker || "") ||
        !FULL_GIT_COMMIT.test(manifest.commit || "") ||
        !manifest.deploymentConfig ||
        typeof manifest.deploymentConfig !== "object" ||
        !manifest.module ||
        typeof manifest.module !== "object" ||
        !SAFE_RELATIVE_PATH.test(manifest.module.path || "") ||
        !Number.isSafeInteger(manifest.module.size) ||
        manifest.module.size < 0 ||
        !SHA256.test(manifest.module.sha256 || "") ||
        manifest.module.contentType !== WORKER_MODULE_CONTENT_TYPE ||
        !Array.isArray(manifest.assets) ||
        manifest.assets.length === 0 ||
        manifest.assets.length > MAX_FILES
    ) {
        throw new Error("Cloudflare deployment artifact manifest is malformed");
    }
    const paths = new Set();
    for (const asset of manifest.assets) {
        if (
            !asset ||
            typeof asset !== "object" ||
            Array.isArray(asset) ||
            !SAFE_RELATIVE_PATH.test(asset.path || "") ||
            paths.has(asset.path) ||
            !Number.isSafeInteger(asset.size) ||
            asset.size < 0 ||
            !SHA256.test(asset.sha256 || "") ||
            typeof asset.public !== "boolean"
        ) {
            throw new Error(
                "Cloudflare deployment artifact manifest has an invalid asset record"
            );
        }
        paths.add(asset.path);
    }
    if (
        !paths.has("release.json") ||
        manifest.assets.find((asset) => asset.path === "release.json")
            ?.public !== true
    ) {
        throw new Error(
            "Cloudflare deployment artifact manifest must include public release.json"
        );
    }
    return manifest;
};

const isPublicAsset = (relative) =>
    !["_headers", "_redirects"].includes(path.posix.basename(relative));

const findMainModule = (artifactDirectory) => {
    const files = walk(artifactDirectory);
    const nonRuntimeOutputs = new Set([
        "README.md",
        CLOUDFLARE_ARTIFACT_MANIFEST_FILE,
    ]);
    const candidates = files.filter(
        (file) => !nonRuntimeOutputs.has(posixRelative(artifactDirectory, file))
    );
    if (candidates.length !== 1 || !/\.(?:m?js)$/.test(candidates[0])) {
        throw new Error(
            `Expected exactly one Wrangler runtime-module output in ${artifactDirectory}, found ${candidates.length}`
        );
    }
    return candidates[0];
};

const readCanonicalManifest = (manifestFile) => {
    const bytes = readFileSync(manifestFile);
    let manifest;
    try {
        manifest = validateManifestShape(JSON.parse(bytes.toString("utf8")));
    } catch (error) {
        throw new Error(`${manifestFile}: ${error.message}`);
    }
    if (!bytes.equals(canonicalBytes(manifest))) {
        throw new Error(`${manifestFile}: artifact manifest is not canonical`);
    }
    return { manifest, bytes, digest: sha256(bytes) };
};

const assetDirectoryFor = ({ configFile, renderedConfig }) => {
    const directory = resolveConfigPath({
        configFile,
        value: renderedConfig.assets?.directory,
        label: `${renderedConfig.name}: assets.directory`,
    });
    const canonical = realpathSync(directory);
    assertInside(
        repoRoot,
        canonical,
        `${renderedConfig.name}: assets.directory`
    );
    return canonical;
};

const manifestFileFor = (artifactDirectory) =>
    path.join(artifactDirectory, CLOUDFLARE_ARTIFACT_MANIFEST_FILE);

const servedManifestFileFor = (assetsDirectory) =>
    path.join(assetsDirectory, CLOUDFLARE_ARTIFACT_PUBLIC_PATH.slice(1));

const artifactDirectoryFor = ({ artifactRoot, siteId }) => {
    const canonicalRoot = realpathSync(artifactRoot);
    assertInside(repoRoot, canonicalRoot, "Cloudflare artifact root");
    const candidate = path.join(artifactRoot, siteId);
    const stat = lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(
            `${siteId}: artifact directory must be a real directory`
        );
    }
    return assertInside(
        canonicalRoot,
        realpathSync(candidate),
        `${siteId}: artifact directory`
    );
};

export const createCloudflareArtifactManifest = ({
    site,
    policy,
    configFile,
    renderedConfig,
    expectedCommit,
    artifactRoot = CLOUDFLARE_ARTIFACT_DIRECTORY,
}) => {
    if (
        site?.id !== policy?.id ||
        renderedConfig?.name !== policy?.productionWorker ||
        !FULL_GIT_COMMIT.test(expectedCommit || "")
    ) {
        throw new Error("Cloudflare artifact manifest identity is invalid");
    }
    const artifactDirectory = artifactDirectoryFor({
        artifactRoot,
        siteId: site.id,
    });
    const manifestFile = manifestFileFor(artifactDirectory);
    rmSync(manifestFile, { force: true });
    const moduleFile = findMainModule(artifactDirectory);
    const assetsDirectory = assetDirectoryFor({ configFile, renderedConfig });
    const servedManifestFile = servedManifestFileFor(assetsDirectory);
    rmSync(servedManifestFile, { force: true });

    const module = fileRecord(artifactDirectory, moduleFile, {
        contentType: WORKER_MODULE_CONTENT_TYPE,
    });
    const assets = walk(assetsDirectory)
        .map((file) => {
            const relative = posixRelative(assetsDirectory, file);
            return fileRecord(assetsDirectory, file, {
                public: isPublicAsset(relative),
            });
        })
        .sort((left, right) => left.path.localeCompare(right.path));
    const manifest = validateManifestShape({
        schema: 1,
        site: site.id,
        worker: policy.productionWorker,
        commit: expectedCommit.toLowerCase(),
        deploymentConfig: normalizeRouteFreeConfig({
            renderedConfig,
            modulePath: module.path,
        }),
        module,
        assets,
    });
    const bytes = canonicalBytes(manifest);
    writeFileSync(manifestFile, bytes, { mode: 0o444, flag: "wx" });
    writeFileSync(servedManifestFile, bytes, { mode: 0o444, flag: "wx" });
    return loadCloudflareArtifactManifest({
        site,
        policy,
        configFile,
        renderedConfig,
        expectedCommit,
        artifactRoot,
    });
};

export const loadCloudflareArtifactManifest = ({
    site,
    policy,
    configFile,
    renderedConfig,
    expectedCommit,
    artifactRoot = CLOUDFLARE_ARTIFACT_DIRECTORY,
}) => {
    const artifactDirectory = artifactDirectoryFor({
        artifactRoot,
        siteId: site.id,
    });
    const manifestFile = manifestFileFor(artifactDirectory);
    const { manifest, bytes, digest } = readCanonicalManifest(manifestFile);
    if (
        manifest.site !== site.id ||
        manifest.worker !== policy.productionWorker ||
        manifest.commit !== expectedCommit.toLowerCase()
    ) {
        throw new Error(
            `${site.id}: artifact manifest identity does not match`
        );
    }
    const expectedConfig = normalizeRouteFreeConfig({
        renderedConfig,
        modulePath: manifest.module.path,
    });
    if (!sameCanonicalValue(manifest.deploymentConfig, expectedConfig)) {
        throw new Error(
            `${site.id}: artifact manifest runtime/config does not match the reviewed config`
        );
    }
    const moduleFile = assertInside(
        artifactDirectory,
        path.resolve(artifactDirectory, manifest.module.path),
        `${site.id}: artifact module`
    );
    if (
        realpathSync(findMainModule(artifactDirectory)) !==
        realpathSync(moduleFile)
    ) {
        throw new Error(
            `${site.id}: Wrangler dry-run output contains an unreviewed runtime module`
        );
    }
    if (
        !sameCanonicalValue(
            fileRecord(artifactDirectory, moduleFile, {
                contentType: WORKER_MODULE_CONTENT_TYPE,
            }),
            manifest.module
        )
    ) {
        throw new Error(`${site.id}: reviewed main-module bytes changed`);
    }
    const assetsDirectory = assetDirectoryFor({ configFile, renderedConfig });
    const servedManifestFile = servedManifestFileFor(assetsDirectory);
    const actualAssets = walk(assetsDirectory)
        .filter((file) => file !== servedManifestFile)
        .map((file) => {
            const relative = posixRelative(assetsDirectory, file);
            return fileRecord(assetsDirectory, file, {
                public: isPublicAsset(relative),
            });
        })
        .sort((left, right) => left.path.localeCompare(right.path));
    if (!sameCanonicalValue(actualAssets, manifest.assets)) {
        throw new Error(`${site.id}: reviewed static-asset bytes changed`);
    }
    if (
        !statSync(servedManifestFile).isFile() ||
        !readFileSync(servedManifestFile).equals(bytes)
    ) {
        throw new Error(`${site.id}: served artifact manifest bytes changed`);
    }
    return Object.freeze({
        siteId: site.id,
        workerName: policy.productionWorker,
        commit: manifest.commit,
        digest,
        manifest: deepFreeze(manifest),
        manifestFile,
        moduleFile,
        assetsDirectory,
    });
};

export const loadCloudflareArtifactManifestSet = ({
    entries,
    configs,
    expectedCommit,
    artifactRoot = CLOUDFLARE_ARTIFACT_DIRECTORY,
}) =>
    new Map(
        entries.map(({ site, policy }) => {
            const rendered = configs.get(site.id);
            if (!rendered) {
                throw new Error(
                    `${site.id}: rendered production config is missing`
                );
            }
            return [
                site.id,
                loadCloudflareArtifactManifest({
                    site,
                    policy,
                    configFile: rendered.file,
                    renderedConfig: rendered.config,
                    expectedCommit,
                    artifactRoot,
                }),
            ];
        })
    );

export const readReviewedCloudflareArtifactAsset = ({
    artifact,
    relativePath,
}) => {
    if (
        !artifact?.manifest ||
        !Array.isArray(artifact.manifest.assets) ||
        typeof artifact.assetsDirectory !== "string" ||
        !SAFE_RELATIVE_PATH.test(relativePath || "")
    ) {
        throw new Error(
            "Cloudflare reviewed artifact asset evidence is missing or malformed"
        );
    }
    const matchingRecords = artifact.manifest.assets.filter(
        (asset) => asset?.path === relativePath
    );
    if (matchingRecords.length !== 1) {
        throw new Error(
            `${artifact.siteId}: reviewed artifact must contain exactly one ${relativePath}`
        );
    }
    const canonicalRoot = realpathSync(artifact.assetsDirectory);
    const candidate = assertInside(
        canonicalRoot,
        path.resolve(canonicalRoot, relativePath),
        `${artifact.siteId}: reviewed artifact asset`
    );
    const canonicalFile = assertInside(
        canonicalRoot,
        realpathSync(candidate),
        `${artifact.siteId}: reviewed artifact asset`
    );
    assertRegularFile(canonicalFile);
    const bytes = readFileSync(canonicalFile);
    const actual = fileRecordFromBytes(canonicalRoot, canonicalFile, bytes, {
        public: isPublicAsset(relativePath),
    });
    if (!sameCanonicalValue(actual, matchingRecords[0])) {
        throw new Error(
            `${artifact.siteId}: reviewed artifact asset bytes changed for ${relativePath}`
        );
    }
    return bytes;
};

export const revalidateCloudflareArtifactManifest = (artifact) => {
    if (!artifact || !SHA256.test(artifact.digest || "")) {
        throw new Error("Cloudflare artifact evidence is missing or malformed");
    }
    const { manifest, bytes, digest } = readCanonicalManifest(
        artifact.manifestFile
    );
    if (
        digest !== artifact.digest ||
        !sameCanonicalValue(manifest, artifact.manifest)
    ) {
        throw new Error(`${artifact.siteId}: artifact manifest digest changed`);
    }
    if (
        !readFileSync(servedManifestFileFor(artifact.assetsDirectory)).equals(
            bytes
        )
    ) {
        throw new Error(
            `${artifact.siteId}: served artifact manifest bytes changed`
        );
    }
    if (
        realpathSync(findMainModule(path.dirname(artifact.manifestFile))) !==
        realpathSync(artifact.moduleFile)
    ) {
        throw new Error(
            `${artifact.siteId}: Wrangler dry-run output contains an unreviewed runtime module`
        );
    }
    const module = fileRecord(
        path.dirname(artifact.manifestFile),
        artifact.moduleFile,
        { contentType: WORKER_MODULE_CONTENT_TYPE }
    );
    if (!sameCanonicalValue(module, artifact.manifest.module)) {
        throw new Error(
            `${artifact.siteId}: reviewed main-module bytes changed`
        );
    }
    const actualAssets = walk(artifact.assetsDirectory)
        .filter(
            (file) => file !== servedManifestFileFor(artifact.assetsDirectory)
        )
        .map((file) => {
            const relative = posixRelative(artifact.assetsDirectory, file);
            return fileRecord(artifact.assetsDirectory, file, {
                public: isPublicAsset(relative),
            });
        })
        .sort((left, right) => left.path.localeCompare(right.path));
    if (!sameCanonicalValue(actualAssets, artifact.manifest.assets)) {
        throw new Error(
            `${artifact.siteId}: reviewed static-asset bytes changed`
        );
    }
    return artifact;
};

export const validateCloudflareArtifactDeploymentConfig = ({
    artifact,
    renderedConfig,
}) => {
    if (!artifact?.manifest?.module) {
        throw new Error("Cloudflare artifact evidence is missing or malformed");
    }
    const observed = normalizeRouteFreeConfig({
        renderedConfig,
        modulePath: artifact.manifest.module.path,
    });
    if (!sameCanonicalValue(observed, artifact.manifest.deploymentConfig)) {
        throw new Error(
            `${artifact.siteId}: reviewed route-free runtime/config changed`
        );
    }
    return artifact;
};

export const artifactBoundVersionMessage = ({
    siteId,
    expectedCommit,
    artifactManifestDigest,
}) => {
    if (
        !SAFE_SITE_ID.test(siteId || "") ||
        !FULL_GIT_COMMIT.test(expectedCommit || "") ||
        !SHA256.test(artifactManifestDigest || "")
    ) {
        throw new Error("Artifact-bound Worker version identity is malformed");
    }
    return `peerbit-examples ${siteId} ${expectedCommit.toLowerCase()} artifact-sha256:${artifactManifestDigest}`;
};

export const validateActiveWorkerModule = ({ artifact, observed }) => {
    const expected = artifact?.manifest?.module;
    if (
        !expected ||
        !observed ||
        typeof observed !== "object" ||
        Array.isArray(observed) ||
        observed.name !== path.posix.basename(expected.path) ||
        observed.size !== expected.size ||
        observed.sha256 !== expected.sha256 ||
        observed.contentType !== expected.contentType
    ) {
        throw new Error(
            `${artifact?.siteId ?? "unknown"}: exact Worker version module set does not match the reviewed artifact manifest`
        );
    }
};

const publicAssetUrl = (origin, relative) =>
    `${origin}/${relative
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`;

export const verifyLiveCloudflareArtifact = async ({
    origin,
    artifact,
    request = fetch,
    concurrency = 6,
}) => {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
        throw new Error("Live artifact verification concurrency is invalid");
    }
    revalidateCloudflareArtifactManifest(artifact);
    const expectedManifest = readFileSync(artifact.manifestFile);
    const manifestResponse = await request(
        `${origin}${CLOUDFLARE_ARTIFACT_PUBLIC_PATH}`,
        { redirect: "manual" }
    );
    if (manifestResponse.status !== 200) {
        throw new Error(
            `${origin}${CLOUDFLARE_ARTIFACT_PUBLIC_PATH}: HTTP ${manifestResponse.status}`
        );
    }
    const liveManifest = Buffer.from(await manifestResponse.arrayBuffer());
    if (
        sha256(liveManifest) !== artifact.digest ||
        !liveManifest.equals(expectedManifest)
    ) {
        throw new Error(`${origin}: live artifact manifest bytes do not match`);
    }

    const publicAssets = artifact.manifest.assets.filter(
        (asset) => asset.public
    );
    let cursor = 0;
    const workers = Array.from(
        { length: Math.max(1, Math.min(concurrency, publicAssets.length)) },
        async () => {
            while (cursor < publicAssets.length) {
                const asset = publicAssets[cursor++];
                const url = publicAssetUrl(origin, asset.path);
                const response = await request(url, { redirect: "manual" });
                if (response.status !== 200) {
                    throw new Error(`${url}: HTTP ${response.status}`);
                }
                const bytes = Buffer.from(await response.arrayBuffer());
                if (
                    bytes.length !== asset.size ||
                    sha256(bytes) !== asset.sha256
                ) {
                    throw new Error(
                        `${url}: live bytes do not match the reviewed artifact manifest`
                    );
                }
            }
        }
    );
    await Promise.all(workers);
};
