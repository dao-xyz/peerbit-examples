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
`cloudflare/sites.json` is the source of truth for build directories, Worker
names, expected titles, and production hostnames under Peerbit-owned domains.

Before a DNS cutover, the Cloudflare workflow deploys isolated `workers.dev`
previews and verifies their release metadata, cache behavior, headers, 404s,
legacy stream redirect, browser/WASM startup, real relay connectivity,
file-share boot, and exact MP4 byte ranges. Worker versions and the isolated
previews are the rollback path; legacy AWS resources are retirement-only and
must not receive new deployments.

Preview deployments use a Workers-Scripts-only token stored as
`CLOUDFLARE_PREVIEW_API_TOKEN` in the `cloudflare-preview` GitHub environment.
Cloudflare includes custom-domain management in that permission, so the GitHub
environment is restricted to `master`, administrator bypass is disabled, and
`master` requires a pull request plus the `validate` check. Preview configs
never render production routes. Production cutover must use a separate reviewed
environment and credential.

Local validation uses the locked Wrangler toolchain:

```sh
pnpm install --frozen-lockfile
pnpm run build
node scripts/validate-production-bootstrap.mjs
node scripts/prepare-cloudflare-assets.mjs
npm ci --ignore-scripts --no-audit --no-fund --prefix tools/wrangler
node scripts/render-cloudflare-configs.mjs --mode preview
for config in .wrangler-config/*.jsonc; do
    tools/wrangler/node_modules/.bin/wrangler deploy --config "$config" --dry-run
done
```

Production configs are rendered with `--mode production` and are restricted to
`peerbit.org` and `peerchecker.com`. Use the separately reviewed production
environment, verify every hostname, and retain a known-good Worker version
before deleting any retirement-only AWS resources.
