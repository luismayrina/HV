/**
 * app/(tabs)/_layout.tsx
 *
 * The live monitoring screen.
 *
 * Previously this screen mapped heart rate straight to a verse with a fixed
 * ladder of bpm thresholds. That has been replaced by the study's pipeline:
 * SWIBSEA entropy over the pulse interval series, a Random Forest
 * classification of emotional state, and the finite state machine that decides
 * the notification tier and verse theme. The bpm number is still shown, but it
 * is no longer what chooses the scripture.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator, Alert, Platform, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { CheckinPrompt } from '@/components/checkin-prompt';
import { VerseCard } from '@/components/verse-card';
import {
  EMOTION_COLOR, EMOTION_LABEL, STATE_COLOR, STATE_LABEL, UI,
} from '@/constants/monitor';
import { useRprvMonitor } from '@/hooks/useRprvMonitor';
import type { MonitorState } from '@/lib/rprv/types';

export default function HomeScreen() {
  const router = useRouter();
  const {
    monitor, tick, isAnalysing, pendingCheckin, pendingEmergency,
    analyseNow, sendEmergencySms, clearPendingCheckin,
  } = useRprvMonitor();
  const [tipDismissed, setTipDismissed] = useState(false);

  const state: MonitorState = tick?.fsm?.to ?? 'CALM';
  const themeColor = STATE_COLOR[state];
  const bpm = monitor.bpm ?? 0;

  const onSendEmergency = useCallback(async () => {
    const result = await sendEmergencySms();
    if (!result) return;
    if (result.result === 'no_contacts') {
      Alert.alert(
        'No emergency contacts',
        'Add a contact in Settings so HV can prepare a message for them.',
        [
          { text: 'Not now', style: 'cancel' },
          { text: 'Open settings', onPress: () => router.push('/settings') },
        ],
      );
    } else if (result.result === 'unavailable') {
      Alert.alert(
        'Cannot send messages',
        'This device cannot send text messages. Contact someone directly if you need help.',
      );
    }
  }, [sendEmergencySms, router]);

  const toggleMonitoring = useCallback(async () => {
    if (monitor.isMonitoring) {
      monitor.stopMonitoring();
      return;
    }
    await monitor.startMonitoring();
  }, [monitor]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="dark-content" />

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* ── Header ──────────────────────────────────────────────────── */}
        <View style={styles.header}>
          <View style={{ flex: 1 }}>
            <Text style={styles.appName}>Heart Verse</Text>
            <View style={styles.statusRow}>
              <View
                style={[
                  styles.statusDot,
                  { backgroundColor: tick?.watchConnected ? '#4CD964' : '#FF9500' },
                ]}
              />
              <Text style={styles.statusText}>
                {tick?.watchConnected ? 'Receiving watch data' : 'Waiting for watch data'}
              </Text>
            </View>
          </View>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.push('/settings')}>
            <Ionicons name="settings-outline" size={20} color={UI.muted} />
          </TouchableOpacity>
          <TouchableOpacity style={styles.iconBtn} onPress={() => router.push('/profile')}>
            <Ionicons name="person" size={20} color={UI.muted} />
          </TouchableOpacity>
        </View>

        {/* ── Emergency hand-off ──────────────────────────────────────── */}
        {pendingEmergency ? (
          <View style={styles.emergencyCard}>
            <View style={styles.emergencyHead}>
              <Ionicons name="warning" size={20} color="#FFF" />
              <Text style={styles.emergencyTitle}>Emergency alert</Text>
            </View>
            <Text style={styles.emergencyBody}>
              HV recorded an acute episode at {Math.round(pendingEmergency.bpm)} bpm.
              You can send your emergency contacts a message — you will see it before
              it is sent.
            </Text>
            <TouchableOpacity style={styles.emergencyBtn} onPress={onSendEmergency}>
              <Ionicons name="chatbubble-ellipses" size={16} color="#FF3B30" />
              <Text style={styles.emergencyBtnText}>Review message</Text>
            </TouchableOpacity>
          </View>
        ) : null}

        {/* ── Wellbeing check-in ──────────────────────────────────────── */}
        {pendingCheckin ? (
          <CheckinPrompt checkin={pendingCheckin} onAnswered={clearPendingCheckin} />
        ) : null}

        {/* ── Live monitor ────────────────────────────────────────────── */}
        <View style={[styles.mainCard, { borderColor: `${themeColor}40` }]}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Live monitoring</Text>
            <View style={styles.tagRow}>
              {monitor.isStale && monitor.isMonitoring ? (
                <View style={styles.staleTag}>
                  <Ionicons name="time-outline" size={10} color="#FF9500" />
                  <Text style={styles.staleTagText}>STALE</Text>
                </View>
              ) : null}
              {bpm > 0 ? (
                <View style={[styles.liveTag, { backgroundColor: themeColor }]}>
                  <Text style={styles.liveTagText}>LIVE</Text>
                </View>
              ) : null}
            </View>
          </View>

          <View style={styles.monitorContent}>
            <View
              style={[
                styles.outerCircle,
                { borderColor: monitor.isMonitoring ? themeColor : UI.background },
              ]}
            >
              {monitor.isLoading ? (
                <ActivityIndicator size="large" color={themeColor} />
              ) : monitor.isMonitoring && bpm === 0 ? (
                <View style={styles.waitingBox}>
                  <ActivityIndicator size="small" color={themeColor} />
                  <Text style={styles.waitingText}>Waiting for{'\n'}heart rate…</Text>
                </View>
              ) : (
                <View style={{ alignItems: 'center' }}>
                  <Ionicons name="heart" size={30} color={themeColor} />
                  <Text style={styles.bpmNumber}>{bpm === 0 ? '--' : bpm}</Text>
                  <Text style={styles.bpmSubtext}>BPM</Text>
                  {monitor.lastUpdated ? (
                    <Text style={styles.bpmTime}>
                      {monitor.lastUpdated.toLocaleTimeString([], {
                        hour: '2-digit', minute: '2-digit', second: '2-digit',
                      })}
                    </Text>
                  ) : null}
                </View>
              )}
            </View>
          </View>

          {/* State and emotion */}
          <View style={styles.pillRow}>
            <View style={[styles.statePill, { backgroundColor: themeColor }]}>
              <Text style={styles.statePillText}>{STATE_LABEL[state]}</Text>
            </View>
            {tick?.classification ? (
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
                  {EMOTION_LABEL[tick.classification.emotion]}{' '}
                  {(tick.classification.confidence * 100).toFixed(0)}%
                </Text>
              </View>
            ) : null}
            {isAnalysing ? <ActivityIndicator size="small" color={UI.faint} /> : null}
          </View>

          {monitor.error ? (
            <View style={styles.errorBanner}>
              <Ionicons name="warning-outline" size={14} color="#FF3B30" />
              <Text style={styles.errorBannerText}>{monitor.error}</Text>
            </View>
          ) : null}
        </View>

        {/* ── Baseline / analysis readout ─────────────────────────────── */}
        <TouchableOpacity
          style={styles.readoutCard}
          onPress={() => router.push('/algorithm')}
          activeOpacity={0.7}
        >
          <View style={styles.readoutHead}>
            <Text style={styles.readoutTitle}>Today&apos;s analysis</Text>
            <Ionicons name="chevron-forward" size={16} color={UI.faint} />
          </View>

          {tick?.skipped ? (
            <Text style={styles.readoutNote}>{tick.skipped}</Text>
          ) : (
            <View style={styles.readoutGrid}>
              <View style={styles.readoutCell}>
                <Text style={styles.readoutValue}>
                  {tick?.entropy.entropy != null ? tick.entropy.entropy.toFixed(2) : '—'}
                </Text>
                <Text style={styles.readoutLabel}>entropy</Text>
              </View>
              <View style={styles.readoutCell}>
                <Text style={styles.readoutValue}>
                  {tick?.baseline != null ? tick.baseline.toFixed(2) : '—'}
                </Text>
                <Text style={styles.readoutLabel}>baseline</Text>
              </View>
              <View style={styles.readoutCell}>
                <Text style={styles.readoutValue}>
                  {tick?.classification
                    ? tick.classification.stressProbability.toFixed(2)
                    : '—'}
                </Text>
                <Text style={styles.readoutLabel}>P(stress)</Text>
              </View>
              <View style={styles.readoutCell}>
                <Text style={styles.readoutValue}>{tick?.sampleCount ?? 0}</Text>
                <Text style={styles.readoutLabel}>readings</Text>
              </View>
            </View>
          )}

          {tick && tick.baseline === null && !tick.skipped ? (
            <Text style={styles.readoutNote}>
              No morning baseline yet. Until HV has seen a calm stretch of your morning,
              only the {tick.settings.warnBpm} bpm and {tick.settings.emergencyBpm} bpm
              thresholds are active.
            </Text>
          ) : null}
        </TouchableOpacity>

        {/* ── Current verse ───────────────────────────────────────────── */}
        {tick?.recommendation ? (
          <VerseCard
            verse={tick.recommendation.verse}
            color={themeColor}
            label={`${STATE_LABEL[state]} · ${tick.recommendation.themes[0] ?? 'scripture'}`}
            state={state}
            emotion={tick.classification?.emotion ?? null}
            rationale={
              tick.recommendation.rules.length > 0
                ? `Chosen for: ${tick.recommendation.rules.map((r) => r.name.toLowerCase()).join(', ')}.`
                : null
            }
          />
        ) : (
          <View style={styles.calmCard}>
            <Ionicons name="leaf-outline" size={22} color="#4CD964" />
            <Text style={styles.calmTitle}>Nothing needed right now</Text>
            <Text style={styles.calmBody}>
              In the calm state HV stays quiet. A verse arrives when your pulse pattern
              shifts away from your own baseline.
            </Text>
          </View>
        )}

        {/* ── Watch setup tip ─────────────────────────────────────────── */}
        {!tipDismissed && !tick?.watchConnected ? (
          <View style={styles.tipCard}>
            <View style={styles.tipHead}>
              <View style={styles.tipIconBox}>
                <Ionicons name="watch" size={19} color="#FF9500" />
              </View>
              <Text style={styles.tipTitle}>Getting watch data through</Text>
              <TouchableOpacity onPress={() => setTipDismissed(true)} hitSlop={8}>
                <Ionicons name="close-circle" size={21} color="#C7C7CC" />
              </TouchableOpacity>
            </View>
            <Text style={styles.tipBody}>
              {Platform.OS === 'android'
                ? 'HV reads heart rate from Health Connect. Make sure your watch app (Samsung Health, Fitbit, or your Wear OS companion) is set to sync heart rate to Health Connect, and that HV has permission to read it.'
                : 'iPhone can only read what your Apple Watch has already written to the Health app. Start a workout on the watch — "Other" works — and readings arrive every few seconds instead of every few minutes.'}
            </Text>
          </View>
        ) : null}

        {/* ── Actions ─────────────────────────────────────────────────── */}
        <View style={styles.actions}>
          <TouchableOpacity
            style={[
              styles.primaryBtn,
              { backgroundColor: monitor.isMonitoring ? '#FF3B30' : themeColor },
            ]}
            onPress={toggleMonitoring}
          >
            <Ionicons
              name={monitor.isMonitoring ? 'stop-circle' : 'play-circle'}
              size={19}
              color="#FFF"
            />
            <Text style={styles.primaryBtnText}>
              {monitor.isMonitoring ? 'Stop monitoring' : 'Start monitoring'}
            </Text>
          </TouchableOpacity>

          <View style={styles.secondaryRow}>
            <TouchableOpacity
              style={styles.secondaryBtn}
              onPress={() => router.push('/analysis')}
            >
              <Ionicons name="stats-chart" size={17} color={UI.accent} />
              <Text style={styles.secondaryBtnText}>Analysis</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.secondaryBtn} onPress={analyseNow}>
              <Ionicons name="refresh" size={17} color={UI.accent} />
              <Text style={styles.secondaryBtnText}>Re-evaluate</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ height: 30 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: UI.background },
  scroll: { padding: 16, gap: 14 },

  header: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  appName: { fontSize: 24, fontWeight: '800', color: UI.text },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 3 },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { fontSize: 12, color: UI.muted },
  iconBtn: {
    width: 38, height: 38, borderRadius: 19, backgroundColor: UI.card,
    alignItems: 'center', justifyContent: 'center',
  },

  emergencyCard: { backgroundColor: '#FF3B30', borderRadius: 16, padding: 16 },
  emergencyHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  emergencyTitle: { color: '#FFF', fontSize: 16, fontWeight: '800' },
  emergencyBody: { color: '#FFE5E3', fontSize: 12.5, lineHeight: 18, marginTop: 6 },
  emergencyBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    backgroundColor: '#FFF', borderRadius: 11, paddingVertical: 11, marginTop: 12,
  },
  emergencyBtnText: { color: '#FF3B30', fontWeight: '800', fontSize: 14 },

  mainCard: {
    backgroundColor: UI.card, borderRadius: 18, padding: 16, borderWidth: 1.5,
  },
  cardHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  cardTitle: { fontSize: 15, fontWeight: '700', color: UI.text },
  tagRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  staleTag: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    backgroundColor: '#FFF4E5', paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6,
  },
  staleTagText: { fontSize: 9, fontWeight: '800', color: '#FF9500' },
  liveTag: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 },
  liveTagText: { fontSize: 9, fontWeight: '800', color: '#FFF' },

  monitorContent: { alignItems: 'center', paddingVertical: 18 },
  outerCircle: {
    width: 168, height: 168, borderRadius: 84, borderWidth: 5,
    alignItems: 'center', justifyContent: 'center',
  },
  waitingBox: { alignItems: 'center', gap: 8, paddingHorizontal: 12 },
  waitingText: { fontSize: 12, color: UI.muted, textAlign: 'center' },
  bpmNumber: {
    fontSize: 46, fontWeight: '800', color: UI.text, fontVariant: ['tabular-nums'],
  },
  bpmSubtext: { fontSize: 11, color: UI.muted, marginTop: -4 },
  bpmTime: { fontSize: 9, color: UI.faint, marginTop: 4 },

  pillRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  statePill: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999 },
  statePillText: { color: '#FFF', fontWeight: '800', fontSize: 12.5 },
  emotionPill: {
    paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999, borderWidth: 1.5,
  },
  emotionPillText: { fontWeight: '700', fontSize: 12.5 },

  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 12,
    backgroundColor: '#FFEBEA', borderRadius: 9, padding: 9,
  },
  errorBannerText: { color: '#C93400', fontSize: 11.5, flex: 1 },

  readoutCard: {
    backgroundColor: UI.card, borderRadius: 16, padding: 16,
    borderWidth: StyleSheet.hairlineWidth, borderColor: UI.border,
  },
  readoutHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginBottom: 10,
  },
  readoutTitle: { fontSize: 15, fontWeight: '700', color: UI.text },
  readoutGrid: { flexDirection: 'row', gap: 8 },
  readoutCell: {
    flex: 1, backgroundColor: UI.background, borderRadius: 10,
    paddingVertical: 9, alignItems: 'center',
  },
  readoutValue: {
    fontSize: 16, fontWeight: '800', color: UI.text, fontVariant: ['tabular-nums'],
  },
  readoutLabel: { fontSize: 9.5, color: UI.muted, marginTop: 1 },
  readoutNote: { fontSize: 11.5, color: UI.faint, lineHeight: 17, marginTop: 8 },

  calmCard: {
    backgroundColor: UI.card, borderRadius: 16, padding: 18, alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth, borderColor: UI.border,
  },
  calmTitle: { fontSize: 15, fontWeight: '700', color: UI.text, marginTop: 8 },
  calmBody: {
    fontSize: 12.5, color: UI.muted, textAlign: 'center', lineHeight: 18, marginTop: 4,
  },

  tipCard: {
    backgroundColor: '#FFF7ED', borderRadius: 14, padding: 14,
    borderWidth: 1, borderColor: '#FFD9A8',
  },
  tipHead: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  tipIconBox: {
    width: 34, height: 34, borderRadius: 10, backgroundColor: '#FFEAD1',
    alignItems: 'center', justifyContent: 'center',
  },
  tipTitle: { flex: 1, fontSize: 14, fontWeight: '800', color: '#B25000' },
  tipBody: { fontSize: 12, color: '#7A5A38', lineHeight: 18, marginTop: 9 },

  actions: { gap: 9 },
  primaryBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7,
    height: 50, borderRadius: 14,
  },
  primaryBtnText: { color: '#FFF', fontWeight: '800', fontSize: 15 },
  secondaryRow: { flexDirection: 'row', gap: 9 },
  secondaryBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, height: 44, borderRadius: 12, backgroundColor: UI.card,
    borderWidth: StyleSheet.hairlineWidth, borderColor: UI.border,
  },
  secondaryBtnText: { color: UI.accent, fontWeight: '700', fontSize: 13.5 },
});
