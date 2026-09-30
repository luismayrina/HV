/**
 * components/checkin-prompt.tsx
 *
 * The post-emergency wellbeing check-in.
 *
 * Implements the client's request for a follow-up question after an emergency
 * warning fires: "Dapat mag karoon ng question na notification (if okay lang
 * ba si User after mag trigger si emergency warning), for record para sa help
 * ni user for adjustment sa health".
 *
 * The answer is recorded against the episode, so the analysis screen can show
 * how often an emergency alert corresponded to the user actually being unwell
 * — which is the evidence needed to decide whether their threshold is set too
 * low or too high.
 */

import React, { useState } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { UI } from '@/constants/monitor';
import { answerCheckin } from '@/lib/db';
import type { CheckinRow } from '@/lib/db';

export interface CheckinPromptProps {
  checkin: CheckinRow;
  /** Called once the user has answered, so the host can dismiss the card. */
  onAnswered: () => void;
}

const OPTIONS: { value: 'ok' | 'not_ok' | 'needed_help'; label: string; icon: string; color: string }[] = [
  { value: 'ok', label: "I'm okay", icon: 'checkmark-circle', color: '#4CD964' },
  { value: 'not_ok', label: 'Not great', icon: 'alert-circle', color: '#FF9500' },
  { value: 'needed_help', label: 'I needed help', icon: 'medical', color: '#FF3B30' },
];

export function CheckinPrompt({ checkin, onAnswered }: CheckinPromptProps) {
  const [saving, setSaving] = useState(false);

  const answer = async (value: 'ok' | 'not_ok' | 'needed_help') => {
    if (saving) return;
    setSaving(true);
    try {
      await answerCheckin(checkin.id, value);
      onAnswered();
    } finally {
      setSaving(false);
    }
  };

  const askedAgo = Math.round((Date.now() - checkin.asked_at) / 60_000);

  return (
    <View style={styles.card}>
      <View style={styles.head}>
        <Ionicons name="hand-left-outline" size={20} color="#B25000" />
        <Text style={styles.title}>Are you okay?</Text>
      </View>
      <Text style={styles.body}>
        HV flagged a high-stress episode{' '}
        {askedAgo < 1 ? 'just now' : `about ${askedAgo} minutes ago`}. Letting us know
        how you actually felt helps set your thresholds correctly — and it is the only
        way to tell a real episode from a false alarm.
      </Text>

      <View style={styles.options}>
        {OPTIONS.map((o) => (
          <TouchableOpacity
            key={o.value}
            style={styles.option}
            onPress={() => answer(o.value)}
            disabled={saving}
          >
            <Ionicons name={o.icon as never} size={18} color={o.color} />
            <Text style={styles.optionText}>{o.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: '#FFF7ED', borderRadius: 16, padding: 16,
    borderWidth: 1, borderColor: '#FFD9A8',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 16, fontWeight: '800', color: '#B25000' },
  body: { fontSize: 12.5, color: '#7A5A38', lineHeight: 18, marginTop: 6 },
  options: { gap: 8, marginTop: 14 },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: UI.card, borderRadius: 11, paddingVertical: 11, paddingHorizontal: 14,
  },
  optionText: { fontSize: 14, fontWeight: '600', color: UI.text },
});
