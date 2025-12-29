import { Ed25519Keypair } from "@peerbit/crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
    deserializeEd25519Keypair,
    serializeEd25519Keypair,
} from "./keypair.js";

export const DEFAULT_KEYPAIR_TABLE = "peerbit_keypairs";

export type KeypairRow = {
    user_id: string;
    keypair: string;
    created_at?: string;
};

export type KeypairStoreOptions = {
    table?: string;
};

export async function requireSupabaseUserId(
    supabase: SupabaseClient
): Promise<string> {
    const { data, error } = await supabase.auth.getUser();
    if (error) throw error;
    if (!data?.user?.id) {
        throw new Error("No Supabase user session. Please sign in first.");
    }
    return data.user.id;
}

export async function getKeypairForUser(
    supabase: SupabaseClient,
    options: KeypairStoreOptions & { userId: string }
): Promise<Ed25519Keypair | undefined> {
    const table = options.table ?? DEFAULT_KEYPAIR_TABLE;
    const { data, error } = await supabase
        .from(table)
        .select("keypair")
        .eq("user_id", options.userId)
        .maybeSingle();
    if (error) throw error;
    if (!data?.keypair) return undefined;
    return deserializeEd25519Keypair(data.keypair);
}

export async function getKeypairForCurrentUser(
    supabase: SupabaseClient,
    options: KeypairStoreOptions = {}
): Promise<Ed25519Keypair | undefined> {
    const userId = await requireSupabaseUserId(supabase);
    return getKeypairForUser(supabase, { ...options, userId });
}

export async function insertKeypairForUser(
    supabase: SupabaseClient,
    options: KeypairStoreOptions & { userId: string; keypair: Ed25519Keypair }
): Promise<void> {
    const table = options.table ?? DEFAULT_KEYPAIR_TABLE;
    const { error } = await supabase.from(table).insert({
        user_id: options.userId,
        keypair: serializeEd25519Keypair(options.keypair),
    } satisfies KeypairRow);
    if (error) throw error;
}

export async function getOrCreateKeypairForUser(
    supabase: SupabaseClient,
    options: KeypairStoreOptions & { userId: string }
): Promise<Ed25519Keypair> {
    const existing = await getKeypairForUser(supabase, options);
    if (existing) return existing;

    const created = await Ed25519Keypair.create();

    // Best-effort insert; if another client races, we'll just read again.
    try {
        await insertKeypairForUser(supabase, {
            ...options,
            keypair: created,
        });
        return created;
    } catch (error: any) {
        const after = await getKeypairForUser(supabase, options);
        if (after) return after;
        throw error;
    }
}

export async function getOrCreateKeypairForCurrentUser(
    supabase: SupabaseClient,
    options: KeypairStoreOptions = {}
): Promise<Ed25519Keypair> {
    const userId = await requireSupabaseUserId(supabase);
    return getOrCreateKeypairForUser(supabase, { ...options, userId });
}
