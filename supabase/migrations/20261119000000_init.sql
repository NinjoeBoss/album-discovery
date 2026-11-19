-- Club Music database (replaces the Google Sheet and Apps Script properties).
--
-- Nothing here is reachable from the browser: row level security is on for every
-- table with no policies, and the anon/authenticated roles have no grants. Only
-- the `api` Edge Function (connecting as the database owner) reads or writes.

create schema if not exists club;
revoke all on schema club from public, anon, authenticated;

-- Members, in column order. `sort` is the order the app lists them in;
-- `rotation` is the weekly pick order.
create table club.members (
  name        text primary key,
  email       text not null unique,
  sort        int  not null,
  rotation    int  not null,
  is_admin    boolean not null default false,
  platform    text check (platform in ('spotify', 'apple')),
  avatar      text            -- data:image/... URL (private photo, never in the repo)
);

create table club.seasons (
  name   text primary key,
  start  date not null unique
);

-- One row per Thursday (kind = 'pick') or per "heard it before" share (kind = 'share').
-- id keeps the numbers the app already uses: picks use the old sheet row numbers
-- (row 7 = Jul 16, 2026, one row per week), shares are 100000 + their old row.
-- A pick week with album = null is an open week; picked_by on an open week is a reservation.
create table club.albums (
  id              int primary key,
  kind            text not null check (kind in ('pick', 'share')),
  week            date not null,
  album           text,
  artist          text,
  year            text,
  picked_by       text references club.members(name) on update cascade,
  cover           text,
  spotify         text,
  apple           text,
  spotify_artist  text,
  apple_artist    text,
  tracks          jsonb,          -- ["song", ...] in album order, null = not looked up yet
  created_at      timestamptz not null default now()
);
create unique index albums_one_pick_per_week on club.albums (week) where kind = 'pick';
create index albums_kind_week on club.albums (kind, week);

create table club.ratings (
  album_id   int  not null references club.albums(id) on delete cascade,
  member     text not null references club.members(name) on update cascade,
  score      numeric(4,2) check (score >= 1 and score <= 10),
  fav        text not null default '',
  least      text not null default '',
  comment    text not null default '' check (char_length(comment) <= 200),
  rated_at   timestamptz,          -- first time a score was saved (null for ratings before Nov 10, 2026)
  primary key (album_id, member)
);

create table club.chat (
  id        bigint primary key,
  at        timestamptz not null default now(),
  name      text not null references club.members(name) on update cascade,
  text      text not null default '' check (char_length(text) <= 2000)   -- '' = deleted
);

-- Sign in. Tokens and codes are stored only as SHA-256 hashes.
create table club.sessions (
  token_hash  text primary key,
  member      text not null references club.members(name) on update cascade on delete cascade,
  created     timestamptz not null default now(),
  last_used   timestamptz not null default now()
);
create table club.app_keys (
  key_hash      text primary key,
  member        text not null references club.members(name) on update cascade on delete cascade,
  session_hash  text unique,
  created       timestamptz not null default now()
);
create table club.codes (
  member     text primary key references club.members(name) on update cascade on delete cascade,
  code_hash  text not null,
  tries      int  not null default 0,
  expires    timestamptz not null
);
-- Per day counts (day in club time). member = '*' holds the club total.
create table club.signin_counts (
  day      date not null,
  member   text not null,
  sent     int  not null default 0,
  wrong    int  not null default 0,
  alerted  boolean not null default false,
  primary key (day, member)
);
-- Short window rate limits (codes per 10 minutes, chat posts per minute).
create table club.rate_hits (
  bucket  text not null,
  at      timestamptz not null default now()
);
create index rate_hits_bucket_at on club.rate_hits (bucket, at);

-- Lookups saved for good (song links, "no match" markers with an expiry) and small settings.
create table club.kv (
  key      text primary key,
  value    jsonb not null,
  expires  timestamptz
);

do $$
declare t text;
begin
  for t in select tablename from pg_tables where schemaname = 'club' loop
    execute format('alter table club.%I enable row level security', t);
    execute format('revoke all on club.%I from public, anon, authenticated', t);
  end loop;
end $$;

insert into club.seasons (name, start) values
  ('Season 1', '2026-07-16'),
  ('Season 2', '2026-11-12');
