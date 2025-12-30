import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "./useAuth";

export const AuthNextRedirect = () => {
    const auth = useAuth();
    const navigate = useNavigate();

    useEffect(() => {
        if (!auth.enabled) return;
        if (auth.loading) return;
        if (!auth.user) return;

        try {
            const url = new URL(window.location.href);
            const next = url.searchParams.get("next");
            if (!next) return;
            navigate(next, { replace: true });
        } catch {}
    }, [auth.enabled, auth.loading, auth.user?.id, navigate]);

    return null;
};
