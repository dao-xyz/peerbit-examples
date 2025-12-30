# `giga-app-news-bot` (CLI)

Runs the `@giga-app/news-bot` program on your machine.

It fetches events/articles from NewsAPI.ai (EventRegistry) and uses OpenAI to write a single “master” markdown article with references, then posts it to the Giga social graph.

## Setup

The CLI reads keys from:

- `--newsApiKey` or `NEWS_API_KEY` / `NEWSAPI_AI_KEY` / `EVENTREGISTRY_API_KEY`
- `--openaiApiKey` or `OPENAI_API_KEY`

It also tries to load a `.env` file if present (current working directory, or `packages/social-media-app/bots/news-bot/.env` when running from this repo).

## Run from this repo

Build:

```sh
pnpm -r --filter @peerbit/news-bot-cli... run build
```

Network selection:

- `--network prod|local|offline` (aliases: `--prod`, `--local`, `--offline`)

Interactive mode (recommended):

```sh
node lib/esm/bin.js
```

Run once (dry-run, prints markdown and exits):

```sh
NEWS_API_KEY=... OPENAI_API_KEY=... \
node lib/esm/bin.js --runOnce --dryRun
```

Run continuously (publishes to the network):

```sh
NEWS_API_KEY=... OPENAI_API_KEY=... \
node lib/esm/bin.js --intervalMinutes 30
```

Dial a local relay instead of bootstrapping:

```sh
node lib/esm/bin.js --local --intervalMinutes 10
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

## Notes

- Event discovery uses NewsAPI.ai `/minuteStreamEvents` (see `--recentActivityEventsMaxEventCount` and `--recentActivityEventsUpdatesAfterMinsAgo`).
- By default the bot tries to fetch a lead image and injects it as markdown: `![alt](giga://image/<ref>)`.
- Published posts include multiple markdown variants (low/medium/high quality) so the app can render different “resolutions” for feed vs full view.
- `--runOnce` prints a summary (events fetched/posted + remote verification status).

## Prod Smoke Test (opt-in)

There is an opt-in vitest that publishes a small markdown post and checks that the bootstrap peer can read it:

```sh
NEWS_BOT_SMOKE_PROD=1 pnpm --filter @peerbit/news-bot-cli... test
```

## Running from repo root

If you prefer to run it from the repo root (instead of `packages/social-media-app/bots/news-bot-cli`), use:

```sh
node packages/social-media-app/bots/news-bot-cli/lib/esm/bin.js --help
```
