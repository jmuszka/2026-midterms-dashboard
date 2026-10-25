-- Supabase schema for the shared store (lib/store.mjs). Run once in the Supabase SQL editor.
-- The poller writes with the service-role key; browsers never talk to these tables directly
-- except, optionally, a Realtime subscription on public.events (read-only policy below).

create table if not exists public.kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.events (
  id bigserial primary key,
  t timestamptz not null,
  type text not null,
  race_id text,
  chamber text,
  state text,
  party text,
  text text not null,
  data jsonb not null default '{}'::jsonb
);
create index if not exists events_t_idx on public.events (t desc);
create index if not exists events_race_idx on public.events (race_id);

create table if not exists public.ticks (
  key text not null,
  t timestamptz not null,
  v double precision,
  primary key (key, t)
);

alter table public.kv enable row level security;
alter table public.events enable row level security;
alter table public.ticks enable row level security;
-- anonymous read of events only (for an optional browser Realtime subscription)
drop policy if exists "events readable" on public.events;
create policy "events readable" on public.events for select using (true);
-- alter publication supabase_realtime add table public.events;  -- uncomment to enable Realtime
