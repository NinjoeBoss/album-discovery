-- When a member last had the app open on screen (refreshed by every chat check while visible,
-- cleared when the app goes to the background). Phone notifications skip members seen recently.
alter table club.members add column if not exists active_at timestamptz;
