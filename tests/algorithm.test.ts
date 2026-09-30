/**
 * tests/algorithm.test.ts
 *
 * Verifies the RPRV pipeline against the worked examples given in the study,
 * plus the client-specified absolute heart-rate rules.
 *
 * Run with:  npm run test:algo
 */

import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import { sampleEntropy, thresholdsFor, computeBaseline, estimateEntropy } from '../lib/rprv/swibsea';
import {
  ELEVATED_SUSTAIN_MS,
  RECOVERY_DWELL_MS,
  initialContext,
  step,
} from '../lib/rprv/fsm';
import type { FsmContext, FsmInput } from '../lib/rprv/fsm';
import { classify } from '../lib/rprv/randomForest';
import type { RandomForestModel } from '../lib/rprv/randomForest';
import model from '../lib/rprv/model.json';
import type { FeatureVector, PulseSample } from '../lib/rprv/types';

const MINUTE = 60_000;

/** The study's worked example uses a personalised baseline of 1.40. */
const BASELINE = 1.4;
const TH = thresholdsFor(BASELINE);

function input(over: Partial<FsmInput> = {}): FsmInput {
  return {
    now: 0,
    entropy: BASELINE,
    thresholds: TH,
    stressProbability: 0.1,
    meanBpm: 70,
    warnBpm: 120,
    emergencyBpm: 150,
    userOverride: false,
    ...over,
  };
}

describe('SWIBSEA thresholds', () => {
  test('match the study: 0.85 shift, 0.90 recovery', () => {
    // The study states a detection threshold of 0.85 x 1.40 = 1.19.
    assert.equal(Number(TH.shift.toFixed(2)), 1.19);
    assert.equal(Number(TH.recovery.toFixed(2)), 1.26);
  });

  test("study's Table 1 entropies land in the stated states", () => {
    // Window 2: 1.35, ratio 0.96 -> CALM (at or above shift threshold)
    assert.ok(1.35 >= TH.shift);
    // Window 3: 1.15, ratio 0.82 -> ELEVATED (below shift)
    assert.ok(1.15 < TH.shift);
    // Window 4: 0.98, ratio 0.70 -> STRESS, but still above critical
    assert.ok(0.98 < TH.shift && 0.98 > TH.critical);
  });
});

describe('sample entropy', () => {
  test('a perfectly regular series has zero entropy', () => {
    assert.equal(sampleEntropy(new Array(60).fill(850)), 0);
  });

  test('an irregular series scores higher than a near-regular one', () => {
    const regular = Array.from({ length: 120 }, (_, i) => 850 + (i % 2));
    const irregular = Array.from({ length: 120 }, (_, i) =>
      850 + 40 * Math.sin(i * 1.7) + 25 * Math.sin(i * 0.41),
    );
    assert.ok(sampleEntropy(irregular) > sampleEntropy(regular));
  });

  test('refuses to estimate from too few samples', () => {
    const sparse: PulseSample[] = Array.from({ length: 10 }, (_, i) => ({
      bpm: 70, at: i * 5_000,
    }));
    const est = estimateEntropy(sparse, 50_000);
    assert.equal(est.usable, false);
    assert.equal(est.entropy, null);
  });

  test('widens the window on a sparse feed until it has enough samples', () => {
    // One sample every 5 s, as Health Connect delivers.
    const samples: PulseSample[] = Array.from({ length: 80 }, (_, i) => ({
      bpm: 68 + (i % 7), at: i * 5_000,
    }));
    const est = estimateEntropy(samples, 400_000);
    assert.ok(est.usable);
    assert.ok(est.sampleCount >= 30);
    // It had to reach past the study's 60 s window to get there.
    assert.ok(est.spanMs > 60_000);
  });

  test('computeBaseline uses the median, so one bad window cannot drag it', () => {
    const windows = [1.4, 1.38, 1.42, 1.41, 0.2].map((entropy, i) => ({
      startsAt: i, endsAt: i, entropy, sampleCount: 60,
    }));
    const baseline = computeBaseline(windows)!;
    assert.ok(baseline > 1.3, `expected a baseline near 1.4, got ${baseline}`);
  });
});

describe("FSM — the study's worked scenario", () => {
  test('07:45 commute: entropy 1.15, P_stress 0.6 -> ELEVATED, Level 1', () => {
    const r = step(initialContext(0), input({ entropy: 1.15, stressProbability: 0.6 }));
    assert.equal(r.to, 'ELEVATED');
    assert.equal(r.tier, 1);
    assert.ok(r.trace.some((t) => t.rule === 'CALM -> ELEVATED' && t.fired));
  });

  test('08:10 sustained 10 min -> STRESS, Level 2', () => {
    let ctx = step(initialContext(0), input({ entropy: 1.15, stressProbability: 0.6 })).context;
    const r = step(ctx, input({ now: ELEVATED_SUSTAIN_MS, entropy: 1.15, stressProbability: 0.6 }));
    assert.equal(r.to, 'STRESS');
    assert.equal(r.tier, 2);
  });

  test('P_stress above 0.7 escalates immediately without waiting 10 min', () => {
    const ctx = step(initialContext(0), input({ entropy: 1.15, stressProbability: 0.6 })).context;
    const r = step(ctx, input({ now: MINUTE, entropy: 1.15, stressProbability: 0.75 }));
    assert.equal(r.to, 'STRESS');
  });

  test('recovery to 1.30 held for 5 min steps ELEVATED down to CALM', () => {
    let ctx: FsmContext = step(initialContext(0), input({ entropy: 1.15, stressProbability: 0.6 })).context;
    // Entropy recovers, but the dwell has not been served yet.
    let r = step(ctx, input({ now: MINUTE, entropy: 1.3, stressProbability: 0.1 }));
    assert.equal(r.to, 'ELEVATED');
    ctx = r.context;
    r = step(ctx, input({ now: MINUTE + RECOVERY_DWELL_MS, entropy: 1.3, stressProbability: 0.1 }));
    assert.equal(r.to, 'CALM');
  });

  test('a dip below recovery restarts the dwell', () => {
    let ctx = step(initialContext(0), input({ entropy: 1.15, stressProbability: 0.6 })).context;
    ctx = step(ctx, input({ now: MINUTE, entropy: 1.3 })).context;
    // Dip back down at the four-minute mark.
    ctx = step(ctx, input({ now: 4 * MINUTE, entropy: 1.1 })).context;
    // Six minutes after the original recovery, the dwell has NOT been served.
    const r = step(ctx, input({ now: 7 * MINUTE, entropy: 1.3 }));
    assert.equal(r.to, 'ELEVATED');
  });
});

describe('FSM — escalation to ACUTE', () => {
  test('entropy below the critical threshold escalates STRESS to ACUTE', () => {
    const ctx: FsmContext = {
      state: 'STRESS', enteredAt: 0, recoveringSince: null,
      lastStressSignalAt: 0, episodeTimestamps: [0],
    };
    const r = step(ctx, input({ now: MINUTE, entropy: TH.critical - 0.01 }));
    assert.equal(r.to, 'ACUTE');
    assert.equal(r.tier, 3);
  });

  test('three stress episodes within six hours escalate to ACUTE', () => {
    const ctx: FsmContext = {
      state: 'STRESS', enteredAt: 0, recoveringSince: null,
      lastStressSignalAt: 0,
      episodeTimestamps: [0, 60 * MINUTE, 120 * MINUTE],
    };
    const r = step(ctx, input({ now: 150 * MINUTE, entropy: 1.1 }));
    assert.equal(r.to, 'ACUTE');
  });

  test('episodes older than six hours no longer count', () => {
    const ctx: FsmContext = {
      state: 'STRESS', enteredAt: 0, recoveringSince: null,
      lastStressSignalAt: 0,
      episodeTimestamps: [0, 10 * MINUTE, 20 * MINUTE],
    };
    // Seven hours later all three have aged out of the window.
    const r = step(ctx, input({ now: 7 * 60 * MINUTE, entropy: 1.1 }));
    assert.notEqual(r.to, 'ACUTE');
  });
});

describe('FSM — absolute heart-rate rules (client requirement)', () => {
  test('120 bpm raises a warning even when entropy looks healthy', () => {
    const r = step(initialContext(0), input({ entropy: BASELINE, meanBpm: 121 }));
    assert.equal(r.to, 'ELEVATED');
    assert.ok(r.trace.some((t) => t.rule === 'heart rate — warning' && t.fired));
  });

  test('119 bpm does not', () => {
    const r = step(initialContext(0), input({ entropy: BASELINE, meanBpm: 119 }));
    assert.equal(r.to, 'CALM');
  });

  test('the emergency threshold jumps straight to ACUTE from CALM', () => {
    const r = step(initialContext(0), input({ entropy: BASELINE, meanBpm: 155 }));
    assert.equal(r.to, 'ACUTE');
    assert.equal(r.tier, 3);
  });

  test('ACUTE will not de-escalate while the pulse is still at emergency level', () => {
    const ctx: FsmContext = {
      state: 'ACUTE', enteredAt: 0, recoveringSince: 0,
      lastStressSignalAt: 0, episodeTimestamps: [],
    };
    const r = step(ctx, input({ now: 60 * MINUTE, entropy: BASELINE, meanBpm: 160 }));
    assert.equal(r.to, 'ACUTE');
  });

  test('a user override clears ACUTE once the pulse has come down', () => {
    const ctx: FsmContext = {
      state: 'ACUTE', enteredAt: 0, recoveringSince: null,
      lastStressSignalAt: 0, episodeTimestamps: [],
    };
    const r = step(ctx, input({ now: MINUTE, entropy: 1.0, meanBpm: 90, userOverride: true }));
    assert.equal(r.to, 'STRESS');
  });
});

describe('FSM — baseline gating and notification hygiene', () => {
  test('without a baseline, entropy rules are skipped', () => {
    const r = step(initialContext(0), input({ entropy: null, thresholds: null }));
    assert.equal(r.entropyAvailable, false);
    assert.equal(r.to, 'CALM');
    assert.ok(r.trace.some((t) => t.rule === 'entropy gate'));
  });

  test('the classifier alone can still escalate without a baseline', () => {
    const r = step(initialContext(0), input({
      entropy: null, thresholds: null, stressProbability: 0.8,
    }));
    assert.equal(r.to, 'ELEVATED');
  });

  test('staying in a state does not re-fire its notification', () => {
    const ctx = step(initialContext(0), input({ entropy: 1.15, stressProbability: 0.6 })).context;
    const r = step(ctx, input({ now: MINUTE, entropy: 1.15, stressProbability: 0.6 }));
    assert.equal(r.transitioned, false);
    assert.equal(r.tier, 0);
  });

  test('30 minutes with no stress signal returns any state to CALM', () => {
    const ctx: FsmContext = {
      state: 'STRESS', enteredAt: 0, recoveringSince: null,
      lastStressSignalAt: 0, episodeTimestamps: [0],
    };
    const r = step(ctx, input({ now: 31 * MINUTE, entropy: 1.35, stressProbability: 0.05 }));
    assert.equal(r.to, 'CALM');
  });
});

describe('Random Forest model', () => {
  const rf = model as unknown as RandomForestModel;

  function features(over: Partial<FeatureVector> = {}): FeatureVector {
    return {
      meanRR: 857, sdnn: 55, rmssd: 42, pnn50: 0.25,
      lfPower: 900, hfPower: 800, lfHfRatio: 1.1,
      entropy: 1.4, entropyRatio: 1.0,
      inactivityMinutes: 10, hourOfDay: 10, meanBpm: 70,
      ...over,
    };
  }

  test('ships with the expected schema', () => {
    assert.equal(rf.version, 1);
    assert.equal(rf.trees.length, rf.meta.nTrees);
    assert.deepEqual(rf.classes, ['calm', 'stress', 'anxiety', 'sadness', 'peace']);
  });

  test('vote shares sum to 1 and confidence is the winning share', () => {
    const c = classify(rf, features());
    const total = Object.values(c.votes).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-9);
    assert.equal(c.confidence, c.votes[c.emotion]);
  });

  test('a relaxed, highly variable profile is not classified as stress', () => {
    const c = classify(rf, features({
      meanBpm: 64, meanRR: 937, sdnn: 62, rmssd: 55,
      hfPower: 1400, lfPower: 600, lfHfRatio: 0.43, entropyRatio: 1.05,
    }));
    assert.ok(['calm', 'peace'].includes(c.emotion), `got ${c.emotion}`);
  });

  test('a fast, rigid profile reads as sympathetic activation', () => {
    const c = classify(rf, features({
      meanBpm: 108, meanRR: 555, sdnn: 14, rmssd: 9, pnn50: 0.01,
      hfPower: 90, lfPower: 800, lfHfRatio: 8.9,
      entropy: 0.9, entropyRatio: 0.64,
    }));
    assert.ok(['stress', 'anxiety'].includes(c.emotion), `got ${c.emotion}`);
    assert.ok(c.stressProbability > 0.2);
  });

  test('explain mode returns one decision path per tree', () => {
    const c = classify(rf, features(), true);
    assert.equal(c.perTree?.length, rf.trees.length);
    assert.ok(c.perTree![0].path.length > 0);
  });
});
