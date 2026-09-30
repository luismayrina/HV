/**
 * lib/monitoring/engine.ts
 *
 * The monitoring orchestrator. One tick of this function is one pass of the
 * study's pseudocode:
 *
 *   every window:
 *     E_win = SWIBSEA(pulse_intervals)
 *     [class, P_stress] = RandomForest(features)
 *     switch (state): ...
 *
 * On top of that it owns the parts the study leaves to the implementation:
 * establishing the day's baseline from the morning segment, deciding whether
 * the watch is actually connected, persisting the audit trail, and keeping the
 * 5:01 PM summary up to date.
 */

import { extractFeatures } from '../rprv/features';
import { estimateEntropy, computeBaseline, slidingEntropy, thresholdsFor } from '../rprv/swibsea';
import type { EntropyEstimate, EntropyThresholds } from '../rprv/swibsea';
import { classify } from '../rprv/randomForest';
import type { Classification, RandomForestModel } from '../rprv/randomForest';
import { initialContext, step } from '../rprv/fsm';
import type { FsmContext, FsmResult } from '../rprv/fsm';
import modelJson from '../rprv/model.json';
import type { EmotionClass, FeatureVector, MonitorState, PulseSample } from '../rprv/types';

import { recommend, recommendForDailySummary } from '../verses/recommender';
import type { Recommendation } from '../verses/recommender';
import { VERSE_BY_ID } from '../verses/corpus';

import {
  dayKey, ensureSession, getSamplesBetween, getSamplesForDay, getSession,
  getVerseEngagement, getWindowsForDay, insertEpisode, insertSamples, insertWindow,
  listNotifications, recomputeSessionStats, updateSession, getSetting, setSetting,
} from '../db';
import { loadSettings, isInBaselineWindow, isInCollectionWindow } from '../settings';
import type { AppSettings } from '../settings';
import {
  presentHighBpmWarning, presentTierNotification, scheduleDailySummary,
  scheduleWellbeingCheckin,
} from '../notifications';
import { dispatchEmergencySms } from '../notifications/emergency';

export const MODEL = modelJson as unknown as RandomForestModel;

/** How often the FSM is evaluated. The study's cadence: 30 s at 50% overlap. */
export const TICK_INTERVAL_MS = 30_000;

/**
 * A sample older than this means the watch is not currently feeding the
 * platform store. Generous, because Health Connect sync is bursty: a watch
 * that is worn and paired can still go several minutes between writes.
 */
export const WATCH_CONNECTED_WINDOW_MS = 10 * 60_000;

/** Minimum gap between repeated high-heart-rate warnings. */
export const HIGH_BPM_WARNING_COOLDOWN_MS = 15 * 60_000;

const FSM_CONTEXT_KEY = 'fsm_context';
const LAST_WARN_KEY = 'last_high_bpm_warning_at';

export interface TickResult {
  at: number;
  /** Null when the window held too few samples to analyse. */
  features: FeatureVector | null;
  entropy: EntropyEstimate;
  classification: Classification | null;
  fsm: FsmResult | null;
  /** The verse selected, when a transition produced a notification. */
  recommendation: Recommendation | null;
  baseline: number | null;
  thresholds: EntropyThresholds | null;
  /** True when watch data has reached the platform store recently. */
  watchConnected: boolean;
  inCollectionWindow: boolean;
  /** Set when the tick did no analysis, explaining why. */
  skipped: string | null;
  settings: AppSettings;
  /** Samples considered by this tick. */
  sampleCount: number;
}

/** Persisted FSM context, so a restart does not reset the machine. */
async function loadFsmContext(now: number): Promise<FsmContext> {
  const raw = await getSetting(FSM_CONTEXT_KEY);
  if (!raw) return initialContext(now);
  try {
    const parsed = JSON.parse(raw) as FsmContext;
    // A context from a previous day is not meaningful: the baseline it was
    // evaluated against is gone, and a stale ACUTE would resurface on launch.
    if (now - parsed.enteredAt > 12 * 60 * 60_000) return initialContext(now);
    return parsed;
  } catch {
    return initialContext(now);
  }
}

async function saveFsmContext(ctx: FsmContext): Promise<void> {
  await setSetting(FSM_CONTEXT_KEY, JSON.stringify(ctx));
}

/** Record a new reading from the health platform. */
export async function ingestSample(
  bpm: number, at: Date, source: string,
): Promise<void> {
  await insertSamples([{ bpm, at: at.getTime() }], source);
}

/**
 * Estimate how long the user has been inactive.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * This is a PROXY, not a measurement. The study's situational rules use
 * inactivity duration, but a phone reading Health Connect or HealthKit has no
 * reliable live signal for "the user is sitting still" — step counts arrive in
 * aggregated buckets, often minutes late.
 *
 * We infer it from the pulse itself: the user is treated as active whenever
 * heart rate rises meaningfully above their own resting level for the day, and
 * inactivity is the time since that last happened. This tracks real activity
 * reasonably well for exercise, and poorly for quiet movement like walking
 * around a room. It is used only to bias verse selection, never to trigger an
 * alert, so an error here changes which verse appears and nothing more.
 * ───────────────────────────────────────────────────────────────────────────
 */
export function estimateInactivityMinutes(
  daySamples: PulseSample[],
  now: number,
): number {
  if (daySamples.length === 0) return 0;

  const bpms = [...daySamples.map((s) => s.bpm)].sort((a, b) => a - b);
  // The 10th percentile approximates the day's resting rate without being
  // hostage to a single artefactually low reading.
  const resting = bpms[Math.floor(bpms.length * 0.1)];
  const activeThreshold = resting + 15;

  for (let i = daySamples.length - 1; i >= 0; i--) {
    if (daySamples[i].bpm >= activeThreshold) {
      return Math.max(0, (now - daySamples[i].at) / 60_000);
    }
  }

  return Math.max(0, (now - daySamples[0].at) / 60_000);
}

/** True when recent samples show a pulse elevated well above rest. */
function detectRecentExertion(daySamples: PulseSample[], now: number): boolean {
  const recent = daySamples.filter((s) => now - s.at <= 45 * 60_000);
  if (recent.length < 3) return false;
  const bpms = [...daySamples.map((s) => s.bpm)].sort((a, b) => a - b);
  const resting = bpms[Math.floor(bpms.length * 0.1)];
  return recent.some((s) => s.bpm >= resting + 35);
}

/**
 * Establish the day's personalised baseline from the morning segment.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * This implements the client's requirement directly: the app should learn what
 * the user's morning looks like, and only treat an afternoon rise as
 * meaningful relative to it. Until the morning segment has produced enough
 * usable windows there is no baseline, the entropy rules stay switched off,
 * and the FSM runs on the classifier and the absolute heart-rate rules alone.
 * ───────────────────────────────────────────────────────────────────────────
 */
export async function establishBaseline(
  day: string, settings: AppSettings, now: Date,
): Promise<number | null> {
  const session = await getSession(day);
  if (session?.baseline_entropy != null) return session.baseline_entropy;

  // Only the morning segment calibrates. Outside it, whatever we have stands.
  if (isInBaselineWindow(settings, now)) {
    const startOfMorning = new Date(now);
    startOfMorning.setHours(settings.collectionStartHour, 0, 0, 0);
    const samples = await getSamplesBetween(startOfMorning.getTime(), now.getTime());
    const windows = slidingEntropy(samples);
    const baseline = computeBaseline(windows, 5);
    if (baseline !== null) {
      await updateSession(day, {
        baseline_entropy: baseline,
        baseline_set_at: now.getTime(),
      });
      return baseline;
    }
  }

  return null;
}

/** Run one evaluation tick. */
export async function runTick(now: Date = new Date()): Promise<TickResult> {
  const settings = await loadSettings();
  const day = dayKey(now);
  const nowMs = now.getTime();

  await ensureSession(day, nowMs);

  const daySamples = await getSamplesForDay(day);
  const latestAt = daySamples.length > 0 ? daySamples[daySamples.length - 1].at : null;
  const watchConnected =
    latestAt !== null && nowMs - latestAt <= WATCH_CONNECTED_WINDOW_MS;

  await updateSession(day, { watch_connected: watchConnected ? 1 : 0 });
  await recomputeSessionStats(day);

  const inCollectionWindow = isInCollectionWindow(settings, now);
  const entropyEstimate = estimateEntropy(daySamples, nowMs);

  const base: Omit<TickResult, 'skipped'> = {
    at: nowMs,
    features: null,
    entropy: entropyEstimate,
    classification: null,
    fsm: null,
    recommendation: null,
    baseline: null,
    thresholds: null,
    watchConnected,
    inCollectionWindow,
    settings,
    sampleCount: daySamples.length,
  };

  if (!watchConnected) {
    // Analysing a stale window would report the last known state as if it were
    // current. Better to say plainly that there is no live data.
    await refreshDailySummary(day, settings, now);
    return { ...base, skipped: 'No recent heart-rate data — watch not connected.' };
  }

  const baseline = await establishBaseline(day, settings, now);
  const thresholds = baseline !== null ? thresholdsFor(baseline) : null;

  const inactivityMinutes = estimateInactivityMinutes(daySamples, nowMs);
  const windowSamples = await getSamplesBetween(nowMs - entropyEstimate.spanMs, nowMs);
  const features = extractFeatures(
    windowSamples, baseline ?? 0, inactivityMinutes, now,
  );

  if (!features) {
    await refreshDailySummary(day, settings, now);
    return {
      ...base, baseline, thresholds,
      skipped: 'Not enough samples in the current window to analyse.',
    };
  }

  const classification = classify(MODEL, features);

  const context = await loadFsmContext(nowMs);
  const fsm = step(context, {
    now: nowMs,
    entropy: entropyEstimate.usable ? entropyEstimate.entropy : null,
    thresholds,
    stressProbability: classification.stressProbability,
    meanBpm: features.meanBpm,
    warnBpm: settings.warnBpm,
    emergencyBpm: settings.emergencyBpm,
    userOverride: false,
  });
  await saveFsmContext(fsm.context);

  await insertWindow({
    day,
    at: nowMs,
    entropy: entropyEstimate.entropy,
    entropy_ratio: features.entropyRatio,
    entropy_span_ms: entropyEstimate.spanMs,
    entropy_samples: entropyEstimate.sampleCount,
    mean_bpm: features.meanBpm,
    emotion: classification.emotion,
    confidence: classification.confidence,
    p_stress: classification.stressProbability,
    state: fsm.to,
    transitioned: fsm.transitioned ? 1 : 0,
    features_json: JSON.stringify(features),
    trace_json: JSON.stringify(fsm.trace),
  });

  // The standalone high-heart-rate warning, independent of the state machine.
  await maybeWarnHighBpm(features.meanBpm, settings, nowMs);

  let recommendation: Recommendation | null = null;
  if (fsm.transitioned && fsm.tier > 0) {
    recommendation = await handleTransition(
      day, now, fsm, classification, features, inactivityMinutes, daySamples, settings,
    );
  }

  await updateDominant(day);
  await refreshDailySummary(day, settings, now);

  return {
    ...base,
    features,
    classification,
    fsm,
    recommendation,
    baseline,
    thresholds,
    skipped: null,
  };
}

/** Deliver the notification tier for a transition, and its side effects. */
async function handleTransition(
  day: string,
  now: Date,
  fsm: FsmResult,
  classification: Classification,
  features: FeatureVector,
  inactivityMinutes: number,
  daySamples: PulseSample[],
  settings: AppSettings,
): Promise<Recommendation | null> {
  const firedRule = fsm.trace.find((t) => t.fired && t.rule.includes('->'));

  const episodeId = await insertEpisode({
    day,
    at: now.getTime(),
    from_state: fsm.from,
    to_state: fsm.to,
    tier: fsm.tier,
    emotion: classification.emotion,
    mean_bpm: features.meanBpm,
    reason: firedRule ? `${firedRule.rule}: ${firedRule.detail}` : null,
  });

  // Engagement history feeds the 25% and 15% weights of the scoring algorithm.
  const week = now.getTime() - 7 * 24 * 60 * 60_000;
  const recentCounts = await getVerseEngagement(week);
  const allCounts = await getVerseEngagement(0);
  const recentNotifications = await listNotifications(10);

  const themeCounts = (verseCounts: Record<string, number>) => {
    const themes: Record<string, number> = {};
    for (const [verseId, n] of Object.entries(verseCounts)) {
      for (const theme of VERSE_BY_ID[verseId]?.themes ?? []) {
        themes[theme] = (themes[theme] ?? 0) + n;
      }
    }
    return themes;
  };

  const recommendation = recommend(
    fsm.to,
    classification.emotion,
    {
      now,
      inactivityMinutes,
      episodesInWindow: fsm.episodesInWindow,
      recentExertion: detectRecentExertion(daySamples, now.getTime()),
    },
    {
      recentThemeCounts: themeCounts(recentCounts),
      historicalThemeCounts: themeCounts(allCounts),
      recentlyShownIds: recentNotifications
        .map((n) => n.verse_id)
        .filter((id): id is string => id !== null),
    },
  );

  if (!recommendation) return null;

  await presentTierNotification({
    tier: fsm.tier,
    state: fsm.to,
    emotion: classification.emotion,
    verse: recommendation.verse,
    meanBpm: features.meanBpm,
    episodeId,
  });

  // Level 3 additionally alerts contacts and schedules the wellbeing check-in.
  if (fsm.tier === 3) {
    await scheduleWellbeingCheckin(episodeId);
    if (settings.alertContacts) {
      // The composer is opened by the UI layer, which can foreground it; the
      // engine only records that an alert was warranted.
      await setSetting('pending_emergency', JSON.stringify({
        episodeId, bpm: features.meanBpm, at: now.getTime(),
      }));
    }
  }

  return recommendation;
}

async function maybeWarnHighBpm(
  meanBpm: number, settings: AppSettings, nowMs: number,
): Promise<void> {
  if (meanBpm < settings.warnBpm) return;

  const raw = await getSetting(LAST_WARN_KEY);
  const lastAt = raw ? Number(raw) : 0;
  if (Number.isFinite(lastAt) && nowMs - lastAt < HIGH_BPM_WARNING_COOLDOWN_MS) return;

  await presentHighBpmWarning(meanBpm, settings.warnBpm);
  await setSetting(LAST_WARN_KEY, String(nowMs));
}

/** Record the day's dominant state and emotion, by window count. */
async function updateDominant(day: string): Promise<void> {
  const windows = await getWindowsForDay(day);
  if (windows.length === 0) return;

  const tally = <T extends string>(values: T[]): T | null => {
    const counts = new Map<T, number>();
    for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
    let best: T | null = null;
    let bestN = 0;
    for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
    return best;
  };

  // The dominant STATE deliberately ignores CALM when anything else occurred:
  // a day that was calm for 90% of its windows and ACUTE for the rest is not
  // usefully summarised as "calm".
  const states = windows.map((w) => w.state as MonitorState);
  const nonCalm = states.filter((s) => s !== 'CALM');
  const dominantState = nonCalm.length > 0 ? tally(nonCalm) : 'CALM';
  const dominantEmotion = tally(windows.map((w) => w.emotion as EmotionClass));

  await updateSession(day, {
    dominant_state: dominantState,
    dominant_emotion: dominantEmotion,
  });
}

/** Re-schedule the daily summary with the day's current figures. */
async function refreshDailySummary(
  day: string, settings: AppSettings, now: Date,
): Promise<void> {
  const session = await getSession(day);
  if (!session) return;

  const verse = recommendForDailySummary(
    (session.dominant_state as MonitorState) ?? 'CALM',
    (session.dominant_emotion as EmotionClass) ?? 'calm',
    now,
  );

  await scheduleDailySummary({
    hour: settings.summaryHour,
    minute: settings.summaryMinute,
    maxBpm: session.max_bpm,
    maxBpmAt: session.max_bpm_at,
    verse: verse?.verse ?? null,
    asOf: now.getTime(),
    sampleCount: session.sample_count,
  });
}

export interface PendingEmergency { episodeId: number; bpm: number; at: number }

/**
 * Read a pending Level 3 alert WITHOUT clearing it.
 *
 * The UI needs to show the banner on every render until the user acts, so
 * peeking and consuming are separate: takePendingEmergency() clears it, and is
 * called only when the composer actually opens.
 */
export async function peekPendingEmergency(): Promise<PendingEmergency | null> {
  const raw = await getSetting('pending_emergency');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingEmergency;
  } catch {
    return null;
  }
}

/** Pending Level 3 alert awaiting the SMS composer, if any. Clears it. */
export async function takePendingEmergency(): Promise<
  { episodeId: number; bpm: number; at: number } | null
> {
  const raw = await getSetting('pending_emergency');
  if (!raw) return null;
  await setSetting('pending_emergency', '');
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export { dispatchEmergencySms };
