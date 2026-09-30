/**
 * lib/db/index.ts
 *
 * Data access layer. All SQL lives here; the rest of the app talks in terms of
 * the record types below.
 */

import * as SQLite from 'expo-sqlite';

import type { EmotionClass, MonitorState, PulseSample } from '../rprv/types';
import { CREATE_STATEMENTS } from './schema';

const DB_NAME = 'hv.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

/**
 * Open (and on first call, create) the database.
 *
 * The promise is cached rather than the database handle, so that concurrent
 * callers during startup await the same open+migrate rather than racing to
 * create the schema twice.
 */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync(DB_NAME);
      await db.execAsync(CREATE_STATEMENTS);
      return db;
    })();
  }
  return dbPromise;
}

/** Local date key, YYYY-MM-DD. Used to group a day's monitoring. */
export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Samples
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Insert heart-rate samples.
 *
 * INSERT OR IGNORE against the (at, bpm, source) unique index de-duplicates
 * silently: the same reading legitimately arrives twice when a HealthKit
 * observer push overlaps the poll interval, and counting it twice would
 * distort both the sample count and the entropy estimate.
 */
export async function insertSamples(samples: PulseSample[], source: string): Promise<number> {
  if (samples.length === 0) return 0;
  const db = await getDb();
  let inserted = 0;

  await db.withTransactionAsync(async () => {
    for (const s of samples) {
      const res = await db.runAsync(
        'INSERT OR IGNORE INTO samples (day, at, bpm, source) VALUES (?, ?, ?, ?)',
        dayKey(new Date(s.at)), s.at, s.bpm, source,
      );
      inserted += res.changes;
    }
  });

  return inserted;
}

export async function getSamplesForDay(day: string): Promise<PulseSample[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ at: number; bpm: number }>(
    'SELECT at, bpm FROM samples WHERE day = ? ORDER BY at ASC', day,
  );
  return rows.map((r) => ({ at: r.at, bpm: r.bpm }));
}

/** Samples inside a time range, used for the trailing entropy window. */
export async function getSamplesBetween(from: number, to: number): Promise<PulseSample[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ at: number; bpm: number }>(
    'SELECT at, bpm FROM samples WHERE at >= ? AND at <= ? ORDER BY at ASC', from, to,
  );
  return rows.map((r) => ({ at: r.at, bpm: r.bpm }));
}

/** The most recent sample timestamp overall, for watch-connectivity checks. */
export async function getLatestSampleAt(): Promise<number | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ at: number }>('SELECT MAX(at) AS at FROM samples');
  return row?.at ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sessions
// ─────────────────────────────────────────────────────────────────────────────

export interface SessionRow {
  day: string;
  started_at: number | null;
  ended_at: number | null;
  baseline_entropy: number | null;
  baseline_set_at: number | null;
  max_bpm: number | null;
  max_bpm_at: number | null;
  min_bpm: number | null;
  avg_bpm: number | null;
  sample_count: number;
  dominant_state: MonitorState | null;
  dominant_emotion: EmotionClass | null;
  watch_connected: number;
  summary_sent_at: number | null;
}

export async function ensureSession(day: string, startedAt: number): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT OR IGNORE INTO sessions (day, started_at) VALUES (?, ?)', day, startedAt,
  );
}

export async function getSession(day: string): Promise<SessionRow | null> {
  const db = await getDb();
  return await db.getFirstAsync<SessionRow>('SELECT * FROM sessions WHERE day = ?', day);
}

export async function listSessions(limit = 30): Promise<SessionRow[]> {
  const db = await getDb();
  return await db.getAllAsync<SessionRow>(
    'SELECT * FROM sessions ORDER BY day DESC LIMIT ?', limit,
  );
}

export async function updateSession(day: string, patch: Partial<SessionRow>): Promise<void> {
  const entries = Object.entries(patch).filter(([k]) => k !== 'day');
  if (entries.length === 0) return;
  const db = await getDb();
  const sets = entries.map(([k]) => `${k} = ?`).join(', ');
  await db.runAsync(
    `UPDATE sessions SET ${sets} WHERE day = ?`,
    ...entries.map(([, v]) => v as never), day,
  );
}

/**
 * Recompute a day's aggregate statistics from its raw samples.
 *
 * Derived rather than maintained incrementally, so that a backfill of older
 * samples from the platform store corrects the day's figures instead of
 * leaving a stale maximum behind.
 */
export async function recomputeSessionStats(day: string): Promise<void> {
  const db = await getDb();
  const agg = await db.getFirstAsync<{
    max_bpm: number | null; min_bpm: number | null;
    avg_bpm: number | null; n: number;
  }>(
    'SELECT MAX(bpm) AS max_bpm, MIN(bpm) AS min_bpm, AVG(bpm) AS avg_bpm, COUNT(*) AS n FROM samples WHERE day = ?',
    day,
  );
  if (!agg || agg.n === 0) return;

  const peak = await db.getFirstAsync<{ at: number }>(
    'SELECT at FROM samples WHERE day = ? ORDER BY bpm DESC, at ASC LIMIT 1', day,
  );

  await db.runAsync(
    `UPDATE sessions SET max_bpm = ?, max_bpm_at = ?, min_bpm = ?, avg_bpm = ?, sample_count = ?
     WHERE day = ?`,
    agg.max_bpm, peak?.at ?? null, agg.min_bpm, agg.avg_bpm, agg.n, day,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Windows
// ─────────────────────────────────────────────────────────────────────────────

export interface WindowRow {
  id: number;
  day: string;
  at: number;
  entropy: number | null;
  entropy_ratio: number | null;
  entropy_span_ms: number | null;
  entropy_samples: number | null;
  mean_bpm: number;
  emotion: EmotionClass;
  confidence: number;
  p_stress: number;
  state: MonitorState;
  transitioned: number;
  features_json: string | null;
  trace_json: string | null;
}

export async function insertWindow(row: Omit<WindowRow, 'id'>): Promise<number> {
  const db = await getDb();
  const res = await db.runAsync(
    `INSERT INTO windows
       (day, at, entropy, entropy_ratio, entropy_span_ms, entropy_samples,
        mean_bpm, emotion, confidence, p_stress, state, transitioned,
        features_json, trace_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.day, row.at, row.entropy, row.entropy_ratio, row.entropy_span_ms,
    row.entropy_samples, row.mean_bpm, row.emotion, row.confidence,
    row.p_stress, row.state, row.transitioned, row.features_json, row.trace_json,
  );
  return res.lastInsertRowId;
}

export async function getWindowsForDay(day: string): Promise<WindowRow[]> {
  const db = await getDb();
  return await db.getAllAsync<WindowRow>(
    'SELECT * FROM windows WHERE day = ? ORDER BY at ASC', day,
  );
}

export async function getLatestWindow(): Promise<WindowRow | null> {
  const db = await getDb();
  return await db.getFirstAsync<WindowRow>(
    'SELECT * FROM windows ORDER BY at DESC LIMIT 1',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Episodes, notifications, feedback, check-ins
// ─────────────────────────────────────────────────────────────────────────────

export interface EpisodeRow {
  id: number;
  day: string;
  at: number;
  from_state: MonitorState;
  to_state: MonitorState;
  tier: number;
  emotion: EmotionClass | null;
  mean_bpm: number | null;
  reason: string | null;
  resolved_at: number | null;
}

export async function insertEpisode(row: Omit<EpisodeRow, 'id' | 'resolved_at'>): Promise<number> {
  const db = await getDb();
  const res = await db.runAsync(
    `INSERT INTO episodes (day, at, from_state, to_state, tier, emotion, mean_bpm, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.day, row.at, row.from_state, row.to_state, row.tier,
    row.emotion, row.mean_bpm, row.reason,
  );
  return res.lastInsertRowId;
}

export async function listEpisodes(day: string): Promise<EpisodeRow[]> {
  const db = await getDb();
  return await db.getAllAsync<EpisodeRow>(
    'SELECT * FROM episodes WHERE day = ? ORDER BY at DESC', day,
  );
}

export interface NotificationRow {
  id: number;
  day: string;
  at: number;
  kind: 'tier' | 'daily_summary' | 'checkin' | 'high_bpm';
  tier: number;
  state: MonitorState | null;
  emotion: EmotionClass | null;
  verse_id: string | null;
  episode_id: number | null;
  body: string | null;
}

export async function insertNotification(
  row: Omit<NotificationRow, 'id'>,
): Promise<number> {
  const db = await getDb();
  const res = await db.runAsync(
    `INSERT INTO notifications (day, at, kind, tier, state, emotion, verse_id, episode_id, body)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.day, row.at, row.kind, row.tier, row.state, row.emotion,
    row.verse_id, row.episode_id, row.body,
  );
  return res.lastInsertRowId;
}

export async function listNotifications(limit = 50): Promise<NotificationRow[]> {
  const db = await getDb();
  return await db.getAllAsync<NotificationRow>(
    'SELECT * FROM notifications ORDER BY at DESC LIMIT ?', limit,
  );
}

/** Notifications carrying a verse that the user has not yet rated. */
export async function getUnratedVerseNotifications(limit = 5): Promise<NotificationRow[]> {
  const db = await getDb();
  return await db.getAllAsync<NotificationRow>(
    `SELECT n.* FROM notifications n
     LEFT JOIN verse_feedback f ON f.notification_id = n.id
     WHERE n.verse_id IS NOT NULL AND f.id IS NULL
     ORDER BY n.at DESC LIMIT ?`,
    limit,
  );
}

export async function recordVerseFeedback(
  notificationId: number | null,
  verseId: string,
  helpful: boolean,
  state: MonitorState | null,
  emotion: EmotionClass | null,
  note?: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT INTO verse_feedback (notification_id, verse_id, state, emotion, helpful, note, at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    notificationId, verseId, state, emotion, helpful ? 1 : 0, note ?? null, Date.now(),
  );
}

export interface VerseEffectiveness {
  verse_id: string;
  shown: number;
  helpful: number;
  rate: number;
}

/**
 * Per-verse helpfulness, the answer to "did the verse help this user".
 *
 * Only rated deliveries are counted. A verse shown ten times and rated once is
 * reported as one sample, not as a 10% helpfulness rate — silence is not a
 * negative rating.
 */
export async function getVerseEffectiveness(): Promise<VerseEffectiveness[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ verse_id: string; shown: number; helpful: number }>(
    `SELECT verse_id,
            COUNT(*) AS shown,
            SUM(helpful) AS helpful
     FROM verse_feedback
     GROUP BY verse_id
     ORDER BY shown DESC`,
  );
  return rows.map((r) => ({
    verse_id: r.verse_id,
    shown: r.shown,
    helpful: r.helpful ?? 0,
    rate: r.shown > 0 ? (r.helpful ?? 0) / r.shown : 0,
  }));
}

/**
 * Counts of verses the user marked helpful since `sinceMs`.
 *
 * Returned per VERSE; the caller maps them onto themes, because the
 * recommender scores themes but the user rates individual verses.
 */
export async function getVerseEngagement(sinceMs: number): Promise<Record<string, number>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ verse_id: string; n: number }>(
    `SELECT verse_id, COUNT(*) AS n FROM verse_feedback
     WHERE helpful = 1 AND at >= ? GROUP BY verse_id`, sinceMs,
  );
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.verse_id] = r.n;
  return counts;
}

export interface CheckinRow {
  id: number;
  episode_id: number | null;
  asked_at: number;
  answered_at: number | null;
  response: 'ok' | 'not_ok' | 'needed_help' | null;
  note: string | null;
}

export async function insertCheckin(episodeId: number | null, askedAt: number): Promise<number> {
  const db = await getDb();
  const res = await db.runAsync(
    'INSERT INTO checkins (episode_id, asked_at) VALUES (?, ?)', episodeId, askedAt,
  );
  return res.lastInsertRowId;
}

export async function answerCheckin(
  id: number,
  response: 'ok' | 'not_ok' | 'needed_help',
  note?: string,
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'UPDATE checkins SET answered_at = ?, response = ?, note = ? WHERE id = ?',
    Date.now(), response, note ?? null, id,
  );
}

export async function getPendingCheckin(): Promise<CheckinRow | null> {
  const db = await getDb();
  return await db.getFirstAsync<CheckinRow>(
    'SELECT * FROM checkins WHERE answered_at IS NULL ORDER BY asked_at DESC LIMIT 1',
  );
}

export async function listCheckins(limit = 30): Promise<CheckinRow[]> {
  const db = await getDb();
  return await db.getAllAsync<CheckinRow>(
    'SELECT * FROM checkins ORDER BY asked_at DESC LIMIT ?', limit,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Contacts and settings
// ─────────────────────────────────────────────────────────────────────────────

export interface ContactRow { id: number; name: string; phone: string }

export async function listContacts(): Promise<ContactRow[]> {
  const db = await getDb();
  return await db.getAllAsync<ContactRow>('SELECT * FROM contacts ORDER BY id ASC');
}

export async function addContact(name: string, phone: string): Promise<number> {
  const db = await getDb();
  const res = await db.runAsync(
    'INSERT INTO contacts (name, phone) VALUES (?, ?)', name, phone,
  );
  return res.lastInsertRowId;
}

export async function deleteContact(id: number): Promise<void> {
  const db = await getDb();
  await db.runAsync('DELETE FROM contacts WHERE id = ?', id);
}

export async function getSetting(key: string): Promise<string | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ value: string }>(
    'SELECT value FROM settings WHERE key = ?', key,
  );
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?',
    key, value, value,
  );
}
