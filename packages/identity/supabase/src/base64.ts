const toBinaryString = (bytes: Uint8Array): string => {
    let out = "";
    for (const byte of bytes) out += String.fromCharCode(byte);
    return out;
};

const fromBinaryString = (binary: string): Uint8Array => {
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
};

export const encodeBase64 = (bytes: Uint8Array): string => {
    if (typeof Buffer !== "undefined") {
        return Buffer.from(bytes).toString("base64");
    }
    if (typeof btoa === "function") {
        return btoa(toBinaryString(bytes));
    }
    throw new Error("No base64 encoder available in this environment");
};

export const decodeBase64 = (value: string): Uint8Array => {
    if (typeof Buffer !== "undefined") {
        return new Uint8Array(Buffer.from(value, "base64"));
    }
    if (typeof atob === "function") {
        return fromBinaryString(atob(value));
    }
    throw new Error("No base64 decoder available in this environment");
};
