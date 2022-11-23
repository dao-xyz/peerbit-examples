import React, { useContext, useEffect } from "react";
import { webSockets } from '@libp2p/websockets'
/* import { useWallet } from "@dao-xyz/wallet-adapter-react"; */
import * as IPFS from 'ipfs-core'
import { multiaddr } from '@multiformats/multiaddr'
import { Peerbit } from '@dao-xyz/peerbit';

interface IPeerContext {
    peer: Peerbit,
    loading: boolean
}

export const PeerContext = React.createContext<IPeerContext>({} as any);
export const usePeer = () => useContext(PeerContext);
export const PeerProvider = ({ children }: { children: JSX.Element }) => {
    const [peer, setPeer] = React.useState<Peerbit | undefined>(undefined);
    /* const [rootIdentity, setRootIdentity] = React.useState<Identity>(undefined); */
    const [loading, setLoading] = React.useState<boolean>(false);
    /* const wallet = useWallet() */
    const memo = React.useMemo<IPeerContext>(
        () => ({
            peer,
            /*    rootIdentity, */
            loading
        }),
        [loading, peer?.identity?.publicKey.toString()]
    );

    useEffect(() => {

        /*   if (!wallet.publicKey)
              return; */
        console.log('load peer')

        setLoading(true);

        console.log('create ipfs node', process.env)
        IPFS.create({
            start: true,
            relay: { enabled: false, hop: { enabled: false, active: false } },
            preload: { enabled: false },
            EXPERIMENTAL: { ipnsPubsub: false, "pubsub": true } as any,
            offline: true,
            config: {
                Bootstrap: [],
                Addresses: {
                    Swarm: []
                },
                Discovery: {
                    MDNS: { Enabled: false },
                    webRTCStar: { Enabled: false },
                },
            },
            repo: 'abc', // repo name uncertainty: When failing to get remote block 
            libp2p: {
                connectionManager: {
                    autoDial: false
                },
                ...(process.env.REACT_APP_NETWORK === 'local' ? {
                    transports: [ // Add websocket impl so we can connect to "unsafe" ws (production only allows wss)
                        webSockets({
                            filter: (addrs) => addrs.filter((addr) => addr.toString().indexOf("/ws/") != -1 || addr.toString().indexOf("/wss/") != -1),

                        })
                    ]
                } : {})
            }
        }).then(async (node) => {

            if (process.env.REACT_APP_NETWORK === 'local') {
                console.log('swarm connect?')
                await node.swarm.connect(multiaddr("/ip4/192.168.1.212/tcp/8081/ws/p2p/12D3KooWR7EYyLG3SnLheULnz9gJskFg5TBBrBcNETy1kisXuvZH"))
            }
            else {
                const bootstrapConfig: { bootstrap: string[] } = { bootstrap: ["/dns4/e182fe9c0b82c9fe13b5c6470cc6e6c4edf2144c.peerchecker.com/tcp/4002/wss/p2p/12D3KooWCDvdPTTNy5Aj59wQtRQpYjnGCuobVJnhhFb4DRXdkbHw"] }
                await Promise.all(bootstrapConfig.bootstrap.map((bootstrap) => node.swarm.connect(multiaddr(bootstrap)).catch(error => {
                    console.error("PEER CONNECT ERROR", error);
                    alert("Failed to connect to peers. Please try again later.")
                    throw error;
                })))
            }

            console.log('Connected to swarm!');
            // TODO fix types
            /*     console.log('got wallet', wallet)
                const walletIdentity: Identity = {
                    publicKey: (wallet.publicKey as (Ed25519PublicKey | Secp256k1PublicKey)) as any,
                    sign: (data) => (wallet.signMessage(data))
                };
                setRootIdentity(walletIdentity);
     */
            Peerbit.create(node).then(async (peer) => {
                console.log("Created peer", peer.identity.publicKey.toString());
                setPeer(peer);
            })

        }).finally(() => {
            setLoading(false);
        })

    }
        ,
        [/* wallet?.publicKey?.toString() */])

    return (
        <PeerContext.Provider value={memo}>
            {children}
        </PeerContext.Provider>
    );
};
