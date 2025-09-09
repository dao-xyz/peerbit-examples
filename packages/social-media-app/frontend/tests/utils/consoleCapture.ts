import { Page, TestInfo } from "@playwright/test";

export type ConsoleCaptureOptions = {
    printAll?: boolean; // echo everything to test runner
    failOnError?: boolean; // throw when a console error happens
    ignorePatterns?: (string | RegExp)[]; // do not fail/print when matching
};

export function setupConsoleCapture(
    page: Page,
    testInfo: TestInfo,
    opts: ConsoleCaptureOptions = { printAll: true, failOnError: false }
) {
    const ignore = opts.ignorePatterns || [];
    const shouldIgnore = (text: string) =>
        ignore.some((p) =>
            typeof p === "string" ? text.includes(p) : p.test(text)
        );

    page.on("console", (msg) => {
        const text = msg.text();
        const type = msg.type();

        if (opts.printAll) {
            testInfo
                .attach(`console:${type}`, {
                    body: Buffer.from(text, "utf8"),
                    contentType: "text/plain",
                })
                .catch(() => {});
            // Also echo to stdout for quick diagnosis
            // eslint-disable-next-line no-console
            console.log(`Page console ${type}: ${text}`);
        }

        if (type === "error" && !shouldIgnore(text)) {
            if (opts.failOnError) {
                throw new Error(`Page console error: ${text}`);
            }
        }
    });
}
