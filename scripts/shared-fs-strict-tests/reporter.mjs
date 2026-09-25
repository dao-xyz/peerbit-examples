function bounded(value) {
    const text = String(value ?? "");
    return text.length > 16_384
        ? `${text.slice(0, 16_384)}\n[shared-fs diagnostic truncated]`
        : text;
}

// Complement the standard reporter; do not rewrite Vitest's test results.
export default class SharedFsStrictReporter {
    onTestRunEnd(modules) {
        let retriedTests = 0;
        let missingInstrumentation = 0;
        for (const module of modules) {
            for (const test of module.children.allTests()) {
                const diagnostic = test.diagnostic();
                const strict = test.meta().sharedFsStrict;
                // Vitest replaces the result (including retryCount) on a
                // dynamic skip, so retain actual retries in worker metadata.
                const retries = Math.max(
                    strict?.retries ?? 0,
                    diagnostic?.retryCount ?? 0
                );
                if (diagnostic && strict?.version !== 1) {
                    missingInstrumentation++;
                }
                if (retries === 0) continue;
                retriedTests++;
                process.stderr.write(
                    `${JSON.stringify({
                        event: "shared-fs.strict-retry",
                        file: bounded(test.module.moduleId),
                        test: bounded(test.fullName),
                        retries,
                        outcome: test.result().state,
                    })}\n`
                );
            }
        }
        process.stderr.write(
            `${JSON.stringify({
                event: "shared-fs.strict-summary",
                retriedTests,
                missingInstrumentation,
            })}\n`
        );
        if (retriedTests || missingInstrumentation) process.exitCode = 1;
    }
}
