-- Supabase schema (idempotent: safe to re-run). Apply with:
--   psql "$POSTGRES_URL_NON_POOLING" -f db/schema.sql
--
-- Writer: only scripts/scraper.mjs on the owner's machine, using the service-role key
-- (which bypasses row-level security). Readers: the Vercel site and browsers, using the
-- anon key, which row-level security limits to SELECT. See docs/SCRUBBER.md §0a.

-- latest snapshot per task (results, markets, streams, news, social:<list>, trends) + small state
create table if not exists public.kv (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- the live feed: every event the differ emits
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

-- market price history (Democratic probability) per control question / race
create table if not exists public.ticks (
  key text not null,
  t timestamptz not null,
  v double precision,
  primary key (key, t)
);

-- scrubber: one row per race each time that race changed
create table if not exists public.race_ticks (
  race_id text not null,
  t timestamptz not null,          -- when the scraper saw it
  src_t timestamptz,               -- the source's own timestamp
  called boolean not null default false,
  winner text,
  runoff boolean not null default false,
  expected real,
  prec int,
  prec_total int,
  votes jsonb not null,            -- [[name, party, votes], ...] in source order
  src text,
  primary key (race_id, t)
);
create index if not exists race_ticks_t_idx on public.race_ticks (t);

-- scrubber: full merged results every 5 minutes (rebuild/debug hedge)
create table if not exists public.snapshots (
  t timestamptz not null,
  task text not null,
  payload jsonb not null,
  primary key (task, t)
);

-- scrubber: append-only content so news and social windows can replay
create table if not exists public.news_items (
  link text primary key,
  first_seen timestamptz not null,
  published timestamptz,
  source text,
  title text not null,
  lanes text[] not null default '{}',
  description text,
  image text
);
create index if not exists news_items_seen_idx on public.news_items (first_seen);
create table if not exists public.posts (
  id text primary key,
  list text not null,
  created_at timestamptz,
  first_seen timestamptz not null,
  payload jsonb not null
);
create index if not exists posts_list_idx on public.posts (list, created_at desc);

-- scrubber: which video each stream channel showed when
create table if not exists public.stream_ticks (
  stream_id text not null,
  t timestamptz not null,
  video_id text,
  status text,
  title text,
  primary key (stream_id, t)
);

-- scraper liveness: one row per poll cycle; the site shows "data paused" when the newest is old
create table if not exists public.heartbeat (
  id bigserial primary key,
  t timestamptz not null default now(),
  host text,
  version text,
  tasks jsonb not null default '{}'::jsonb
);
create index if not exists heartbeat_t_idx on public.heartbeat (t desc);

-- read-only for everyone except the service role
do $$
declare tbl text;
begin
  foreach tbl in array array['kv','events','ticks','race_ticks','snapshots','news_items','posts','stream_ticks','heartbeat'] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('drop policy if exists "public read" on public.%I', tbl);
    execute format('create policy "public read" on public.%I for select to anon, authenticated using (true)', tbl);
    execute format('revoke insert, update, delete, truncate on public.%I from anon, authenticated', tbl);
  end loop;
end $$;

-- Realtime: browsers subscribe to heartbeat inserts as a "new data" nudge
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'heartbeat') then
    alter publication supabase_realtime add table public.heartbeat;
  end if;
end $$;
