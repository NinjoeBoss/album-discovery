-- Phone notifications (Web Push).
--
-- One row per phone that turned notifications on. It belongs to that phone's sign in,
-- so signing out (or the sign in expiring) removes it too.
create table club.push_subs (
  endpoint      text primary key,
  member        text not null references club.members(name) on update cascade on delete cascade,
  session_hash  text not null references club.sessions(token_hash) on delete cascade,
  p256dh        text not null,
  auth          text not null,
  created       timestamptz not null default now(),
  last_ok       timestamptz
);
create index push_subs_member on club.push_subs (member);

-- Which kinds of notifications each member wants (all on until they switch some off).
alter table club.members add column push_prefs jsonb not null
  default '{"chat": true, "picks": true, "ratings": true, "reminders": true}';

alter table club.push_subs enable row level security;
revoke all on club.push_subs from public, anon, authenticated;
