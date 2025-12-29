import {
    createClient,
    type SupabaseClient,
    type SupabaseClientOptions,
} from "@supabase/supabase-js";

export function createSupabaseClient(
    supabaseUrl: string,
    supabaseAnonKey: string,
    options?: SupabaseClientOptions<"public">
): SupabaseClient {
    return createClient(supabaseUrl, supabaseAnonKey, options);
}
