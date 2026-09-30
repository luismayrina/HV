/**
 * lib/verses/recommender.ts
 *
 * The scripture recommendation engine.
 *
 * Two layers, as the study specifies:
 *
 *   1. RULE-BASED EMOTION-TO-SCRIPTURE MAPPING. The FSM state selects a theme
 *      pool (Table 3), which situational rules then refine according to the
 *      user's daily rhythm.
 *
 *   2. WEIGHTED SCORING across the candidate pool:
 *        60%  emotional state fit
 *        25%  recent engagement patterns
 *        15%  historical verse preferences
 *
 * Every component of the final score is returned alongside the chosen verse so
 * the algorithm screen can show why this verse and not another.
 */

import type { EmotionClass, MonitorState } from '../rprv/types';
import { VERSES } from './corpus';
import type { Verse, VerseTheme } from './corpus';

/** Weights from the study's recommendation algorithm. They must sum to 1. */
export const WEIGHT_EMOTION = 0.6;
export const WEIGHT_RECENT_ENGAGEMENT = 0.25;
export const WEIGHT_HISTORICAL = 0.15;

/** Theme pools per FSM state, from the study's Table 3. */
export const STATE_THEMES: Record<MonitorState, VerseTheme[]> = {
  CALM: [],
  ELEVATED: ['peace', 'comfort'],
  STRESS: ['strength', 'hope'],
  ACUTE: ['protection', 'courage'],
};

/**
 * Theme preferences per detected emotional class.
 *
 * The FSM state says how urgent the moment is; the classifier says what kind of
 * distress it is. A user in STRESS because they are anxious and a user in
 * STRESS because they are sad need different words, so the emotion refines the
 * pool that the state opens.
 */
export const EMOTION_THEMES: Record<EmotionClass, VerseTheme[]> = {
  calm: ['peace', 'hope'],
  stress: ['strength', 'peace'],
  anxiety: ['peace', 'courage', 'protection'],
  sadness: ['comfort', 'hope'],
  peace: ['rest', 'peace'],
};

export interface SituationalContext {
  /** Time the recommendation is being made. */
  now: Date;
  /** Minutes since the user was last active. */
  inactivityMinutes: number;
  /** Stress episodes counted inside the six-hour window. */
  episodesInWindow: number;
  /** True when recent activity data indicates physical exertion. */
  recentExertion: boolean;
}

/** A situational rule that fired, for display and for the record. */
export interface SituationalRule {
  name: string;
  detail: string;
  themes: VerseTheme[];
}

/**
 * Apply the study's situational rules, which refine theme selection within the
 * ELEVATED and STRESS states according to the user's daily rhythm.
 *
 * Rules are additive: more than one can apply, and each contributes its themes
 * to the candidate pool with a boost. They never replace the state's own
 * themes, only bias selection within and around them.
 */
export function situationalRules(ctx: SituationalContext): SituationalRule[] {
  const hour = ctx.now.getHours();
  const rules: SituationalRule[] = [];

  // Morning detection, 5:00 AM - 9:00 AM: renewal, guidance, daily strength.
  if (hour >= 5 && hour < 9) {
    rules.push({
      name: 'Morning',
      detail: `${hour}:00 falls in the 5 AM - 9 AM morning window`,
      themes: ['renewal'],
    });
  }

  // Evening detection, 8:00 PM - 12:00 AM: peace, rest, reflection.
  if (hour >= 20 && hour <= 23) {
    rules.push({
      name: 'Evening',
      detail: `${hour}:00 falls in the 8 PM - 12 AM evening window`,
      themes: ['rest', 'peace'],
    });
  }

  // Prolonged inactivity with elevated stress: God's presence in stillness.
  if (ctx.inactivityMinutes >= 120) {
    rules.push({
      name: 'Prolonged inactivity',
      detail: `inactive for ${Math.round(ctx.inactivityMinutes)} min (threshold 120)`,
      themes: ['stillness'],
    });
  }

  // Three or more stress episodes in six hours: direct encouragement.
  if (ctx.episodesInWindow >= 3) {
    rules.push({
      name: 'Repeated stress',
      detail: `${ctx.episodesInWindow} stress episodes in the last 6 h (threshold 3)`,
      themes: ['encouragement', 'strength'],
    });
  }

  // Post-workout recovery: restoration alongside spiritual encouragement.
  if (ctx.recentExertion) {
    rules.push({
      name: 'Post-exertion recovery',
      detail: 'recent physical exertion detected',
      themes: ['restoration'],
    });
  }

  return rules;
}

export interface EngagementProfile {
  /** Times the user engaged with each theme in the last 7 days. */
  recentThemeCounts: Partial<Record<VerseTheme, number>>;
  /** Times the user engaged with each theme across all history. */
  historicalThemeCounts: Partial<Record<VerseTheme, number>>;
  /** Verses shown recently, most recent first — used to avoid repetition. */
  recentlyShownIds: string[];
}

export const EMPTY_ENGAGEMENT: EngagementProfile = {
  recentThemeCounts: {},
  historicalThemeCounts: {},
  recentlyShownIds: [],
};

/** The full score breakdown for one candidate verse. */
export interface VerseScore {
  verse: Verse;
  /** 0-1: how well the verse's themes match the state and emotion. */
  emotionFit: number;
  /** 0-1: alignment with themes engaged with in the last 7 days. */
  recentEngagement: number;
  /** 0-1: alignment with all-time theme preferences. */
  historical: number;
  /** Penalty applied for having been shown recently (subtracted). */
  repetitionPenalty: number;
  /** The weighted total actually used for ranking. */
  total: number;
}

export interface Recommendation {
  verse: Verse;
  /** Themes the pool was drawn from. */
  themes: VerseTheme[];
  /** Situational rules that fired. */
  rules: SituationalRule[];
  /** The top candidates with full score breakdowns, best first. */
  ranked: VerseScore[];
}

/** Normalise a count map to 0-1 by its own maximum. */
function normalised(
  counts: Partial<Record<VerseTheme, number>>,
  themes: VerseTheme[],
): number {
  const values = Object.values(counts) as number[];
  const max = values.length > 0 ? Math.max(...values) : 0;
  if (max === 0) return 0;
  const best = Math.max(0, ...themes.map((t) => counts[t] ?? 0));
  return best / max;
}

/**
 * Choose a verse for the current moment.
 *
 * @param state    Current FSM state. CALM returns null — the study specifies
 *                 no notification in the baseline state.
 * @param emotion  The Random Forest's classification.
 * @param ctx      Situational context for the refinement rules.
 * @param profile  The user's engagement history.
 */
export function recommend(
  state: MonitorState,
  emotion: EmotionClass,
  ctx: SituationalContext,
  profile: EngagementProfile = EMPTY_ENGAGEMENT,
): Recommendation | null {
  if (state === 'CALM') return null;

  const rules = situationalRules(ctx);

  const stateThemes = STATE_THEMES[state];
  const emotionThemes = EMOTION_THEMES[emotion];
  const ruleThemes = rules.flatMap((r) => r.themes);

  // ACUTE keeps its own themes primary: an emergency is not the moment for the
  // evening-rest refinement to pull the selection away from protection.
  const themes: VerseTheme[] = state === 'ACUTE'
    ? [...new Set([...stateThemes, ...emotionThemes])]
    : [...new Set([...stateThemes, ...ruleThemes, ...emotionThemes])];

  const ranked: VerseScore[] = VERSES.map((verse) => {
    // ── Emotional state fit (60%) ────────────────────────────────────────
    // A verse scores highest when its most central theme is one the state
    // itself calls for, lower when it merely shares a refining theme.
    let emotionFit = 0;
    for (const theme of stateThemes) {
      if (verse.themes[0] === theme) emotionFit = Math.max(emotionFit, 1);
      else if (verse.themes.includes(theme)) emotionFit = Math.max(emotionFit, 0.75);
    }
    for (const theme of emotionThemes) {
      if (verse.themes.includes(theme)) emotionFit = Math.max(emotionFit, 0.6);
    }
    for (const theme of ruleThemes) {
      if (verse.themes[0] === theme) emotionFit = Math.max(emotionFit, 0.9);
      else if (verse.themes.includes(theme)) emotionFit = Math.max(emotionFit, 0.7);
    }

    const recentEngagement = normalised(profile.recentThemeCounts, verse.themes);
    const historical = normalised(profile.historicalThemeCounts, verse.themes);

    // ── Repetition penalty ───────────────────────────────────────────────
    // Not part of the study's weighting, but without it the same top-scoring
    // verse is delivered on every single notification, which reads as a broken
    // app rather than as guidance. The penalty decays over the last five
    // deliveries and never exceeds the weight of the engagement term.
    const recentIndex = profile.recentlyShownIds.indexOf(verse.id);
    const repetitionPenalty = recentIndex === -1
      ? 0
      : 0.25 * (1 - recentIndex / profile.recentlyShownIds.length);

    const total =
      WEIGHT_EMOTION * emotionFit +
      WEIGHT_RECENT_ENGAGEMENT * recentEngagement +
      WEIGHT_HISTORICAL * historical -
      repetitionPenalty;

    return { verse, emotionFit, recentEngagement, historical, repetitionPenalty, total };
  })
    .filter((s) => s.emotionFit > 0)
    .sort((a, b) => b.total - a.total);

  if (ranked.length === 0) return null;

  return { verse: ranked[0].verse, themes, rules, ranked: ranked.slice(0, 8) };
}

/**
 * The daily 5:01 PM summary verse.
 *
 * Chosen from the day's dominant emotional state rather than the current
 * instant: the summary reflects the day that was, not the minute it is sent.
 */
export function recommendForDailySummary(
  dominantState: MonitorState,
  dominantEmotion: EmotionClass,
  now: Date,
  profile: EngagementProfile = EMPTY_ENGAGEMENT,
): Recommendation | null {
  // A day that stayed calm still deserves a verse, so fall back to a gentle
  // pool rather than returning nothing.
  const state: MonitorState = dominantState === 'CALM' ? 'ELEVATED' : dominantState;
  return recommend(
    state,
    dominantEmotion,
    { now, inactivityMinutes: 0, episodesInWindow: 0, recentExertion: false },
    profile,
  );
}
