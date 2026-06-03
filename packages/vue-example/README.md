# Peerbit Vue example

A small Vue 3 + Vite example that opens a Peerbit document store in the browser.
Open the app in multiple tabs to see messages replicate through Peerbit.

Peerbit-specific setup lives in [`src/db.ts`](./src/db.ts), mirroring the direct Peerbit usage in the Svelte example while showing how to wire it into Vue's Composition API.

## Setup

From the root of the `peerbit-examples` repo:

```bash
pnpm install
```

## Developing

Inside this project run:

```bash
pnpm run dev
```

To use the public relay bootstrap flow, run:

```bash
pnpm run start-remote
```

To verify the example builds:

```bash
pnpm run build
```
