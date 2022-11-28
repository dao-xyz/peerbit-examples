# Browser chat

## [Application is live here](https://dao-xyz.github.io/peerbit-examples/)

This app is running from Browser to Browser.

Snapshots are currently not implemented. So if you are alone in the app and refresh the page you will loose everything! (No one else will help you out when you come back online again)

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

See [this](../../README.md) for a local node (on your computer in a Docker container) (EASY!)

See [this](https://github.com/dao-xyz/peerbit/tree/master/packages/server-node) for a remote node (host in a data center, or at home with port forwarding) (A little harder)

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

To interact with a local node
```sh
yarn start
```

or

For remote node
```sh
yarn start-remote
```

