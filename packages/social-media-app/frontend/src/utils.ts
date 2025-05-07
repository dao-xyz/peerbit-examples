export const buildCommit =
    import.meta.env.VITE_COMMIT_HASH || // Vite
    "unknown";
