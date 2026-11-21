begin;

create table public.watchlist_items (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null check (ticker ~ '^[A-Z][A-Z0-9.]{0,9}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, ticker)
);

create table public.analysis_runs (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  result jsonb not null check (jsonb_typeof(result) = 'object')
);

create index analysis_runs_by_user on public.analysis_runs (user_id, created_at desc);

create table public.holdings (
  user_id uuid not null references auth.users(id) on delete cascade,
  ticker text not null check (ticker ~ '^[A-Z][A-Z0-9.]{0,9}$'),
  shares numeric(14,6) not null check (shares > 0 and shares <= 10000000),
  average_cost numeric(14,6) not null check (average_cost > 0 and average_cost <= 10000000),
  primary key (user_id, ticker)
);

create table public.preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  provider text not null check (provider in ('demo', 'openai', 'claude', 'gemini')),
  horizon text not null check (horizon in ('1w', '1m', '3m', '6m')),
  agent_count integer not null check (agent_count in (3, 5))
);

alter table public.watchlist_items enable row level security;
alter table public.analysis_runs enable row level security;
alter table public.holdings enable row level security;
alter table public.preferences enable row level security;

revoke all on public.watchlist_items, public.analysis_runs, public.holdings, public.preferences from public, anon, authenticated;
grant select, insert, delete on public.watchlist_items to authenticated;
grant select, insert on public.analysis_runs to authenticated;
grant select, insert, update, delete on public.holdings to authenticated;
grant select, insert, update on public.preferences to authenticated;

create policy own_watchlist on public.watchlist_items for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy own_analysis on public.analysis_runs for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy own_holdings on public.holdings for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy own_preferences on public.preferences for all to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

commit;
