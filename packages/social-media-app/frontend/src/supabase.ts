import { createSupabaseClient } from "@peerbit/identity-supabase";

const normalizeUrl = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        return trimmed;
    }
    return `https://${trimmed}`;
};

const configuredSupabaseUrl = import.meta.env.VITE_SUPABASE_URL
    ? normalizeUrl(import.meta.env.VITE_SUPABASE_URL)
    : undefined;

const configuredSupabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()
    ? import.meta.env.VITE_SUPABASE_ANON_KEY.trim()
    : undefined;

export const SUPABASE_AUTH_ENABLED =
    import.meta.env.VITE_SUPABASE_AUTH_ENABLED === "true";

if (
    SUPABASE_AUTH_ENABLED &&
    (!configuredSupabaseUrl || !configuredSupabaseAnonKey)
) {
    throw new Error(
        "VITE_SUPABASE_AUTH_ENABLED=true requires VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY"
    );
}

export const SUPABASE_URL = SUPABASE_AUTH_ENABLED
    ? configuredSupabaseUrl
    : undefined;

export const SUPABASE_ANON_KEY = SUPABASE_AUTH_ENABLED
    ? configuredSupabaseAnonKey
    : undefined;

export const supabase =
    SUPABASE_AUTH_ENABLED && SUPABASE_URL && SUPABASE_ANON_KEY
        ? createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY)
        : undefined;
