export const BASE_URL = process.env.BASE_URL || "http://localhost:5173";

export const OFFLINE_BASE = (() => {
    const base = BASE_URL.replace(/\/+$/, "");
    if (/[?&]bootstrap=/.test(base)) {
        return base.includes("#") ? base : base + "#/";
    }
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}bootstrap=offline#/`;
})();
