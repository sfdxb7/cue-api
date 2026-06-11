-- Cue persistence schema (run in Supabase SQL editor as supabase_admin).
-- All access goes through cue-api with the service-role key; RLS locks out
-- anon/authenticated roles entirely.

create extension if not exists pgcrypto;

create table if not exists public.meetings (
  id text primary key check (id ~ '^[A-Za-z0-9-]{1,64}$'),
  device_id text not null,
  title text not null default 'Untitled meeting',
  date_label text not null default '',
  started_at timestamptz,
  ended_at timestamptz,
  duration text not null default '',
  people int not null default 0,
  status text not null default 'processing'
    check (status in ('ready', 'processing', 'transcript_missing')),
  chips jsonb not null default '[]',
  minutes jsonb not null default '{"summary":"","decisions":[],"actions":[],"unclearItems":[]}',
  chat jsonb not null default '[]',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search_tsv tsvector generated always as (
    to_tsvector('english',
      coalesce(title, '') || ' ' || coalesce(minutes::text, '') || ' ' || coalesce(chat::text, ''))
  ) stored
);

create index if not exists meetings_device_idx on public.meetings (device_id, updated_at desc);
create index if not exists meetings_tsv_idx on public.meetings using gin (search_tsv);

create table if not exists public.moments (
  meeting_id text not null references public.meetings(id) on delete cascade,
  id text not null,
  device_id text not null,
  type text not null check (type in ('Key Moment', 'Decision', 'Follow-up', 'Unclear Item', 'Note')),
  title text not null,
  summary text not null,
  timestamp_label text not null,
  context text not null,
  has_screenshot boolean not null default false,
  tags jsonb not null default '[]',
  created_at timestamptz not null default now(),
  primary key (meeting_id, id),
  search_tsv tsvector generated always as (
    to_tsvector('english', title || ' ' || summary || ' ' || coalesce(tags::text, ''))
  ) stored
);

create index if not exists moments_device_idx on public.moments (device_id);
create index if not exists moments_tsv_idx on public.moments using gin (search_tsv);

create table if not exists public.transcripts (
  meeting_id text primary key references public.meetings(id) on delete cascade,
  device_id text not null,
  content text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.playbooks (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  name text not null,
  kind text not null check (kind in ('text', 'pdf')),
  content text not null,
  source_filename text,
  page_count int,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists playbooks_device_idx on public.playbooks (device_id);

alter table public.meetings enable row level security;
alter table public.moments enable row level security;
alter table public.transcripts enable row level security;
alter table public.playbooks enable row level security;

create or replace function public.search_memory(p_device text, p_query text, p_limit int default 10)
returns jsonb
language sql
stable
as $$
  with q as (
    select websearch_to_tsquery('english', p_query) as tsq
  ),
  meeting_hits as (
    select m.id as meeting_id,
           m.title,
           m.date_label,
           ts_rank(m.search_tsv, q.tsq) as rank,
           ts_headline('english', coalesce(m.minutes->>'summary', m.title), q.tsq,
                       'MaxWords=24, MinWords=8') as snippet,
           'minutes'::text as kind,
           null::text as moment_id
    from public.meetings m, q
    where m.device_id = p_device and m.search_tsv @@ q.tsq
  ),
  moment_hits as (
    select mo.meeting_id,
           m.title,
           m.date_label,
           ts_rank(mo.search_tsv, q.tsq) as rank,
           ts_headline('english', mo.title || '. ' || mo.summary, q.tsq,
                       'MaxWords=24, MinWords=8') as snippet,
           'moment'::text as kind,
           mo.id as moment_id
    from public.moments mo
    join public.meetings m on m.id = mo.meeting_id, q
    where mo.device_id = p_device and mo.search_tsv @@ q.tsq
  )
  select coalesce(jsonb_agg(to_jsonb(hits) order by hits.rank desc), '[]'::jsonb)
  from (
    select * from meeting_hits
    union all
    select * from moment_hits
    order by rank desc
    limit p_limit
  ) hits;
$$;
