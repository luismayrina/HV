/**
 * lib/rprv/types.ts
 *
 * Shared types for the RPRV (Radial Pulse Rate Variability) analysis pipeline.
 *
 * The pipeline follows the three-stage design described in the study:
 *   1. Feature extraction  — raw pulse intervals -> feature vector (features.ts)
 *   2. Classification      — feature vector -> emotional state (randomForest.ts)
 *   3. State machine       — classification + entropy -> notification tier (fsm.ts)
 */

/**
 * A single heart-rate observation as delivered by the health platform.
 * Health Connect and HealthKit both expose beats-per-minute rather than raw
 * inter-beat intervals, so `bpm` is the primary field and the RR interval is
 * derived (see features.ts `toPulseIntervals`).
 */
export interface PulseSample {
  /** Beats per minute as reported by the platform. */
  bpm: number;
  /** Timestamp of the sample (epoch milliseconds). */
  at: number;
}

/**
 * The five emotional state classes produced by the Random Forest classifier.
 * These are the classes named in the study's classification stage.
 */
export type EmotionClass = 'calm' | 'stress' | 'anxiety' | 'sadness' | 'peace';

export const EMOTION_CLASSES: EmotionClass[] = [
  'calm',
  'stress',
  'anxiety',
  'sadness',
  'peace',
];

/**
 * The four finite-state-machine states that drive notification tiers.
 * Distinct from EmotionClass: the classifier answers "what is the user
 * feeling", the FSM answers "what should the app do about it".
 */
export type MonitorState = 'CALM' | 'ELEVATED' | 'STRESS' | 'ACUTE';

/** Notification tiers of the three-tier alert model. 0 = no notification. */
export type NotificationTier = 0 | 1 | 2 | 3;

/**
 * The feature vector consumed by the Random Forest classifier.
 *
 * Composition follows the study's feature specification:
 *   - time-domain measures      (mean pulse interval, SDNN, RMSSD)
 *   - frequency-domain measures (LF power, HF power, LF/HF ratio)
 *   - entropy features          (produced by the SWIBSEA algorithm)
 *   - behavioural features      (inactivity duration, time of day)
 */
export interface FeatureVector {
  /** Mean inter-beat interval over the window (ms). */
  meanRR: number;
  /** Standard deviation of NN intervals (ms). */
  sdnn: number;
  /** Root mean square of successive differences (ms). */
  rmssd: number;
  /** Proportion of successive intervals differing by more than 50 ms (0-1). */
  pnn50: number;
  /** Low-frequency band power, 0.04-0.15 Hz (ms^2). */
  lfPower: number;
  /** High-frequency band power, 0.15-0.40 Hz (ms^2). */
  hfPower: number;
  /** LF/HF ratio — sympathovagal balance indicator. */
  lfHfRatio: number;
  /** Sample entropy of the window, from the SWIBSEA algorithm. */
  entropy: number;
  /** Window entropy divided by the user's personalised baseline entropy. */
  entropyRatio: number;
  /** Minutes since the user was last physically active. */
  inactivityMinutes: number;
  /** Hour of day, 0-23, as a behavioural/contextual feature. */
  hourOfDay: number;
  /** Mean heart rate over the window (bpm) — retained for rule evaluation. */
  meanBpm: number;
}

/** Ordered feature names. The order defines the numeric vector layout used by
 *  the trained model, so it must stay in sync with the training script. */
export const FEATURE_NAMES: (keyof FeatureVector)[] = [
  'meanRR',
  'sdnn',
  'rmssd',
  'pnn50',
  'lfPower',
  'hfPower',
  'lfHfRatio',
  'entropy',
  'entropyRatio',
  'inactivityMinutes',
  'hourOfDay',
  'meanBpm',
];

/** Convert a FeatureVector to the ordered numeric array the model expects. */
export function toFeatureArray(f: FeatureVector): number[] {
  return FEATURE_NAMES.map((name) => f[name]);
}
