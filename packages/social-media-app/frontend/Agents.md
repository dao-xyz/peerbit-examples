# Debugging Playwright Tests

Use this guide to capture console output, inspect failures, and diagnose runtime errors reported by the app when running Playwright against the social-media frontend.

## Capture Browser Console
- Add `setupConsoleCapture(page, testInfo, { printAll: true, capturePageErrors: true })` at the top of the test to auto-attach logs to Playwright artifacts.
- Wrap the scenario with `withConsoleCapture(page, async () => { ... })` to get synchronous access to console/page errors for assertions.
- When a run fails, the test attaches `console:` artifacts inside `packages/social-media-app/frontend/test-results/<run>/`.

## Reproduce Failing Tests
- Run a single spec with `yarn workspace @giga-app/interface-frontend playwright test tests/<file>.spec.ts --project=Chromium --reporter=line`.
- For headed debugging, pass `PWDEBUG=1`; to keep it headless while using VS Code/Chrome inspector, set `PLAYWRIGHT_HEADLESS=1`.
- If using the persistent context fixture, the browser may open when running under an attached inspector—this is expected.

## Inspect Trace & Screenshots
- Each failure writes `trace.zip`, `test-failed-<n>.png` in the test-results directory.
- View traces with `yarn workspace @giga-app/interface-frontend playwright show-trace test-results/<run>/trace.zip`.
- To inspect raw console messages from a trace, unzip the archive and read `/tmp/trace-*/test.trace` or `0-trace.trace` for event logs.

## Common Gotchas
- Ensure draft composers mount a text area before assertions; missing text rects often manifest as `locator('textarea')` timeouts.
- Console errors like `Cannot read properties of undefined (__context)` usually stem from incomplete iterator data in `useQuery` – check iterator setup before expecting feed content.
- When running offline (`?bootstrap=offline`), the app skips relay dialing; if data never appears check local peer logs or bootstrapping conditions.

## Checklist Before Filing a Bug
- [ ] Confirm the failing test attaches console logs or page errors.
- [ ] Re-run with `--reporter=line` to capture the inline failure message.
- [ ] Inspect `trace.zip` for network errors, console warnings, and DOM state.
- [ ] Validate the test environment (BASE_URL, offline query parameter, persistent context state).

Following this workflow keeps test diagnostics consistent for both humans and automated agents.


