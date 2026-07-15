import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Check, X, Flame, ArrowRight, RotateCcw, Minus, Share2, Trophy, ChevronLeft, User } from 'lucide-react';
import { supabase } from './supabaseClient.js';

/* ---------------------------------------------------------------
   REAL DATA — fetched at runtime from public/data/ (see build-catalog.js
   and pick-daily.js). Each round is { team, nickname, league, logo:
   { url, type, era } }. catalog.json (the full team pool, all leagues)
   feeds the typeahead's decoy options; daily-puzzle-{date}.json is
   today's 5 difficulty tiers of 10 rounds each.
----------------------------------------------------------------- */
const DATA_BASE = '/data';
const DAILY_COUNT = 10; // matches DAILY_COUNT in pick-daily.js

const GAME_NAME = 'Logos for Breakfast';
const PUZZLE_NO = 214;
const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD', 'EXPERT', 'SICKO'];

// Team/Nickname: binary — correct or wrong. League: optional flat bonus.
const FULL_POINTS = { team: 10, nickname: 15 };
const LEAGUE_BONUS = 5;
const MAX_MISSES = 3; // shared across the whole round — 3 wrong guesses and the round ends
const FIRST_TRY_BONUS = 3; // flat, per field, not multiplied — correct on your very first guess
const CLEAN_SHEET_BONUS = 5; // flat, once per round — finish with 0 misses used

const FIELD_LABEL = { team: 'Team / City', nickname: 'Nickname', league: 'League / Sport' };

function formatDateLong(iso) {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function multiplierFor(streak) {
  if (streak >= 12) return 3;
  if (streak >= 9) return 2.5;
  if (streak >= 6) return 2;
  if (streak >= 3) return 1.5;
  return 1;
}

function matchQuality(input, correct) {
  const a = input.trim().toLowerCase();
  const b = correct.trim().toLowerCase();
  return a && a === b ? 'full' : 'none';
}

function rankFor(correctRounds, total) {
  const pct = correctRounds / total;
  if (pct === 1) return { title: 'UNDEFEATED', note: 'Perfect sheet. Every logo, every field.' };
  if (pct >= 0.7) return { title: 'ALL-STAR', note: 'Strong outing — most logos locked in.' };
  if (pct >= 0.4) return { title: 'STARTER', note: 'Solid gains, room to climb the roster.' };
  if (pct > 0) return { title: 'BENCHWARMER', note: 'On the board — grind it out tomorrow.' };
  return { title: 'WAIVED', note: 'Rough one. Every team has a bye week.' };
}

function buildShareText(history, score, rank, puzzleNo) {
  const grid = history
    .map((r) => (r.team === 'full' && r.nickname === 'full' ? '🟩' : r.team === 'full' || r.nickname === 'full' ? '🟨' : '⬜'))
    .join('');
  return `${GAME_NAME.toUpperCase()} No. ${puzzleNo}\n${score} pts · ${rank.title}\n${grid}`;
}

/* ---------------------------------------------------------------
   LEADERBOARD STORAGE — real Supabase table (see supabase/schema.sql).
   Player's own name is remembered via localStorage (this is a real
   browser now, not a Claude artifact sandbox, so localStorage is fine).
----------------------------------------------------------------- */
const NAME_KEY = 'logos-for-breakfast:player-name';

function slugify(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'player';
}

// "First L" or "First L." — first name (2+ letters) + a single last-initial.
function isValidNameFormat(name) {
  return /^[A-Za-z][A-Za-z'-]+\s+[A-Za-z]\.?$/.test(name.trim());
}
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function rowToEntry(row) {
  return {
    date: row.play_date,
    points: row.points,
    streak: row.streak,
    correctRounds: row.correct_rounds,
    difficulty: row.difficulty,
  };
}

async function savePlayerResult(name, entry) {
  try {
    const { error } = await supabase.from('leaderboard_entries').insert({
      player_name: name,
      player_name_slug: slugify(name),
      difficulty: entry.difficulty,
      play_date: entry.date,
      points: entry.points,
      streak: entry.streak,
      correct_rounds: entry.correctRounds,
    });
    if (error) throw error;
  } catch (e) {
    console.error('savePlayerResult failed:', e); // fail quietly to the UI, but log for debugging
  }
}

async function loadPlayerRecord(name) {
  if (!name || !name.trim()) return { name, entries: [] };
  try {
    const { data, error } = await supabase
      .from('leaderboard_entries')
      .select('*')
      .eq('player_name_slug', slugify(name));
    if (error) throw error;
    return { name, entries: (data || []).map(rowToEntry) };
  } catch (e) {
    console.error('loadPlayerRecord failed:', e);
    return { name, entries: [] };
  }
}

async function loadLeaderboard() {
  try {
    const { data, error } = await supabase.from('leaderboard_entries').select('*');
    if (error) throw error;
    const byName = {};
    for (const row of data || []) {
      const key = row.player_name_slug;
      if (!byName[key]) byName[key] = { name: row.player_name, entries: [] };
      byName[key].entries.push(rowToEntry(row));
    }
    return Object.values(byName);
  } catch (e) {
    console.error('loadLeaderboard failed:', e);
    return [];
  }
}

function computeStats(data, difficulty) {
  const today = todayISO();
  const weekStart = daysAgoISO(6);
  const entries = (data.entries || []).filter((e) => e.difficulty === difficulty);
  const dailyPts = entries.filter((e) => e.date === today).reduce((s, e) => s + e.points, 0);
  const weeklyPts = entries.filter((e) => e.date >= weekStart).reduce((s, e) => s + e.points, 0);
  const avg = entries.length ? Math.round(entries.reduce((s, e) => s + e.points, 0) / entries.length) : 0;
  const bestStreak = entries.reduce((m, e) => Math.max(m, e.streak || 0), 0);
  return { name: data.name, dailyPts, weeklyPts, avg, bestStreak, played: entries.length };
}

// Consecutive-days-played streak (distinct from the in-round puzzle streak).
// Counts backward from today (or yesterday, so missing "today so far" doesn't
// zero it out) through unbroken consecutive calendar dates.
function computeDayStreak(entries) {
  const dates = [...new Set(entries.map((e) => e.date))].sort().reverse();
  if (dates.length === 0) return 0;
  const today = todayISO();
  const yesterday = daysAgoISO(1);
  if (dates[0] !== today && dates[0] !== yesterday) return 0;

  let streak = 1;
  for (let i = 0; i < dates.length - 1; i++) {
    const diffDays = Math.round((new Date(dates[i]) - new Date(dates[i + 1])) / 86400000);
    if (diffDays === 1) streak++;
    else break;
  }
  return streak;
}

// All-time profile view — combines every difficulty, unlike computeStats
// which is scoped to one tier for the leaderboard.
function computeProfileStats(data) {
  const entries = data.entries || [];
  const daysPlayed = new Set(entries.map((e) => e.date)).size;
  const totalGames = entries.length;
  const allTimePoints = entries.reduce((s, e) => s + e.points, 0);
  const dayStreak = computeDayStreak(entries);

  const perDifficulty = {};
  DIFFICULTIES.forEach((d) => {
    const de = entries.filter((e) => e.difficulty === d);
    const totalPoints = de.reduce((s, e) => s + e.points, 0);
    perDifficulty[d] = {
      played: de.length,
      totalPoints,
      avgPoints: de.length ? Math.round(totalPoints / de.length) : 0,
      bestStreak: de.reduce((m, e) => Math.max(m, e.streak || 0), 0),
    };
  });

  let bestDifficulty = null;
  let bestAvg = -1;
  DIFFICULTIES.forEach((d) => {
    if (perDifficulty[d].played > 0 && perDifficulty[d].avgPoints > bestAvg) {
      bestAvg = perDifficulty[d].avgPoints;
      bestDifficulty = d;
    }
  });

  return { name: data.name, daysPlayed, totalGames, allTimePoints, dayStreak, perDifficulty, bestDifficulty };
}

const INK = '#121212';
const SUB = '#787C7E';
const LINE = '#D8D8D2';
const PAGE = '#F6F6F1';
const CARD = '#FFFFFF';
const GREEN = '#63A375';
const GREEN_BG = '#E7F4E9';
const WRONG_BG = '#F8EAEA';
const RED = '#D97C7C';
const RED_BG = '#F8EAEA';
const BLUE = '#6E9BC7';
const AMBER = '#DDA15E';

const barlow = "'Barlow Semi Condensed', sans-serif";
const inter = "'Inter', sans-serif";

function Crest({ round, size = 132 }) {
  return (
    <div
      style={{
        width: size, height: size,
        border: `2px solid ${INK}`,
        borderRadius: 6,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: CARD,
      }}
    >
      <img
        src={round.logo.url}
        alt=""
        referrerPolicy="no-referrer"
        style={{ maxWidth: '80%', maxHeight: '80%', objectFit: 'contain' }}
      />
    </div>
  );
}

function TypeaheadField({ field, round, status, answer, firstTry, essential, options, onSubmit, onSkip }) {
  const [value, setValue] = useState('');
  const [open, setOpen] = useState(false);
  const [shakeKey, setShakeKey] = useState(0);
  const boxRef = useRef(null);

  const matches = useMemo(() => {
    if (!value.trim()) return [];
    const v = value.toLowerCase();
    return options.filter(o => o.toLowerCase().startsWith(v)).sort((a, b) => a.localeCompare(b));
  }, [value, options]);

  const check = (candidate) => {
    const quality = matchQuality(candidate, round[field]);
    onSubmit(field, quality, round[field]);
    if (quality === 'full') {
      setValue(candidate);
    } else {
      setValue('');
      setShakeKey((k) => k + 1);
    }
    setOpen(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && value.trim()) check(value);
  };

  const isDone = status !== 'pending';
  const resolvedBg = status === 'full' ? GREEN_BG : status === 'wrong' ? WRONG_BG : status === 'skipped' ? PAGE : CARD;
  const resolvedBorder = status === 'full' ? GREEN : status === 'wrong' ? RED : status === 'skipped' ? LINE : INK;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <label style={{ fontFamily: inter, fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: SUB }}>
          {FIELD_LABEL[field]}{' '}
          <span style={{ color: '#B4B4AC' }}>
            {field === 'league' ? `· +${LEAGUE_BONUS}` : `· +${FULL_POINTS[field]}`}
          </span>
        </label>
        {!essential && !isDone && (
          <button
            onClick={() => onSkip(field)}
            style={{ background: 'none', border: 'none', color: SUB, fontFamily: inter, fontSize: 11, cursor: 'pointer', textDecoration: 'underline' }}
          >
            skip
          </button>
        )}
      </div>

      <div
        key={shakeKey}
        ref={boxRef}
        className={!isDone ? 'field-shake-host' : ''}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          background: isDone ? resolvedBg : CARD,
          border: `1.5px solid ${isDone ? resolvedBorder : LINE}`,
          borderRadius: 6,
          padding: '13px 14px',
          transition: 'border-color 140ms ease, background 140ms ease',
        }}
      >
        {!isDone && (
          <input
            value={value}
            onChange={(e) => { setValue(e.target.value); setOpen(true); }}
            onKeyDown={handleKeyDown}
            onFocus={(e) => { setOpen(true); if (boxRef.current) boxRef.current.style.borderColor = INK; }}
            onBlur={(e) => { setTimeout(() => setOpen(false), 120); if (boxRef.current) boxRef.current.style.borderColor = LINE; }}
            placeholder="Type your answer…"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: INK, fontFamily: inter, fontSize: 15 }}
          />
        )}

        {isDone && (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span
              style={{
                fontFamily: inter, fontSize: 15, fontWeight: 500,
                color: status === 'wrong' ? RED : status === 'skipped' ? SUB : INK,
                textDecoration: status === 'wrong' ? 'line-through' : 'none',
              }}
            >
              {status === 'skipped' ? '— skipped —' : answer}
            </span>
            {status === 'full' && firstTry && (
              <span style={{ fontFamily: inter, fontSize: 10, fontWeight: 700, color: GREEN, letterSpacing: '0.02em', marginRight: 6 }}>
                1ST TRY +{FIRST_TRY_BONUS}
              </span>
            )}
            {status === 'full' && <Check size={17} color={GREEN} strokeWidth={3} />}
            {status === 'wrong' && <X size={17} color={RED} strokeWidth={3} />}
            {status === 'skipped' && <Minus size={16} color={SUB} />}
          </div>
        )}
      </div>

      {status === 'wrong' && (
        <div style={{ marginTop: 4, fontFamily: inter, fontSize: 12, color: RED }}>
          answer: {round[field]}
        </div>
      )}

      {open && !isDone && matches.length > 0 && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 6,
            background: CARD, border: `1.5px solid ${INK}`, borderRadius: 6,
            maxHeight: 220, overflowY: 'auto', zIndex: 10, boxShadow: '0 8px 20px -8px rgba(0,0,0,0.25)',
          }}
        >
          {matches.map((m) => (
            <div
              key={m}
              onMouseDown={() => check(m)}
              style={{ padding: '10px 14px', fontFamily: inter, fontSize: 14, color: INK, cursor: 'pointer', borderBottom: `1px solid ${PAGE}` }}
              onMouseEnter={(e) => (e.currentTarget.style.background = PAGE)}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              {m}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------
   START SCREEN
----------------------------------------------------------------- */
function StartScreen({ nameInput, setNameInput, nameError, rememberedName, difficulty, setDifficulty, playedToday, puzzleReady, puzzleFailed, onStart, onViewLeaderboard, onViewProfile, preview, previewLoading }) {
  const alreadyPlayed = playedToday.has(difficulty);
  const canStart = nameInput.trim() && !nameError && !alreadyPlayed && puzzleReady;
  const isReturning = rememberedName && nameInput.trim() === rememberedName.trim();
  return (
    <div style={{ width: '100%', maxWidth: 420, background: CARD, border: `1.5px solid ${INK}`, borderRadius: 10, padding: '32px 24px 24px' }}>
      <div style={{ textAlign: 'center', marginBottom: 26 }}>
        <div style={{ fontFamily: inter, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: SUB, marginBottom: 10 }}>
          {formatDateLong(todayISO())} · No. {PUZZLE_NO}
        </div>
        <div style={{ fontFamily: barlow, fontWeight: 800, fontSize: 42, letterSpacing: '-0.01em', textTransform: 'uppercase', lineHeight: 0.95 }}>
          Logos for<br />Breakfast
        </div>
        <div style={{ fontFamily: inter, fontSize: 13, color: SUB, marginTop: 10, lineHeight: 1.5 }}>
          Coffee. Flapjacks. Logos.
          <br />
          <span style={{ fontWeight: 700, color: INK }}>{DAILY_COUNT} New Logos Daily.</span>
        </div>
      </div>

      <div style={{ marginBottom: 20 }}>
        <label style={{ display: 'block', fontFamily: inter, fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: SUB, marginBottom: 8 }}>
          Difficulty — one play per tier per day
        </label>
        <div style={{ display: 'flex', gap: 6 }}>
          {DIFFICULTIES.map((d) => {
            const active = difficulty === d;
            const done = playedToday.has(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => setDifficulty(d)}
                style={{
                  flex: 1, padding: '9px 0', borderRadius: 20, cursor: 'pointer',
                  border: `1.5px solid ${active ? INK : done ? '#C7C7BF' : LINE}`,
                  background: active ? INK : done ? '#EFEFEC' : 'transparent',
                  color: active ? '#FFF' : done ? '#A9A9A1' : INK,
                  fontFamily: inter, fontWeight: 600, fontSize: 10, letterSpacing: '0.02em',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
                }}
              >
                {done && <Check size={10} strokeWidth={3} />}
                {d}
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <label style={{ display: 'block', fontFamily: inter, fontSize: 11, fontWeight: 600, letterSpacing: '0.08em', textTransform: 'uppercase', color: SUB, marginBottom: 6 }}>
          Your name
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, border: `1.5px solid ${nameError ? RED : INK}`, borderRadius: 6, padding: '13px 14px' }}>
          <User size={16} color={SUB} />
          <input
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && canStart) onStart(); }}
            placeholder="First name + last initial, e.g. Liam M"
            style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: INK, fontFamily: inter, fontSize: 15 }}
          />
        </div>
        {nameError ? (
          <div style={{ fontFamily: inter, fontSize: 11.5, color: RED, marginTop: 6 }}>{nameError}</div>
        ) : isReturning ? (
          <div style={{ fontFamily: inter, fontSize: 11.5, color: GREEN, marginTop: 6 }}>Welcome back, {rememberedName}</div>
        ) : (
          <div style={{ fontFamily: inter, fontSize: 11, color: '#B4B4AC', marginTop: 6 }}>
            One name per player — visible to everyone on the leaderboard.
          </div>
        )}
      </div>

      <button
        type="button"
        onClick={onStart}
        disabled={!canStart}
        style={{
          width: '100%', padding: '14px 20px', borderRadius: 30, border: 'none', marginBottom: 10,
          background: canStart ? INK : LINE, cursor: canStart ? 'pointer' : 'not-allowed',
          fontFamily: inter, fontWeight: 600, fontSize: 14, color: canStart ? '#FFF' : '#9B9B93',
        }}
      >
        {alreadyPlayed ? `${difficulty} already played today`
          : puzzleFailed ? "Today's puzzle isn't ready yet"
          : !puzzleReady ? 'Loading…'
          : "Start Today's Puzzle"}
      </button>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={onViewLeaderboard}
          style={{ flex: 1, padding: '12px 14px', borderRadius: 30, background: 'transparent', border: `1.5px solid ${LINE}`, color: INK, fontFamily: inter, fontWeight: 600, fontSize: 12.5, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
        >
          <Trophy size={14} /> Leaderboard
        </button>
        <button
          type="button"
          onClick={onViewProfile}
          disabled={!nameInput.trim()}
          style={{
            flex: 1, padding: '12px 14px', borderRadius: 30, background: 'transparent',
            border: `1.5px solid ${LINE}`, color: nameInput.trim() ? INK : '#C9C9C1',
            fontFamily: inter, fontWeight: 600, fontSize: 12.5,
            cursor: nameInput.trim() ? 'pointer' : 'not-allowed',
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          }}
        >
          <User size={14} /> Profile
        </button>
      </div>

      <div style={{ marginTop: 22, borderTop: `1px solid ${LINE}`, paddingTop: 16 }}>
        <div style={{ fontFamily: inter, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: SUB, marginBottom: 10 }}>
          This week's top 3 · {difficulty}
        </div>
        {previewLoading && (
          <div style={{ fontFamily: inter, fontSize: 13, color: SUB }}>Loading…</div>
        )}
        {!previewLoading && preview.length === 0 && (
          <div style={{ fontFamily: inter, fontSize: 13, color: SUB }}>No one's played yet — be the first.</div>
        )}
        {!previewLoading && preview.map((p, i) => (
          <div key={p.name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontFamily: barlow, fontWeight: 800, fontSize: 15, color: SUB, width: 16 }}>{i + 1}</span>
              <span style={{ fontFamily: inter, fontSize: 14, color: INK, fontWeight: 500 }}>{p.name}</span>
            </div>
            <span style={{ fontFamily: inter, fontSize: 13, color: SUB }}>{p.weeklyPts} pts</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   LEADERBOARD SCREEN
----------------------------------------------------------------- */
function LeaderboardScreen({ rawRows, loading, currentName, initialTab, onBack }) {
  const [tab, setTab] = useState(initialTab || 'MEDIUM');
  const sorted = rawRows
    .map((r) => computeStats(r, tab))
    .filter((s) => s.played > 0)
    .sort((a, b) => b.weeklyPts - a.weeklyPts);

  return (
    <div style={{ width: '100%', maxWidth: 420, background: CARD, border: `1.5px solid ${INK}`, borderRadius: 10, padding: '20px 20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}>
        <button type="button" onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 4 }}>
          <ChevronLeft size={20} color={INK} />
        </button>
        <div style={{ fontFamily: barlow, fontWeight: 800, fontSize: 24, textTransform: 'uppercase' }}>Leaderboard</div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {DIFFICULTIES.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setTab(d)}
            style={{
              flex: 1, padding: '7px 0', borderRadius: 20, cursor: 'pointer',
              border: `1.5px solid ${tab === d ? INK : LINE}`,
              background: tab === d ? INK : 'transparent',
              color: tab === d ? '#FFF' : INK,
              fontFamily: inter, fontWeight: 600, fontSize: 9.5,
            }}
          >
            {d}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', fontFamily: inter, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: SUB, padding: '0 4px 8px', borderBottom: `1px solid ${LINE}`, marginBottom: 4 }}>
        <div style={{ flex: 2 }}>Player</div>
        <div style={{ flex: 1, textAlign: 'right' }}>Today</div>
        <div style={{ flex: 1, textAlign: 'right' }}>Week</div>
        <div style={{ flex: 1, textAlign: 'right' }}>Avg</div>
        <div style={{ flex: 1, textAlign: 'right' }}>Streak</div>
      </div>

      {loading && <div style={{ fontFamily: inter, fontSize: 13, color: SUB, padding: '16px 4px' }}>Loading leaderboard…</div>}
      {!loading && sorted.length === 0 && (
        <div style={{ fontFamily: inter, fontSize: 13, color: SUB, padding: '16px 4px' }}>No {tab.toLowerCase()} results yet. Play that tier to get on the board.</div>
      )}
      {!loading && sorted.map((p, i) => {
        const isMe = currentName && p.name.trim().toLowerCase() === currentName.trim().toLowerCase();
        return (
          <div
            key={p.name}
            style={{
              display: 'flex', alignItems: 'center', padding: '10px 4px',
              background: isMe ? '#F0F5FB' : 'transparent',
              borderRadius: 6,
              fontFamily: inter, fontSize: 13.5,
            }}
          >
            <div style={{ flex: 2, display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span style={{ fontFamily: barlow, fontWeight: 800, fontSize: 14, color: SUB, width: 16, flexShrink: 0 }}>{i + 1}</span>
              <span style={{ fontWeight: isMe ? 700 : 500, color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
            </div>
            <div style={{ flex: 1, textAlign: 'right', color: SUB }}>{p.dailyPts}</div>
            <div style={{ flex: 1, textAlign: 'right', color: INK, fontWeight: 600 }}>{p.weeklyPts}</div>
            <div style={{ flex: 1, textAlign: 'right', color: SUB }}>{p.avg}</div>
            <div style={{ flex: 1, textAlign: 'right', color: SUB, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}>
              <Flame size={11} color={AMBER} /> {p.bestStreak}
            </div>
          </div>
        );
      })}

      <div style={{ marginTop: 16, fontFamily: inter, fontSize: 11, color: '#B4B4AC', textAlign: 'center' }}>
        Week = last 7 days · Avg = points per puzzle played
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------
   PROFILE SCREEN — all-time record for one player, across every
   difficulty tier.
----------------------------------------------------------------- */
function ProfileScreen({ record, loading, onBack }) {
  const stats = computeProfileStats(record);
  const hasPlayed = stats.totalGames > 0;

  return (
    <div style={{ width: '100%', maxWidth: 420, background: CARD, border: `1.5px solid ${INK}`, borderRadius: 10, padding: '20px 20px 24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 18 }}>
        <button type="button" onClick={onBack} style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', padding: 4 }}>
          <ChevronLeft size={20} color={INK} />
        </button>
        <div style={{ fontFamily: barlow, fontWeight: 800, fontSize: 24, textTransform: 'uppercase' }}>Profile</div>
      </div>

      {loading && <div style={{ fontFamily: inter, fontSize: 13, color: SUB, padding: '16px 4px' }}>Loading…</div>}

      {!loading && !hasPlayed && (
        <div style={{ fontFamily: inter, fontSize: 13, color: SUB, padding: '16px 4px' }}>
          No games played yet under this name. Play a puzzle to start building your record.
        </div>
      )}

      {!loading && hasPlayed && (
        <>
          <div style={{ textAlign: 'center', marginBottom: 8 }}>
            <div style={{ fontFamily: barlow, fontWeight: 800, fontSize: 24, textTransform: 'uppercase' }}>{stats.name}</div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'center', gap: 24, margin: '18px 0 22px', flexWrap: 'wrap' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: barlow, fontWeight: 800, fontSize: 26 }}>{stats.allTimePoints}</div>
              <div style={{ fontFamily: inter, fontSize: 11, color: SUB }}>all-time pts</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontFamily: barlow, fontWeight: 800, fontSize: 26 }}>{stats.daysPlayed}</div>
              <div style={{ fontFamily: inter, fontSize: 11, color: SUB }}>days played</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                <Flame size={18} color={stats.dayStreak > 0 ? AMBER : '#C9C9C1'} strokeWidth={2.5} />
                <span style={{ fontFamily: barlow, fontWeight: 800, fontSize: 26 }}>{stats.dayStreak}</span>
              </div>
              <div style={{ fontFamily: inter, fontSize: 11, color: SUB }}>day streak</div>
            </div>
          </div>

          {stats.bestDifficulty && (
            <div style={{ textAlign: 'center', marginBottom: 20, padding: '10px 14px', borderRadius: 8, background: GREEN_BG, border: `1px solid ${GREEN}40` }}>
              <span style={{ fontFamily: inter, fontSize: 12.5, color: INK }}>
                Best category: <strong>{stats.bestDifficulty}</strong> ({stats.perDifficulty[stats.bestDifficulty].avgPoints} avg pts)
              </span>
            </div>
          )}

          <div style={{ fontFamily: inter, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: SUB, marginBottom: 8 }}>
            By difficulty
          </div>
          <div style={{ display: 'flex', fontFamily: inter, fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase', color: SUB, padding: '0 4px 8px', borderBottom: `1px solid ${LINE}`, marginBottom: 4 }}>
            <div style={{ flex: 1.6 }}>Tier</div>
            <div style={{ flex: 1, textAlign: 'right' }}>Played</div>
            <div style={{ flex: 1, textAlign: 'right' }}>Avg</div>
            <div style={{ flex: 1, textAlign: 'right' }}>Streak</div>
          </div>
          {DIFFICULTIES.map((d) => {
            const s = stats.perDifficulty[d];
            const isBest = d === stats.bestDifficulty;
            return (
              <div
                key={d}
                style={{
                  display: 'flex', alignItems: 'center', padding: '9px 4px',
                  background: isBest ? '#F0F5FB' : 'transparent',
                  borderRadius: 6, fontFamily: inter, fontSize: 13,
                  opacity: s.played === 0 ? 0.45 : 1,
                }}
              >
                <div style={{ flex: 1.6, fontWeight: isBest ? 700 : 500, color: INK }}>{d}</div>
                <div style={{ flex: 1, textAlign: 'right', color: SUB }}>{s.played}</div>
                <div style={{ flex: 1, textAlign: 'right', color: INK, fontWeight: 600 }}>{s.avgPoints}</div>
                <div style={{ flex: 1, textAlign: 'right', color: SUB, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3 }}>
                  <Flame size={11} color={AMBER} /> {s.bestStreak}
                </div>
              </div>
            );
          })}

          <div style={{ marginTop: 16, fontFamily: inter, fontSize: 11, color: '#B4B4AC', textAlign: 'center' }}>
            Day streak = consecutive calendar days with at least one puzzle played
          </div>
        </>
      )}
    </div>
  );
}

const EMPTY_FIELDS = {
  team: { status: 'pending', answer: '', firstTry: false },
  nickname: { status: 'pending', answer: '', firstTry: false },
  league: { status: 'pending', answer: '', firstTry: false },
};
const EMPTY_ATTEMPTS = { team: 0, nickname: 0, league: 0 };

export default function LogoDaily() {
  const [view, setView] = useState('start'); // 'start' | 'leaderboard' | 'playing' | 'profile'
  const [nameInput, setNameInput] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [difficulty, setDifficulty] = useState('MEDIUM');
  const [activeDifficulty, setActiveDifficulty] = useState('MEDIUM'); // locked in for the puzzle in progress
  const [lbRawRows, setLbRawRows] = useState([]); // raw {name, entries} per player — filtered per-difficulty at render time
  const [lbLoading, setLbLoading] = useState(true);
  const [playerRecord, setPlayerRecord] = useState({ name: '', entries: [] });
  const [rememberedName, setRememberedName] = useState(''); // the name saved on this device, if any
  const [resultSaved, setResultSaved] = useState(false);

  const [roundIdx, setRoundIdx] = useState(0);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [correctRounds, setCorrectRounds] = useState(0);
  const [roundScored, setRoundScored] = useState(false);
  const [fieldState, setFieldState] = useState(EMPTY_FIELDS);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState([]);
  const [misses, setMisses] = useState(0);
  const [attempts, setAttempts] = useState(EMPTY_ATTEMPTS); // per-field guess count, for the first-try bonus

  const [catalog, setCatalog] = useState([]); // full team pool, all leagues — feeds the typeahead
  const [dailyPuzzle, setDailyPuzzle] = useState(null); // today's { EASY, MEDIUM, HARD, EXPERT, SICKO }
  const [puzzleFailed, setPuzzleFailed] = useState(false);

  const rounds = dailyPuzzle?.[activeDifficulty] || [];
  const round = rounds[roundIdx];
  const multiplier = multiplierFor(streak);
  const isLastRound = roundIdx === rounds.length - 1;
  const roundOver = misses >= MAX_MISSES;

  const fieldOptions = useMemo(() => ({
    team: [...new Set(catalog.map((t) => t.team))],
    nickname: [...new Set(catalog.map((t) => t.nickname))],
    league: [...new Set(catalog.map((t) => t.league))],
  }), [catalog]);

  // Remember the player's name between visits + preload the leaderboard +
  // fetch the team catalog and today's puzzle.
  useEffect(() => {
    try {
      const saved = localStorage.getItem(NAME_KEY);
      if (saved) {
        setNameInput(saved);
        setRememberedName(saved);
      }
    } catch (e) { /* localStorage unavailable (private browsing etc) — fine, just won't remember */ }
    refreshLeaderboard();

    fetch(`${DATA_BASE}/catalog.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setCatalog)
      .catch(() => setCatalog([]));

    fetch(`${DATA_BASE}/daily-puzzle-${todayISO()}.json`)
      .then((r) => { if (!r.ok) throw new Error('puzzle not found'); return r.json(); })
      .then(setDailyPuzzle)
      .catch(() => setPuzzleFailed(true));
  }, []);

  // Look up this player's own record whenever their name settles, so we know
  // which difficulties they've already played today.
  useEffect(() => {
    const name = nameInput.trim();
    if (!name) { setPlayerRecord({ name: '', entries: [] }); return; }
    const t = setTimeout(async () => {
      const rec = await loadPlayerRecord(name);
      setPlayerRecord(rec);
    }, 350);
    return () => clearTimeout(t);
  }, [nameInput]);

  const playedToday = useMemo(() => {
    const today = todayISO();
    return new Set((playerRecord.entries || []).filter((e) => e.date === today).map((e) => e.difficulty));
  }, [playerRecord]);

  // Name rules: must be "First L" format, and must be unique on the leaderboard
  // unless it's the name already remembered on this device (a returning player).
  const trimmedName = nameInput.trim();
  const formatValid = trimmedName === '' || isValidNameFormat(trimmedName);
  const isOwnRememberedName = rememberedName && slugify(trimmedName) === slugify(rememberedName);
  const nameTaken = !isOwnRememberedName && lbRawRows.some((r) => slugify(r.name) === slugify(trimmedName) && trimmedName !== '');
  const nameError = trimmedName === '' ? ''
    : !formatValid ? 'Use first name + last initial, e.g. "Liam M"'
    : nameTaken ? 'That name is taken — try a different last initial'
    : '';

  const refreshLeaderboard = async () => {
    setLbLoading(true);
    const rows = await loadLeaderboard();
    setLbRawRows(rows);
    setLbLoading(false);
  };

  const pointsFor = (field, quality, firstTry) => {
    const base = field === 'league'
      ? (quality === 'full' ? LEAGUE_BONUS : 0)
      : (quality === 'full' ? Math.round(FULL_POINTS[field] * multiplier) : 0);
    return base + (quality === 'full' && firstTry ? FIRST_TRY_BONUS : 0);
  };

  // Streak only counts a FULL round: Team AND Nickname both correct. Anything less resets it.
  const evaluateStreak = (next) => {
    const teamDone = next.team.status !== 'pending';
    const nickDone = next.nickname.status !== 'pending';
    if (teamDone && nickDone && !roundScored) {
      const bothFull = next.team.status === 'full' && next.nickname.status === 'full';
      setStreak((s) => (bothFull ? s + 1 : 0));
      if (bothFull) setCorrectRounds((c) => c + 1);
      setRoundScored(true);
    }
  };

  // Reveals every still-pending field with its correct answer. Used both when
  // MAX_MISSES is hit, and when the player voluntarily gives up on a logo.
  const revealAndEndRound = () => {
    setFieldState((prev) => {
      const next = { ...prev };
      ['team', 'nickname', 'league'].forEach((f) => {
        if (next[f].status === 'pending') next[f] = { status: 'wrong', answer: round[f] };
      });
      evaluateStreak(next);
      return next;
    });
  };

  const handleSubmit = (field, quality, correctVal) => {
    const attemptNumber = attempts[field] + 1;
    setAttempts((a) => ({ ...a, [field]: attemptNumber }));

    if (quality === 'full') {
      const firstTry = attemptNumber === 1;
      setFieldState((prev) => {
        const next = { ...prev, [field]: { status: 'full', answer: correctVal, firstTry } };
        evaluateStreak(next);
        return next;
      });
      const pts = pointsFor(field, 'full', firstTry);
      if (pts > 0) setScore((s) => s + pts);
    } else {
      setMisses((m) => {
        const nm = m + 1;
        if (nm >= MAX_MISSES) revealAndEndRound();
        return nm;
      });
    }
  };

  const handleSkip = (field) => {
    setFieldState((prev) => {
      const next = { ...prev, [field]: { status: 'skipped', answer: '' } };
      evaluateStreak(next);
      return next;
    });
  };

  const roundDone = fieldState.team.status !== 'pending' && fieldState.nickname.status !== 'pending';

  // Keep a running per-round recap for the results grid + share text.
  useEffect(() => {
    if (!roundDone) return;
    setHistory((h) => {
      const copy = [...h];
      copy[roundIdx] = { team: fieldState.team.status, nickname: fieldState.nickname.status, league: fieldState.league.status };
      return copy;
    });
  }, [fieldState, roundIdx, roundDone]);

  const nextRound = () => {
    if (isLastRound) return;
    if (misses === 0) setScore((s) => s + CLEAN_SHEET_BONUS);
    setRoundIdx((i) => i + 1);
    setFieldState(EMPTY_FIELDS);
    setRoundScored(false);
    setMisses(0);
    setAttempts(EMPTY_ATTEMPTS);
  };

  const resetGame = () => {
    setRoundIdx(0);
    setScore(0);
    setStreak(0);
    setCorrectRounds(0);
    setFieldState(EMPTY_FIELDS);
    setRoundScored(false);
    setCopied(false);
    setHistory([]);
    setMisses(0);
    setAttempts(EMPTY_ATTEMPTS);
    setResultSaved(false);
  };

  const roundPts = ['team', 'nickname', 'league'].reduce((sum, f) => {
    if (fieldState[f].status !== 'full') return sum;
    return sum + pointsFor(f, 'full', fieldState[f].firstTry);
  }, 0) + (misses === 0 ? CLEAN_SHEET_BONUS : 0);

  const rank = rankFor(correctRounds, rounds.length);

  // Save the result to the shared leaderboard once, right when the puzzle completes.
  useEffect(() => {
    if (view === 'playing' && isLastRound && roundDone && !resultSaved) {
      setResultSaved(true);
      const finalScore = misses === 0 ? score + CLEAN_SHEET_BONUS : score;
      if (misses === 0) setScore(finalScore);
      const entry = { date: todayISO(), points: finalScore, streak, correctRounds, difficulty: activeDifficulty };
      savePlayerResult(playerName, entry).then(async () => {
        refreshLeaderboard();
        setPlayerRecord(await loadPlayerRecord(playerName));
      });
    }
  }, [view, isLastRound, roundDone, resultSaved]);

  const copyResults = () => {
    const text = buildShareText(history, score, rank, PUZZLE_NO);
    if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const handleStart = async () => {
    const name = nameInput.trim();
    if (!name || nameError || playedToday.has(difficulty)) return;
    setPlayerName(name);
    setActiveDifficulty(difficulty);
    try { localStorage.setItem(NAME_KEY, name); } catch (e) { /* private browsing etc — fine */ }
    resetGame();
    setView('playing');
  };

  return (
    <div style={{ minHeight: '100vh', background: PAGE, color: INK, fontFamily: inter, display: 'flex', justifyContent: 'center', padding: '32px 16px' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Semi+Condensed:wght@700;800&family=Inter:wght@400;500;600;700&display=swap');
        * { box-sizing: border-box; }
        @keyframes fieldShake {
          0%, 100% { transform: translateX(0); }
          20% { transform: translateX(-6px); }
          40% { transform: translateX(5px); }
          60% { transform: translateX(-4px); }
          80% { transform: translateX(3px); }
        }
        .field-shake-host:not(:focus-within) {}
      `}</style>

      {view === 'start' && (
        <StartScreen
          nameInput={nameInput}
          setNameInput={setNameInput}
          nameError={nameError}
          rememberedName={rememberedName}
          difficulty={difficulty}
          setDifficulty={setDifficulty}
          playedToday={playedToday}
          puzzleReady={!!dailyPuzzle}
          puzzleFailed={puzzleFailed}
          onStart={handleStart}
          onViewLeaderboard={() => setView('leaderboard')}
          onViewProfile={() => setView('profile')}
          preview={[...lbRawRows].map((r) => computeStats(r, difficulty)).filter((s) => s.played > 0).sort((a, b) => b.weeklyPts - a.weeklyPts).slice(0, 3)}
          previewLoading={lbLoading}
        />
      )}

      {view === 'profile' && (
        <ProfileScreen record={playerRecord} loading={false} onBack={() => setView('start')} />
      )}

      {view === 'leaderboard' && (
        <LeaderboardScreen rawRows={lbRawRows} loading={lbLoading} currentName={playerName || nameInput} initialTab={difficulty} onBack={() => setView('start')} />
      )}

      {view === 'playing' && (
        <div style={{ width: '100%', maxWidth: 420, background: CARD, border: `1.5px solid ${INK}`, borderRadius: 10, padding: '28px 24px 24px' }}>
          {/* back to home */}
          <button
            type="button"
            onClick={() => { resetGame(); setView('start'); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, padding: 4, marginBottom: 4, color: SUB, fontFamily: inter, fontSize: 12, fontWeight: 600 }}
          >
            <ChevronLeft size={16} /> Home
          </button>

          {/* masthead */}
          <div style={{ textAlign: 'center', marginBottom: 18 }}>
            <div style={{ fontFamily: inter, fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: SUB, marginBottom: 6 }}>
              {formatDateLong(todayISO())} · No. {PUZZLE_NO} · {playerName} · {activeDifficulty}
            </div>
            <div style={{ fontFamily: barlow, fontWeight: 800, fontSize: 32, letterSpacing: '-0.01em', textTransform: 'uppercase' }}>
              Logos for Breakfast
            </div>
          </div>
          <div style={{ height: 1, background: INK, marginBottom: 18 }} />

          {/* status row */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Flame size={15} color={streak > 0 ? AMBER : '#C9C9C1'} strokeWidth={2.5} />
              <span style={{ fontFamily: inter, fontSize: 13, fontWeight: 600, color: streak > 0 ? INK : SUB }}>
                {streak} streak
              </span>
              {multiplier > 1 && (
                <span style={{ fontFamily: inter, fontSize: 12, fontWeight: 600, color: BLUE, background: '#6E9BC714', padding: '2px 7px', borderRadius: 20, marginLeft: 4 }}>
                  {multiplier.toFixed(1)}×
                </span>
              )}
            </div>
            <div style={{ fontFamily: inter, fontSize: 13, color: SUB }}>
              Round {roundIdx + 1}/{rounds.length} · <strong style={{ color: INK }}>{score} pts</strong>
            </div>
          </div>

          {/* misses row */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 20 }}>
            {Array.from({ length: MAX_MISSES }).map((_, i) => (
              <div key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: i < misses ? RED : GREEN }} />
            ))}
            <span style={{ fontFamily: inter, fontSize: 11.5, color: SUB, marginLeft: 2 }}>
              {roundOver ? 'Round over — out of guesses' : `${MAX_MISSES - misses} guess${MAX_MISSES - misses === 1 ? '' : 'es'} left`}
            </span>
          </div>

          {/* progress dots */}
          <div style={{ display: 'flex', gap: 5, marginBottom: 24 }}>
            {rounds.map((_, i) => (
              <div key={i} style={{ flex: 1, height: 4, borderRadius: 2, background: i < roundIdx ? GREEN : i === roundIdx ? INK : LINE }} />
            ))}
          </div>

          {/* crest */}
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 24 }}>
            <Crest round={round} />
          </div>

          {/* fields */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {['team', 'nickname', 'league'].map((f) => (
              <TypeaheadField
                key={f + roundIdx}
                field={f}
                round={round}
                status={fieldState[f].status}
                answer={fieldState[f].answer}
                firstTry={fieldState[f].firstTry}
                essential={f !== 'league'}
                options={fieldOptions[f]}
                onSubmit={handleSubmit}
                onSkip={handleSkip}
              />
            ))}
          </div>

          {!roundDone && (
            <div style={{ textAlign: 'center', marginTop: 16 }}>
              <button
                type="button"
                onClick={revealAndEndRound}
                style={{ background: 'none', border: 'none', color: SUB, fontFamily: inter, fontSize: 12.5, cursor: 'pointer', textDecoration: 'underline' }}
              >
                I don't know this one — reveal &amp; move on
              </button>
            </div>
          )}

          <div style={{ marginTop: 24 }}>
            {roundDone && !isLastRound && (
              <>
                {misses === 0 && (
                  <div style={{ textAlign: 'center', fontFamily: inter, fontSize: 11.5, fontWeight: 600, color: GREEN, marginBottom: 8 }}>
                    Clean sheet — no misses · +{CLEAN_SHEET_BONUS}
                  </div>
                )}
                <button
                  type="button"
                  onClick={nextRound}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 20px', borderRadius: 30, background: INK, border: 'none', cursor: 'pointer' }}
                >
                  <span style={{ fontFamily: inter, fontWeight: 600, fontSize: 14, color: '#FFF' }}>
                    +{roundPts} this round · Next
                  </span>
                  <ArrowRight size={16} color="#FFF" strokeWidth={2.5} />
                </button>
              </>
            )}

            {roundDone && isLastRound && (
              <div>
                <div style={{ height: 1, background: LINE, margin: '4px 0 20px' }} />

                <div style={{ textAlign: 'center', marginBottom: 20 }}>
                  <div style={{ fontFamily: inter, fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: SUB, marginBottom: 10 }}>
                    Puzzle complete
                  </div>
                  <div style={{ fontFamily: barlow, fontWeight: 800, fontSize: 44, letterSpacing: '-0.01em', textTransform: 'uppercase', color: INK, lineHeight: 1 }}>
                    {rank.title}
                  </div>
                  <div style={{ fontFamily: inter, fontSize: 13, color: SUB, marginTop: 6 }}>
                    {rank.note}
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'center', gap: 28, marginBottom: 22 }}>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontFamily: barlow, fontWeight: 800, fontSize: 30 }}>{score}</div>
                    <div style={{ fontFamily: inter, fontSize: 11, color: SUB }}>points</div>
                  </div>
                  <div style={{ width: 1, background: LINE }} />
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontFamily: barlow, fontWeight: 800, fontSize: 30 }}>{correctRounds}/{rounds.length}</div>
                    <div style={{ fontFamily: inter, fontSize: 11, color: SUB }}>full logos</div>
                  </div>
                  <div style={{ width: 1, background: LINE }} />
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontFamily: barlow, fontWeight: 800, fontSize: 30 }}>{streak}</div>
                    <div style={{ fontFamily: inter, fontSize: 11, color: SUB }}>best streak</div>
                  </div>
                </div>

                <div style={{ marginBottom: 22 }}>
                  <div style={{ fontFamily: inter, fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: SUB, marginBottom: 8, textAlign: 'center' }}>
                    Today's sheet
                  </div>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                    {rounds.map((r, i) => {
                      const h = history[i] || {};
                      const bothFull = h.team === 'full' && h.nickname === 'full';
                      const oneFull = h.team === 'full' || h.nickname === 'full';
                      const tileBg = bothFull ? GREEN_BG : oneFull ? '#FCF3E3' : RED_BG;
                      const tileBorder = bothFull ? GREEN : oneFull ? AMBER : RED;
                      return (
                        <div
                          key={i}
                          title={`${r.team} ${r.nickname}`}
                          style={{ width: 44, height: 44, borderRadius: 6, background: tileBg, border: `1.5px solid ${tileBorder}`, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}
                        >
                          <img src={r.logo.url} alt="" referrerPolicy="no-referrer" style={{ width: 26, height: 26, objectFit: 'contain' }} />
                          {h.league === 'full' && (
                            <div style={{ position: 'absolute', top: -3, right: -3, width: 9, height: 9, borderRadius: '50%', background: BLUE, border: `1.5px solid ${CARD}` }} />
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, marginBottom: 10 }}>
                  <button
                    onClick={copyResults}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '12px 16px', borderRadius: 30, background: INK, border: 'none', cursor: 'pointer' }}
                  >
                    <Share2 size={14} color="#FFF" />
                    <span style={{ fontFamily: inter, fontWeight: 600, fontSize: 13, color: '#FFF' }}>
                      {copied ? 'Copied!' : 'Share results'}
                    </span>
                  </button>
                  <button
                    onClick={resetGame}
                    style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '12px 16px', borderRadius: 30, background: 'transparent', border: `1.5px solid ${LINE}`, color: INK, fontFamily: inter, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                  >
                    <RotateCcw size={13} /> Replay
                  </button>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                  <button
                    type="button"
                    onClick={() => setView('leaderboard')}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '12px 16px', borderRadius: 30, background: 'transparent', border: 'none', color: SUB, fontFamily: inter, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                  >
                    <Trophy size={13} /> Leaderboard
                  </button>
                  <button
                    type="button"
                    onClick={() => setView('profile')}
                    style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '12px 16px', borderRadius: 30, background: 'transparent', border: 'none', color: SUB, fontFamily: inter, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
                  >
                    <User size={13} /> Profile
                  </button>
                </div>

                <div style={{ textAlign: 'center', fontFamily: inter, fontSize: 12, color: SUB }}>
                  New logos tomorrow · No. {PUZZLE_NO + 1}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
