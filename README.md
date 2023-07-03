
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
![one-chat-room](/packages/one-chat-room/demo.gif)

### [Lobby + chat rooms](./packages/many-chat-rooms/)
![lobby-chat](/packages/many-chat-rooms/demo.gif)

### [Sync files](./packages/many-chat-rooms/)
![lobby-chat](/packages/file-share/demo.gif)



### [Video streaming in a Document store](./packages/live-streaming/)
![video-stream](/packages/live-streaming/demo.gif)

### [Collaborative machine learning](./packages/live-streaming/)
![video-stream](/packages/collaborative-learning/demo.gif)


## How to run the examples

1. 
```sh
yarn
yarn lerna bootstrap
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