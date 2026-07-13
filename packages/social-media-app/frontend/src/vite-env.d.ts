/// <reference types="vite/client" />
interface ImportMeta {
    readonly env: ImportMetaEnv;
}

interface ImportMetaEnv {
    readonly VITE_SUPABASE_URL?: string;
    readonly VITE_SUPABASE_ANON_KEY?: string;
    readonly VITE_STREAMING_APP_URL?: string;
    readonly VITE_CHESS_APP_URL?: string;
}
