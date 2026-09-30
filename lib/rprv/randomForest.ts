/**
 * lib/rprv/randomForest.ts
 *
 * Random Forest classifier for emotional state recognition from RPRV features.
 *
 * Implements the design specified by the study:
 *   - An ensemble of decision trees.
 *   - Each tree is grown on a BOOTSTRAP SAMPLE of the training data and
 *     considers a RANDOM SUBSET OF FEATURES at each split.
 *   - Each tree independently predicts an emotional state.
 *   - The final classification is decided by MAJORITY VOTE across all trees.
 *   - The fraction of trees voting for the winning class is reported as the
 *     CONFIDENCE PROBABILITY.
 *
 * This ensemble design reduces overfitting relative to a single decision tree
 * and is robust to the small-to-medium physiological datasets typical of
 * wearable emotion recognition.
 *
 * Both training and inference are implemented here in plain TypeScript with no
 * native dependency, so the same code path produces the shipped model offline
 * (scripts/train-random-forest.mjs) and evaluates it on-device. That matters
 * for the algorithm transparency screen: what the user sees explained is
 * literally the code that produced the answer.
 */

import { EMOTION_CLASSES, FEATURE_NAMES, toFeatureArray } from './types';
import type { EmotionClass, FeatureVector } from './types';

// ─────────────────────────────────────────────────────────────────────────────
// Model representation
// ─────────────────────────────────────────────────────────────────────────────

/** An internal decision node: route left when value <= threshold. */
export interface SplitNode {
  kind: 'split';
  /** Index into FEATURE_NAMES. */
  feature: number;
  threshold: number;
  left: TreeNode;
  right: TreeNode;
}

/** A terminal node carrying a class distribution. */
export interface LeafNode {
  kind: 'leaf';
  /** Index into EMOTION_CLASSES. */
  classIndex: number;
  /** Per-class sample proportions at this leaf, for reporting. */
  distribution: number[];
  /** Number of training samples that reached this leaf. */
  samples: number;
}

export type TreeNode = SplitNode | LeafNode;

export interface RandomForestModel {
  /** Schema version, so a stale bundled model is detected rather than misread. */
  version: number;
  /** Feature order this model was trained against. */
  featureNames: string[];
  /** Class order this model was trained against. */
  classes: string[];
  trees: TreeNode[];
  /** Training metadata, surfaced on the algorithm screen. */
  meta: {
    trainedAt: string;
    trainingSamples: number;
    nTrees: number;
    maxDepth: number;
    maxFeatures: number;
    /** Mean 5-fold cross-validation accuracy. */
    cvAccuracy: number;
    /** Per-class precision / recall / F1 from cross-validation. */
    perClass: Record<string, { precision: number; recall: number; f1: number }>;
    /** Gini feature importances, normalised to sum to 1. */
    featureImportance: Record<string, number>;
    /** Provenance of the training data. */
    dataSource: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic RNG
// ─────────────────────────────────────────────────────────────────────────────

/**
 * mulberry32 — a small seeded PRNG.
 *
 * Training must be reproducible: re-running the training script with the same
 * seed has to produce the same forest, otherwise the accuracy figures reported
 * in the app could not be reproduced or defended.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Training
// ─────────────────────────────────────────────────────────────────────────────

export interface TrainOptions {
  /** Number of trees in the ensemble. */
  nTrees: number;
  /** Maximum tree depth. */
  maxDepth: number;
  /** Minimum samples required to attempt a split. */
  minSamplesSplit: number;
  /** Minimum samples permitted in a leaf. */
  minSamplesLeaf: number;
  /** Features considered per split. Defaults to floor(sqrt(nFeatures)). */
  maxFeatures?: number;
  /** RNG seed, for reproducible forests. */
  seed: number;
}

export const DEFAULT_TRAIN_OPTIONS: TrainOptions = {
  nTrees: 60,
  maxDepth: 8,
  minSamplesSplit: 8,
  minSamplesLeaf: 4,
  seed: 20260907,
};

/** Gini impurity of a class-count histogram. */
export function gini(counts: number[], total: number): number {
  if (total === 0) return 0;
  let sum = 0;
  for (const c of counts) {
    const p = c / total;
    sum += p * p;
  }
  return 1 - sum;
}

function classCounts(labels: number[], indices: number[], nClasses: number): number[] {
  const counts = new Array(nClasses).fill(0);
  for (const i of indices) counts[labels[i]]++;
  return counts;
}

interface BestSplit {
  feature: number;
  threshold: number;
  left: number[];
  right: number[];
  impurityDrop: number;
}

/**
 * Search a random subset of features for the split that most reduces Gini
 * impurity.
 *
 * Thresholds are evaluated by sorting the node's samples on the candidate
 * feature once and then sweeping the split point from left to right, moving
 * one sample across the boundary at a time and updating the two class
 * histograms incrementally. Recomputing both histograms from scratch at every
 * candidate threshold would make training quadratic in the node size, which is
 * too slow to cross-validate a 60-tree forest.
 */
function findBestSplit(
  X: number[][],
  labels: number[],
  indices: number[],
  nClasses: number,
  maxFeatures: number,
  minSamplesLeaf: number,
  rng: () => number,
): BestSplit | null {
  const n = indices.length;
  const nFeatures = X[0].length;
  const parentCounts = classCounts(labels, indices, nClasses);
  const parentImpurity = gini(parentCounts, n);
  if (parentImpurity === 0) return null;

  // Draw the feature subset without replacement (partial Fisher-Yates).
  const pool = Array.from({ length: nFeatures }, (_, i) => i);
  for (let i = 0; i < maxFeatures && i < nFeatures; i++) {
    const j = i + Math.floor(rng() * (nFeatures - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const candidates = pool.slice(0, Math.min(maxFeatures, nFeatures));

  let best: BestSplit | null = null;

  for (const feature of candidates) {
    const order = [...indices].sort((a, b) => X[a][feature] - X[b][feature]);

    const leftCounts = new Array(nClasses).fill(0);
    const rightCounts = [...parentCounts];

    for (let k = 0; k < n - 1; k++) {
      const moved = order[k];
      leftCounts[labels[moved]]++;
      rightCounts[labels[moved]]--;

      const vHere = X[moved][feature];
      const vNext = X[order[k + 1]][feature];
      // Identical values cannot be separated by a threshold.
      if (vHere === vNext) continue;

      const leftSize = k + 1;
      const rightSize = n - leftSize;
      if (leftSize < minSamplesLeaf || rightSize < minSamplesLeaf) continue;

      const weighted =
        (leftSize / n) * gini(leftCounts, leftSize) +
        (rightSize / n) * gini(rightCounts, rightSize);
      const drop = parentImpurity - weighted;

      if (!best || drop > best.impurityDrop) {
        best = {
          feature,
          threshold: (vHere + vNext) / 2,
          left: order.slice(0, leftSize),
          right: order.slice(leftSize),
          impurityDrop: drop,
        };
      }
    }
  }

  return best && best.impurityDrop > 1e-9 ? best : null;
}

function makeLeaf(labels: number[], indices: number[], nClasses: number): LeafNode {
  const counts = classCounts(labels, indices, nClasses);
  let classIndex = 0;
  for (let c = 1; c < counts.length; c++) {
    if (counts[c] > counts[classIndex]) classIndex = c;
  }
  return {
    kind: 'leaf',
    classIndex,
    distribution: counts.map((c) => c / indices.length),
    samples: indices.length,
  };
}

/**
 * Grow one decision tree, accumulating weighted Gini importance per feature.
 */
function growTree(
  X: number[][],
  labels: number[],
  indices: number[],
  nClasses: number,
  depth: number,
  opts: Required<Pick<TrainOptions, 'maxDepth' | 'minSamplesSplit' | 'minSamplesLeaf'>> & { maxFeatures: number },
  rng: () => number,
  importance: number[],
  totalSamples: number,
): TreeNode {
  if (
    depth >= opts.maxDepth ||
    indices.length < opts.minSamplesSplit
  ) {
    return makeLeaf(labels, indices, nClasses);
  }

  const split = findBestSplit(
    X, labels, indices, nClasses, opts.maxFeatures, opts.minSamplesLeaf, rng,
  );
  if (!split) return makeLeaf(labels, indices, nClasses);

  // Gini importance: impurity drop weighted by the share of samples reaching
  // this node. Summed across trees this ranks the features the forest relies on.
  importance[split.feature] += (indices.length / totalSamples) * split.impurityDrop;

  return {
    kind: 'split',
    feature: split.feature,
    threshold: split.threshold,
    left: growTree(X, labels, split.left, nClasses, depth + 1, opts, rng, importance, totalSamples),
    right: growTree(X, labels, split.right, nClasses, depth + 1, opts, rng, importance, totalSamples),
  };
}

export interface TrainResult {
  trees: TreeNode[];
  /** Normalised Gini importance per feature, in FEATURE_NAMES order. */
  featureImportance: number[];
}

/**
 * Train the forest.
 *
 * @param X      Feature matrix, one row per sample, columns in FEATURE_NAMES order.
 * @param labels Class indices into EMOTION_CLASSES.
 */
export function trainForest(
  X: number[][],
  labels: number[],
  options: Partial<TrainOptions> = {},
): TrainResult {
  const opts = { ...DEFAULT_TRAIN_OPTIONS, ...options };
  const nClasses = EMOTION_CLASSES.length;
  const nFeatures = X[0].length;
  const maxFeatures = opts.maxFeatures ?? Math.max(1, Math.floor(Math.sqrt(nFeatures)));
  const rng = makeRng(opts.seed);
  const importance = new Array(nFeatures).fill(0);
  const trees: TreeNode[] = [];

  for (let t = 0; t < opts.nTrees; t++) {
    // Bootstrap sample: draw N samples WITH replacement, per the study's design.
    const bootstrap: number[] = [];
    for (let i = 0; i < X.length; i++) {
      bootstrap.push(Math.floor(rng() * X.length));
    }
    trees.push(
      growTree(
        X, labels, bootstrap, nClasses, 0,
        {
          maxDepth: opts.maxDepth,
          minSamplesSplit: opts.minSamplesSplit,
          minSamplesLeaf: opts.minSamplesLeaf,
          maxFeatures,
        },
        rng, importance, X.length,
      ),
    );
  }

  const importanceTotal = importance.reduce((a, b) => a + b, 0);
  return {
    trees,
    featureImportance: importanceTotal > 0
      ? importance.map((v) => v / importanceTotal)
      : importance,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inference
// ─────────────────────────────────────────────────────────────────────────────

/** One step of a tree's decision path, for the transparency screen. */
export interface DecisionStep {
  feature: string;
  value: number;
  threshold: number;
  wentLeft: boolean;
}

export interface TreeVote {
  treeIndex: number;
  classIndex: number;
  /** The path this tree took to reach its leaf. */
  path: DecisionStep[];
}

/** Walk one tree, recording the path taken. */
export function classifyTree(
  node: TreeNode,
  x: number[],
  path: DecisionStep[] = [],
): { classIndex: number; path: DecisionStep[] } {
  let current = node;
  while (current.kind === 'split') {
    const value = x[current.feature];
    const wentLeft = value <= current.threshold;
    path.push({
      feature: FEATURE_NAMES[current.feature] as string,
      value,
      threshold: current.threshold,
      wentLeft,
    });
    current = wentLeft ? current.left : current.right;
  }
  return { classIndex: current.classIndex, path };
}

export interface Classification {
  /** The majority-vote class. */
  emotion: EmotionClass;
  /** Fraction of trees voting for the winning class — the confidence probability. */
  confidence: number;
  /** Vote share per class, in EMOTION_CLASSES order. */
  votes: Record<EmotionClass, number>;
  /** Probability assigned to the 'stress' class — P_stress in the FSM rules. */
  stressProbability: number;
  /** Total trees consulted. */
  treeCount: number;
  /** Per-tree votes with decision paths. Present only when explain=true. */
  perTree?: TreeVote[];
}

/**
 * Classify a feature vector by majority vote across the ensemble.
 *
 * @param explain When true, the full per-tree decision paths are returned so
 *                the algorithm screen can show exactly how the answer was
 *                reached. Skipped by default — the paths are large and are not
 *                needed for routine monitoring.
 */
export function classify(
  model: RandomForestModel,
  features: FeatureVector,
  explain = false,
): Classification {
  const x = toFeatureArray(features);
  const counts = new Array(model.classes.length).fill(0);
  const perTree: TreeVote[] = [];

  model.trees.forEach((tree, treeIndex) => {
    const { classIndex, path } = classifyTree(tree, x, []);
    counts[classIndex]++;
    if (explain) perTree.push({ treeIndex, classIndex, path });
  });

  const total = model.trees.length;
  let winner = 0;
  for (let c = 1; c < counts.length; c++) {
    if (counts[c] > counts[winner]) winner = c;
  }

  const votes = {} as Record<EmotionClass, number>;
  model.classes.forEach((name, i) => {
    votes[name as EmotionClass] = counts[i] / total;
  });

  const stressIndex = model.classes.indexOf('stress');

  return {
    emotion: model.classes[winner] as EmotionClass,
    confidence: counts[winner] / total,
    votes,
    // P_stress drives the FSM transitions, so it is read out explicitly rather
    // than inferred from the winning class: a window can be 45% stress without
    // stress winning the vote, and the FSM still needs to see that 0.45.
    stressProbability: stressIndex >= 0 ? counts[stressIndex] / total : 0,
    treeCount: total,
    perTree: explain ? perTree : undefined,
  };
}

/** Predict just the class index — the hot path used during cross-validation. */
export function predictIndex(trees: TreeNode[], x: number[], nClasses: number): number {
  const counts = new Array(nClasses).fill(0);
  for (const tree of trees) {
    counts[classifyTree(tree, x, []).classIndex]++;
  }
  let winner = 0;
  for (let c = 1; c < counts.length; c++) {
    if (counts[c] > counts[winner]) winner = c;
  }
  return winner;
}
