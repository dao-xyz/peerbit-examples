# `giga-app-joke-bot` (CLI)

Runs the `@giga-app/joke-bot` program on your machine.

## Run from this repo

Build:

```sh
pnpm -r --filter @peerbit/joke-bot-cli... run build
```

Network selection:

- `--network prod|local|offline` (aliases: `--prod`, `--local`, `--offline`)

Interactive mode (recommended):

```sh
node lib/esm/bin.js
```

Non-interactive (dry-run):

```sh
node lib/esm/bin.js --intervalMinutes 1 --dryRun
```

Publish to the network:

```sh
node lib/esm/bin.js --intervalMinutes 5
```

Post once and exit:

```sh
node lib/esm/bin.js --runOnce
```

Dial a local relay instead of bootstrapping:

```sh
node lib/esm/bin.js --local --intervalMinutes 1
```

Offline (no dial/bootstrap):

```sh
node lib/esm/bin.js --offline --runOnce --dryRun
```

## Targeting (optional)

By default, the bot posts under the public Giga root canvas.

- `--scopeAddress` (or `--scope`) posts within a specific `Scope` address.
- `--parentCanvasId` (or `--parent`) posts under a specific parent canvas id (base64/base64url of the 32-byte `canvas.id`).

## Options

```sh
node lib/esm/bin.js --help
```

## Running from repo root

If you prefer to run it from the repo root (instead of `packages/social-media-app/bots/joke-bot-cli`), use:

```sh
node packages/social-media-app/bots/joke-bot-cli/lib/esm/bin.js --help
```
