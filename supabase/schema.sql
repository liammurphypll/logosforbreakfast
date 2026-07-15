-- Run this in the Supabase SQL editor (Project -> SQL Editor -> New query)
-- once, when setting up the project.

create table if not exists leaderboard_entries (
  id bigint generated always as identity primary key,
  player_name text not null,
  player_name_slug text not null, -- lowercase, used for case-insensitive lookups/uniqueness checks
  difficulty text not null check (difficulty in ('EASY', 'MEDIUM', 'HARD', 'EXPERT', 'SICKO')),
  play_date date not null,
  points integer not null default 0,
  streak integer not null default 0,
  correct_rounds integer not null default 0,
  created_at timestamptz not null default now()
);

-- Speeds up "has this player already played this tier today" checks.
create index if not exists idx_leaderboard_player_date
  on leaderboard_entries (player_name_slug, play_date, difficulty);

-- Speeds up leaderboard aggregation queries (per-difficulty, recent entries).
create index if not exists idx_leaderboard_difficulty_date
  on leaderboard_entries (difficulty, play_date);

-- Row Level Security: allow anyone to read (public leaderboard), and allow
-- anyone to insert their own result (no auth system — client sends whatever
-- name they typed). This matches the current no-login design. If this ever
-- needs real auth, tighten the insert policy to check auth.uid() instead.
alter table leaderboard_entries enable row level security;

create policy "Public read access"
  on leaderboard_entries for select
  using (true);

create policy "Public insert access"
  on leaderboard_entries for insert
  with check (true);

-- Today's (and every past day's) puzzle, written by scripts/pick-daily.js
-- (run on a schedule — see .github/workflows/daily-puzzle.yml) and read by
-- the game at runtime. Replaces the old static
-- public/data/daily-puzzle-{date}.json file, which only worked for local
-- dev — a real deploy (e.g. Render) builds straight from git and that file
-- is gitignored, so it was never actually present in production.
create table if not exists daily_puzzles (
  play_date date primary key,
  data jsonb not null,
  created_at timestamptz not null default now()
);

alter table daily_puzzles enable row level security;

create policy "Public read access"
  on daily_puzzles for select
  using (true);

create policy "Public insert access"
  on daily_puzzles for insert
  with check (true);

create policy "Public update access"
  on daily_puzzles for update
  using (true)
  with check (true);

-- Rolling history of which team was used on which day, for pick-daily.js's
-- 14-day cooldown logic. Replaces the old public/data/used-log.json file —
-- that was local-disk state, which doesn't persist across separate script
-- runs in a real scheduled-job environment (GitHub Actions, Render Cron
-- Jobs, etc. each start from a clean checkout).
create table if not exists team_usage_log (
  id bigint generated always as identity primary key,
  team_id text not null,
  used_date date not null
);

create index if not exists idx_team_usage_log_team_date
  on team_usage_log (team_id, used_date);

alter table team_usage_log enable row level security;

create policy "Public read access"
  on team_usage_log for select
  using (true);

create policy "Public insert access"
  on team_usage_log for insert
  with check (true);

-- Needed so pick-daily.js can prune old entries each run (mirrors the old
-- used-log.json trimming logic) — low-stakes if this were ever misused,
-- since it's just team-id/date pairs with no PII, same trust model as the
-- rest of this no-auth project.
create policy "Public delete access"
  on team_usage_log for delete
  using (true);
