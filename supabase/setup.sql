-- Sherpa database setup. Paste into Supabase → SQL Editor → Run. Safe to run again.

-- ---- Sign-up: campus (.edu) emails only ----
-- Enable it afterwards: Authentication → Hooks → "Before User Created" → Postgres → public.hook_edu_only
-- (For a real rollout, swap '%.edu' for the school's own domain, e.g. '%@gatech.edu'.)
create or replace function public.hook_edu_only(event jsonb)
returns jsonb
language plpgsql
as $$
begin
  if lower(coalesce(event->'user'->>'email', '')) like '%.edu' then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'message', 'Please sign up with your campus (.edu) email.',
    'http_code', 403));
end;
$$;

grant execute on function public.hook_edu_only to supabase_auth_admin;
revoke execute on function public.hook_edu_only from authenticated, anon, public;


-- ---- One emergency contact per account ----
create table if not exists public.contacts (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 60),
  phone text not null check (phone ~ '^[+0-9 ().-]{7,20}$'),
  updated_at timestamptz not null default now()
);

alter table public.contacts enable row level security;

drop policy if exists "Users manage their own contact" on public.contacts;
create policy "Users manage their own contact" on public.contacts
  for all to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);


-- ---- Crowd reports (path blocked, accessibility barrier, light out, safety concern) ----
-- Every signed-in user can read them; each person can only add reports as themselves.
-- Two reports from different people, same category, within ~30 m, confirm a report (worked out by the app).
create table if not exists public.reports (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  category text not null check (category in ('blocked', 'barrier', 'light', 'safety')),
  lat double precision not null check (lat between 33.75 and 33.80),      -- Georgia Tech, with a margin
  lng double precision not null check (lng between -84.42 and -84.37),
  still_there boolean not null default true,   -- false: a passerby answered "no" to "Is this still here?"
  created_at timestamptz not null default now()
);

create index if not exists reports_recent on public.reports (created_at desc);

alter table public.reports enable row level security;

drop policy if exists "Signed-in users can read reports" on public.reports;
create policy "Signed-in users can read reports" on public.reports
  for select to authenticated
  using (true);

drop policy if exists "Users add reports as themselves" on public.reports;
create policy "Users add reports as themselves" on public.reports
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

-- so someone who reports by accident can take it back (only their own)
drop policy if exists "Users remove their own reports" on public.reports;
create policy "Users remove their own reports" on public.reports
  for delete to authenticated
  using ((select auth.uid()) = user_id);
