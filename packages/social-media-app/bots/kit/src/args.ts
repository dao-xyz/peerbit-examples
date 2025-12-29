export const parseBooleanArg = (
    value: unknown,
    defaultValue: boolean
): boolean => {
    if (value == null) return defaultValue;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
        if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
    }
    return defaultValue;
};

export const parseNumberArg = (value: unknown): number | undefined => {
    if (value == null) return undefined;
    const numberValue =
        typeof value === "number" ? value : Number(String(value));
    if (!Number.isFinite(numberValue)) return undefined;
    return numberValue;
};

export const parseIntervalMs = (args: {
    intervalMs?: unknown;
    intervalMinutes?: unknown;
    defaultMs?: number;
}): number => {
    const intervalMs = parseNumberArg(args.intervalMs);
    if (intervalMs != null) return Math.max(0, intervalMs);

    const intervalMinutes = parseNumberArg(args.intervalMinutes);
    if (intervalMinutes != null) return Math.max(0, intervalMinutes) * 60_000;

    return args.defaultMs ?? 60_000;
};
