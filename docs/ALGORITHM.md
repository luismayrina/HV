# HV — Algorithm Reference

How the system decides what to show you, stage by stage, with every constant and rule
written out.

Source of truth for each stage is named in its heading. If this document and the code ever
disagree, the code is right and this document is stale.

---

## Contents

- [1. System scope](#1-system-scope)
- [2. Data flow](#2-data-flow)
- [3. Stage 1 — Feature extraction](#3-stage-1--feature-extraction)
- [4. Stage 2 — SWIBSEA entropy](#4-stage-2--swibsea-entropy)
- [5. Stage 3 — Random Forest classification](#5-stage-3--random-forest-classification)
- [6. Stage 4 — Finite state machine](#6-stage-4--finite-state-machine)
- [7. Stage 5 — Verse recommendation](#7-stage-5--verse-recommendation)
- [8. Absolute heart-rate rules](#8-absolute-heart-rate-rules)
- [9. The daily cycle](#9-the-daily-cycle)
- [10. Deviations from the outline paper](#10-deviations-from-the-outline-paper)
- [11. Client feedback traceability](#11-client-feedback-traceability)
- [12. Data model](#12-data-model)
- [13. Limitations](#13-limitations)

---

## 1. System scope

| Dimension | In scope | Out of scope |
|---|---|---|
| Signal | Heart rate (bpm) from Health Connect / HealthKit | Raw PPG, ECG, EDA, accelerometry |
| Inference | 5 emotional classes, 4 alert states | Diagnosis of any kind |
| Corpus | Curated King James Version set (see §7) | Any verse outside that set |
| Platform | Android + iOS phone; watch is a **data source** | Native Wear OS / watchOS app |
| Timing | 08:00–17:00 collection, 17:01 summary | 24/7 real-time alerting |
| Contacts | SMS composer pre-filled, user presses send | Automatic dispatch, calling |

**What the app is.** A phone app that reads what the watch has already written to the
platform health store, analyses it, and delivers scripture matched to the inferred emotional
state.

**What the app is not.** It is not a sensor, not a medical device, and not a continuous
monitor. It cannot see anything the health store has not been given.

---

## 2. Data flow

```
  Watch (PPG sensor)
        │  writes bpm samples
        ▼
  Health Connect (Android) / HealthKit (iOS)
        │  polled every 3–5 s while app is open
        ▼
  useHeartRateMonitor ──► samples table (SQLite)
        │
        │  every 30 s (foreground) / ~15 min (background)
        ▼
  ┌─────────────────── runTick() ───────────────────┐
  │                                                 │
  │  1. extractFeatures()   → 12-value vector       │
  │  2. estimateEntropy()   → E_win + baseline      │
  │  3. classify()          → emotion + P_stress    │
  │  4. step()              → state + tier          │
  │  5. recommend()         → verse                 │
  │                                                 │
  └─────────────────────────────────────────────────┘
        │
        ├──► windows table      (full audit trail)
        ├──► episodes table     (transitions)
        ├──► notifications      (what was delivered)
        └──► notification to the user
```

---

## 3. Stage 1 — Feature extraction

**Source:** [`lib/rprv/features.ts`](../lib/rprv/features.ts)

Inter-beat intervals are reconstructed as `RR = 60000 / bpm`, then reduced to 12 features.

| # | Feature | Unit | Domain | What it measures |
|---|---|---|---|---|
| 1 | `meanRR` | ms | time | Mean inter-beat interval |
| 2 | `sdnn` | ms | time | Standard deviation of intervals — overall variability |
| 3 | `rmssd` | ms | time | Root mean square of successive differences — short-term variability |
| 4 | `pnn50` | 0–1 | time | Proportion of successive intervals differing by >50 ms |
| 5 | `lfPower` | ms² | frequency | Power in 0.04–0.15 Hz — Mayer waves, sympathetic activity |
| 6 | `hfPower` | ms² | frequency | Power in 0.15–0.40 Hz — respiratory sinus arrhythmia, vagal tone |
| 7 | `lfHfRatio` | — | frequency | Sympathovagal balance |
| 8 | `entropy` | — | entropy | Sample entropy from SWIBSEA |
| 9 | `entropyRatio` | × | entropy | `entropy / personal baseline` |
| 10 | `inactivityMinutes` | min | behavioural | Minutes since last inferred activity |
| 11 | `hourOfDay` | 0–23 | behavioural | Time of day |
| 12 | `meanBpm` | bpm | time | Mean heart rate |

**Frequency-domain method.** An RR series is unevenly sampled by construction — each
interval advances time by its own duration. A standard FFT would need resampling and
interpolation first, which introduces artefacts. We use a **Lomb–Scargle periodogram**,
which estimates spectral power directly on unevenly spaced data.

**Guards:**

| Guard | Value | Reason |
|---|---|---|
| `MIN_PLAUSIBLE_BPM` | 25 | Sensor glitches are dropped, not clamped |
| `MAX_PLAUSIBLE_BPM` | 240 | Same |
| `MIN_SAMPLES_PER_WINDOW` | 6 | Below this, no feature vector is produced |
| `lfHfRatio` when `hfPower ≈ 0` | `0` | Prevents `Infinity` poisoning every tree comparison |

---

## 4. Stage 2 — SWIBSEA entropy

**Source:** [`lib/rprv/swibsea.ts`](../lib/rprv/swibsea.ts)

Sliding Window-Based Signal Entropy Analysis. **High entropy = variable = relaxed.
Low entropy = regular = sympathetic dominance = stress.**

### Parameters

| Constant | Value | Meaning |
|---|---|---|
| `WINDOW_MS` | 60 000 | Nominal window length |
| `WINDOW_OVERLAP` | 0.5 | 50% overlap |
| `WINDOW_STEP_MS` | 30 000 | New estimate every 30 s |
| `ENTROPY_SHIFT_RATIO` | **0.85** | Below this × baseline → emotional shift flagged |
| `ENTROPY_RECOVERY_RATIO` | **0.90** | At/above this × baseline → de-escalation |
| `ENTROPY_CRITICAL_RATIO` | **0.65** | Below this × baseline → escalate to ACUTE |
| `TARGET_ENTROPY_SAMPLES` | 60 | Intervals the estimate aims for |
| `MIN_ENTROPY_SAMPLES` | 30 | Below this, entropy is reported as **unavailable** |
| `MAX_ENTROPY_SPAN_MS` | 300 000 | Cap on window widening |
| `SAMPEN_R_FACTOR` | 0.2 | Tolerance `r = 0.2 × SD` |

`ENTROPY_CRITICAL_RATIO` is **our** calibration constant. The paper names `E_critical` in the
transition rules but never fixes its value; we set it below the 0.70 ratio the paper's own
worked example labels STRESS.

### Adaptive embedding dimension

`m` is chosen from the series length, because `m = 2` collapses toward zero on short series.
Measured separation of calm vs stress (Cohen's *d*):

| N intervals | m = 1 | m = 2 | Chosen |
|---|---|---|---|
| 12 | −0.03 | −0.34 | *refuses to estimate* |
| 36 | **1.49** | 0.41 | m = 1 |
| 60 | **1.79** | 1.14 | m = 1 |
| 100 | 0.65 | **1.24** | m = 2 |
| 300 | 2.49 | **3.88** | m = 2 |

Rule: `m = 2` when `N ≥ 100`, else `m = 1`.

### Worked example (from the paper, baseline 1.40 → threshold 1.19)

| Window | Span | Entropy | Ratio | State |
|---|---|---|---|---|
| 1 | 0:00–1:00 | 1.42 | 1.01 | CALM |
| 2 | 0:30–1:30 | 1.35 | 0.96 | CALM |
| 3 | 1:00–2:00 | 1.15 | 0.82 | ELEVATED |
| 4 | 1:30–2:30 | 0.98 | 0.70 | STRESS |

Verified in [`tests/algorithm.test.ts`](../tests/algorithm.test.ts).

### Baseline

Computed as the **median** entropy of the morning segment's windows (minimum 5 windows).
Median rather than mean, so one agitated morning window cannot drag the baseline down and
suppress genuine detections for the rest of the day.

---

## 5. Stage 3 — Random Forest classification

**Source:** [`lib/rprv/randomForest.ts`](../lib/rprv/randomForest.ts) ·
**Trainer:** [`scripts/train-random-forest.ts`](../scripts/train-random-forest.ts)

### How it works

1. Grow `nTrees` decision trees.
2. Each tree trains on a **bootstrap sample** (N draws with replacement).
3. At each split, only a **random subset of features** is considered (`√12 → 3`).
4. Splits are chosen to maximise **Gini impurity** reduction.
5. Each tree votes; **majority wins**; the winning vote share is the **confidence**.

### Hyperparameters

| Parameter | Value |
|---|---|
| Trees | 60 |
| Max depth | 8 |
| Min samples to split | 8 |
| Min samples per leaf | 4 |
| Features per split | 3 (`⌊√12⌋`) |
| RNG seed | 20260907 (reproducible) |
| Training windows | 2 800 (560 × 5 classes) |

### Performance — stratified 5-fold cross-validation

**Overall accuracy: 83.82%**

| Class | Precision | Recall | F1 |
|---|---|---|---|
| calm | 81.2% | 84.6% | 82.9% |
| stress | 75.4% | 77.3% | 76.4% |
| anxiety | 83.8% | 82.3% | 83.1% |
| sadness | 92.4% | 93.0% | 92.7% |
| peace | 86.7% | 81.8% | 84.2% |

### Confusion matrix (rows = actual, columns = predicted)

| | calm | stress | anxiety | sadness | peace |
|---|---|---|---|---|---|
| **calm** | **474** | 8 | 0 | 8 | 70 |
| **stress** | 12 | **433** | 89 | 26 | 0 |
| **anxiety** | 0 | 98 | **461** | 1 | 0 |
| **sadness** | 5 | 34 | 0 | **521** | 0 |
| **peace** | 93 | 1 | 0 | 8 | **458** |

The two error clusters are **stress ↔ anxiety** (187 total) and **calm ↔ peace** (163). Both
are physiologically adjacent — the first pair are both sympathetic activation, the second pair
are both relaxed states. The classifier almost never confuses a relaxed state with an aroused
one, which is the distinction the alerting actually depends on.

### Feature importance (Gini)

| Rank | Feature | Importance |
|---|---|---|
| 1 | `sdnn` | 25.13% |
| 2 | `meanRR` | 19.75% |
| 3 | `meanBpm` | 18.15% |
| 4 | `rmssd` | 6.69% |
| 5 | `hfPower` | 6.63% |
| 6 | `pnn50` | 5.26% |
| 7 | `inactivityMinutes` | 4.78% |
| 8 | `lfPower` | 3.91% |
| 9 | `entropyRatio` | 3.77% |
| 10 | `entropy` | 2.71% |
| 11 | `lfHfRatio` | 2.06% |
| 12 | `hourOfDay` | 1.17% |

> ### ⚠️ On citing these numbers
>
> The model is trained on **synthetic** data. The paper specifies PhysioNet Fantasia plus
> supplemental PRV-labelled data; that corpus is not bundled here. The trainer synthesises
> physiologically-shaped RR series (class-specific heart rate, HF respiratory oscillation, LF
> Mayer waves, noise) and runs them through the **same `extractFeatures()` the app uses at
> runtime**, so the model sees the production feature distribution including the real
> sampling rate.
>
> **These figures measure separation of simulated classes. They are not evidence of accuracy
> against real human emotion and must not be reported as such.**
>
> An earlier version of the generator scored **91.2%** — but `inactivityMinutes` alone carried
> 24% of the importance, because "inactive 45+ min" was a near-perfect tell for sadness *in
> the generator*. That is leakage from the simulation, not a finding. Widening the behavioural
> distributions dropped accuracy to 83.8% and moved the importance onto physiology. The lower
> number is the trustworthy one.

---

## 6. Stage 4 — Finite state machine

**Source:** [`lib/rprv/fsm.ts`](../lib/rprv/fsm.ts)

### States

| State | Tier | Theme | Meaning | Side effects |
|---|---|---|---|---|
| `CALM` | none | — | Baseline | None — the app stays quiet |
| `ELEVATED` | **1** | peace, comfort | Mild stress or agitation | Gentle notification |
| `STRESS` | **2** | strength, hope | Sustained stress | Moderate notification; records a 6 h episode |
| `ACUTE` | **3** | protection, courage | Acute stress or danger | Urgent notification, emergency contact offer, wellbeing check-in |

### Timing constants

| Constant | Value |
|---|---|
| `ELEVATED_SUSTAIN_MS` | 10 min |
| `RECOVERY_DWELL_MS` | 5 min |
| `ACUTE_RECOVERY_DWELL_MS` | 10 min |
| `EPISODE_WINDOW_MS` | 6 h |
| `EPISODES_FOR_ACUTE` | 3 |
| `CALM_RESET_MS` | 30 min |
| `P_STRESS_ELEVATE` | 0.5 |
| `P_STRESS_ESCALATE` | 0.7 |

### Transition table

| From | To | Condition |
|---|---|---|
| CALM | ELEVATED | `E_win < 0.85 × baseline` **or** `P_stress > 0.5` **or** `bpm ≥ warnBpm` |
| ELEVATED | STRESS | elevated ≥ 10 min **or** `P_stress > 0.7` |
| ELEVATED | CALM | `E_win ≥ 0.90 × baseline` held ≥ 5 min |
| STRESS | ACUTE | ≥ 3 stress episodes in 6 h **or** `E_win < 0.65 × baseline` |
| STRESS | ELEVATED | `E_win ≥ 0.90 × baseline` held ≥ 5 min |
| ACUTE | STRESS | `E_win ≥ critical` held ≥ 10 min **or** user override — **and** bpm below emergency |
| *any* | CALM | no stress signal for ≥ 30 min |
| *any* | ACUTE | `bpm ≥ emergencyBpm` (overrides the whole graph) |

### Behavioural guarantees

| Guarantee | How |
|---|---|
| Notifications only on **entry** to a state | `tier = transitioned ? tierFor(to) : 0` — sitting in STRESS for an hour does not re-fire every 30 s |
| Recovery must be **continuous** | Any dip below the recovery threshold resets `recoveringSince` to null |
| Dwell does not carry across transitions | `recoveringSince` is cleared on any state change |
| ACUTE cannot clear while pulse is dangerous | De-escalation is blocked while `bpm ≥ emergencyBpm` |
| Stale state does not survive a restart | A context older than 12 h resets to CALM |
| Entropy rules are **skipped**, not defaulted | With no baseline, `entropyAvailable = false`; the FSM runs on classifier + bpm only |

### Rule tracing

Every tick records **every rule it evaluated**, fired or not, with the actual numbers
substituted in. This is what the Algorithm screen renders, and it is stored in
`windows.trace_json` for later inspection.

---

## 7. Stage 5 — Verse recommendation

**Source:** [`lib/verses/recommender.ts`](../lib/verses/recommender.ts) ·
**Corpus:** [`lib/verses/corpus.ts`](../lib/verses/corpus.ts)

### Scoring formula

```
score = 0.60 × emotionFit
      + 0.25 × recentEngagement     (themes rated helpful in the last 7 days)
      + 0.15 × historicalPreference (themes rated helpful all-time)
      − repetitionPenalty           (≤ 0.25, decaying over the last 5 deliveries)
```

The repetition penalty is **not** in the paper. Without it the same top-scoring verse is
delivered every single time, which reads as a broken app rather than as guidance.

### `emotionFit` scoring

| Match | Score |
|---|---|
| Verse's **primary** theme is one the state calls for | 1.00 |
| Verse's **primary** theme came from a situational rule | 0.90 |
| Verse **contains** a theme the state calls for | 0.75 |
| Verse **contains** a theme from a situational rule | 0.70 |
| Verse **contains** a theme from the classified emotion | 0.60 |

### State → theme pools

| State | Themes |
|---|---|
| CALM | *(none — no notification)* |
| ELEVATED | peace, comfort |
| STRESS | strength, hope |
| ACUTE | protection, courage |

### Emotion → theme refinement

The state says *how urgent*; the classifier says *what kind*. Someone in STRESS because they
are anxious needs different words from someone in STRESS because they are sad.

| Emotion | Themes |
|---|---|
| calm | peace, hope |
| stress | strength, peace |
| anxiety | peace, courage, protection |
| sadness | comfort, hope |
| peace | rest, peace |

### Situational rules

| Rule | Trigger | Themes added |
|---|---|---|
| Morning | 05:00–08:59 | renewal |
| Evening | 20:00–23:59 | rest, peace |
| Prolonged inactivity | ≥ 120 min inactive | stillness |
| Repeated stress | ≥ 3 episodes in 6 h | encouragement, strength |
| Post-exertion recovery | recent exertion detected | restoration |

Rules are **additive** — more than one can fire. In **ACUTE** the state's own themes stay
primary and situational refinement is suppressed: an emergency is not the moment for the
evening-rest rule to pull selection away from protection.

### Corpus

Curated King James Version set, per the paper's scope: **Psalms 23, 34, 46, 55, 91, 94, 119;
Isaiah 40–41; Philippians 4; Matthew 11; 1 Peter 5; Jeremiah 29.**

> **Discrepancy in the source paper.** It states verses outside that list are not
> recommended, yet its own rules name five that are: 2 Timothy 1:7 (ACUTE), Lamentations
> 3:22–23 and Psalm 143:8 (morning), Psalm 4:8 (evening), Exodus 14:14 (stillness). Both
> statements cannot hold. We include them — a morning rule with no morning verses would be
> inert — and flag each with `outsideStatedScope: true` so the discrepancy stays visible.

---

## 8. Absolute heart-rate rules

Not in the paper. Added per the client brief, because the paper's transitions are **entirely
relative to the user's own entropy baseline** — a genuinely dangerous absolute heart rate
could pass unremarked if it arrived gradually.

| Rule | Default | Configurable | Effect |
|---|---|---|---|
| Warning | **120 bpm** | Yes | Forces ≥ ELEVATED + a plain high-heart-rate notification |
| Emergency | **150 bpm** | Yes | Forces ACUTE, overriding the state graph |
| Warning cooldown | 15 min | No | Prevents notification spam |

Both are user-editable because the brief states an emergency "depende sa condition ng user",
and the paper's own design is personalised rather than population-based. The app enforces
`emergencyBpm > warnBpm`; inverting them would make one rule unreachable.

The high-heart-rate warning is deliberately **separate** from the tier notifications. The
tier notification is about emotional state; this one is about a number crossing a line.
Conflating them would bury the safety message underneath scripture.

---

## 9. The daily cycle

| Time | What happens |
|---|---|
| **08:00** | Collection window opens. Samples are recorded. |
| **08:00–12:00** | **Morning segment.** Baseline entropy accumulates. Until ≥ 5 usable windows exist there is **no baseline**, so entropy rules are off and only the absolute bpm thresholds are live. |
| **12:00–17:00** | Afternoon. Every reading is compared against **this morning's** baseline. This is what makes "calm sa umaga, mataas sa hapon" the actual trigger condition rather than a fixed threshold. |
| **17:00** | Collection window closes. |
| **17:01** | **Daily summary notification** — the day's peak heart rate, the time it occurred, and a verse chosen from the day's dominant emotional state. |
| **20:00–24:00** | Evening situational rule active — rest and peace themes prioritised. |

**Evaluation cadence:** every 30 s while the app is open; roughly every 15 min in the
background (OS-dependent — see §13).

### Why the summary is re-scheduled, not set once

The summary must state the day's peak, which is unknown until it fires. A local
notification's text is fixed at scheduling time, and neither OS will reliably wake the app at
an exact moment to compose one. So it is **re-scheduled with current figures on every tick**.
If the app ran at any point in the afternoon the figure is current; if not, the notification
still fires and says the figure is "as of the last time HV was open". The Analysis screen
always shows the true value.

---

## 10. Deviations from the outline paper

| # | Paper says | Implementation | Why |
|---|---|---|---|
| 1 | Entropy over a 60 s window | 60 s **evaluation cadence**, but the entropy **span widens** to 300 s until it holds ≥ 30 intervals | At Health Connect's 5 s cadence a 60 s window holds 12 points; measured separation there is **d = −0.03**, i.e. noise with the sign inverted. See §4. |
| 2 | Sample entropy (m unspecified) | `m` adapts: 2 when N ≥ 100, else 1 | `m = 2` collapses toward zero on short series |
| 3 | Raw PPG inter-beat intervals | `RR = 60000 / bpm` reconstruction | Neither platform exposes beat-to-beat data to a phone app |
| 4 | Train on PhysioNet Fantasia | Synthetic RPRV generator | Corpus not bundled; `loadRealDataset()` is the hook |
| 5 | `E_critical` named, not valued | 0.65 × baseline | Set below the 0.70 the paper's own example calls STRESS |
| 6 | Level 3 "alerts emergency contacts" | Opens SMS composer; **user presses send** | A false positive texts someone's family that they are in medical distress. Classifier accuracy is nowhere near what silent dispatch would require. |
| 7 | Corpus bounded to a chapter list | Five named-but-outside verses included, flagged | The paper contradicts itself; see §7 |
| 8 | Native Wear OS app (Android Studio) | Expo phone app; watch is a data source | Expo has no Wear OS target |
| 9 | — | Repetition penalty added | Otherwise the same verse every time |
| 10 | — | Absolute bpm rules added | Client requirement; see §8 |

---

## 11. Client feedback traceability

| # | Feedback | Implementation | Where |
|---|---|---|---|
| 1 | "Check for algorithm na makikita na ito yung naging computation for output" | Algorithm screen: entropy vs baseline and all thresholds, the 12-feature vector, per-class tree votes, one tree's full decision path, **every FSM rule including those that did not fire**, verse score breakdown, model provenance | [`app/algorithm.tsx`](../app/algorithm.tsx) |
| 2 | "May Analysis sya, nakarecord dapat ang mga previous test" | Per-day session records with peak/avg/min bpm, reading count, baseline, dominant state | [`app/analysis.tsx`](../app/analysis.tsx), `sessions` + `windows` tables |
| 3 | "Daily nag cocollect… umaga calm, hapon tumaas, dun palang mag ti-trigger" | Morning baseline gating — entropy rules **off** until the morning segment produces a baseline | [`engine.ts` `establishBaseline()`](../lib/monitoring/engine.ts) |
| 4 | "If emergency, may notif kapag nag limit si pulse rate… depende sa condition ng user. Sa gabi yung recommendation (rule based)" | Configurable emergency threshold → ACUTE; evening situational rule 20:00–24:00 | [`fsm.ts`](../lib/rprv/fsm.ts), [`recommender.ts`](../lib/verses/recommender.ts) |
| 5 | "For analysis, if nakatulong ba yung verse sa user" | Helpful / not-helpful rating on every verse; per-verse effectiveness; ratings feed back into the 25% + 15% scoring terms | [`verse-card.tsx`](../components/verse-card.tsx), `verse_feedback` table |
| 6 | "Kapag hindi naka connect yung watch ito lang yung records… kapag naka-connect mag aappear yung bago" | `watch_connected` per session, banner at top of Analysis, `INCOMPLETE` badge on affected days, analysis skipped rather than reporting stale state as current | [`app/analysis.tsx`](../app/analysis.tsx), `sessions.watch_connected` |
| 7 | "Question na notification (if okay lang ba si User after mag trigger si emergency warning)" | Check-in scheduled 10 min after any Level 3; three responses recorded against the episode | [`checkin-prompt.tsx`](../components/checkin-prompt.tsx), `checkins` table |
| 8 | "Check the literature, set the scope ng system" | §1 of this document | *this file* |
| 9 | "Kapag emergency notification, may emotional state na nag babased… at recommendation if anong verse" | `EMOTION_THEMES` refines verse selection by classified emotion, including in ACUTE | [`recommender.ts`](../lib/verses/recommender.ts) |

---

## 12. Data model

**Source:** [`lib/db/schema.ts`](../lib/db/schema.ts)

| Table | Holds | Answers |
|---|---|---|
| `samples` | Every accepted bpm reading | Raw record; de-duplicated on `(at, bpm, source)` |
| `sessions` | One row per day | "Previous tests" — peak/avg/min, baseline, dominant state, watch connectivity |
| `windows` | One row per 30 s evaluation | Full audit trail: features, votes, state, complete rule trace |
| `episodes` | State transitions that notified | What fired, when, and which rule caused it |
| `notifications` | Everything delivered | Reconcile what the user was told against what the algorithm saw |
| `verse_feedback` | Helpful / not-helpful ratings | "Did the verse help?" |
| `checkins` | Post-emergency wellbeing answers | Real episode vs false alarm |
| `contacts` | Emergency contacts | Level 3 SMS recipients |
| `settings` | Thresholds, FSM context | User configuration, restart-safe state |

Session statistics are **derived** from raw samples, not maintained incrementally — so a
backfill of older readings corrects the day's figures rather than leaving a stale peak behind.

---

## 13. Limitations

| # | Limitation | Consequence | Mitigation |
|---|---|---|---|
| 1 | **Not a sensor.** Reads only what the watch wrote to the health store | A reading is only as fresh as the last sync | `watch_connected` flag; analysis is skipped rather than reporting stale data as live |
| 2 | **Averaged, not beat-to-beat.** One bpm value every 3–5 s | Variability measures are not comparable with clinical HRV | All thresholds are relative to the user's **own** baseline, never to population norms |
| 3 | **Entropy needs density.** 12 points per 60 s is not enough | The paper's literal window is unusable on a phone | Adaptive span + adaptive `m`; span used is shown on the Algorithm screen |
| 4 | **Background execution is throttled.** ~15 min floor on Android, stricter on iOS | A tier notification can arrive late | Nothing is lost — the health store keeps samples and each run recomputes the day from scratch |
| 5 | **Inactivity is inferred** from heart-rate elevation, not step data | Poor at detecting quiet movement | Only biases verse selection, **never** triggers an alert |
| 6 | **Synthetic training data** | CV accuracy is not real-world accuracy | Stated in the trainer, the README, and the Algorithm screen; `loadRealDataset()` is a one-file swap |
| 7 | **Stress ↔ anxiety and calm ↔ peace confusion** | ~12% of predictions land on the adjacent class | Errors stay within arousal group; aroused vs relaxed is almost never confused |
| 8 | **No automatic emergency dispatch** | Someone must press send | Deliberate — see §10 row 6 |
| 9 | **Not a medical device** | Emotional states are inferred, not measured | Stated in-app on the Analysis screen |

---

## Reproducing the numbers

```bash
npm run train:model   # rebuilds model.json, prints CV + confusion matrix + importances
```

```bash
npm run test:algo     # 29 tests, including the paper's worked scenario
```
