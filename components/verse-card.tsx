/**
 * components/verse-card.tsx
 *
 * Displays the current verse and collects the helpfulness rating.
 *
 * The rating is what makes the "did the verse help" analysis possible, and it
 * also feeds the 25% recent-engagement and 15% historical-preference terms of
 * the recommendation score — so rating a verse genuinely changes what the app
 * offers next time, and the copy says so.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { UI } from '@/constants/monitor';
import { recordVerseFeedback } from '@/lib/db';
import type { EmotionClass, MonitorState } from '@/lib/rprv/types';
import type { Verse } from '@/lib/verses/corpus';

export interface VerseCardProps {
  verse: Verse;
  /** Accent colour, normally the current state's colour. */
  color: string;
  /** Label above the reference, e.g. "ELEVATED · PEACE". */
  label: string;
  /** The notifications row this verse was delivered as, when it was one. */
  notificationId?: number | null;
  state?: MonitorState | null;
  emotion?: EmotionClass | null;
  /** Why this verse was chosen, in one line. */
  rationale?: string | null;
}

export function VerseCard({
  verse, color, label, notificationId, state, emotion, rationale,
}: VerseCardProps) {
  const [rated, setRated] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  const rate = async (helpful: boolean) => {
    if (saving || rated !== null) return;
    setSaving(true);
    try {
      // A verse shown on screen without having been delivered as a notification
      // still deserves a rating, so the link is left null rather than pointed
      // at a notifications row that does not exist.
      await recordVerseFeedback(
        notificationId ?? null, verse.id, helpful, state ?? null, emotion ?? null,
      );
      setRated(helpful);
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <View style={[styles.iconBox, { backgroundColor: `${color}15` }]}>
          <Ionicons name="book" size={18} color={color} />
        </View>
        <Text style={[styles.label, { color }]}>{label.toUpperCase()}</Text>
      </View>

      <Text style={styles.reference}>{verse.reference}</Text>
      <Text style={styles.text}>{verse.text}</Text>

      {rationale ? <Text style={styles.rationale}>{rationale}</Text> : null}

      <View style={styles.divider} />

      {rated === null ? (
        <View style={styles.rateRow}>
          <Text style={styles.ratePrompt}>Did this help?</Text>
          <View style={styles.rateButtons}>
            <TouchableOpacity
              style={[styles.rateBtn, styles.rateNo]}
              onPress={() => rate(false)}
              disabled={saving}
            >
              <Ionicons name="close" size={15} color="#8E8E93" />
              <Text style={styles.rateNoText}>No</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.rateBtn, { backgroundColor: color }]}
              onPress={() => rate(true)}
              disabled={saving}
            >
              <Ionicons name="heart" size={15} color="#FFF" />
              <Text style={styles.rateYesText}>Yes</Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.thanksRow}>
          <Ionicons
            name={rated ? 'checkmark-circle' : 'checkmark-circle-outline'}
            size={16}
            color={rated ? '#4CD964' : UI.muted}
          />
          <Text style={styles.thanksText}>
            {rated
              ? 'Noted — verses like this will come up more often.'
              : 'Noted — this one will come up less often.'}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: UI.card, borderRadius: 16, padding: 16,
    borderWidth: StyleSheet.hairlineWidth, borderColor: UI.border,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 },
  iconBox: {
    width: 32, height: 32, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
  },
  label: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  reference: { fontSize: 15, fontWeight: '800', color: UI.text },
  text: { fontSize: 14, color: UI.text, lineHeight: 21, marginTop: 6 },
  rationale: { fontSize: 11.5, color: UI.faint, lineHeight: 16, marginTop: 8 },
  divider: {
    height: StyleSheet.hairlineWidth, backgroundColor: UI.border, marginVertical: 12,
  },
  rateRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  ratePrompt: { fontSize: 13, color: UI.muted, fontWeight: '600' },
  rateButtons: { flexDirection: 'row', gap: 8 },
  rateBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999,
  },
  rateNo: { backgroundColor: UI.background },
  rateNoText: { color: UI.muted, fontWeight: '700', fontSize: 13 },
  rateYesText: { color: '#FFF', fontWeight: '700', fontSize: 13 },
  thanksRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  thanksText: { fontSize: 12, color: UI.muted, flex: 1 },
});
