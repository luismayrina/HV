/**
 * app/analysis.tsx
 *
 * Analysis and history.
 *
 * Covers three of the client's requirements directly:
 *
 *   "May Analysis sya, nakarecord dapat ang mga previous test"
 *       -> the session history below, one row per day of monitoring.
 *
 *   "For analysis, if nakatulong ba yung verse sa user"
 *       -> verse effectiveness, from the helpful / not helpful ratings.
 *
 *   "kapag hindi naka connect yung watch ito lang yung mga record na makikita
 *    ... then kapag naka-connect na mag aappear na yung bagong record"
 *       -> every session is marked with whether watch data was reaching the
 *          phone, and the banner at the top says so plainly.
 */

import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator, RefreshControl, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Text, TouchableOpacity, View,
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { EMOTION_LABEL, STATE_COLOR, STATE_LABEL, UI } from '@/constants/monitor';
import {
  dayKey, getLatestSampleAt, getVerseEffectiveness, listCheckins,
  listEpisodes, listSessions,
} from '@/lib/db';
import type {
  CheckinRow, EpisodeRow, SessionRow, VerseEffectiveness,
} from '@/lib/db';
import { WATCH_CONNECTED_WINDOW_MS } from '@/lib/monitoring/engine';
import { VERSE_BY_ID } from '@/lib/verses/corpus';
import type { EmotionClass, MonitorState } from '@/lib/rprv/types';

function formatDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const today = dayKey();
  if (day === today) return 'Today';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === dayKey(yesterday)) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function timeOf(ms: number | null): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function AnalysisScreen() {
  const router = useRouter();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [effectiveness, setEffectiveness] = useState<VerseEffectiveness[]>([]);
  const [checkins, setCheckins] = useState<CheckinRow[]>([]);
  const [todayEpisodes, setTodayEpisodes] = useState<EpisodeRow[]>([]);
  const [latestSampleAt, setLatestSampleAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const [s, e, c, ep, latest] = await Promise.all([
      listSessions(30),
      getVerseEffectiveness(),
      listCheckins(10),
      listEpisodes(dayKey()),
      getLatestSampleAt(),
    ]);
    setSessions(s);
    setEffectiveness(e);
    setCheckins(c);
    setTodayEpisodes(ep);
    setLatestSampleAt(latest);
    setLoading(false);
  }, []);

  // Reload on focus: the user arrives here straight after a notification, and
  // a stale list would not show the episode that brought them.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const watchConnected =
    latestSampleAt !== null && Date.now() - latestSampleAt <= WATCH_CONNECTED_WINDOW_MS;

  const totalRated = effectiveness.reduce((a, v) => a + v.shown, 0);
  const totalHelpful = effectiveness.reduce((a, v) => a + v.helpful, 0);

  return (
    <SafeAreaView style={styles.safeArea}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={UI.accent} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Analysis</Text>
      </View>

      <ScrollView
        contentContainerStyle={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {loading ? (
          <View style={styles.loading}>
            <ActivityIndicator size="large" color={UI.accent} />
          </View>
        ) : null}

        {/* ── Watch connection state ──────────────────────────────────── */}
        <View
          style={[
            styles.banner,
            { backgroundColor: watchConnected ? '#E8F8EC' : '#FFF4E5' },
          ]}
        >
          <Ionicons
            name={watchConnected ? 'watch' : 'cloud-offline-outline'}
            size={20}
            color={watchConnected ? '#248A3D' : '#B25000'}
          />
          <View style={{ flex: 1 }}>
            <Text
              style={[
                styles.bannerTitle,
                { color: watchConnected ? '#248A3D' : '#B25000' },
              ]}
            >
              {watchConnected ? 'Watch data is reaching this phone' : 'Watch not connected'}
            </Text>
            <Text style={styles.bannerBody}>
              {watchConnected
                ? `Last reading ${timeOf(latestSampleAt)}. New records appear as your watch syncs.`
                : latestSampleAt
                  ? `The most recent reading was ${timeOf(latestSampleAt)} on ${formatDay(dayKey(new Date(latestSampleAt)))}. These are the only records available until the watch reconnects — new ones will appear once it syncs again.`
                  : 'No heart-rate readings have been recorded yet. Records will appear once your watch syncs data to the phone.'}
            </Text>
          </View>
        </View>

        {/* ── Today's episodes ────────────────────────────────────────── */}
        {todayEpisodes.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Today&apos;s episodes</Text>
            {todayEpisodes.map((ep) => (
              <View key={ep.id} style={styles.episodeRow}>
                <View
                  style={[
                    styles.tierDot,
                    { backgroundColor: STATE_COLOR[ep.to_state as MonitorState] },
                  ]}
                />
                <View style={{ flex: 1 }}>
                  <Text style={styles.episodeTitle}>
                    {STATE_LABEL[ep.to_state as MonitorState]} · Level {ep.tier}
                    {ep.mean_bpm ? ` · ${Math.round(ep.mean_bpm)} bpm` : ''}
                  </Text>
                  {ep.reason ? (
                    <Text style={styles.episodeReason} numberOfLines={2}>{ep.reason}</Text>
                  ) : null}
                </View>
                <Text style={styles.episodeTime}>{timeOf(ep.at)}</Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* ── Previous sessions ───────────────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Previous records</Text>
          <Text style={styles.cardSubtitle}>
            One row per day of monitoring. Pull down to refresh.
          </Text>

          {sessions.length === 0 ? (
            <Text style={styles.empty}>
              No sessions recorded yet. Start monitoring to build a history.
            </Text>
          ) : (
            sessions.map((s) => (
              <View key={s.day} style={styles.sessionRow}>
                <View style={styles.sessionHead}>
                  <Text style={styles.sessionDay}>{formatDay(s.day)}</Text>
                  {s.dominant_state ? (
                    <View
                      style={[
                        styles.sessionPill,
                        { backgroundColor: STATE_COLOR[s.dominant_state as MonitorState] },
                      ]}
                    >
                      <Text style={styles.sessionPillText}>
                        {STATE_LABEL[s.dominant_state as MonitorState]}
                      </Text>
                    </View>
                  ) : null}
                  {!s.watch_connected ? (
                    <View style={styles.incompletePill}>
                      <Text style={styles.incompletePillText}>INCOMPLETE</Text>
                    </View>
                  ) : null}
                </View>

                <View style={styles.statGrid}>
                  <View style={styles.stat}>
                    <Text style={styles.statValue}>
                      {s.max_bpm ? Math.round(s.max_bpm) : '—'}
                    </Text>
                    <Text style={styles.statLabel}>peak bpm</Text>
                  </View>
                  <View style={styles.stat}>
                    <Text style={styles.statValue}>
                      {s.avg_bpm ? Math.round(s.avg_bpm) : '—'}
                    </Text>
                    <Text style={styles.statLabel}>average</Text>
                  </View>
                  <View style={styles.stat}>
                    <Text style={styles.statValue}>
                      {s.min_bpm ? Math.round(s.min_bpm) : '—'}
                    </Text>
                    <Text style={styles.statLabel}>lowest</Text>
                  </View>
                  <View style={styles.stat}>
                    <Text style={styles.statValue}>{s.sample_count}</Text>
                    <Text style={styles.statLabel}>readings</Text>
                  </View>
                </View>

                <Text style={styles.sessionMeta}>
                  {s.max_bpm_at ? `Peak at ${timeOf(s.max_bpm_at)}. ` : ''}
                  {s.baseline_entropy !== null
                    ? `Morning baseline ${s.baseline_entropy.toFixed(2)}.`
                    : 'No morning baseline was established, so entropy rules were off this day.'}
                  {s.dominant_emotion
                    ? ` Mostly ${EMOTION_LABEL[s.dominant_emotion as EmotionClass].toLowerCase()}.`
                    : ''}
                </Text>
              </View>
            ))
          )}
        </View>

        {/* ── Did the verses help? ────────────────────────────────────── */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Did the verses help?</Text>
          <Text style={styles.cardSubtitle}>
            Based on your own ratings after each verse. Only rated deliveries are
            counted — a verse you did not rate is not counted against it.
          </Text>

          {effectiveness.length === 0 ? (
            <Text style={styles.empty}>
              No ratings yet. When a verse arrives, tell the app whether it helped and
              this list will build up.
            </Text>
          ) : (
            <>
              <View style={styles.overallBox}>
                <Text style={styles.overallValue}>
                  {totalRated > 0 ? `${Math.round((totalHelpful / totalRated) * 100)}%` : '—'}
                </Text>
                <Text style={styles.overallLabel}>
                  of {totalRated} rated {totalRated === 1 ? 'verse' : 'verses'} marked helpful
                </Text>
              </View>

              {effectiveness.map((v) => {
                const verse = VERSE_BY_ID[v.verse_id];
                return (
                  <View key={v.verse_id} style={styles.effRow}>
                    <Text style={styles.effRef}>{verse?.reference ?? v.verse_id}</Text>
                    <View style={styles.effTrack}>
                      <View
                        style={[
                          styles.effFill,
                          {
                            width: `${v.rate * 100}%`,
                            backgroundColor: v.rate >= 0.5 ? '#4CD964' : '#FF9500',
                          },
                        ]}
                      />
                    </View>
                    <Text style={styles.effValue}>
                      {v.helpful}/{v.shown}
                    </Text>
                  </View>
                );
              })}
            </>
          )}
        </View>

        {/* ── Wellbeing check-ins ─────────────────────────────────────── */}
        {checkins.length > 0 ? (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Wellbeing check-ins</Text>
            <Text style={styles.cardSubtitle}>
              Asked after each emergency alert, so the app can learn whether its
              thresholds are set right for you.
            </Text>
            {checkins.map((c) => (
              <View key={c.id} style={styles.checkinRow}>
                <Ionicons
                  name={
                    c.response === 'ok' ? 'checkmark-circle'
                      : c.response === null ? 'help-circle-outline'
                        : 'alert-circle'
                  }
                  size={18}
                  color={
                    c.response === 'ok' ? '#4CD964'
                      : c.response === null ? UI.faint
                        : '#FF3B30'
                  }
                />
                <Text style={styles.checkinText}>
                  {new Date(c.asked_at).toLocaleString([], {
                    month: 'short', day: 'numeric',
                    hour: '2-digit', minute: '2-digit',
                  })}
                  {' — '}
                  {c.response === 'ok' ? 'Said they were okay'
                    : c.response === 'not_ok' ? 'Said they were not okay'
                      : c.response === 'needed_help' ? 'Needed help'
                        : 'No answer'}
                </Text>
              </View>
            ))}
          </View>
        ) : null}

        {/* ── Limitations ─────────────────────────────────────────────── */}
        <View style={[styles.card, styles.limitCard]}>
          <Text style={styles.cardTitle}>What this app can and cannot see</Text>
          <Text style={styles.limitItem}>
            <Text style={styles.limitLead}>It reads, it does not sense. </Text>
            HV has no sensor of its own. It reads what your watch has written to{' '}
            {`the phone's health store`}, so a reading is only as fresh as the last
            time your watch synced. When the watch is off or unpaired, no new
            records appear.
          </Text>
          <Text style={styles.limitItem}>
            <Text style={styles.limitLead}>Averaged, not beat-to-beat. </Text>
            The health store gives one averaged heart rate every few seconds, not
            individual beats. Variability measures are reconstructed from those
            averages, so they track changes in your own pattern rather than
            matching clinical HRV figures.
          </Text>
          <Text style={styles.limitItem}>
            <Text style={styles.limitLead}>Your morning sets the standard. </Text>
            Each day the app learns your calm baseline from the morning, then
            compares the rest of the day against it. Before that baseline exists,
            only the absolute heart-rate thresholds are active.
          </Text>
          <Text style={styles.limitItem}>
            <Text style={styles.limitLead}>It is not a medical device. </Text>
            Emotional states are inferred, not measured, and the classifier is
            wrong a meaningful share of the time. Nothing here diagnoses anything.
            If you feel unwell, seek medical help regardless of what the app says.
          </Text>

          <TouchableOpacity
            style={styles.algoLink}
            onPress={() => router.push('/algorithm')}
          >
            <Ionicons name="calculator-outline" size={16} color={UI.accent} />
            <Text style={styles.algoLinkText}>See the full computation</Text>
          </TouchableOpacity>
        </View>

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
  loading: { paddingVertical: 30, alignItems: 'center' },

  banner: {
    flexDirection: 'row', gap: 12, padding: 14, borderRadius: 14, alignItems: 'flex-start',
  },
  bannerTitle: { fontSize: 14, fontWeight: '800' },
  bannerBody: { fontSize: 12, color: '#6B5A45', lineHeight: 17, marginTop: 3 },

  card: {
    backgroundColor: UI.card, borderRadius: 16, padding: 16,
    borderWidth: StyleSheet.hairlineWidth, borderColor: UI.border,
  },
  limitCard: { backgroundColor: '#FBFBFD' },
  cardTitle: { fontSize: 16, fontWeight: '800', color: UI.text },
  cardSubtitle: { fontSize: 12, color: UI.muted, marginTop: 4, lineHeight: 17, marginBottom: 10 },
  empty: { fontSize: 13, color: UI.faint, lineHeight: 19, paddingVertical: 8 },

  episodeRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: UI.border,
  },
  tierDot: { width: 10, height: 10, borderRadius: 5 },
  episodeTitle: { fontSize: 13.5, fontWeight: '700', color: UI.text },
  episodeReason: { fontSize: 11, color: UI.faint, marginTop: 2, lineHeight: 15 },
  episodeTime: { fontSize: 12, color: UI.muted, fontVariant: ['tabular-nums'] },

  sessionRow: {
    paddingVertical: 12,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: UI.border,
  },
  sessionHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sessionDay: { fontSize: 15, fontWeight: '800', color: UI.text, flex: 1 },
  sessionPill: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 999 },
  sessionPillText: { color: '#FFF', fontSize: 10, fontWeight: '800' },
  incompletePill: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999,
    borderWidth: 1, borderColor: '#FF9500',
  },
  incompletePillText: { color: '#B25000', fontSize: 9, fontWeight: '800' },

  statGrid: { flexDirection: 'row', marginTop: 10, gap: 8 },
  stat: {
    flex: 1, backgroundColor: UI.background, borderRadius: 10,
    paddingVertical: 8, alignItems: 'center',
  },
  statValue: {
    fontSize: 17, fontWeight: '800', color: UI.text, fontVariant: ['tabular-nums'],
  },
  statLabel: { fontSize: 9.5, color: UI.muted, marginTop: 1 },
  sessionMeta: { fontSize: 11.5, color: UI.faint, marginTop: 8, lineHeight: 16 },

  overallBox: {
    alignItems: 'center', paddingVertical: 14, backgroundColor: UI.background,
    borderRadius: 12, marginBottom: 12,
  },
  overallValue: { fontSize: 34, fontWeight: '800', color: UI.text },
  overallLabel: { fontSize: 12, color: UI.muted, marginTop: 2 },

  effRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 5 },
  effRef: { width: 130, fontSize: 12, color: UI.text },
  effTrack: {
    flex: 1, height: 8, borderRadius: 4, backgroundColor: UI.background, overflow: 'hidden',
  },
  effFill: { height: '100%', borderRadius: 4 },
  effValue: {
    width: 42, fontSize: 11, color: UI.muted, textAlign: 'right',
    fontVariant: ['tabular-nums'],
  },

  checkinRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: UI.border,
  },
  checkinText: { fontSize: 12.5, color: UI.text, flex: 1 },

  limitItem: { fontSize: 12.5, color: UI.muted, lineHeight: 19, marginTop: 10 },
  limitLead: { fontWeight: '800', color: UI.text },
  algoLink: {
    flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 16,
    paddingVertical: 10, justifyContent: 'center',
    backgroundColor: UI.background, borderRadius: 10,
  },
  algoLinkText: { color: UI.accent, fontWeight: '700', fontSize: 13 },
});
