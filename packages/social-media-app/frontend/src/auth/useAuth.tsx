import type { Session, SupabaseClient, User } from "@peerbit/identity-supabase";
import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useState,
} from "react";
import { supabase as supabaseClient } from "../supabase";

export type AuthContextValue = {
    enabled: boolean;
    supabase?: SupabaseClient;
    loading: boolean;
    session: Session | null;
    user: User | null;
    lastEvent?:
        | "INITIAL_SESSION"
        | "SIGNED_IN"
        | "SIGNED_OUT"
        | "PASSWORD_RECOVERY"
        | "TOKEN_REFRESHED"
        | "USER_UPDATED"
        | string;
    signInWithPassword: (args: {
        email: string;
        password: string;
    }) => Promise<{ user: User | null; session: Session | null }>;
    signUpWithPassword: (args: {
        email: string;
        password: string;
    }) => Promise<{ user: User | null; session: Session | null }>;
    resetPasswordForEmail: (args: {
        email: string;
        redirectTo?: string;
    }) => Promise<void>;
    updatePassword: (args: { password: string }) => Promise<void>;
    signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({
    children,
}) => {
    const enabled = !!supabaseClient;
    const [session, setSession] = useState<Session | null>(null);
    const [user, setUser] = useState<User | null>(null);
    const [loading, setLoading] = useState<boolean>(enabled);
    const [lastEvent, setLastEvent] = useState<AuthContextValue["lastEvent"]>();

    useEffect(() => {
        if (!supabaseClient) {
            setLoading(false);
            return;
        }

        let cancelled = false;
        let resolved = false;
        let gotAuthEvent = false;
        let gotGetSession = false;

        const authCallbackHint = (() => {
            try {
                const url = `${window.location.href || ""}`;
                return /access_token=|refresh_token=|type=recovery|type=signup|type=magiclink|code=/.test(
                    url
                );
            } catch {
                return false;
            }
        })();

        let timeout: ReturnType<typeof setTimeout> | undefined;
        const resolveLoading = () => {
            if (cancelled || resolved) return;
            resolved = true;
            if (timeout) clearTimeout(timeout);
            setLoading(false);
        };
        const resolveWhenReady = () => {
            if (cancelled || resolved) return;
            if (authCallbackHint) return;
            if (gotAuthEvent && gotGetSession) {
                resolveLoading();
            }
        };

        setLoading(true);

        if (authCallbackHint) {
            // Give Supabase time to process sessions embedded in the URL (email confirm / recovery links).
            timeout = setTimeout(resolveLoading, 5000);
        }

        const { data } = supabaseClient.auth.onAuthStateChange(
            (event, next) => {
                if (cancelled) return;
                gotAuthEvent = true;
                setLastEvent(event);
                setSession(next ?? null);
                setUser(next?.user ?? null);

                // Callback flows: keep loading until we either have a session, or an event beyond INITIAL_SESSION arrives.
                if (authCallbackHint && (next || event !== "INITIAL_SESSION")) {
                    resolveLoading();
                }

                resolveWhenReady();
            }
        );

        (async () => {
            try {
                const { data, error } = await supabaseClient.auth.getSession();
                if (error) throw error;
                if (cancelled) return;
                setSession(data.session ?? null);
                setUser(data.session?.user ?? null);
                gotGetSession = true;
                if (authCallbackHint) {
                    if (data.session) resolveLoading();
                    return;
                }
                resolveWhenReady();
            } catch (error) {
                console.error("[Auth] getSession failed", error);
                if (cancelled) return;
                setSession(null);
                setUser(null);
                gotGetSession = true;
                resolveWhenReady();
            }
        })();

        return () => {
            cancelled = true;
            if (timeout) clearTimeout(timeout);
            try {
                data.subscription.unsubscribe();
            } catch {}
        };
    }, [enabled]);

    const signInWithPassword = useCallback<
        AuthContextValue["signInWithPassword"]
    >(async ({ email, password }) => {
        if (!supabaseClient) throw new Error("Supabase is not configured.");
        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email,
            password,
        });
        if (error) throw error;
        return { user: data.user ?? null, session: data.session ?? null };
    }, []);

    const signUpWithPassword = useCallback<
        AuthContextValue["signUpWithPassword"]
    >(async ({ email, password }) => {
        if (!supabaseClient) throw new Error("Supabase is not configured.");
        const { data, error } = await supabaseClient.auth.signUp({
            email,
            password,
        });
        if (error) throw error;
        return { user: data.user ?? null, session: data.session ?? null };
    }, []);

    const resetPasswordForEmail = useCallback<
        AuthContextValue["resetPasswordForEmail"]
    >(async ({ email, redirectTo }) => {
        if (!supabaseClient) throw new Error("Supabase is not configured.");
        const { error } = await supabaseClient.auth.resetPasswordForEmail(
            email,
            redirectTo ? { redirectTo } : undefined
        );
        if (error) throw error;
    }, []);

    const updatePassword = useCallback<AuthContextValue["updatePassword"]>(
        async ({ password }) => {
            if (!supabaseClient) throw new Error("Supabase is not configured.");
            const { error } = await supabaseClient.auth.updateUser({
                password,
            });
            if (error) throw error;
        },
        []
    );

    const signOut = useCallback<AuthContextValue["signOut"]>(async () => {
        if (!supabaseClient) return;
        const { error } = await supabaseClient.auth.signOut();
        if (error) throw error;
    }, []);

    const value = useMemo<AuthContextValue>(
        () => ({
            enabled,
            supabase: supabaseClient ?? undefined,
            loading,
            session,
            user,
            lastEvent,
            signInWithPassword,
            signUpWithPassword,
            resetPasswordForEmail,
            updatePassword,
            signOut,
        }),
        [
            enabled,
            loading,
            session,
            user,
            lastEvent,
            signInWithPassword,
            signUpWithPassword,
            resetPasswordForEmail,
            updatePassword,
            signOut,
        ]
    );

    return (
        <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
    );
};

export const useAuth = (): AuthContextValue => {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
    return ctx;
};
