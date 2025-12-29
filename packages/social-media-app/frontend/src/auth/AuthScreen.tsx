import { useMemo, useState } from "react";
import { useAuth } from "./useAuth";
import { Link, useLocation, useNavigate } from "react-router";
import { Spinner } from "../utils/Spinner";

type Mode = "sign-in" | "sign-up" | "reset";
type AuthNavState = {
    email?: string;
    password?: string;
    notice?: string;
};

const cardClass =
    "w-full max-w-md rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-all-lg p-6";

const inputClass =
    "w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary-300 dark:focus:ring-primary-600";

export const AuthScreen = ({ mode }: { mode: Mode }) => {
    const auth = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const nav = (location.state || {}) as AuthNavState;

    const [email, setEmail] = useState(() => nav.email ?? "");
    const [password, setPassword] = useState(() => nav.password ?? "");
    const [password2, setPassword2] = useState("");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(nav.notice ?? null);
    const [error, setError] = useState<string | null>(null);

    const title = useMemo(() => {
        if (mode === "sign-up") return "Create account";
        if (mode === "reset") return "Reset password";
        return "Sign in";
    }, [mode]);

    const canSubmit = useMemo(() => {
        if (!auth.enabled) return false;
        if (!email.trim()) return false;
        if (mode === "reset") return true;
        if (!password) return false;
        if (mode === "sign-up" && password !== password2) return false;
        return true;
    }, [auth.enabled, email, mode, password, password2]);

    const normalizeAuthError = (e: any) => {
        const msg = String(e?.message || e || "");
        const lowered = msg.toLowerCase();
        if (
            lowered.includes("email not confirmed") ||
            lowered.includes("email_not_confirmed")
        ) {
            return "Please confirm your email first (check your inbox), then sign in.";
        }
        if (lowered.includes("invalid login credentials")) {
            return "Wrong email or password.";
        }
        return msg || "Something went wrong.";
    };

    const onSubmit = async () => {
        setError(null);
        setNotice(null);

        if (!auth.enabled) {
            setError("Sign in isn’t available in this build.");
            return;
        }

        const normalizedEmail = email.trim();
        if (!normalizedEmail) {
            setError("Enter your email.");
            return;
        }

        setBusy(true);
        try {
            if (mode === "reset") {
                await auth.resetPasswordForEmail({
                    email: normalizedEmail,
                    redirectTo: `${window.location.origin}${window.location.pathname}?next=${encodeURIComponent(
                        "/auth/update-password"
                    )}`,
                });
                setNotice("Check your email for a reset link.");
                return;
            }

            if (!password) {
                setError("Enter your password.");
                return;
            }

            if (mode === "sign-up") {
                if (password !== password2) {
                    setError("Passwords don’t match.");
                    return;
                }
                const result = await auth.signUpWithPassword({
                    email: normalizedEmail,
                    password,
                });
                // If Supabase returns a session, the user is already signed in.
                if (result.session) {
                    navigate("/", { replace: true });
                    return;
                }

                // Email confirmation is likely required; send them to sign-in with a friendly notice.
                navigate("/auth", {
                    replace: true,
                    state: {
                        email: normalizedEmail,
                        password,
                        notice:
                            "Check your email to confirm your account. After confirming, come back here to sign in.",
                    } satisfies AuthNavState,
                });
                return;
            }

            await auth.signInWithPassword({ email: normalizedEmail, password });
            navigate("/", { replace: true });
        } catch (e: any) {
            setError(normalizeAuthError(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="min-h-[70vh] flex items-center justify-center px-3 py-10">
            <div className={cardClass}>
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <h1 className="text-xl font-semibold">{title}</h1>
                        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                            {mode === "reset"
                                ? "We’ll email you a link to set a new password."
                                : "Save your identity so you can come back on any device."}
                        </p>
                    </div>
                    {auth.loading && <Spinner />}
                </div>

                {!auth.enabled && (
                    <div className="mt-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-3 text-sm text-neutral-700 dark:text-neutral-300">
                        <div className="font-semibold">Sign in not set up</div>
                        <div className="mt-1">
                            Set <code>VITE_SUPABASE_URL</code> and{" "}
                            <code>VITE_SUPABASE_ANON_KEY</code> in{" "}
                            <code>packages/social-media-app/frontend/.env</code>{" "}
                            (or <code>.env.local</code>), then restart the dev
                            server.
                        </div>
                    </div>
                )}

                {notice && (
                    <div className="mt-4 rounded-lg border border-primary-200 dark:border-primary-700 bg-primary-50 dark:bg-primary-900/30 p-3 text-sm">
                        {notice}
                    </div>
                )}
                {error && (
                    <div className="mt-4 rounded-lg border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-800 dark:text-red-200">
                        {error}
                    </div>
                )}

                {auth.user && mode !== "reset" && (
                    <div className="mt-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-3 text-sm">
                        <div className="font-semibold">You’re signed in</div>
                        <div className="mt-1 text-neutral-600 dark:text-neutral-400">
                            {auth.user.email ?? "Account"}
                        </div>
                        <div className="mt-3 flex items-center gap-2">
                            <button
                                className="btn btn-secondary"
                                onClick={async () => {
                                    setBusy(true);
                                    try {
                                        await auth.signOut();
                                        navigate("/", { replace: true });
                                    } catch (e: any) {
                                        setError(
                                            e?.message || "Failed to sign out."
                                        );
                                    } finally {
                                        setBusy(false);
                                    }
                                }}
                            >
                                Sign out
                            </button>
                            <Link className="btn btn-sm" to="/">
                                Back
                            </Link>
                        </div>
                    </div>
                )}

                {!auth.user && (
                    <div className="mt-5 flex flex-col gap-3">
                        <label className="flex flex-col gap-1">
                            <span className="text-sm text-neutral-700 dark:text-neutral-300">
                                Email
                            </span>
                            <input
                                className={inputClass}
                                type="email"
                                autoComplete="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                            />
                        </label>

                        {mode !== "reset" && (
                            <label className="flex flex-col gap-1">
                                <span className="text-sm text-neutral-700 dark:text-neutral-300">
                                    Password
                                </span>
                                <input
                                    className={inputClass}
                                    type="password"
                                    autoComplete={
                                        mode === "sign-up"
                                            ? "new-password"
                                            : "current-password"
                                    }
                                    value={password}
                                    onChange={(e) =>
                                        setPassword(e.target.value)
                                    }
                                />
                            </label>
                        )}

                        {mode === "sign-up" && (
                            <label className="flex flex-col gap-1">
                                <span className="text-sm text-neutral-700 dark:text-neutral-300">
                                    Confirm password
                                </span>
                                <input
                                    className={inputClass}
                                    type="password"
                                    autoComplete="new-password"
                                    value={password2}
                                    onChange={(e) =>
                                        setPassword2(e.target.value)
                                    }
                                />
                            </label>
                        )}

                        <button
                            className="btn btn-secondary w-full"
                            disabled={!canSubmit || busy}
                            onClick={onSubmit}
                        >
                            {busy ? (
                                <span className="flex items-center gap-2">
                                    <Spinner />
                                    <span>Working…</span>
                                </span>
                            ) : mode === "reset" ? (
                                "Send reset link"
                            ) : mode === "sign-up" ? (
                                "Create account"
                            ) : (
                                "Sign in"
                            )}
                        </button>

                        <div className="flex items-center justify-between gap-3 text-sm">
                            {mode !== "reset" ? (
                                <Link
                                    to="/auth/reset"
                                    className="underline text-neutral-700 dark:text-neutral-300"
                                >
                                    Forgot password?
                                </Link>
                            ) : (
                                <Link
                                    to="/auth"
                                    className="underline text-neutral-700 dark:text-neutral-300"
                                >
                                    Back to sign in
                                </Link>
                            )}

                            {mode === "sign-in" && (
                                <Link
                                    to="/auth/sign-up"
                                    className="underline text-neutral-700 dark:text-neutral-300"
                                >
                                    Create account
                                </Link>
                            )}
                            {mode === "sign-up" && (
                                <Link
                                    to="/auth"
                                    className="underline text-neutral-700 dark:text-neutral-300"
                                >
                                    I already have an account
                                </Link>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
