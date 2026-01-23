# SharedWorker Todo (Canonical)

Demo of Peerbit canonical client + proxy pattern: a single Peerbit node runs in a `SharedWorker` (single source of truth) and multiple tabs connect to it to read/write a shared `Documents` store (todos) via `@peerbit/document-proxy`.

## Run

From repo root:

```sh
pnpm --filter sharedworker-todo dev
```

Open the printed URL in **two tabs**. Adding/toggling/removing todos in one tab should update the other tab via the shared canonical worker.

## Notes

- Requires browser support for `SharedWorker` (Chrome/Edge/Firefox; Safari support varies).
- The worker is started as a module worker (`type: "module"`).
