const clusterStartPattern = new Uint8Array([31, 67, 182, 117])
export const getClusterStartIndices = (firstChunk: Uint8Array) => {
    let ret: number[] = [];
    outer:
    for (let i = 0; i < firstChunk.length - clusterStartPattern.length; i++) {
        for (let j = 0; j < clusterStartPattern.length; j++) {
            if (firstChunk[i + j] !== clusterStartPattern[j]) {
                continue outer;
            }
        }
        ret.push(i);
    }
    return ret;
}