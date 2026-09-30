/**
 * lib/settings.ts
 *
 * Typed access to user-configurable settings, backed by the settings table.
 *
 * Thresholds are per-user by design. The client's brief is explicit that what
 * counts as an emergency "depende sa condition ng user" — a resting athlete
 * and someone with a cardiac condition do not share a threshold — so 120 bpm
 * is a default, not a constant.
 */

import { getSetting, setSetting } from './db';
import { DEFAULT_EMERGENCY_BPM, DEFAULT_WARN_BPM } from './rprv/fsm';

export interface AppSettings {
  /** Absolute heart rate that raises a warning notification (bpm). */
  warnBpm: number;
  /** Absolute heart rate treated as an emergency (bpm). */
  emergencyBpm: number;
  /** Hour the daily collection window opens (local, 0-23). */
  collectionStartHour: number;
  /** Hour the daily collection window closes (local, 0-23). */
  collectionEndHour: number;
  /** Hour the daily summary is delivered. */
  summaryHour: number;
  /** Minute the daily summary is delivered. */
  summaryMinute: number;
  /** Hour the morning baseline segment ends (local, 0-23). */
  baselineEndHour: number;
  /** Whether to text emergency contacts on a Level 3 alert. */
  alertContacts: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  warnBpm: DEFAULT_WARN_BPM,
  emergencyBpm: DEFAULT_EMERGENCY_BPM,
  // The client's brief: record through the working day, 8 AM to 5 PM.
  collectionStartHour: 8,
  collectionEndHour: 17,
  // "on 5:01pm there must be a notification of the bible verse".
  summaryHour: 17,
  summaryMinute: 1,
  // The morning segment used to establish the day's personalised baseline.
  baselineEndHour: 12,
  alertContacts: true,
};

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof AppSettings)[];

export async function loadSettings(): Promise<AppSettings> {
  const settings = { ...DEFAULT_SETTINGS };

  await Promise.all(
    KEYS.map(async (key) => {
      const raw = await getSetting(key);
      if (raw === null) return;
      const fallback = DEFAULT_SETTINGS[key];
      if (typeof fallback === 'boolean') {
        (settings[key] as boolean) = raw === 'true';
      } else {
        const n = Number(raw);
        // A corrupted row must not silently disable the safety thresholds.
        if (Number.isFinite(n)) (settings[key] as number) = n;
      }
    }),
  );

  // The emergency threshold sitting at or below the warning threshold would
  // make the warning unreachable, since the emergency rule is evaluated first.
  if (settings.emergencyBpm <= settings.warnBpm) {
    settings.emergencyBpm = settings.warnBpm + 20;
  }

  return settings;
}

export async function saveSetting<K extends keyof AppSettings>(
  key: K,
  value: AppSettings[K],
): Promise<void> {
  await setSetting(key, String(value));
}

/** True when `date` falls inside the configured daily collection window. */
export function isInCollectionWindow(s: AppSettings, date: Date = new Date()): boolean {
  const hour = date.getHours();
  return hour >= s.collectionStartHour && hour < s.collectionEndHour;
}

/** True when `date` falls in the morning baseline segment. */
export function isInBaselineWindow(s: AppSettings, date: Date = new Date()): boolean {
  const hour = date.getHours();
  return hour >= s.collectionStartHour && hour < s.baselineEndHour;
}
