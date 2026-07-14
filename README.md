<br>
<p align="center">
    <img width="350" src="./library.jpeg"  alt="Libraryn">
</p>

<h1 align="center" style="border-bottom: none">
    <strong>
        Peerbit Example Library
        </strong>
</h1>

## Examples

### [Chat room](./packages/one-chat-room/)
[<img src="./packages/one-chat-room/demo.gif" width="600" />](./packages/one-chat-room/)


### [Lobby + chat rooms](./packages/many-chat-rooms/)
[<img src="./packages/many-chat-rooms/demo.gif" width="600" />](./packages/many-chat-rooms/)

### [Blog platform](./packages/blog-platform/)
[<img src="./packages/blog-platform/demo-cli.gif" width="600" />](./packages/blog-platform/)


### [Collaborative text document](./packages/text-document/)
[<img src="./packages/text-document/demo.gif" width="600" />](./packages/text-document/)


### [Sync files](./packages/file-share/)
#### [React app](./packages/file-share/)
[<img src="./packages/file-share/demo-frontend.gif" width="600" />](./packages/file-share/)
#### [CLI](./packages/file-share/)
[<img src="./packages/file-share/demo-cli.gif" width="600" />](./packages/file-share/)


### [Video streaming](./packages/media-streaming/video-streaming)
[<img src="./packages/media-streaming/video-streaming/demo.gif" width="600" />](./packages/media-streaming/video-streaming/)


### [Collaborative machine learning](./packages/collaborative-learning/)
[<img src="./packages/collaborative-learning/demo.gif" width="600" />](./packages/collaborative-learning/)

## Requirements

1. Node.js >= 22 (You can switch to Node 22 using `nvm use 22`)

## How to run the examples

1.
```sh
yarn
yarn build
```

2.
Go into an example. If it is a frontend app, you can run it locally (if you have a node running (see below)) with

```sh
yarn start
```

and remotely on a test relay

```sh
yarn start-remote
```

## How to setup a local relay node
(This is just a basic libp2p-js node)

1.
Install Node >= 16

2.
Install CLI
```sh
npm install -g @peerbit/server
```
3.
```sh
peerbit start
```

Ending with '&' to start a background process

For more complete instructions on how to run a node in a server center that can be accessed remotely [see this](https://github.com/dao-xyz/peerbit/tree/master/packages/clients/peerbit-server).

## Cloudflare hosting

The public frontends are hosted with Cloudflare Workers Static Assets, with a
selective cache Worker in front of the large MP4 fixtures that need byte-range
support.
`cloudflare/sites.json` is the source of truth for build directories and
expected titles. Worker identities and production hostnames must also match the
exact, deliberately duplicated allowlist in
`cloudflare/deployment-policy.json`. Updating a hostname or Worker therefore
requires an explicit deployment-policy review; merely adding another
`peerbit.org` subdomain to the site manifest is rejected.

Public preview deployment is disabled. Pull requests and `master` still build
every app, validate every asset, and dry-run every isolated preview Worker
bundle without a Cloudflare credential. Preview configs have no routes and
disable both `workers.dev` and version preview URLs, so Cloudflare account or
user slugs are never part of a public URL or workflow log. Production runtime
checks run inside the per-app transactional deploy and trigger rollback on
failure.

Preview validation uses no Cloudflare token. This is an authorization boundary,
not just a naming convention: preview CI cannot mutate any production Worker.
Production cutover uses a separately reviewed environment and credential.

Local validation uses the locked Wrangler toolchain:

```sh
pnpm install --frozen-lockfile
export VITE_SUPABASE_AUTH_ENABLED=false
unset VITE_SUPABASE_URL VITE_SUPABASE_ANON_KEY
node scripts/validate-cloudflare-account-auth.mjs
pnpm run build
node scripts/validate-cloudflare-account-auth.mjs --dist packages/social-media-app/frontend/dist
node scripts/validate-production-bootstrap.mjs
node scripts/prepare-cloudflare-assets.mjs
npm ci --ignore-scripts --no-audit --no-fund --prefix tools/wrangler
node scripts/render-cloudflare-configs.mjs --mode preview
for config in .wrangler-config/*.jsonc; do
    tools/wrangler/node_modules/.bin/wrangler deploy --config "$config" --dry-run
done
```

Production configs are rendered with `--mode production`. First-party demo
Workers are restricted to `*.apps.peerbit.org`; the legacy redirect remains on
`peerchecker.com`. Both sets must exactly match the deployment policy.
Production deploys
run one site at a time: capture its current 100% version, deploy, verify the
site (including the app-specific Chromium gate where one exists), and only then
continue. A failed upload or verification automatically restores the captured
version and verifies it again. Verification child processes do not inherit the
Cloudflare credential.

Cloudflare version rollback does not revert attached resources. Treat a change
to the exact hostname policy as a separate provisioning migration with its own
rollback plan; the routine release workflow is for code/assets on already
attached hostnames.

The transactional workflow intentionally refuses to create a Worker that has
no existing deployment, because there would be no version to restore. Seed a
new production Worker once under direct operator supervision, verify it, then
use the workflow for all later releases. Use the separately reviewed production
environment and retain a known-good Worker version.

Giga account auth is intentionally disabled in Cloudflare preview and
production builds. The workflows do not expose Supabase secrets, require
`VITE_SUPABASE_AUTH_ENABLED=false`, reject any Supabase URL or publishable key
in the built assets, publish the disabled state in `release.json`, and smoke-test
that the deployed UI has no account entry or Supabase traffic. Enabling auth
requires a separate reviewed change after a Peerbit-owned auth project is
provisioned; the retired project has no users or data to migrate.
