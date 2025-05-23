import { toBase64URL } from "@peerbit/crypto";

export const getPicSumLink = (db: { id: Uint8Array }, size: number) => {
    return `https://picsum.photos/seed/${toBase64URL(db.id)}/${size}`;
};
