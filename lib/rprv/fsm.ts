/**
 * lib/rprv/fsm.ts
 *
 * The rule-based recommendation system, implemented as the finite state
 * machine specified by the study.
 *
 * Each detected emotional state is a discrete machine state; each change in
 * physiological or contextual input triggers a rule-based transition. Entering
 * a state produces a predefined notification tier and verse theme.
 *
 *   CALM      no notification. Baseline.
 *   ELEVATED  Level 1, gentle    — verses of peace and comfort.
 *   STRESS    Level 2, moderate  — verses of strength and hope.
 *   ACUTE     Level 3, urgent    — verses of protection and courage,
 *                                  plus alerts to emergency contacts.
 *
 * The rule set below is a direct transcription of the study's pseudocode:
 *
 *   every 60 s window:
 *     E_win = SWIBSEA(pulse_intervals)
 *     [class, P_stress] = RandomForest(features)
 *     switch (state):
 *       case CALM:
 *         if E_win < 0.85 * E_base or P_stress > 0.5:
 *           state = ELEVATED;  notify(Level1, verse_pool[peace])
 *       case ELEVATED:
 *         if duration_elevated >= 10 min or P_stress > 0.7:
 *           state = STRESS;    notify(Level2, verse_pool[strength])
 *         else if E_win >= 0.90 * E_base for 5 min:
 *           state = CALM
 *       case STRESS:
 *         if episodes_6h >= 3 or E_win < E_critical:
 *           state = ACUTE;     notify(Level3, verse_pool[protection],
 *                                     emergency_contacts)
 *         else if E_win >= 0.90 * E_base for 5 min:
 *           state = ELEVATED
 *       case ACUTE:
 *         if E_win >= E_critical for 10 min or user_override:
 *           state = STRESS
 *
 * Two additions sit alongside the study's rules, both required by the client:
 *
 *   1. A HARD HEART-RATE RULE. The study's transitions are entirely relative
 *      to the user's own entropy baseline, which means a genuinely dangerous
 *      absolute heart rate could pass unremarked if it arrived gradually. A
 *      configurable warning threshold (default 120 bpm) forces at least
 *      ELEVATED, and an emergency threshold forces ACUTE, regardless of what
 *      the entropy is doing.
 *
 *   2. BASELINE GATING. Entropy rules are skipped entirely until the day's
 *      personalised baseline has been established from the morning segment.
 *      Before then the machine runs on the classifier and the absolute
 *      heart-rate rules alone. This is what makes the "calm in the morning,
 *      elevated in the afternoon" comparison meaningful rather than comparing
 *      the user against a stale baseline from another day.
 */

import type { EntropyThresholds } from './swibsea';
import type { MonitorState, NotificationTier } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Timing constants, from the study's transition table
// ─────────────────────────────────────────────────────────────────────────────

/** ELEVATED must persist this long before escalating to STRESS. */
export const ELEVATED_SUSTAIN_MS = 10 * 60_000;

/** Entropy must sit at or above the recovery threshold this long to step down. */
export const RECOVERY_DWELL_MS = 5 * 60_000;

/** ACUTE requires a longer recovery dwell before stepping down to STRESS. */
export const ACUTE_RECOVERY_DWELL_MS = 10 * 60_000;

/** Window over which stress episodes are counted for the ACUTE rule. */
export const EPISODE_WINDOW_MS = 6 * 60 * 60_000;

/** Episodes within EPISODE_WINDOW_MS that escalate STRESS to ACUTE. */
export const EPISODES_FOR_ACUTE = 3;

/** With no stress signal for this long, any state returns to CALM. */
export const CALM_RESET_MS = 30 * 60_000;

/** P_stress above this moves CALM to ELEVATED. */
export const P_STRESS_ELEVATE = 0.5;

/** P_stress above this moves ELEVATED to STRESS. */
export const P_STRESS_ESCALATE = 0.7;

/** Default absolute heart rate that raises a warning, per the client's brief. */
export const DEFAULT_WARN_BPM = 120;

/** Default absolute heart rate treated as an emergency. */
export const DEFAULT_EMERGENCY_BPM = 150;

// ─────────────────────────────────────────────────────────────────────────────
// Machine state
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The machine's persistent context.
 *
 * Kept separate from the transition function so the whole thing stays a pure
 * reducer: the monitoring layer owns persistence, the FSM owns the rules. That
 * also makes every transition reproducible from a stored context, which is
 * what the analysis screen replays.
 */
export interface FsmContext {
  state: MonitorState;
  /** When the current state was entered (epoch ms). */
  enteredAt: number;
  /** When entropy first rose to the recovery threshold, or null. */
  recoveringSince: number | null;
  /** Last time any stress signal was observed (epoch ms). */
  lastStressSignalAt: number | null;
  /** Timestamps at which STRESS was entered — the six-hour episode counter. */
  episodeTimestamps: number[];
}

export function initialContext(now: number = Date.now()): FsmContext {
  return {
    state: 'CALM',
    enteredAt: now,
    recoveringSince: null,
    lastStressSignalAt: null,
    episodeTimestamps: [],
  };
}

export interface FsmInput {
  now: number;
  /** Window entropy, or null when no usable estimate was available. */
  entropy: number | null;
  /** Thresholds derived from the personalised baseline, or null when ungated. */
  thresholds: EntropyThresholds | null;
  /** P_stress from the Random Forest. */
  stressProbability: number;
  /** Mean heart rate over the window (bpm). */
  meanBpm: number;
  /** Absolute warning threshold (bpm). */
  warnBpm: number;
  /** Absolute emergency threshold (bpm). */
  emergencyBpm: number;
  /** True when the user has manually dismissed an ACUTE alert. */
  userOverride: boolean;
}

/** One rule evaluation, recorded whether or not it fired. */
export interface RuleTrace {
  /** Identifier matching the study's pseudocode, e.g. "CALM -> ELEVATED". */
  rule: string;
  /** The condition as evaluated, with the actual numbers substituted in. */
  detail: string;
  fired: boolean;
}

export interface FsmResult {
  context: FsmContext;
  from: MonitorState;
  to: MonitorState;
  /** True when the state changed on this tick. */
  transitioned: boolean;
  /** Notification tier to deliver, 0 when none. */
  tier: NotificationTier;
  /** Every rule considered this tick, in evaluation order. */
  trace: RuleTrace[];
  /** Whether entropy rules were skipped for want of a baseline. */
  entropyAvailable: boolean;
  /** Stress episodes counted inside the six-hour window. */
  episodesInWindow: number;
}

/** The notification tier each state carries, per the study's Table 3. */
export function tierFor(state: MonitorState): NotificationTier {
  switch (state) {
    case 'CALM': return 0;
    case 'ELEVATED': return 1;
    case 'STRESS': return 2;
    case 'ACUTE': return 3;
  }
}

const fmt = (n: number, digits = 2) =>
  Number.isFinite(n) ? n.toFixed(digits) : 'n/a';

const mins = (ms: number) => `${(ms / 60_000).toFixed(1)} min`;

/**
 * Advance the machine by one tick.
 *
 * Pure: given the same context and input it always produces the same result,
 * and it never reads the clock itself. Every rule it considers is recorded in
 * `trace`, including rules that did not fire, so the algorithm screen can show
 * the full evaluation rather than just the outcome.
 */
export function step(context: FsmContext, input: FsmInput): FsmResult {
  const {
    now, entropy, thresholds, stressProbability,
    meanBpm, warnBpm, emergencyBpm, userOverride,
  } = input;

  const trace: RuleTrace[] = [];
  const entropyAvailable = entropy !== null && thresholds !== null;

  // Prune the episode counter to the six-hour window before counting.
  const episodeTimestamps = context.episodeTimestamps.filter(
    (t) => now - t <= EPISODE_WINDOW_MS,
  );
  const episodesInWindow = episodeTimestamps.length;

  const belowShift = entropyAvailable && entropy! < thresholds!.shift;
  const belowCritical = entropyAvailable && entropy! < thresholds!.critical;
  const atRecovery = entropyAvailable && entropy! >= thresholds!.recovery;

  if (!entropyAvailable) {
    trace.push({
      rule: 'entropy gate',
      detail: thresholds === null
        ? 'no personalised baseline yet — entropy rules skipped, running on classifier and heart rate only'
        : 'not enough pulse samples for a usable entropy estimate — entropy rules skipped',
      fired: false,
    });
  } else {
    trace.push({
      rule: 'SWIBSEA',
      detail: `E_win ${fmt(entropy!)} vs baseline ${fmt(thresholds!.baseline)} `
        + `(shift < ${fmt(thresholds!.shift)}, recovery >= ${fmt(thresholds!.recovery)}, `
        + `critical < ${fmt(thresholds!.critical)})`,
      fired: belowShift,
    });
  }

  // ── Track recovery dwell ──────────────────────────────────────────────────
  // recoveringSince records when entropy FIRST reached the recovery threshold;
  // any dip below resets it, so the dwell requirement means "continuously at or
  // above recovery", not "at recovery at some point in the last five minutes".
  let recoveringSince = context.recoveringSince;
  if (atRecovery) {
    if (recoveringSince === null) recoveringSince = now;
  } else {
    recoveringSince = null;
  }
  const recoveryHeldFor = recoveringSince === null ? 0 : now - recoveringSince;

  // ── Track the last stress signal, for the 30-minute any -> CALM rule ──────
  const stressSignalNow =
    belowShift ||
    stressProbability > P_STRESS_ELEVATE ||
    meanBpm >= warnBpm;
  const lastStressSignalAt = stressSignalNow ? now : context.lastStressSignalAt;

  // ── Absolute heart-rate rules (client requirement, outside the study) ─────
  const bpmEmergency = meanBpm >= emergencyBpm;
  const bpmWarning = meanBpm >= warnBpm;

  trace.push({
    rule: 'heart rate — emergency',
    detail: `mean ${fmt(meanBpm, 0)} bpm >= ${emergencyBpm} bpm`,
    fired: bpmEmergency,
  });
  trace.push({
    rule: 'heart rate — warning',
    detail: `mean ${fmt(meanBpm, 0)} bpm >= ${warnBpm} bpm`,
    fired: bpmWarning,
  });

  const from = context.state;
  let to = from;
  let newEpisodes = episodeTimestamps;

  // An absolute emergency heart rate overrides the state graph entirely.
  if (bpmEmergency && from !== 'ACUTE') {
    to = 'ACUTE';
  } else {
    switch (from) {
      case 'CALM': {
        const fired = belowShift || stressProbability > P_STRESS_ELEVATE || bpmWarning;
        trace.push({
          rule: 'CALM -> ELEVATED',
          detail: `E_win below 85% of baseline (${belowShift}) `
            + `or P_stress ${fmt(stressProbability)} > ${P_STRESS_ELEVATE} `
            + `or heart rate at warning threshold (${bpmWarning})`,
          fired,
        });
        if (fired) to = 'ELEVATED';
        break;
      }

      case 'ELEVATED': {
        const heldFor = now - context.enteredAt;
        const escalate =
          heldFor >= ELEVATED_SUSTAIN_MS || stressProbability > P_STRESS_ESCALATE;
        trace.push({
          rule: 'ELEVATED -> STRESS',
          detail: `elevated for ${mins(heldFor)} (needs ${mins(ELEVATED_SUSTAIN_MS)}) `
            + `or P_stress ${fmt(stressProbability)} > ${P_STRESS_ESCALATE}`,
          fired: escalate,
        });

        if (escalate) {
          to = 'STRESS';
        } else {
          const recover = recoveryHeldFor >= RECOVERY_DWELL_MS;
          trace.push({
            rule: 'ELEVATED -> CALM',
            detail: `entropy at or above 90% of baseline for ${mins(recoveryHeldFor)} `
              + `(needs ${mins(RECOVERY_DWELL_MS)})`,
            fired: recover,
          });
          if (recover) to = 'CALM';
        }
        break;
      }

      case 'STRESS': {
        const escalate = episodesInWindow >= EPISODES_FOR_ACUTE || belowCritical;
        trace.push({
          rule: 'STRESS -> ACUTE',
          detail: `${episodesInWindow} stress episodes in 6 h `
            + `(needs ${EPISODES_FOR_ACUTE}) or entropy below critical (${belowCritical})`,
          fired: escalate,
        });

        if (escalate) {
          to = 'ACUTE';
        } else {
          const recover = recoveryHeldFor >= RECOVERY_DWELL_MS;
          trace.push({
            rule: 'STRESS -> ELEVATED',
            detail: `entropy at or above 90% of baseline for ${mins(recoveryHeldFor)} `
              + `(needs ${mins(RECOVERY_DWELL_MS)})`,
            fired: recover,
          });
          if (recover) to = 'ELEVATED';
        }
        break;
      }

      case 'ACUTE': {
        // De-escalation from ACUTE additionally requires that the absolute
        // heart-rate emergency has cleared — recovering entropy while the pulse
        // is still dangerously high is not a recovery.
        const entropyRecovered =
          entropyAvailable && entropy! >= thresholds!.critical
          && recoveryHeldFor >= ACUTE_RECOVERY_DWELL_MS;
        const fired = (entropyRecovered || userOverride) && !bpmEmergency;
        trace.push({
          rule: 'ACUTE -> STRESS',
          detail: `entropy at or above critical for ${mins(recoveryHeldFor)} `
            + `(needs ${mins(ACUTE_RECOVERY_DWELL_MS)}) or user override (${userOverride})`
            + `${bpmEmergency ? ', blocked: heart rate still at emergency level' : ''}`,
          fired,
        });
        if (fired) to = 'STRESS';
        break;
      }
    }
  }

  // ── any -> CALM after a sustained quiet period ────────────────────────────
  if (to !== 'CALM' && lastStressSignalAt !== null) {
    const quietFor = now - lastStressSignalAt;
    const fired = quietFor >= CALM_RESET_MS && !bpmWarning;
    trace.push({
      rule: 'any -> CALM',
      detail: `no stress signal for ${mins(quietFor)} (needs ${mins(CALM_RESET_MS)})`,
      fired,
    });
    if (fired) to = 'CALM';
  }

  // Entering STRESS records an episode for the six-hour counter.
  if (to === 'STRESS' && from !== 'STRESS') {
    newEpisodes = [...episodeTimestamps, now];
  }

  const transitioned = to !== from;

  return {
    context: {
      state: to,
      enteredAt: transitioned ? now : context.enteredAt,
      // A state change restarts the recovery dwell: the five minutes must be
      // served in the state being left, not carried across the transition.
      recoveringSince: transitioned ? null : recoveringSince,
      lastStressSignalAt,
      episodeTimestamps: newEpisodes,
    },
    from,
    to,
    transitioned,
    // Only an ENTRY into a state notifies. Remaining in STRESS for an hour
    // must not re-fire the Level 2 notification every thirty seconds.
    tier: transitioned ? tierFor(to) : 0,
    trace,
    entropyAvailable,
    episodesInWindow,
  };
}
