import { fromHexString } from "@dao-xyz/peerbit-crypto";

const clusterStartPattern = new Uint8Array([31, 67, 182, 117]);
const segmedStartPattern = fromHexString("1654AE6B"); //fromHexString("73A4");

export const getClusterStartIndices = (firstChunk: Uint8Array) => {
    const ret: number[] = [];
    outer: for (
        let i = 0;
        i < firstChunk.length - clusterStartPattern.length;
        i++
    ) {
        for (let j = 0; j < clusterStartPattern.length; j++) {
            if (firstChunk[i + j] !== clusterStartPattern[j]) {
                continue outer;
            }
        }
        ret.push(i);
    }
    return ret;
};

export const getSegmentStartIndices = (firstChunk: Uint8Array) => {
    const ret: number[] = [];
    outer: for (
        let i = 0;
        i < firstChunk.length - segmedStartPattern.length;
        i++
    ) {
        for (let j = 0; j < segmedStartPattern.length; j++) {
            if (firstChunk[i + j] !== segmedStartPattern[j]) {
                continue outer;
            }
        }
        ret.push(i);
    }
    return ret;
};

export const createFirstCluster = (
    chunk: Uint8Array,
    remainder: Uint8Array
):
    | { type: "wait"; remainder: Uint8Array }
    | { type: "cluster"; cluster: Uint8Array } => {
    const arr = new Uint8Array(chunk.length + remainder.length);
    arr.set(remainder, 0);
    arr.set(chunk, remainder.length);
    const clusterIndices = getClusterStartIndices(arr);
    if (clusterIndices.length === 0) {
        return {
            remainder: arr,
            type: "wait",
        };
    }
    return {
        cluster: arr.slice(clusterIndices[0]),
        type: "cluster",
    };
};
