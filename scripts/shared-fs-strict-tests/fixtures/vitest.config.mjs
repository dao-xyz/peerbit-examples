import { fileURLToPath } from "node:url";

const mode = process.env.SHARED_FS_STRICT_FIXTURE;
const fault = process.env.SHARED_FS_STRICT_FIXTURE_FAULT;
const localPath = (name) => fileURLToPath(new URL(name, import.meta.url));

export default {
    test: {
        include: [
            fault === "collection"
                ? "collection-error.spec.mjs"
                : "cases.spec.mjs",
        ],
        setupFiles: fault === "setup" ? [localPath("./setup-error.mjs")] : [],
        fileParallelism: false,
        maxWorkers: 1,
        bail: 0,
        retry: 0,
        runner: mode === "strict" ? localPath("../runner.mjs") : undefined,
        reporters:
            mode === "plain"
                ? ["default"]
                : ["default", localPath("../reporter.mjs")],
    },
};
