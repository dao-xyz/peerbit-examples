# Blog platform 

A app that allwos you to do blogging

## Library
In the library folder you can find all code that is handling the file data.


## CLI

This is the UI

<img src="./demo-cli.gif" width="600" />

There is a CLI application inside [./cli](./cli), that allows you to do the basic functionality.

Install from remote: 

```sh
npm install @peerbit/blog -g
```

Launch it
```sh
blog
```


### Run CLI from local build
To run from local build do:

First go [./cli](./cli)

```
yarn
yarn build
node  ./cli/lib/esm/bin.js
```


## Deploying the blog-platform to a server for persistance
To keep state available for peers when few peers are online, you might want to host a dedicated server for this. With the Peerbit cli it looks something like this 

```sh
npm install -g @peerbit/server
peerbit remote spawn aws --count 1 --size medium --name "blog-platform" 
```
wait for server to become ready, then do:

```sh
peerbit remote connect blog-platform-1
install @peerbit/blog-sdk
program open --variant blog-posts
```

Now you have launched a server on your AWS account in the default region. This node will keep whatever posts other have created, and will be available when new peers want to read posts, but no other are online, except this server.

## Express server API wrapper

This package contains an express server that wraps the blog client.

see [./server](./server) for more info

