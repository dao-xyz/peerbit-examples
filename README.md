
<br>
<p align="center">
    <img width="350" src="./library.jpeg"  alt="Libraryn">
</p>

<h1 align="center" style="border-bottom: none">
    <strong>
        Peerbit Example Library
        </strong>
</h1>

# 🚧 WIP 🚧

## Examples
### [Chat in the browser](./packages/browser-chat/)


TBD


## How to setup a local relay node

Launch an IPFS node for development purposes

Create an init file so that the IPFS node supports Websocket and PubSub
```sh
echo "#\!/bin/sh \nset -ex \nipfs bootstrap rm all \nipfs config Addresses.Swarm '[\"/ip4/0.0.0.0/tcp/4001\", \"/ip4/0.0.0.0/tcp/8081/ws\", \"/ip6/::/tcp/4001\"]' --json\nipfs config --json Pubsub.Enabled true \nipfs config Swarm.RelayService '{\"Enabled\": true}' --json" > ipfs-config.sh
```

Launch node
```sh
sudo docker run -d --name ipfs_host -v $(pwd)/ipfs-config.sh:/container-init.d/001-test.sh  -p 4001:4001 -p 4001:4001/udp -p 127.0.0.1:8080:8080 -p 127.0.0.1:8081:8081 -p 127.0.0.1:5001:5001 ipfs/kubo:latest daemon
```

Get adddresses you can connect to locally
```
docker exec ipfs_host ipfs id  
```

Copy the address that looks like this:
```/ip4/127.0.0.1/tcp/8081/ws/p2p/12D3KooWDQjLGJppKwWndK8SwYX9gmr2YBCh3doR5bWXxptdKpaL``` 
The important thing here is the ```/ws/``` that indicates that this is an address for WebSocket connections


If you want the docker node to relay PubSub messages between two browsers you need to make sure that the node is subscribing to that topic where the communication is going to occur

Run
```sh
docker exec ipfs_host pubsub sub TOPIC
```