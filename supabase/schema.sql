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
