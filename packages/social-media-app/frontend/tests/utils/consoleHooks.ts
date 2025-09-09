import type { Page, ConsoleMessage } from "@playwright/test";

export type ConsoleHook = {
    stop: () => void;
    clear: () => void;
    errors: () => ConsoleMessage[];
    messages: () => ConsoleMessage[];
};

/**
 * Attach console listeners for the given page and collect messages for later inspection.
 * Prints errors to the test runner console immediately for easier debugging.
 */
export function attachConsoleHooks(
    page: Page,
    opts?: { logAll?: boolean; echoErrors?: boolean }
): ConsoleHook {
    const all: ConsoleMessage[] = [];
    const errs: ConsoleMessage[] = [];
    const { logAll = false, echoErrors = true } = opts || {};

    const onConsole = (msg: ConsoleMessage) => {
        all.push(msg);
        if (logAll) {
            // Print everything
            // eslint-disable-next-line no-console
            console.log(`[console.${msg.type()}] ${msg.text()}`);
        }
        if (msg.type() === "error") {
            errs.push(msg);
            if (echoErrors) {
                const loc = msg.location();
                const locStr = loc?.url
                    ? `${loc.url}:${loc.lineNumber ?? 0}:${
                          loc.columnNumber ?? 0
                      }`
                    : "<no-location>";
                // eslint-disable-next-line no-console
                console.error(
                    `Page console error at ${locStr}:\n${msg.text()}`
                );
            }
        }
    };

    page.on("console", onConsole);

    return {
        stop: () => page.off("console", onConsole),
        clear: () => {
            all.length = 0;
            errs.length = 0;
        },
        errors: () => errs.slice(),
        messages: () => all.slice(),
    };
}

/**
 * Scoped capture of page console during an async block.
 */
export async function withConsoleCapture<T>(
    page: Page,
    run: () => Promise<T>,
    opts?: { logAll?: boolean; echoErrors?: boolean }
): Promise<{
    result: T;
    errors: ConsoleMessage[];
    messages: ConsoleMessage[];
}> {
    const hook = attachConsoleHooks(page, opts);
    try {
        const result = await run();
        return { result, errors: hook.errors(), messages: hook.messages() };
    } finally {
        hook.stop();
    }
}
