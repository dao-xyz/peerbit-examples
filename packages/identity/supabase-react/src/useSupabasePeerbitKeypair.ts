import { useEffect, useMemo, useState } from "react";
import type { Ed25519Keypair } from "@peerbit/crypto";
import type { SupabaseClient } from "@peerbit/identity-supabase";
import {
    getOrCreateKeypairForUser,
    getKeypairForUser,
} from "@peerbit/identity-supabase";

export type UseSupabasePeerbitKeypairOptions = {
    supabase: SupabaseClient;
    table?: string;
    createIfMissing?: boolean;
};

export type UseSupabasePeerbitKeypairResult = {
    keypair: Ed25519Keypair | undefined;
    loading: boolean;
    error: unknown;
    userId: string | undefined;
};

export function useSupabasePeerbitKeypair(
    options: UseSupabasePeerbitKeypairOptions
): UseSupabasePeerbitKeypairResult {
    const { supabase } = options;
    const createIfMissing = options.createIfMissing ?? true;

    const [keypair, setKeypair] = useState<Ed25519Keypair | undefined>(
        undefined
    );
    const [userId, setUserId] = useState<string | undefined>(undefined);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<unknown>(undefined);

    const storeOptions = useMemo(
        () => ({ table: options.table }),
        [options.table]
    );

    useEffect(() => {
        let cancelled = false;

        const clear = () => {
            setKeypair(undefined);
            setUserId(undefined);
            setError(undefined);
        };

        const loadForSession = async () => {
            setLoading(true);
            setError(undefined);

            try {
                const { data, error: sessionError } =
                    await supabase.auth.getSession();
                if (sessionError) throw sessionError;
                if (!data.session?.user?.id) {
                    clear();
                    return;
                }

                const id = data.session.user.id;
                setUserId(id);

                const keypairResolved = createIfMissing
                    ? await getOrCreateKeypairForUser(supabase, {
                          ...storeOptions,
                          userId: id,
                      })
                    : await getKeypairForUser(supabase, {
                          ...storeOptions,
                          userId: id,
                      });

                if (cancelled) return;
                setKeypair(keypairResolved);
            } catch (e) {
                if (cancelled) return;
                clear();
                setError(e);
            } finally {
                if (!cancelled) setLoading(false);
            }
        };

        void loadForSession();

        const { data: subscription } = supabase.auth.onAuthStateChange(
            () => void loadForSession()
        );

        return () => {
            cancelled = true;
            subscription.subscription.unsubscribe();
        };
    }, [supabase, createIfMissing, storeOptions]);

    return { keypair, loading, error, userId };
}
