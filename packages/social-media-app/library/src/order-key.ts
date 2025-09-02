const ORDER_ALPHABET =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MID_CHAR = "U"; // ok to keep

function keyAfter(k: string): string {
    const A = ORDER_ALPHABET;
    const arr = k.split("");
    for (let i = arr.length - 1; i >= 0; i--) {
        const p = A.indexOf(arr[i]);
        if (p < A.length - 1) {
            arr[i] = A[p + 1];
            return arr.slice(0, i + 1).join(""); // strictly greater, minimal
        }
    }
    return k + A[0]; // all max chars → append min
}

function keyBefore(k: string): string {
    const A = ORDER_ALPHABET;
    const MAX = A[A.length - 1];
    const arr = k.split("");
    for (let i = arr.length - 1; i >= 0; i--) {
        const p = A.indexOf(arr[i]);
        if (p > 0) {
            arr[i] = A[p - 1];
            return (
                arr.slice(0, i + 1).join("") + MAX.repeat(k.length - (i + 1))
            ); // largest < k
        }
    }
    // k is the absolute minimum (e.g., "0", "00", ...). If you don't allow empty keys,
    // you can return A[Math.floor(A.length/2) - 1] or throw. This case won’t occur
    // if your first keys are around MID_CHAR.
    return ""; // only if empty keys are acceptable; otherwise throw.
}

/** Return a key strictly between a and b (lexicographically). */
export function orderKeyBetween(a?: string, b?: string): string {
    if (a == null && b == null) return MID_CHAR; // first-ever key
    if (a == null) return keyBefore(b!); // must be strictly < b
    if (b == null) return keyAfter(a!); // must be strictly > a

    // ----- strictly between a and b -----
    const A = ORDER_ALPHABET;
    const MIN = A[0],
        MAX = A[A.length - 1];

    if (!(a < b))
        throw new Error(`orderKeyBetween requires a < b, got a=${a}, b=${b}`);

    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;

    const ca = i < a.length ? a[i] : MIN;
    const cb = i < b.length ? b[i] : MAX;

    const ia = A.indexOf(ca);
    const ib = A.indexOf(cb);

    if (ia + 1 < ib) {
        const mid = A[Math.floor((ia + ib) / 2)];
        return b.slice(0, i) + mid;
    }
    // No room at this position → extend a minimally
    return a + MID_CHAR;
}
