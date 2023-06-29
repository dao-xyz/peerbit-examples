import { getFreeKeypair, getAllKeyPairs } from "@peerbit/react";
export const getRootKeypair = () => getFreeKeypair("root");
export const getRootKeypairs = () => getAllKeyPairs("root");
export const getCanvasKeypair = () => getFreeKeypair("canvas");
export const getCanvasKeypairs = () => getAllKeyPairs("canvas");
export const getAllKeypairs = async () => {
    return [...(await getRootKeypairs()), ...(await getCanvasKeypairs())];
};
