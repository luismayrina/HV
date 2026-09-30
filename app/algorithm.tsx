/**
 * app/algorithm.tsx
 *
 * Algorithm transparency screen.
 *
 * Answers the client's requirement to be able to "check for algorithm na
 * makikita na ito yung naging computation for output": every number that went
 * into the current classification, every rule the state machine evaluated
 * (including the ones that did not fire), and the provenance of the model
 * itself.
 *
 * Nothing here is recomputed for display. It reads the same tick result the
 * monitoring engine acted on, so what is shown is what actually happened.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import {
  EMOTION_COLOR, EMOTION_LABEL, FEATURE_LABEL, FEATURE_UNIT,
  STATE_COLOR, STATE_DESCRIPTION, STATE_LABEL, UI,
} from '@/constants/monitor';
import { MODEL, runTick } from '@/lib/monitoring/engine';
import type { TickResult } from '@/lib/monitoring/engine';
import { classify } from '@/lib/rprv/randomForest';
import { EMOTION_CLASSES, FEATURE_NAMES } from '@/lib/rprv/types';
import type { EmotionClass } from '@/lib/rprv/types';
import {
  WEIGHT_EMOTION, WEIGHT_HISTORICAL, WEIGHT_RECENT_ENGAGEMENT,
} from '@/lib/verses/recommender';

function Section({ title, subtitle, children }: {
  title: string; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>{title}</Text>
      {subtitle ? <Text style={styles.cardSubtitle}>{subtitle}</Text> : null}
      {children}
    </View>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.mono]}>{value}</Text>
    </View>
  );
}

/** A labelled proportion bar, used for vote shares and importances. */
function Bar({ label, fraction, color, right }: {
  label: string; fraction: number; color: string; right: string;
}) {
  return (
    <View style={styles.barRow}>
      <Text style={styles.barLabel}>{label}</Text>
      <View style={styles.barTrack}>
        <View
          style={[
            styles.barFill,
            { width: `${Math.max(0, Math.min(1, fraction)) * 100}%`, backgroundColor: color },
          ]}
        />
      </View>
      <Text style={styles.barValue}>{right}</Text>
    </View>
  );
}

export default function AlgorithmScreen() {
  const router = useRouter();
  const [tick, setTick] = useState<TickResult | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await runTick(new Date());
        if (!cancelled) setTick(result);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Re-run the classification in explain mode so the per-tree decision paths
  // are available. The votes are identical to the ones the engine acted on;
  // only the recorded paths are extra.
  const explained = useMemo(() => {
    if (!tick?.features) return null;
    return classify(MODEL, tick.features, true);
  }, [tick]);

  const meta = MODEL.meta;

  return (
    <SafeAreaView style={styles.safeArea}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={UI.accent} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>How this was computed</Text>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator size="large" color={UI.accent} />
            <Text style={styles.loadingText}>Running an evaluation…</Text>
          </View>
        ) : null}

        {!loading && tick?.skipped ? (
          <View style={[styles.card, styles.noticeCard]}>
            <Ionicons name="information-circle" size={20} color="#FF9500" />
            <Text style={styles.noticeText}>{tick.skipped}</Text>
          </View>
        ) : null}

        {/* ── Outcome ─────────────────────────────────────────────────── */}
        {tick?.fsm ? (
          <Section title="Output" subtitle="What the system concluded, and what it did">
            <View style={styles.outcomeRow}>
              <View style={[styles.statePill, { backgroundColor: STATE_COLOR[tick.fsm.to] }]}>
                <Text style={styles.statePillText}>{STATE_LABEL[tick.fsm.to]}</Text>
              </View>
              {tick.classification ? (
                <View
                  style={[
                    styles.emotionPill,
                    { borderColor: EMOTION_COLOR[tick.classification.emotion] },
                  ]}
                >
                  <Text
                    style={[
                      styles.emotionPillText,
                      { color: EMOTION_COLOR[tick.classification.emotion] },
                    ]}
                  >
                    {EMOTION_LABEL[tick.classification.emotion]}
                    {' · '}
                    {(tick.classification.confidence * 100).toFixed(0)}%
                  </Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.stateDescription}>{STATE_DESCRIPTION[tick.fsm.to]}</Text>
            <Row
              label="Notification tier"
              value={tick.fsm.tier === 0 ? 'None' : `Level ${tick.fsm.tier}`}
            />
            <Row
              label="State changed this tick"
              value={tick.fsm.transitioned ? `${tick.fsm.from} → ${tick.fsm.to}` : 'No'}
            />
          </Section>
        ) : null}

        {/* ── Step 1: SWIBSEA ─────────────────────────────────────────── */}
        <Section
          title="Step 1 — SWIBSEA entropy"
          subtitle="Sliding Window-Based Signal Entropy Analysis of the pulse interval series"
        >
          {tick?.entropy.usable && tick.entropy.entropy !== null ? (
            <>
              <Row label="Window entropy" value={tick.entropy.entropy.toFixed(3)} mono />
              <Row
                label="Personal baseline"
                value={tick.baseline !== null ? tick.baseline.toFixed(3) : 'not established yet'}
                mono
              />
              {tick.thresholds ? (
                <>
                  <Row
                    label="Shift threshold (85%)"
                    value={tick.thresholds.shift.toFixed(3)}
                    mono
                  />
                  <Row
                    label="Recovery threshold (90%)"
                    value={tick.thresholds.recovery.toFixed(3)}
                    mono
                  />
                  <Row
                    label="Critical threshold (65%)"
                    value={tick.thresholds.critical.toFixed(3)}
                    mono
                  />
                </>
              ) : null}
              <View style={styles.divider} />
              <Row
                label="Computed over"
                value={`${tick.entropy.sampleCount} intervals across ${Math.round(tick.entropy.spanMs / 1000)} s`}
              />
              <Row label="Embedding dimension" value={`m = ${tick.entropy.m}`} mono />
              {tick.entropy.spanMs > 60_000 ? (
                <Text style={styles.footnote}>
                  The study specifies a 60-second window. Your device delivers roughly one
                  reading every few seconds, which is too sparse for a stable entropy estimate
                  over 60 seconds, so the window was widened to{' '}
                  {Math.round(tick.entropy.spanMs / 1000)} seconds to reach{' '}
                  {tick.entropy.sampleCount} intervals.
                </Text>
              ) : null}
            </>
          ) : (
            <Text style={styles.footnote}>
              No usable entropy estimate. {tick?.entropy.sampleCount ?? 0} intervals were
              available and at least 30 are needed. The state machine is running on the
              classifier and the heart-rate rules alone.
            </Text>
          )}
        </Section>

        {/* ── Step 2: features ────────────────────────────────────────── */}
        {tick?.features ? (
          <Section
            title="Step 2 — Feature vector"
            subtitle="The 12 values passed to the classifier"
          >
            {FEATURE_NAMES.map((name) => {
              const value = tick.features![name];
              const unit = FEATURE_UNIT[name as string];
              return (
                <Row
                  key={name as string}
                  label={FEATURE_LABEL[name as string] ?? (name as string)}
                  value={`${value.toFixed(value >= 100 ? 0 : 2)}${unit ? ` ${unit}` : ''}`}
                  mono
                />
              );
            })}
          </Section>
        ) : null}

        {/* ── Step 3: Random Forest ───────────────────────────────────── */}
        {explained ? (
          <Section
            title="Step 3 — Random Forest vote"
            subtitle={`${explained.treeCount} decision trees, each trained on a bootstrap sample with a random feature subset. The class with the most votes wins; its vote share is the confidence.`}
          >
            {EMOTION_CLASSES.map((cls: EmotionClass) => {
              const share = explained.votes[cls];
              const trees = Math.round(share * explained.treeCount);
              return (
                <Bar
                  key={cls}
                  label={EMOTION_LABEL[cls]}
                  fraction={share}
                  color={EMOTION_COLOR[cls]}
                  right={`${trees} / ${explained.treeCount}`}
                />
              );
            })}
            <View style={styles.divider} />
            <Row
              label="Majority vote"
              value={`${EMOTION_LABEL[explained.emotion]} (${(explained.confidence * 100).toFixed(1)}%)`}
            />
            <Row
              label="P_stress (drives the rules)"
              value={explained.stressProbability.toFixed(3)}
              mono
            />

            <View style={styles.divider} />
            <Text style={styles.subheading}>How tree #1 reached its answer</Text>
            {explained.perTree![0].path.map((stepRow, i) => (
              <Text key={i} style={styles.pathLine}>
                {FEATURE_LABEL[stepRow.feature] ?? stepRow.feature}{' '}
                {stepRow.value.toFixed(2)} {stepRow.wentLeft ? '≤' : '>'}{' '}
                {stepRow.threshold.toFixed(2)}
              </Text>
            ))}
            <Text style={styles.pathResult}>
              → {EMOTION_LABEL[MODEL.classes[explained.perTree![0].classIndex] as EmotionClass]}
            </Text>
          </Section>
        ) : null}

        {/* ── Step 4: the state machine ───────────────────────────────── */}
        {tick?.fsm ? (
          <Section
            title="Step 4 — State machine rules"
            subtitle="Every rule evaluated this tick. Rules that did not fire are shown too, so you can see what was considered."
          >
            {tick.fsm.trace.map((t, i) => (
              <View key={i} style={styles.ruleRow}>
                <Ionicons
                  name={t.fired ? 'checkmark-circle' : 'ellipse-outline'}
                  size={16}
                  color={t.fired ? '#4CD964' : UI.faint}
                  style={{ marginTop: 2 }}
                />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.ruleName, t.fired && styles.ruleNameFired]}>
                    {t.rule}
                  </Text>
                  <Text style={styles.ruleDetail}>{t.detail}</Text>
                </View>
              </View>
            ))}
            <View style={styles.divider} />
            <Row
              label="Stress episodes in the last 6 h"
              value={String(tick.fsm.episodesInWindow)}
            />
          </Section>
        ) : null}

        {/* ── Step 5: verse selection ─────────────────────────────────── */}
        {tick?.recommendation ? (
          <Section
            title="Step 5 — Verse selection"
            subtitle={`Weighted scoring: ${WEIGHT_EMOTION * 100}% emotional state fit, ${WEIGHT_RECENT_ENGAGEMENT * 100}% recent engagement, ${WEIGHT_HISTORICAL * 100}% historical preference.`}
          >
            {tick.recommendation.rules.length > 0 ? (
              <>
                <Text style={styles.subheading}>Situational rules that fired</Text>
                {tick.recommendation.rules.map((r, i) => (
                  <Text key={i} style={styles.pathLine}>
                    {r.name} — {r.detail}
                  </Text>
                ))}
                <View style={styles.divider} />
              </>
            ) : null}

            <Text style={styles.subheading}>Candidate scores</Text>
            {tick.recommendation.ranked.slice(0, 5).map((s, i) => (
              <View key={s.verse.id} style={styles.scoreRow}>
                <Text style={[styles.scoreRef, i === 0 && styles.scoreRefTop]}>
                  {i === 0 ? '✓ ' : ''}{s.verse.reference}
                </Text>
                <Text style={styles.scoreBreakdown}>
                  {(WEIGHT_EMOTION * s.emotionFit).toFixed(3)} fit
                  {' + '}{(WEIGHT_RECENT_ENGAGEMENT * s.recentEngagement).toFixed(3)} recent
                  {' + '}{(WEIGHT_HISTORICAL * s.historical).toFixed(3)} history
                  {s.repetitionPenalty > 0
                    ? ` − ${s.repetitionPenalty.toFixed(3)} repeat`
                    : ''}
                  {' = '}
                  <Text style={styles.scoreTotal}>{s.total.toFixed(3)}</Text>
                </Text>
              </View>
            ))}
          </Section>
        ) : null}

        {/* ── The model itself ────────────────────────────────────────── */}
        <Section
          title="The model"
          subtitle="Provenance and measured performance of the shipped classifier"
        >
          <Row label="Trees" value={String(meta.nTrees)} />
          <Row label="Max depth" value={String(meta.maxDepth)} />
          <Row label="Features per split" value={String(meta.maxFeatures)} />
          <Row label="Training windows" value={String(meta.trainingSamples)} />
          <Row
            label="5-fold CV accuracy"
            value={`${(meta.cvAccuracy * 100).toFixed(1)}%`}
          />
          <Row
            label="Trained"
            value={new Date(meta.trainedAt).toLocaleDateString()}
          />

          <View style={styles.divider} />
          <Text style={styles.subheading}>Per-class performance</Text>
          {Object.entries(meta.perClass).map(([cls, m]) => (
            <Row
              key={cls}
              label={EMOTION_LABEL[cls as EmotionClass] ?? cls}
              value={`P ${(m.precision * 100).toFixed(0)}% · R ${(m.recall * 100).toFixed(0)}% · F1 ${(m.f1 * 100).toFixed(0)}%`}
              mono
            />
          ))}

          <View style={styles.divider} />
          <Text style={styles.subheading}>What the model relies on</Text>
          {Object.entries(meta.featureImportance)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 6)
            .map(([name, v]) => (
              <Bar
                key={name}
                label={FEATURE_LABEL[name] ?? name}
                fraction={v}
                color={UI.accent}
                right={`${(v * 100).toFixed(1)}%`}
              />
            ))}

          <View style={[styles.divider, { marginTop: 12 }]} />
          <Text style={styles.warningHeading}>Read this before citing the accuracy</Text>
          <Text style={styles.footnote}>
            The model was trained on {meta.dataSource}. The cross-validation figures above
            measure how well it separates those simulated classes — they are a check that
            the pipeline carries the intended signal, not evidence of accuracy against real
            labelled human emotion. Training on a real labelled corpus is a one-file change
            in the training script.
          </Text>
        </Section>

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: UI.background },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: UI.border,
    backgroundColor: UI.card,
  },
  backBtn: { padding: 4 },
  headerTitle: { fontSize: 17, fontWeight: '700', color: UI.text },
  scroll: { padding: 16, gap: 14 },
  loading: { paddingVertical: 40, alignItems: 'center', gap: 12 },
  loadingText: { color: UI.muted, fontSize: 13 },

  card: {
    backgroundColor: UI.card, borderRadius: 16, padding: 16,
    borderWidth: StyleSheet.hairlineWidth, borderColor: UI.border,
  },
  noticeCard: { flexDirection: 'row', gap: 10, alignItems: 'center' },
  noticeText: { flex: 1, color: '#8A6100', fontSize: 13, lineHeight: 18 },
  cardTitle: { fontSize: 16, fontWeight: '800', color: UI.text },
  cardSubtitle: { fontSize: 12, color: UI.muted, marginTop: 4, lineHeight: 17, marginBottom: 10 },

  outcomeRow: { flexDirection: 'row', gap: 8, marginTop: 4, marginBottom: 10 },
  statePill: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999 },
  statePillText: { color: '#FFF', fontWeight: '800', fontSize: 13 },
  emotionPill: {
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1.5,
  },
  emotionPillText: { fontWeight: '700', fontSize: 13 },
  stateDescription: { fontSize: 13, color: UI.muted, lineHeight: 18, marginBottom: 8 },

  row: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
    paddingVertical: 5, gap: 12,
  },
  rowLabel: { fontSize: 13, color: UI.muted, flexShrink: 1 },
  rowValue: { fontSize: 13, color: UI.text, fontWeight: '600', textAlign: 'right' },
  mono: { fontVariant: ['tabular-nums'] },

  divider: {
    height: StyleSheet.hairlineWidth, backgroundColor: UI.border,
    marginVertical: 10,
  },
  subheading: {
    fontSize: 12, fontWeight: '800', color: UI.muted,
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8,
  },
  warningHeading: {
    fontSize: 12, fontWeight: '800', color: '#C93400',
    textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6,
  },
  footnote: { fontSize: 12, color: UI.muted, lineHeight: 18 },

  barRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 4 },
  barLabel: { width: 96, fontSize: 12, color: UI.text },
  barTrack: {
    flex: 1, height: 8, borderRadius: 4, backgroundColor: UI.background, overflow: 'hidden',
  },
  barFill: { height: '100%', borderRadius: 4 },
  barValue: {
    width: 64, fontSize: 11, color: UI.muted, textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },

  ruleRow: { flexDirection: 'row', gap: 8, paddingVertical: 6 },
  ruleName: { fontSize: 13, fontWeight: '600', color: UI.muted },
  ruleNameFired: { color: UI.text, fontWeight: '800' },
  ruleDetail: { fontSize: 11.5, color: UI.faint, lineHeight: 16, marginTop: 2 },

  pathLine: { fontSize: 12, color: UI.muted, lineHeight: 19, fontVariant: ['tabular-nums'] },
  pathResult: { fontSize: 12.5, color: UI.text, fontWeight: '700', marginTop: 4 },

  scoreRow: { paddingVertical: 5 },
  scoreRef: { fontSize: 13, color: UI.muted, fontWeight: '600' },
  scoreRefTop: { color: UI.text, fontWeight: '800' },
  scoreBreakdown: {
    fontSize: 11, color: UI.faint, marginTop: 2, fontVariant: ['tabular-nums'],
  },
  scoreTotal: { color: UI.text, fontWeight: '700' },
});
