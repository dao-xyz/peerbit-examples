import { createSupabaseClient } from "@peerbit/identity-supabase";

const normalizeUrl = (value: string): string => {
    const trimmed = value.trim();
    if (!trimmed) return trimmed;
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
        return trimmed;
    }
    return `https://${trimmed}`;
};

export const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL
    ? normalizeUrl(import.meta.env.VITE_SUPABASE_URL)
    : undefined;

export const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim()
    ? import.meta.env.VITE_SUPABASE_ANON_KEY.trim()
    : undefined;

export const supabase =
    SUPABASE_URL && SUPABASE_ANON_KEY
        ? createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY)
        : undefined;
