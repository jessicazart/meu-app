-- Aquecimento de hoje — esquema do banco (Supabase)
-- Rode este arquivo inteiro em: Supabase → SQL Editor → New query → Run.

-- Lista de apps do usuário + primeiro dia de uso (para numerar "Dia 1", "Dia 2"…)
create table if not exists public.profiles (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  apps       jsonb not null default '[]'::jsonb,   -- [{ "id": "...", "name": "..." }]
  first_day  date,
  updated_at timestamptz not null default now()
);

-- Um registro por dia: tempo de cada conta (timestamps) + nomes dos apps naquele dia
create table if not exists public.days (
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  day        date not null,
  apps       jsonb not null default '[]'::jsonb,   -- retrato dos apps naquele dia
  accounts   jsonb not null default '{}'::jsonb,   -- { appId: { ig: {...}, tt: {...} } }
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

-- Segurança: cada pessoa só vê e altera os próprios dados
alter table public.profiles enable row level security;
alter table public.days     enable row level security;

drop policy if exists "profiles: dono" on public.profiles;
create policy "profiles: dono" on public.profiles
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "days: dono" on public.days;
create policy "days: dono" on public.days
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Tempo real: avisa os outros aparelhos quando algo muda
do $$
begin
  begin
    alter publication supabase_realtime add table public.profiles;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.days;
  exception when duplicate_object then null;
  end;
end $$;
