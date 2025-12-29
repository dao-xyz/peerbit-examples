import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Spinner } from "../utils/Spinner";
import { useAuth } from "./useAuth";

const cardClass =
    "w-full max-w-md rounded-xl border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-neutral-950 shadow-all-lg p-6";

const inputClass =
    "w-full rounded-lg border border-neutral-200 dark:border-neutral-800 bg-white dark:bg-black px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary-300 dark:focus:ring-primary-600";

export const UpdatePasswordScreen = () => {
    const auth = useAuth();
    const navigate = useNavigate();
    const location = useLocation();
    const [password, setPassword] = useState("");
    const [password2, setPassword2] = useState("");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        // If we arrived here via `?next=...` keep URL clean after router consumes it.
        try {
            const url = new URL(window.location.href);
            if (url.searchParams.has("next")) {
                url.searchParams.delete("next");
                window.history.replaceState({}, "", url.toString());
            }
        } catch {}
    }, [location.key]);

    const canSubmit = useMemo(() => {
        if (!auth.enabled) return false;
        if (!auth.user) return false;
        if (!password) return false;
        if (password !== password2) return false;
        return true;
    }, [auth.enabled, auth.user, password, password2]);

    const onSubmit = async () => {
        setError(null);
        setNotice(null);

        if (!auth.enabled) {
            setError("Password reset isn’t available in this build.");
            return;
        }
        if (!auth.user) {
            setError(
                "Open the reset link from your email to set a new password."
            );
            return;
        }
        if (!password) {
            setError("Enter a new password.");
            return;
        }
        if (password !== password2) {
            setError("Passwords don’t match.");
            return;
        }

        setBusy(true);
        try {
            await auth.updatePassword({ password });
            setNotice("Password updated.");
            setTimeout(() => navigate("/", { replace: true }), 800);
        } catch (e: any) {
            setError(e?.message || "Failed to update password.");
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="min-h-[70vh] flex items-center justify-center px-3 py-10">
            <div className={cardClass}>
                <div className="flex items-start justify-between gap-3">
                    <div>
                        <h1 className="text-xl font-semibold">
                            Set a new password
                        </h1>
                        <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                            Choose a new password for your account.
                        </p>
                    </div>
                    {auth.loading && <Spinner />}
                </div>

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

                {!auth.user && (
                    <div className="mt-4 rounded-lg border border-neutral-200 dark:border-neutral-800 bg-neutral-50 dark:bg-neutral-900 p-3 text-sm text-neutral-700 dark:text-neutral-300">
                        You’re not signed in. Open the reset link from your
                        email.
                        <div className="mt-3">
                            <Link className="btn btn-secondary" to="/auth">
                                Go to sign in
                            </Link>
                        </div>
                    </div>
                )}

                {auth.user && (
                    <div className="mt-5 flex flex-col gap-3">
                        <label className="flex flex-col gap-1">
                            <span className="text-sm text-neutral-700 dark:text-neutral-300">
                                New password
                            </span>
                            <input
                                className={inputClass}
                                type="password"
                                autoComplete="new-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                            />
                        </label>
                        <label className="flex flex-col gap-1">
                            <span className="text-sm text-neutral-700 dark:text-neutral-300">
                                Confirm new password
                            </span>
                            <input
                                className={inputClass}
                                type="password"
                                autoComplete="new-password"
                                value={password2}
                                onChange={(e) => setPassword2(e.target.value)}
                            />
                        </label>

                        <button
                            className="btn btn-secondary w-full"
                            disabled={!canSubmit || busy}
                            onClick={onSubmit}
                        >
                            {busy ? (
                                <span className="flex items-center gap-2">
                                    <Spinner />
                                    <span>Updating…</span>
                                </span>
                            ) : (
                                "Update password"
                            )}
                        </button>

                        <div className="text-sm text-neutral-600 dark:text-neutral-400">
                            <Link className="underline" to="/">
                                Back to app
                            </Link>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};

