/**
 * app/settings.tsx
 *
 * Thresholds and emergency contacts.
 *
 * The thresholds are deliberately user-editable. The client's brief states
 * that what counts as an emergency "depende sa condition ng user", and the
 * study's own design is built on personalised rather than population
 * thresholds, so 120 bpm is a starting point that the user can move.
 */

import React, { useCallback, useState } from 'react';
import {
  Alert, KeyboardAvoidingView, Platform, SafeAreaView, ScrollView, StatusBar,
  StyleSheet, Switch, Text, TextInput, TouchableOpacity, View,
} from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { UI } from '@/constants/monitor';
import { addContact, deleteContact, listContacts } from '@/lib/db';
import type { ContactRow } from '@/lib/db';
import { DEFAULT_SETTINGS, loadSettings, saveSetting } from '@/lib/settings';
import type { AppSettings } from '@/lib/settings';

/** Bounds that keep a typo from disabling the safety rules entirely. */
const BPM_MIN = 60;
const BPM_MAX = 220;

export default function SettingsScreen() {
  const router = useRouter();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [contacts, setContacts] = useState<ContactRow[]>([]);
  const [warnText, setWarnText] = useState(String(DEFAULT_SETTINGS.warnBpm));
  const [emergencyText, setEmergencyText] = useState(String(DEFAULT_SETTINGS.emergencyBpm));
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  const load = useCallback(async () => {
    const [s, c] = await Promise.all([loadSettings(), listContacts()]);
    setSettings(s);
    setWarnText(String(s.warnBpm));
    setEmergencyText(String(s.emergencyBpm));
    setContacts(c);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const commitThreshold = useCallback(async (
    key: 'warnBpm' | 'emergencyBpm',
    text: string,
  ) => {
    const value = Number(text);
    if (!Number.isFinite(value) || value < BPM_MIN || value > BPM_MAX) {
      Alert.alert(
        'Out of range',
        `Enter a heart rate between ${BPM_MIN} and ${BPM_MAX} bpm.`,
      );
      await load();
      return;
    }

    // The emergency threshold sits above the warning threshold by definition;
    // inverting them would make one of the two rules unreachable.
    if (key === 'warnBpm' && value >= settings.emergencyBpm) {
      Alert.alert(
        'Warning must be below emergency',
        `Your emergency threshold is ${settings.emergencyBpm} bpm. Set the warning below it.`,
      );
      await load();
      return;
    }
    if (key === 'emergencyBpm' && value <= settings.warnBpm) {
      Alert.alert(
        'Emergency must be above warning',
        `Your warning threshold is ${settings.warnBpm} bpm. Set the emergency above it.`,
      );
      await load();
      return;
    }

    await saveSetting(key, value);
    await load();
  }, [settings.warnBpm, settings.emergencyBpm, load]);

  const onAddContact = useCallback(async () => {
    const trimmedName = name.trim();
    const trimmedPhone = phone.trim();
    if (!trimmedName || !trimmedPhone) {
      Alert.alert('Missing details', 'Enter both a name and a phone number.');
      return;
    }
    await addContact(trimmedName, trimmedPhone);
    setName('');
    setPhone('');
    await load();
  }, [name, phone, load]);

  const onDeleteContact = useCallback((contact: ContactRow) => {
    Alert.alert(
      'Remove contact',
      `Remove ${contact.name} from your emergency contacts?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => { await deleteContact(contact.id); await load(); },
        },
      ],
    );
  }, [load]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="dark-content" />

      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={24} color={UI.accent} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Settings</Text>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {/* ── Thresholds ─────────────────────────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Heart rate thresholds</Text>
            <Text style={styles.cardSubtitle}>
              These are absolute limits, checked on every reading independently of
              the emotional analysis. What is normal for you may not be normal for
              someone else — set them with your doctor if you have a heart condition.
            </Text>

            <View style={styles.field}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>Warning</Text>
                <Text style={styles.fieldHint}>Sends a high heart rate notification</Text>
              </View>
              <TextInput
                style={styles.input}
                value={warnText}
                onChangeText={setWarnText}
                onBlur={() => commitThreshold('warnBpm', warnText)}
                keyboardType="number-pad"
                returnKeyType="done"
                maxLength={3}
              />
              <Text style={styles.unit}>bpm</Text>
            </View>

            <View style={styles.field}>
              <View style={{ flex: 1 }}>
                <Text style={styles.fieldLabel}>Emergency</Text>
                <Text style={styles.fieldHint}>
                  Triggers a Level 3 alert and the wellbeing check-in
                </Text>
              </View>
              <TextInput
                style={styles.input}
                value={emergencyText}
                onChangeText={setEmergencyText}
                onBlur={() => commitThreshold('emergencyBpm', emergencyText)}
                keyboardType="number-pad"
                returnKeyType="done"
                maxLength={3}
              />
              <Text style={styles.unit}>bpm</Text>
            </View>
          </View>

          {/* ── Collection window ──────────────────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Daily collection</Text>
            <Text style={styles.cardSubtitle}>
              HV records through the working day and sends a summary at the end of it.
            </Text>
            <View style={styles.readonlyRow}>
              <Text style={styles.readonlyLabel}>Recording window</Text>
              <Text style={styles.readonlyValue}>
                {String(settings.collectionStartHour).padStart(2, '0')}:00 –{' '}
                {String(settings.collectionEndHour).padStart(2, '0')}:00
              </Text>
            </View>
            <View style={styles.readonlyRow}>
              <Text style={styles.readonlyLabel}>Morning baseline ends</Text>
              <Text style={styles.readonlyValue}>
                {String(settings.baselineEndHour).padStart(2, '0')}:00
              </Text>
            </View>
            <View style={styles.readonlyRow}>
              <Text style={styles.readonlyLabel}>Daily summary</Text>
              <Text style={styles.readonlyValue}>
                {String(settings.summaryHour).padStart(2, '0')}:
                {String(settings.summaryMinute).padStart(2, '0')}
              </Text>
            </View>
            <Text style={styles.note}>
              Your calm baseline is learned from the morning segment each day. Readings
              after it are compared against that baseline, so a rise in the afternoon is
              measured against your own morning rather than against a fixed number.
            </Text>
          </View>

          {/* ── Emergency contacts ─────────────────────────────────────── */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Emergency contacts</Text>
            <Text style={styles.cardSubtitle}>
              On a Level 3 alert, HV opens a text message to these contacts with your
              heart rate. You press send — the app never messages anyone by itself.
            </Text>

            <View style={styles.switchRow}>
              <Text style={styles.fieldLabel}>Offer to text contacts</Text>
              <Switch
                value={settings.alertContacts}
                onValueChange={async (v) => {
                  await saveSetting('alertContacts', v);
                  await load();
                }}
              />
            </View>

            {contacts.map((c) => (
              <View key={c.id} style={styles.contactRow}>
                <Ionicons name="person-circle-outline" size={26} color={UI.muted} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.contactName}>{c.name}</Text>
                  <Text style={styles.contactPhone}>{c.phone}</Text>
                </View>
                <TouchableOpacity onPress={() => onDeleteContact(c)} hitSlop={8}>
                  <Ionicons name="trash-outline" size={19} color="#FF3B30" />
                </TouchableOpacity>
              </View>
            ))}

            {contacts.length === 0 ? (
              <Text style={styles.note}>
                No contacts saved. Without one, a Level 3 alert still notifies you and
                records the episode, but there is nobody to text.
              </Text>
            ) : null}

            <View style={styles.addBox}>
              <TextInput
                style={styles.addInput}
                placeholder="Name"
                placeholderTextColor={UI.faint}
                value={name}
                onChangeText={setName}
              />
              <TextInput
                style={styles.addInput}
                placeholder="Phone number"
                placeholderTextColor={UI.faint}
                value={phone}
                onChangeText={setPhone}
                keyboardType="phone-pad"
              />
              <TouchableOpacity style={styles.addBtn} onPress={onAddContact}>
                <Ionicons name="add" size={18} color="#FFF" />
                <Text style={styles.addBtnText}>Add contact</Text>
              </TouchableOpacity>
            </View>
          </View>

          <View style={{ height: 40 }} />
        </ScrollView>
      </KeyboardAvoidingView>
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

  card: {
    backgroundColor: UI.card, borderRadius: 16, padding: 16,
    borderWidth: StyleSheet.hairlineWidth, borderColor: UI.border,
  },
  cardTitle: { fontSize: 16, fontWeight: '800', color: UI.text },
  cardSubtitle: { fontSize: 12, color: UI.muted, marginTop: 4, lineHeight: 17, marginBottom: 6 },
  note: { fontSize: 11.5, color: UI.faint, lineHeight: 17, marginTop: 10 },

  field: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: UI.border,
  },
  fieldLabel: { fontSize: 14, fontWeight: '600', color: UI.text },
  fieldHint: { fontSize: 11, color: UI.faint, marginTop: 2 },
  input: {
    width: 64, height: 38, borderRadius: 9, backgroundColor: UI.background,
    textAlign: 'center', fontSize: 16, fontWeight: '700', color: UI.text,
  },
  unit: { fontSize: 12, color: UI.muted, width: 26 },

  readonlyRow: {
    flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 7,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: UI.border,
  },
  readonlyLabel: { fontSize: 13, color: UI.muted },
  readonlyValue: {
    fontSize: 13, color: UI.text, fontWeight: '700', fontVariant: ['tabular-nums'],
  },

  switchRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: UI.border,
  },

  contactRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: UI.border,
  },
  contactName: { fontSize: 14, fontWeight: '600', color: UI.text },
  contactPhone: { fontSize: 12, color: UI.muted, marginTop: 1 },

  addBox: { marginTop: 12, gap: 8 },
  addInput: {
    height: 42, borderRadius: 10, backgroundColor: UI.background,
    paddingHorizontal: 12, fontSize: 14, color: UI.text,
  },
  addBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: 44, borderRadius: 11, backgroundColor: UI.accent,
  },
  addBtnText: { color: '#FFF', fontWeight: '700', fontSize: 14 },
});
