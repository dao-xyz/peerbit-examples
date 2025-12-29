# `@peerbit/identity-supabase-react`

Thin React hooks for `@peerbit/identity-supabase`.

This package intentionally does **not** include any profile/avatar logic.

## Usage

```tsx
import { PeerProvider } from "@peerbit/react";
import { createSupabaseClient } from "@peerbit/identity-supabase";
import { useSupabasePeerbitKeypair } from "@peerbit/identity-supabase-react";

const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);

export function App() {
  const { keypair, loading, error } = useSupabasePeerbitKeypair({ supabase });
  if (loading) return null;
  if (error) return <pre>{String(error)}</pre>;
  if (!keypair) return <div>Please sign in</div>;

  return (
    <PeerProvider keypair={keypair} network={{ type: "remote" }}>
      {/* ... */}
    </PeerProvider>
  );
}
```

