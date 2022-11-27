# Browser chat 🚧 WIP 🚧

This application consists of two parts

## The Library
Contains the data controller functionality and access controll. 


## The frontend
Connects UI code that interacts with The Library to create rooms, posts etc


# How to launch a node

1. 
In the root folder of this repo
```sh
yarn install
yarn lerna bootstrap
```

2. 
See [this](https://github.com/dao-xyz/peerbit/tree/master/packages/server-node) for a remote node (host in a data center)

See [this](../../README.md) for a local node (on your computer in a Docker container)

3. 
The topics you need to subscribe to are 

```
"world"
"world!"
"_block"
```

4. 
Go to [Peer](./frontend/src/Peer.tsx) and modify the hard coded swarm addresses to one of the addresses you obtained in (1)

5. 
In the frontend package

For local network
```sh
yarn start
```

or

For remote network
```sh
yarn start-remote
```

