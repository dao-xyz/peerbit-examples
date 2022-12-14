# Browser chat

## [Application is live here](https://dao-xyz.github.io/peerbit-examples/)

App might not work well or at all on mobile (not tested)

This app is running from Browser to Browser. A relay is hosted in a datacenter that allows peers to discover and communicate with each other.

## About

### library

Contains the data controller functionality and access controll. 


### frontend
Connects UI code that interacts with library to create rooms, posts etc


## Developer setup

1. 
In the root folder of this repo
```sh
yarn install
yarn lerna bootstrap
```

2. 

For the browser to browser to work you need a relay (or use the one that is already available if its online)

See [this](../../README.md) for a local node (EASY!)

See [this](https://github.com/dao-xyz/peerbit/tree/master/packages/server-node) for a remote node (host in a data center, or at home with port forwarding) (A little harder)

3. 
The topics you need to subscribe to are 

```
"world"
"world!"
"_block"
```

4. 
Go to [Peer](./frontend/src/Peer.tsx) and modify the hard code addresses to one of the addresses you obtained in (1)

5. 
In the frontend package

To interact with a local node
```sh
yarn start
```

or

For remote node
```sh
yarn start-remote
```

