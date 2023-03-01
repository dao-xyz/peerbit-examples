import { getFreeKeypair, getAllKeyPairs } from "@dao-xyz/peerbit-react";

export const getRootKeypair = () => getFreeKeypair("root");
export const getRootKeypairs = () => getAllKeyPairs("root");
export const getCanvasKeypair = () => getFreeKeypair("canvas");
export const getCanvasKeypairs = () => getAllKeyPairs("canvas");
export const getAllKeypairs = async () => {
    return [...(await getRootKeypairs()), ...(await getCanvasKeypairs())];
};
