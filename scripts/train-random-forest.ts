/**
 * scripts/train-random-forest.ts
 *
 * Offline trainer that produces lib/rprv/model.json — the Random Forest the
 * app loads at runtime for emotional state classification.
 *
 * Run with:  npm run train:model
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TRAINING DATA PROVENANCE — READ THIS BEFORE CITING ANY ACCURACY FIGURE
 * ─────────────────────────────────────────────────────────────────────────────
 * The study specifies training on the PhysioNet Fantasia dataset together with
 * supplemental PRV-labelled data. That corpus is NOT bundled with this
 * repository, so this script trains on a SYNTHETIC dataset instead.
 *
 * The synthesis is not arbitrary. For each simulated subject and each of the
 * five emotional classes, we generate a physiologically-shaped inter-beat
 * interval series from three components that are well established in the
 * heart-rate-variability literature:
 *
 *   - a class-specific mean heart rate,
 *   - a respiratory sinus arrhythmia oscillation in the HF band (~0.25 Hz),
 *     whose amplitude reflects parasympathetic (vagal) tone,
 *   - a Mayer-wave oscillation in the LF band (~0.1 Hz), which rises with
 *     sympathetic activation,
 *   - plus additive measurement noise.
 *
 * Sympathetic dominance (stress, anxiety) is therefore encoded the way the
 * study describes it: a faster, more regular pulse with suppressed HF content
 * and a raised LF/HF ratio, which the entropy measure reads as reduced
 * variability. The resulting series are then passed through the SAME
 * extractFeatures() used on-device, so the model is trained on exactly the
 * feature distribution it will see at inference time, including the sparse
 * sampling rate that Health Connect and HealthKit actually deliver.
 *
 * What this means in practice: the cross-validation figures below measure how
 * well the forest separates the SIMULATED classes. They are a check that the
 * pipeline is coherent and that the features carry the intended signal. They
 * are NOT evidence of accuracy against real labelled human emotion, and must
 * not be reported as such. Swap in a real labelled corpus via loadRealDataset()
 * to obtain defensible figures.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { extractFeatures } from '../lib/rprv/features';
import {
  MAX_ENTROPY_SPAN_MS,
  TARGET_ENTROPY_SAMPLES,
  sampleEntropy,
} from '../lib/rprv/swibsea';
import {
  DEFAULT_TRAIN_OPTIONS,
  makeRng,
  predictIndex,
  trainForest,
} from '../lib/rprv/randomForest';
import type { RandomForestModel } from '../lib/rprv/randomForest';
import { EMOTION_CLASSES, FEATURE_NAMES, toFeatureArray } from '../lib/rprv/types';
import type { EmotionClass, FeatureVector, PulseSample } from '../lib/rprv/types';

// ─────────────────────────────────────────────────────────────────────────────
// Class profiles
// ─────────────────────────────────────────────────────────────────────────────

interface ClassProfile {
  /** Mean heart rate range (bpm). */
  bpm: [number, number];
  /** HF (respiratory) oscillation amplitude range, in ms of RR modulation. */
  hfAmp: [number, number];
  /** LF (Mayer wave) oscillation amplitude range, in ms of RR modulation. */
  lfAmp: [number, number];
  /** Additive noise standard deviation range (ms). */
  noise: [number, number];
  /** Inactivity minutes range — a behavioural feature. */
  inactivity: [number, number];
  /** Hours of day this state is weighted toward. */
  hours: number[];
}

/**
 * Hour-of-day pool for a class: every waking hour is possible, with the
 * characteristic hours merely appearing twice.
 *
 * An earlier version gave each class a narrow hour range and a narrow
 * inactivity range. The forest promptly learned the clock instead of the
 * physiology — inactivityMinutes alone carried 24% of the Gini importance,
 * because "inactive for 45+ minutes" was a near-perfect tell for sadness in
 * the generator and in nothing else. That is leakage from the simulation, not
 * a finding about emotion, and a model trained on it would collapse on real
 * data where people sit still for every reason under the sun.
 *
 * Behavioural features are kept because the study specifies them and the
 * situational rules use them, but they are deliberately made weak: they should
 * break ties, not decide cases.
 */
function weight(characteristic: number[]): number[] {
  const waking = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23];
  return [...waking, ...characteristic];
}

/**
 * Amplitudes are expressed as RR modulation in milliseconds. High HF amplitude
 * means strong vagal tone and an irregular, "breathing" pulse — read by sample
 * entropy as high variability. Suppressing HF while raising LF reproduces the
 * sympathetic dominance the study associates with stress.
 */
const PROFILES: Record<EmotionClass, ClassProfile> = {
  calm: {
    bpm: [62, 78],
    hfAmp: [26, 42],
    lfAmp: [18, 30],
    noise: [8, 16],
    inactivity: [0, 120],
    hours: weight([8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]),
  },
  peace: {
    bpm: [54, 68],
    hfAmp: [36, 55],
    lfAmp: [12, 22],
    noise: [8, 15],
    inactivity: [0, 150],
    hours: weight([5, 6, 7, 20, 21, 22, 23]),
  },
  stress: {
    bpm: [86, 106],
    hfAmp: [6, 14],
    lfAmp: [24, 38],
    noise: [3, 8],
    inactivity: [0, 120],
    hours: weight([8, 9, 10, 11, 13, 14, 15, 16, 17]),
  },
  anxiety: {
    bpm: [98, 126],
    hfAmp: [3, 9],
    lfAmp: [26, 40],
    noise: [2, 6],
    inactivity: [0, 100],
    hours: weight([7, 8, 9, 14, 15, 16, 17, 21, 22]),
  },
  sadness: {
    bpm: [70, 88],
    hfAmp: [10, 19],
    lfAmp: [12, 22],
    noise: [3, 9],
    inactivity: [0, 180],
    hours: weight([10, 11, 15, 16, 17, 20, 21, 22, 23]),
  },
};

/** Sampling cadence the app actually receives, in seconds between samples. */
const SAMPLE_CADENCE_S: number[] = [1, 3, 5];

const SUBJECTS = 70;
const WINDOWS_PER_CLASS_PER_SUBJECT = 8;
const WINDOW_SECONDS = 60;

function uniform(rng: () => number, range: [number, number]): number {
  return range[0] + rng() * (range[1] - range[0]);
}

/** Box-Muller transform for normally distributed measurement noise. */
function gaussian(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Synthesise one 60-second window of pulse samples for a given class.
 *
 * `hrOffset` is a per-subject constant that shifts the subject's whole heart
 * rate range, so that the model cannot separate classes on absolute bpm alone
 * — different people run at genuinely different rates, and the study's design
 * is explicitly built around a PERSONALISED baseline rather than population
 * thresholds.
 */
function synthWindow(
  emotion: EmotionClass,
  rng: () => number,
  hrOffset: number,
  startAt: number,
): PulseSample[] {
  const p = PROFILES[emotion];
  const baseBpm = uniform(rng, p.bpm) + hrOffset;
  const baseRR = 60_000 / baseBpm;
  const hfAmp = uniform(rng, p.hfAmp);
  const lfAmp = uniform(rng, p.lfAmp);
  const noise = uniform(rng, p.noise);

  // Respiratory rate drifts between roughly 12 and 21 breaths per minute.
  const hfFreq = 0.2 + rng() * 0.15;
  const lfFreq = 0.08 + rng() * 0.05;
  const hfPhase = rng() * Math.PI * 2;
  const lfPhase = rng() * Math.PI * 2;

  // A slow linear drift across the window, as pulse rarely sits perfectly flat.
  const drift = (rng() - 0.5) * 0.08 * baseRR;

  const cadence = SAMPLE_CADENCE_S[Math.floor(rng() * SAMPLE_CADENCE_S.length)];
  const samples: PulseSample[] = [];

  // Span the window far enough back to carry TARGET_ENTROPY_SAMPLES intervals
  // at this cadence, capped the same way estimateEntropy caps it. Training on
  // 60-second windows while the app evaluates 300-second ones would train the
  // model on a feature distribution it never sees in production.
  const spanSeconds = Math.min(
    Math.max(WINDOW_SECONDS, TARGET_ENTROPY_SAMPLES * cadence),
    MAX_ENTROPY_SPAN_MS / 1000,
  );

  for (let t = 0; t < spanSeconds; t += cadence) {
    const frac = t / spanSeconds;
    const rr =
      baseRR +
      hfAmp * Math.sin(2 * Math.PI * hfFreq * t + hfPhase) +
      lfAmp * Math.sin(2 * Math.PI * lfFreq * t + lfPhase) +
      gaussian(rng) * noise +
      drift * frac;

    // The device reports whole beats per minute, so quantise the same way.
    const bpm = Math.round(60_000 / Math.max(rr, 200));
    samples.push({ bpm, at: startAt + t * 1000 });
  }

  return samples;
}

interface LabelledSample {
  features: FeatureVector;
  label: number;
}

/**
 * Build the full labelled dataset.
 *
 * Each simulated subject first produces a set of calm windows, whose median
 * entropy becomes that subject's personalised baseline. Every window for that
 * subject is then scored against their own baseline, which is exactly how the
 * app computes entropyRatio at runtime.
 */
function buildDataset(seed: number): LabelledSample[] {
  const rng = makeRng(seed);
  const dataset: LabelledSample[] = [];

  for (let s = 0; s < SUBJECTS; s++) {
    // Resting heart rate varies widely between individuals.
    const hrOffset = (rng() - 0.5) * 24;

    // ── Calibration: derive this subject's personalised baseline entropy ──
    const calmEntropies: number[] = [];
    for (let w = 0; w < 10; w++) {
      const win = synthWindow('calm', rng, hrOffset, 0);
      const intervals = win.map((x) => 60_000 / x.bpm);
      const e = sampleEntropy(intervals);
      if (e > 0) calmEntropies.push(e);
    }
    if (calmEntropies.length < 3) continue;
    calmEntropies.sort((a, b) => a - b);
    const baseline = calmEntropies[Math.floor(calmEntropies.length / 2)];

    // ── Generate labelled windows against that baseline ──
    EMOTION_CLASSES.forEach((emotion, label) => {
      const profile = PROFILES[emotion];
      for (let w = 0; w < WINDOWS_PER_CLASS_PER_SUBJECT; w++) {
        const hour = profile.hours[Math.floor(rng() * profile.hours.length)];
        const when = new Date(2026, 0, 1, hour, Math.floor(rng() * 60));
        const inactivity = uniform(rng, profile.inactivity);

        const win = synthWindow(emotion, rng, hrOffset, when.getTime());
        const features = extractFeatures(win, baseline, inactivity, when);
        if (!features) continue;

        dataset.push({ features, label });
      }
    });
  }

  return dataset;
}

/**
 * Placeholder for a real labelled corpus.
 *
 * To train on Fantasia or your own recordings, load them here as
 * LabelledSample[] and return them from buildDataset(). The rest of the
 * pipeline needs no changes — only the provenance string below.
 */
export function loadRealDataset(): LabelledSample[] | null {
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Evaluation
// ─────────────────────────────────────────────────────────────────────────────

interface Metrics {
  accuracy: number;
  perClass: Record<string, { precision: number; recall: number; f1: number }>;
}

/**
 * Stratified 5-fold cross-validation.
 *
 * Folds are stratified so each holdout contains every class in roughly its
 * population proportion; an unstratified split can leave a class absent from a
 * fold entirely and make its recall undefined.
 */
function crossValidate(
  X: number[][],
  y: number[],
  folds: number,
  seed: number,
): Metrics {
  const nClasses = EMOTION_CLASSES.length;
  const rng = makeRng(seed);

  // Group indices by class, shuffle within class, then deal round-robin.
  const byClass: number[][] = Array.from({ length: nClasses }, () => []);
  y.forEach((label, i) => byClass[label].push(i));
  for (const group of byClass) {
    for (let i = group.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [group[i], group[j]] = [group[j], group[i]];
    }
  }
  const foldIndices: number[][] = Array.from({ length: folds }, () => []);
  for (const group of byClass) {
    group.forEach((idx, k) => foldIndices[k % folds].push(idx));
  }

  // confusion[actual][predicted]
  const confusion = Array.from({ length: nClasses }, () =>
    new Array(nClasses).fill(0),
  );
  let correct = 0;
  let total = 0;

  for (let f = 0; f < folds; f++) {
    const testIdx = foldIndices[f];
    const trainIdx = foldIndices.filter((_, i) => i !== f).flat();

    const { trees } = trainForest(
      trainIdx.map((i) => X[i]),
      trainIdx.map((i) => y[i]),
      { ...DEFAULT_TRAIN_OPTIONS, seed: seed + f },
    );

    for (const i of testIdx) {
      const pred = predictIndex(trees, X[i], nClasses);
      confusion[y[i]][pred]++;
      if (pred === y[i]) correct++;
      total++;
    }
    process.stdout.write(`  fold ${f + 1}/${folds} done\n`);
  }

  const perClass: Metrics['perClass'] = {};
  EMOTION_CLASSES.forEach((name, c) => {
    const tp = confusion[c][c];
    let predictedAsC = 0;
    let actualC = 0;
    for (let k = 0; k < nClasses; k++) {
      predictedAsC += confusion[k][c];
      actualC += confusion[c][k];
    }
    const precision = predictedAsC > 0 ? tp / predictedAsC : 0;
    const recall = actualC > 0 ? tp / actualC : 0;
    const f1 =
      precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
    perClass[name] = { precision, recall, f1 };
  });

  // Print the confusion matrix — the most informative single artefact for
  // judging whether the classes are genuinely separable.
  console.log('\n  Confusion matrix (rows = actual, cols = predicted)');
  console.log('           ' + EMOTION_CLASSES.map((c) => c.padStart(8)).join(''));
  EMOTION_CLASSES.forEach((name, c) => {
    console.log(
      '  ' + name.padEnd(9) + confusion[c].map((v) => String(v).padStart(8)).join(''),
    );
  });

  return { accuracy: total > 0 ? correct / total : 0, perClass };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const seed = DEFAULT_TRAIN_OPTIONS.seed;

  const real = loadRealDataset();
  const dataset = real ?? buildDataset(seed);
  const dataSource = real
    ? 'real labelled corpus'
    : 'synthetic RPRV windows generated from HF/LF oscillation profiles (see scripts/train-random-forest.ts)';

  console.log(`Dataset: ${dataset.length} labelled windows`);
  const counts = new Array(EMOTION_CLASSES.length).fill(0);
  dataset.forEach((d) => counts[d.label]++);
  EMOTION_CLASSES.forEach((c, i) => console.log(`  ${c.padEnd(8)} ${counts[i]}`));

  const X = dataset.map((d) => toFeatureArray(d.features));
  const y = dataset.map((d) => d.label);

  console.log('\nRunning 5-fold cross-validation...');
  const metrics = crossValidate(X, y, 5, seed);
  console.log(`\n  accuracy: ${(metrics.accuracy * 100).toFixed(2)}%`);
  for (const [name, m] of Object.entries(metrics.perClass)) {
    console.log(
      `  ${name.padEnd(8)} precision ${(m.precision * 100).toFixed(1)}%` +
        `  recall ${(m.recall * 100).toFixed(1)}%` +
        `  f1 ${(m.f1 * 100).toFixed(1)}%`,
    );
  }

  console.log('\nTraining final forest on the full dataset...');
  const { trees, featureImportance } = trainForest(X, y, DEFAULT_TRAIN_OPTIONS);

  const importanceMap: Record<string, number> = {};
  FEATURE_NAMES.forEach((name, i) => {
    importanceMap[name as string] = featureImportance[i];
  });

  console.log('\n  Feature importance (Gini):');
  Object.entries(importanceMap)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, v]) => console.log(`    ${name.padEnd(18)} ${(v * 100).toFixed(2)}%`));

  const model: RandomForestModel = {
    version: 1,
    featureNames: FEATURE_NAMES as string[],
    classes: EMOTION_CLASSES,
    trees,
    meta: {
      trainedAt: new Date().toISOString(),
      trainingSamples: dataset.length,
      nTrees: DEFAULT_TRAIN_OPTIONS.nTrees,
      maxDepth: DEFAULT_TRAIN_OPTIONS.maxDepth,
      maxFeatures: Math.floor(Math.sqrt(FEATURE_NAMES.length)),
      cvAccuracy: metrics.accuracy,
      perClass: metrics.perClass,
      featureImportance: importanceMap,
      dataSource,
    },
  };

  // Round on the way out. Full float64 thresholds carry 17 significant digits
  // and inflate the bundled model to ~1 MB, which Metro then has to parse on
  // every cold start. Four significant digits is far finer than the resolution
  // of the features themselves and leaves predictions unchanged.
  const round = (_key: string, value: unknown) =>
    typeof value === 'number' && !Number.isInteger(value)
      ? Number(value.toPrecision(4))
      : value;

  const outPath = join(process.cwd(), 'lib', 'rprv', 'model.json');
  const serialised = JSON.stringify(model, round);
  writeFileSync(outPath, serialised);
  console.log(`\nWrote ${outPath} (${(serialised.length / 1024).toFixed(0)} KB)`);
}

main();
