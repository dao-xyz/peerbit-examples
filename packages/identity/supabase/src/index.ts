export type { SupabaseClient, Session, User } from "@supabase/supabase-js";

export { createSupabaseClient } from "./client.js";

export { DEFAULT_KEYPAIR_TABLE } from "./store.js";
export type { KeypairRow, KeypairStoreOptions } from "./store.js";
export {
    requireSupabaseUserId,
    getKeypairForUser,
    getKeypairForCurrentUser,
    insertKeypairForUser,
    getOrCreateKeypairForUser,
    getOrCreateKeypairForCurrentUser,
} from "./store.js";

export {
    serializeEd25519Keypair,
    deserializeEd25519Keypair,
} from "./keypair.js";
