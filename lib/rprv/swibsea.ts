/**
 * lib/rprv/swibsea.ts
 *
 * SWIBSEA — Sliding Window-Based Signal Entropy Analysis.
 *
 * Computes a signal entropy measure over a sliding window of the RPRV
 * inter-beat interval series, as specified by the study:
 *
 *   - 60-second window with 50% overlap, so a new entropy estimate is
 *     produced every 30 seconds.
 *   - Within each window, sample entropy measures signal regularity.
 *     HIGH entropy = high variability = relaxed state.
 *     LOW  entropy = reduced variability = sympathetic dominance = stress.
 *   - An entropy below 85% of the user's personalised baseline flags an
 *     emotional shift; sustained low entropy escalates the detected state.
 *   - Detection latency is bounded by one window length (~60 s).
 *
 * Worked example from the study, for a baseline of 1.40 and a detection
 * threshold of 0.85 x 1.40 = 1.19:
 *
 *   Window  Span       Entropy  Ratio  State
 *   1       0:00-1:00  1.42     1.01   CALM
 *   2       0:30-1:30  1.35     0.96   CALM
 *   3       1:00-2:00  1.15     0.82   ELEVATED
 *   4       1:30-2:30  0.98     0.70   STRESS
 */

import type { PulseSample } from './types';
import { toPulseIntervals } from './features';

/** Analysis window length (ms). */
export const WINDOW_MS = 60_000;

/** Window overlap fraction — 50% per the study. */
export const WINDOW_OVERLAP = 0.5;

/** Interval between successive entropy estimates (ms) — 30 s at 50% overlap. */
export const WINDOW_STEP_MS = WINDOW_MS * (1 - WINDOW_OVERLAP);

/**
 * Detection threshold: entropy below this fraction of baseline flags a shift.
 * Specified by the study as 85% of the personalised baseline.
 */
export const ENTROPY_SHIFT_RATIO = 0.85;

/**
 * Recovery threshold: entropy at or above this fraction of baseline for the
 * required dwell time de-escalates the state. Specified by the study as 90%.
 */
export const ENTROPY_RECOVERY_RATIO = 0.9;

/**
 * Critical threshold for escalation to ACUTE.
 *
 * The study names E_critical in the transition rules but does not fix its
 * value. We set it below the 0.70 ratio that the study's own worked example
 * labels STRESS, so that ACUTE remains strictly more severe than any entropy
 * the example demonstrates. This is a calibration constant, not a figure
 * quoted from the source, and is exposed in the algorithm screen as such.
 */
export const ENTROPY_CRITICAL_RATIO = 0.65;

/** Tolerance multiplier for sample entropy — r = 0.2 * SD, the usual choice. */
export const SAMPEN_R_FACTOR = 0.2;

/**
 * Target number of intervals an entropy estimate should be computed over.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — a necessary deviation from the study's 60-second window
 * ───────────────────────────────────────────────────────────────────────────
 * The study specifies entropy over a 60-second window, which assumes raw
 * beat-to-beat intervals from a PPG sensor: at a resting 70 bpm that is ~70
 * intervals per window. A phone reading Health Connect or HealthKit does not
 * get beat-to-beat data — it gets one averaged bpm sample every 3-5 seconds,
 * so a literal 60-second window holds only 12-20 points.
 *
 * Measured on simulated calm-vs-stress series, sample entropy over 12 points
 * separates the two conditions with an effect size of d = -0.03: the estimate
 * is pure noise at that length, and its standard deviation exceeds the
 * difference between the conditions. Separation only becomes usable at roughly
 * 40 intervals (d = 1.5) and is strong by 60 (d = 1.8).
 *
 * We therefore keep the study's 30-second EVALUATION cadence and its bounded
 * detection latency, but widen the span the entropy is COMPUTED over until it
 * holds enough intervals to support an estimate. The span actually used is
 * reported alongside every reading and shown on the algorithm screen, so the
 * widening is visible rather than hidden.
 * ───────────────────────────────────────────────────────────────────────────
 */
export const TARGET_ENTROPY_SAMPLES = 60;

/** Below this many intervals an entropy estimate is not reported at all. */
export const MIN_ENTROPY_SAMPLES = 30;

/** Hard cap on how far back the entropy window may reach (ms). */
export const MAX_ENTROPY_SPAN_MS = 300_000;

/**
 * Embedding dimension, chosen from the series length.
 *
 * m = 2 is the conventional choice and gives the cleanest separation when the
 * series is long, but on short series it produces very few template matches
 * and the estimate collapses toward zero. m = 1 is markedly more stable below
 * ~100 intervals. Measured separations (calm vs stress, Cohen's d):
 *
 *   N =  36   m=1: 1.49   m=2: 0.41
 *   N =  60   m=1: 1.79   m=2: 1.14
 *   N = 100   m=1: 0.65   m=2: 1.24
 *   N = 300   m=1: 2.49   m=2: 3.88
 */
export function adaptiveM(n: number): number {
  return n >= 100 ? 2 : 1;
}

/**
 * Sample entropy: the negative natural log of the conditional probability that
 * two sequences similar for `m` points remain similar at the next point,
 * self-matches excluded.
 *
 * Lower values indicate a more regular, more predictable signal.
 *
 * @param series Inter-beat interval series (ms).
 * @param m      Embedding dimension.
 * @param rFactor Tolerance as a multiple of the series standard deviation.
 */
export function sampleEntropy(
  series: number[],
  m: number = adaptiveM(series.length),
  rFactor: number = SAMPEN_R_FACTOR,
): number {
  const n = series.length;
  if (n < m + 2) return 0;

  // Tolerance is scaled to this window's own spread, which makes the measure
  // comparable across users with different resting heart rates.
  const meanVal = series.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(
    series.reduce((acc, v) => acc + (v - meanVal) ** 2, 0) / n,
  );
  if (sd === 0) return 0; // A perfectly flat series carries no information.
  const r = rFactor * sd;

  let matchesM = 0;
  let matchesM1 = 0;

  for (let i = 0; i <= n - m - 1; i++) {
    for (let j = i + 1; j <= n - m - 1; j++) {
      // Chebyshev distance over the m-length template.
      let dist = 0;
      for (let k = 0; k < m; k++) {
        const d = Math.abs(series[i + k] - series[j + k]);
        if (d > dist) dist = d;
      }
      if (dist <= r) {
        matchesM++;
        if (Math.abs(series[i + m] - series[j + m]) <= r) matchesM1++;
      }
    }
  }

  // With no matches at either length the estimate is undefined; report 0 so
  // callers treat the window as uninformative rather than as extreme stress.
  if (matchesM === 0 || matchesM1 === 0) return 0;

  return -Math.log(matchesM1 / matchesM);
}

/** One entropy estimate produced by the sliding window. */
export interface EntropyWindow {
  /** Window start (epoch ms). */
  startsAt: number;
  /** Window end (epoch ms). */
  endsAt: number;
  /** Sample entropy of the window. */
  entropy: number;
  /** Number of pulse samples that fell inside the window. */
  sampleCount: number;
}

/** An entropy estimate together with the evidence behind it. */
export interface EntropyEstimate {
  /** Sample entropy, or null when there was not enough data to estimate it. */
  entropy: number | null;
  /** Intervals the estimate was computed over. */
  sampleCount: number;
  /** Time span the estimate actually covered (ms). */
  spanMs: number;
  /** Embedding dimension used. */
  m: number;
  /**
   * False when the window could not reach MIN_ENTROPY_SAMPLES even at the
   * maximum span — the caller must then fall back to the classifier alone
   * rather than treating a missing entropy as a low one.
   */
  usable: boolean;
}

/**
 * Estimate entropy over a trailing window ending at `endAt`.
 *
 * The window starts at the study's 60-second length and is widened backwards
 * only as far as needed to reach TARGET_ENTROPY_SAMPLES intervals, up to
 * MAX_ENTROPY_SPAN_MS. On a device delivering dense samples the window stays
 * at 60 seconds exactly as specified; on a sparse feed it widens, and says so.
 */
export function estimateEntropy(
  samples: PulseSample[],
  endAt: number = Date.now(),
): EntropyEstimate {
  const sorted = [...samples]
    .filter((s) => s.at <= endAt)
    .sort((a, b) => a.at - b.at);

  let span = WINDOW_MS;
  let selected: PulseSample[] = [];

  // Widen until the window holds enough intervals, or we hit the cap.
  while (span <= MAX_ENTROPY_SPAN_MS) {
    selected = sorted.filter((s) => s.at >= endAt - span);
    if (selected.length >= TARGET_ENTROPY_SAMPLES) break;
    if (span === MAX_ENTROPY_SPAN_MS) break;
    span = Math.min(span * 2, MAX_ENTROPY_SPAN_MS);
  }

  const intervals = toPulseIntervals(selected);
  const n = intervals.length;

  if (n < MIN_ENTROPY_SAMPLES) {
    return { entropy: null, sampleCount: n, spanMs: span, m: adaptiveM(n), usable: false };
  }

  const m = adaptiveM(n);
  return {
    entropy: sampleEntropy(intervals, m),
    sampleCount: n,
    spanMs: span,
    m,
    usable: true,
  };
}

/**
 * Slice a sample series into overlapping windows and compute entropy for each.
 *
 * Used to establish the personalised baseline from a calibration period. Each
 * window is evaluated at the study's 30-second cadence, with the entropy for
 * that instant estimated by estimateEntropy — so the reported cadence is the
 * study's while the estimate itself rests on enough data to be meaningful.
 */
export function slidingEntropy(samples: PulseSample[]): EntropyWindow[] {
  if (samples.length === 0) return [];

  const sorted = [...samples].sort((a, b) => a.at - b.at);
  const first = sorted[0].at;
  const last = sorted[sorted.length - 1].at;
  const windows: EntropyWindow[] = [];

  for (let end = first + WINDOW_MS; end <= last; end += WINDOW_STEP_MS) {
    const est = estimateEntropy(sorted, end);
    if (!est.usable || est.entropy === null) continue;
    windows.push({
      startsAt: end - est.spanMs,
      endsAt: end,
      entropy: est.entropy,
      sampleCount: est.sampleCount,
    });
  }

  return windows;
}

/**
 * Establish a personalised baseline entropy from a set of calm-period windows.
 *
 * The median is used rather than the mean so that a single agitated window
 * inside the calibration period cannot drag the baseline down — which would
 * otherwise raise the trigger threshold and suppress genuine detections for
 * the rest of the day.
 *
 * @returns The baseline entropy, or null when there is not enough data.
 */
export function computeBaseline(
  windows: EntropyWindow[],
  minWindows = 3,
): number | null {
  const usable = windows.map((w) => w.entropy).filter((e) => e > 0);
  if (usable.length < minWindows) return null;

  const sorted = [...usable].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** The thresholds derived from a baseline, for display and rule evaluation. */
export interface EntropyThresholds {
  baseline: number;
  /** Below this, an emotional shift is flagged (0.85 x baseline). */
  shift: number;
  /** At or above this, the state de-escalates (0.90 x baseline). */
  recovery: number;
  /** Below this, the state escalates to ACUTE (0.65 x baseline). */
  critical: number;
}

export function thresholdsFor(baseline: number): EntropyThresholds {
  return {
    baseline,
    shift: baseline * ENTROPY_SHIFT_RATIO,
    recovery: baseline * ENTROPY_RECOVERY_RATIO,
    critical: baseline * ENTROPY_CRITICAL_RATIO,
  };
}
