# Many chat rooms
![demo](./demo.gif)

This example showcase how you can create a a lobby where you can enter different chat rooms

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
Go to [Peer](./frontend/src/Peer.tsx) and modify the hard code addresses to one of the addresses you obtained in (1)

4. 
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