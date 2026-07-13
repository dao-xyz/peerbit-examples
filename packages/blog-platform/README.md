# A P2P Blog Platform

An app that allows you to do blogging, in a local first, p2p way.

## CLI

This is the app you can interact with:

![CLI Demo](./demo-cli.gif)

The CLI code is defined in [./cli](./cli).

Install from npm:

```sh
npm install @peerbit/blog -g
```

Launch it:

```sh
blog
```

Data will persist in /HOME_DIR/peerbit-blog-platform

To set a custom working directory

```sh
blog --directory DIRECTORY
```

### Run CLI from Local Build

To run from a local build, do the following:

First, navigate to [./cli](./cli):

```sh
yarn
yarn build
node ./lib/esm/bin.js
```

## Library

In the library folder, you can find all the code that handles file data. The CLI app uses this library to provide functionality.

## Deploying the Blog Platform to a Server for Persistence

To keep the state available for peers when only a few peers are online, run a
dedicated Peerbit node on a persistent Linux host. Cloudflare Workers can host
the web frontend, but they cannot run this long-lived stateful Peerbit process.

First, run `peerbit id` on the administrator machine and copy its peer ID. Then
install `@peerbit/server` on the host, configure its public DNS and TLS without
proxying Peerbit's non-HTTP ports, and run the following command with a process
supervisor such as systemd:

```sh
npm install -g @peerbit/server
peerbit start --grant-access <ADMINISTRATOR_PEER_ID>
```

The access grant is required before the local CLI can manage programs on the
remote. Once that server is reachable, register it on the administrator machine
and open the blog program:

```sh
peerbit remote add blog-platform node.example.com
peerbit remote connect blog-platform
install @peerbit/blog-sdk
program open --variant blog-posts
```

This node maintains posts created by other peers and keeps them available when
no other peers are online. Keep the server package updated and back up the
node's Peerbit data directory.

## Express Server API Wrapper

This package is not necessary to interact with the platform. It is just a demostration how you can wrap it with an Express server.

See [./server](./server) for more information.
