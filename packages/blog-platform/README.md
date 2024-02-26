
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

To keep the state available for peers when only a few peers are online, you might want to host a dedicated server for this. With the Peerbit CLI, it looks something like this:

```sh
npm install -g @peerbit/server
peerbit remote spawn aws --count 1 --size medium --name "blog-platform"
```

Wait for the server to become ready, then do:

```sh
peerbit remote connect blog-platform-1
install @peerbit/blog-sdk
program open --variant blog-posts
```

Now, you have launched a server on your AWS account in the default region. This node will maintain whatever posts others have created and will be available when new peers want to read posts, but no others are online, except this server.

## Express Server API Wrapper

This package is not necessary to interact with the platform. It is just a demostration how you can wrap it with an Express server.

See [./server](./server) for more information.
