# `@peerbit/identity-supabase`

Minimal Supabase-backed storage for a **single Peerbit Ed25519 keypair per Supabase user**.

This package intentionally does **not** handle profiles/avatars (store those in Peerbit).

## Table schema (SQL)

```sql
create table if not exists peerbit_keypairs (
  user_id uuid primary key references auth.users(id) on delete cascade,
  keypair text not null,
  created_at timestamptz not null default now()
);

alter table peerbit_keypairs enable row level security;

create policy "read own keypair" on peerbit_keypairs
for select using (auth.uid() = user_id);

create policy "insert own keypair" on peerbit_keypairs
for insert with check (auth.uid() = user_id);
```

If you want to allow key rotation, also add an `update` policy (and update code accordingly).

## Usage

```ts
import { createSupabaseClient, getOrCreateKeypairForCurrentUser } from "@peerbit/identity-supabase";

const supabase = createSupabaseClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ... user logs in with Supabase Auth ...

const keypair = await getOrCreateKeypairForCurrentUser(supabase);
```

## Security note

This stores the keypair material in Supabase (guarded by RLS). If you need end-to-end encryption of private keys, add client-side encryption before storage.

