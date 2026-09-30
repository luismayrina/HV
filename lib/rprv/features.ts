/**
 * lib/rprv/features.ts
 *
 * Stage 1 of the classification pipeline: converts a window of raw pulse
 * samples into the numeric feature vector consumed by the Random Forest.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * MEASUREMENT NOTE (important — this is a stated limitation of the build)
 * ─────────────────────────────────────────────────────────────────────────────
 * The study's algorithm is specified over raw radial pulse inter-beat intervals
 * sampled directly from a PPG sensor. Neither Health Connect nor HealthKit
 * exposes raw PPG or beat-to-beat intervals to a phone application — both
 * deliver averaged beats-per-minute samples written by the watch.
 *
 * We therefore reconstruct the inter-beat interval series as RR = 60000 / bpm.
 * This preserves the *shape* of the variability (a rising, steady pulse still
 * yields low variability; a fluctuating pulse still yields high variability),
 * which is what the entropy and SDNN/RMSSD measures respond to. It does NOT
 * recover true beat-to-beat detail, so absolute values are not comparable with
 * clinical HRV figures derived from ECG.
 *
 * Consequence for the user: all thresholds are evaluated against the user's own
 * personalised baseline rather than against published population norms.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { sampleEntropy } from './swibsea';
import type { FeatureVector, PulseSample } from './types';

/** Low-frequency band bounds (Hz). */
export const LF_BAND: [number, number] = [0.04, 0.15];

/** High-frequency band bounds (Hz). */
export const HF_BAND: [number, number] = [0.15, 0.4];

/** Minimum samples required before a window can produce a feature vector. */
export const MIN_SAMPLES_PER_WINDOW = 6;

/** Physiologically implausible readings are discarded before analysis. */
export const MIN_PLAUSIBLE_BPM = 25;
export const MAX_PLAUSIBLE_BPM = 240;

/**
 * Derive the inter-beat interval series (ms) from bpm samples.
 * Implausible readings are dropped rather than clamped, so a sensor glitch
 * cannot drag the window statistics toward a false state.
 */
export function toPulseIntervals(samples: PulseSample[]): number[] {
  return samples
    .filter((s) => s.bpm >= MIN_PLAUSIBLE_BPM && s.bpm <= MAX_PLAUSIBLE_BPM)
    .map((s) => 60_000 / s.bpm);
}

/** Arithmetic mean. Returns 0 for an empty series. */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let total = 0;
  for (const x of xs) total += x;
  return total / xs.length;
}

/** Population standard deviation — SDNN when applied to an RR series. */
export function stdDev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let sumSq = 0;
  for (const x of xs) sumSq += (x - m) ** 2;
  return Math.sqrt(sumSq / xs.length);
}

/** Root mean square of successive differences. */
export function rmssd(intervals: number[]): number {
  if (intervals.length < 2) return 0;
  let sumSq = 0;
  for (let i = 1; i < intervals.length; i++) {
    sumSq += (intervals[i] - intervals[i - 1]) ** 2;
  }
  return Math.sqrt(sumSq / (intervals.length - 1));
}

/** Proportion of successive intervals differing by more than 50 ms. */
export function pnn50(intervals: number[]): number {
  if (intervals.length < 2) return 0;
  let over = 0;
  for (let i = 1; i < intervals.length; i++) {
    if (Math.abs(intervals[i] - intervals[i - 1]) > 50) over++;
  }
  return over / (intervals.length - 1);
}

/**
 * Lomb-Scargle periodogram power integrated over a frequency band.
 *
 * An RR series is unevenly sampled by construction — each interval advances
 * time by its own duration — so the usual FFT would require resampling and
 * interpolation first. The Lomb-Scargle periodogram estimates spectral power
 * directly on unevenly spaced data, which is the standard approach for
 * frequency-domain HRV and avoids interpolation artefacts.
 *
 * @param times  Sample times in seconds (cumulative sum of the RR series).
 * @param values Interval values in ms.
 * @param band   [low, high] band bounds in Hz.
 * @param bins   Number of frequencies evaluated across the band.
 */
export function bandPower(
  times: number[],
  values: number[],
  band: [number, number],
  bins = 32,
): number {
  const n = values.length;
  if (n < 4) return 0;

  const m = mean(values);
  const variance = values.reduce((acc, v) => acc + (v - m) ** 2, 0) / n;
  if (variance === 0) return 0;

  const [lo, hi] = band;
  const step = (hi - lo) / bins;
  let total = 0;

  for (let b = 0; b < bins; b++) {
    const freq = lo + step * (b + 0.5);
    const omega = 2 * Math.PI * freq;

    // Time offset tau makes the periodogram invariant to time translation.
    let sumSin2 = 0;
    let sumCos2 = 0;
    for (let i = 0; i < n; i++) {
      sumSin2 += Math.sin(2 * omega * times[i]);
      sumCos2 += Math.cos(2 * omega * times[i]);
    }
    const tau = Math.atan2(sumSin2, sumCos2) / (2 * omega);

    let cosNum = 0;
    let cosDen = 0;
    let sinNum = 0;
    let sinDen = 0;
    for (let i = 0; i < n; i++) {
      const arg = omega * (times[i] - tau);
      const c = Math.cos(arg);
      const s = Math.sin(arg);
      const dev = values[i] - m;
      cosNum += dev * c;
      cosDen += c * c;
      sinNum += dev * s;
      sinDen += s * s;
    }

    const cosTerm = cosDen > 1e-12 ? (cosNum * cosNum) / cosDen : 0;
    const sinTerm = sinDen > 1e-12 ? (sinNum * sinNum) / sinDen : 0;
    // Power spectral density at this frequency, scaled to ms^2/Hz.
    total += 0.5 * (cosTerm + sinTerm) * step;
  }

  return total;
}

/** Cumulative sample times in seconds, derived from the RR series itself. */
export function intervalTimes(intervals: number[]): number[] {
  const times: number[] = [];
  let t = 0;
  for (const rr of intervals) {
    times.push(t);
    t += rr / 1000;
  }
  return times;
}

/**
 * Build the full feature vector for one analysis window.
 *
 * @param samples            Pulse samples falling inside the window.
 * @param baselineEntropy    The user's personalised baseline entropy. When 0 or
 *                           unknown, entropyRatio falls back to 1 (treated as
 *                           "at baseline") so an uncalibrated user is never
 *                           reported as stressed purely for lack of a baseline.
 * @param inactivityMinutes  Minutes since the user was last active.
 * @param now                Window reference time, for the hour-of-day feature.
 */
export function extractFeatures(
  samples: PulseSample[],
  baselineEntropy: number,
  inactivityMinutes: number,
  now: Date = new Date(),
): FeatureVector | null {
  const intervals = toPulseIntervals(samples);
  if (intervals.length < MIN_SAMPLES_PER_WINDOW) return null;

  const times = intervalTimes(intervals);
  const entropy = sampleEntropy(intervals);
  const lfPower = bandPower(times, intervals, LF_BAND);
  const hfPower = bandPower(times, intervals, HF_BAND);
  const meanInterval = mean(intervals);

  return {
    meanRR: meanInterval,
    sdnn: stdDev(intervals),
    rmssd: rmssd(intervals),
    pnn50: pnn50(intervals),
    lfPower,
    hfPower,
    // Guard the ratio: an HF power of zero would otherwise yield Infinity and
    // poison every downstream comparison in the decision trees.
    lfHfRatio: hfPower > 1e-9 ? lfPower / hfPower : 0,
    entropy,
    entropyRatio: baselineEntropy > 0 ? entropy / baselineEntropy : 1,
    inactivityMinutes,
    hourOfDay: now.getHours(),
    meanBpm: meanInterval > 0 ? 60_000 / meanInterval : 0,
  };
}
