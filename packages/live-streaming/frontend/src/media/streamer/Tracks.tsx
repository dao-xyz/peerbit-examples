import { MediaStreamDB } from "../database";
import { useLocal } from "@peerbit/react";

/**
 * Track managed
 */
export const Tracks = (props: { db?: MediaStreamDB }) => {
    const local = useLocal(props.db?.tracks);
    return <div>TRACK {local.length}</div>;
};
