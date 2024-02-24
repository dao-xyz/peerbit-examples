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


### Run CLI locally
To run it locally:

First go to the root folder of the exampels repo and build it

```
yarn build
```

Then go back to the [./cli](./cli) folder and now you can do: 

```node  ./cli/lib/esm/bin.js``` instead of ```blog``` to invoke the cli. 



## Server

This package contains an express server that wraps the blog client

You can interact with the server using API tools, like Insomnia to read blog posts

