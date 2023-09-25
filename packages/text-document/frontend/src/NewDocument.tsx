import { usePeer } from "@peerbit/react";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom"
import { CollaborativeTextDocument } from "./db";
import { AppClient } from "@dao-xyz/app-sdk";


export const NewDocument = () => {

    const { peer } = usePeer();
    const navigate = useNavigate()
    const params = useParams();
    useEffect(() => {
        if (!peer) {
            return;
        }

        peer.open<CollaborativeTextDocument>(new CollaborativeTextDocument()).then((d) => {
            navigate("/d/" + d.address)
        })
    }, [peer?.identity.publicKey.hashcode()])
    return <></>
}