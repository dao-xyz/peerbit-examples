import { fileURLToPath } from "node:url";
import baseConfig from "../../vitest.config.ts";

const localPath = (name) => fileURLToPath(new URL(name, import.meta.url));

// Preserve the existing projects, setup, timeouts and scheduling. Only the
// shared-fs CI commands explicitly select this configuration.
export default {
    ...baseConfig,
    test: {
        ...baseConfig.test,
        reporters: ["default", localPath("./reporter.mjs")],
        projects: baseConfig.test.projects.map((project) => ({
            ...project,
            test: {
                ...project.test,
                runner: localPath("./runner.mjs"),
            },
        })),
    },
};
