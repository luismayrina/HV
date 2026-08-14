import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  StyleSheet, 
  Text, 
  View, 
  TouchableOpacity, 
  SafeAreaView, 
  ActivityIndicator, 
  StatusBar, 
  ScrollView, 
  Platform,
  Modal,
  Pressable,
} from 'react-native';
import { Stack, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';

import { useHeartRateMonitor } from '@/hooks/useHeartRateMonitor';

// Android-only: set up local notification handler
if (Platform.OS === 'android') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
}

/** How long (ms) before a reading is shown as stale in the "last polled" indicator. */
const STALE_DISPLAY_THRESHOLD_MS = 60_000;

interface VerseContent {
  emotion: string;
  verse: string;
  text: string;
  color: string;
  advice: string;
}

interface SyncLog {
  id: string;
  time: string;
  date: string;
  bpm: number;
  status: string;
  verse: string;
  fullText: string;
}

// --- EXPANDED DATA STRUCTURE ---
const verseData: Record<string, VerseContent> = {
  none: { 
    emotion: "Waiting", 
    verse: "Ready", 
    text: "Tap sync to start.", 
    color: '#5856D6', 
    advice: "Prepare for your sync." 
  },
  bradycardia: { // < 50 BPM
    emotion: "Very Low", 
    verse: "Psalm 18:2", 
    text: "The Lord is my rock, my fortress and my deliverer.", 
    color: '#007AFF', 
    advice: "Heart rate is very low. If you aren't an athlete or sleeping, please rest and move slowly." 
  },
  tired: { // 50 - 64 BPM
    emotion: "Relaxed/Low", 
    verse: "Isaiah 40:31", 
    text: "But they who wait for the Lord shall renew their strength.", 
    color: '#FF9500', 
    advice: "You are in a deep state of rest or low energy. Use this time for quiet reflection." 
  },
  calm: { // 65 - 85 BPM
    emotion: "Steady", 
    verse: "Psalm 23:1", 
    text: "The Lord is my shepherd; I shall not want.", 
    color: '#4CD964', 
    advice: "Your heart is at a healthy, steady pace. Maintain this peace." 
  },
  elevated: { // 86 - 100 BPM
    emotion: "Active", 
    verse: "Colossians 3:23", 
    text: "Whatever you do, work at it with all your heart, as working for the Lord.", 
    color: '#FFCC00', 
    advice: "Your heart is working. Stay focused and keep your spirit high." 
  },
  stressed: { // 101 - 130 BPM
    emotion: "Anxious/High", 
    verse: "Philippians 4:6-7", 
    text: "Do not be anxious about anything, but in everything by prayer...", 
    color: '#FF3B30', 
    advice: "High heart rate. Try box breathing: Inhale 4s, Hold 4s, Exhale 4s." 
  },
  tachycardia: { // > 130 BPM
    emotion: "Very High", 
    verse: "Psalm 46:10", 
    text: "Be still, and know that I am God.", 
    color: '#8E1717', 
    advice: "Intense heart rate detected. Stop physical activity, sit down, and focus on slow breaths." 
  }
};

export default function HomeScreen() {
  const router = useRouter();
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [selectedLog, setSelectedLog] = useState<SyncLog | null>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [watchTipDismissed, setWatchTipDismissed] = useState(false);
  // DEV simulation interval — separate from the real monitoring hook
  const simulatePollInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  // Simulated BPM state (only used in DEV simulate mode)
  const [simBpm, setSimBpm] = useState<number | null>(null);
  // Tracks the last BPM value for which an Android notification was sent.
  // Prevents duplicate notifications when Health Connect returns the same
  // cached reading on consecutive poll ticks.
  const lastNotifiedBpmRef = useRef<number | null>(null);

  // ── Heart rate monitoring hook ──────────────────────────────────────────
  // onNewBpm callback: builds a SyncLog entry and fires an Android notification
  const handleNewBpm = useCallback(async (newBpm: number, updatedAt: Date) => {
    const content = getActiveContent(newBpm);
    const newLog: SyncLog = {
      id: Math.random().toString(),
      time: updatedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      date: updatedAt.toLocaleDateString([], { month: 'long', day: 'numeric' }),
      bpm: newBpm,
      status: content.emotion,
      verse: content.verse,
      fullText: content.text,
    };
    setLogs(prev => [newLog, ...prev].slice(0, 10));

    if (Platform.OS === 'android' && newBpm !== lastNotifiedBpmRef.current) {
      lastNotifiedBpmRef.current = newBpm;
      await Notifications.scheduleNotificationAsync({
        content: {
          title: `💬 Heart Guidance: ${content.emotion}`,
          body: `${content.verse} • ${newBpm} BPM — "${content.text}"`,
        },
        trigger: null,
      });
    }
  }, []);

  const monitor = useHeartRateMonitor(handleNewBpm);

  // Effective BPM: prefer hook value; fall back to DEV simulated BPM
  const effectiveBpm = isSimulating ? (simBpm ?? 0) : (monitor.bpm ?? 0);
  const effectiveMonitoring = monitor.isMonitoring || isSimulating;
  const effectivePermission = monitor.permissionGranted || isSimulating;

  // --- DYNAMIC SELECTION LOGIC ---
  const getActiveContent = (currentBpm: number): VerseContent => {
    if (currentBpm === 0) return verseData.none;
    if (currentBpm < 50) return verseData.bradycardia;
    if (currentBpm < 65) return verseData.tired;
    if (currentBpm <= 85) return verseData.calm;
    if (currentBpm <= 100) return verseData.elevated;
    if (currentBpm <= 130) return verseData.stressed;
    return verseData.tachycardia;
  };

  // Set up Android notification channel once on mount
  useEffect(() => {
    if (Platform.OS === 'android') {
      (async () => {
        await Notifications.setNotificationChannelAsync('messages', {
          name: 'Heart Guidance',
          importance: Notifications.AndroidImportance.MAX,
        });
        const { status } = await Notifications.getPermissionsAsync();
        if (status !== 'granted') await Notifications.requestPermissionsAsync();
      })();
    }
  }, []);

  // Clean up DEV simulation interval on unmount
  useEffect(() => {
    return () => {
      if (simulatePollInterval.current) {
        clearInterval(simulatePollInterval.current);
        simulatePollInterval.current = null;
      }
    };
  }, []);

  const activeContent = getActiveContent(effectiveBpm);
  const themeColor = activeContent.color;


  /** Toggle monitoring via the hook, or stop DEV simulation. */
  const toggleMonitoring = async () => {
    if (effectiveMonitoring) {
      // Stop real monitoring
      monitor.stopMonitoring();
      // Stop DEV simulation if active
      if (simulatePollInterval.current) {
        clearInterval(simulatePollInterval.current);
        simulatePollInterval.current = null;
      }
      setIsSimulating(false);
      setSimBpm(null);
      // Reset notification dedup so next session sends a fresh first notification
      lastNotifiedBpmRef.current = null;
      return;
    }
    await monitor.startMonitoring();
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <Stack.Screen options={{ headerShown: false }} />
      <StatusBar barStyle="dark-content" />
      
      <ScrollView contentContainerStyle={styles.scrollContainer} showsVerticalScrollIndicator={false}>
        <View style={styles.header}>
          <View>
            <Text style={styles.welcomeText}>Heart Verse</Text>
            <View style={styles.statusRow}>
              <View style={[styles.statusDot, { backgroundColor: effectivePermission ? '#4CD964' : '#FF3B30' }]} />
              <Text style={styles.statusText}>{effectivePermission ? 'Watch Active' : 'Disconnected'}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.profileCircle} onPress={() => router.push('/profile')}>
            <Ionicons name="person" size={20} color="#8E8E93" />
          </TouchableOpacity>
        </View>

        <View style={[styles.mainCard, { borderColor: themeColor + '40' }]}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Live Monitoring</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              {monitor.isStale && effectiveMonitoring && (
                <View style={styles.staleTag}>
                  <Ionicons name="time-outline" size={10} color="#FF9500" />
                  <Text style={styles.staleTagText}>STALE</Text>
                </View>
              )}
              {effectiveBpm > 0 && <View style={[styles.liveTag, { backgroundColor: themeColor }]}><Text style={styles.liveTagText}>LIVE</Text></View>}
            </View>
          </View>
          <View style={styles.monitorContent}>
            <View style={[styles.outerCircle, { borderColor: effectiveMonitoring ? themeColor : '#F2F2F7' }]}>
              {monitor.isLoading ? (
                <ActivityIndicator size="large" color={themeColor} />
              ) : effectiveMonitoring && effectiveBpm === 0 ? (
                <View style={{ alignItems: 'center', paddingHorizontal: 12 }}>
                  <ActivityIndicator size="small" color={themeColor} style={{ marginBottom: 8 }} />
                  <Text style={styles.waitingText}>Waiting for{`\n`}heart rate…</Text>
                </View>
              ) : (
                <View style={{ alignItems: 'center' }}>
                  <Ionicons name="heart" size={32} color={themeColor} />
                  <Text style={styles.bpmNumber}>{effectiveBpm === 0 ? '--' : effectiveBpm}</Text>
                  <Text style={styles.bpmSubtext}>BPM</Text>
                  {monitor.lastUpdated && (
                    <Text style={{ fontSize: 9, color: '#AEAEC0', marginTop: 4 }}>
                      {monitor.lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </Text>
                  )}
                </View>
              )}
            </View>
          </View>
          {monitor.error && (
            <View style={styles.errorBanner}>
              <Ionicons name="warning-outline" size={14} color="#FF3B30" />
              <Text style={styles.errorBannerText}>{monitor.error}</Text>
            </View>
          )}
        </View>

        {/* Compact banner shown while monitoring is active */}
        {effectiveMonitoring && !watchTipDismissed && !isSimulating && Platform.OS === 'ios' && (
          <View style={styles.watchBanner}>
            <Ionicons name="watch" size={16} color="#FF9500" />
            <Text style={styles.watchBannerText}>Start a workout on your Apple Watch for live BPM updates</Text>
            <TouchableOpacity onPress={() => setWatchTipDismissed(true)}>
              <Ionicons name="close" size={16} color="#FF9500" />
            </TouchableOpacity>
          </View>
        )}

        {/* Watch setup tip card — shown before monitoring starts */}
        {!effectiveMonitoring && !watchTipDismissed && Platform.OS === 'ios' && (
          <View style={styles.watchTipCard}>
            <View style={styles.watchTipHeader}>
              <View style={styles.watchTipIconBox}>
                <Ionicons name="watch" size={20} color="#FF9500" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.watchTipTitle}>For Real-Time Updates</Text>
                <Text style={styles.watchTipSubtitle}>Apple Watch + iPhone sync is controlled by iOS</Text>
              </View>
              <TouchableOpacity onPress={() => setWatchTipDismissed(true)}>
                <Ionicons name="close-circle" size={22} color="#C7C7CC" />
              </TouchableOpacity>
            </View>
            <View style={styles.watchTipDivider} />
            <View style={styles.watchTipStep}>
              <View style={styles.watchTipStepNum}><Text style={styles.watchTipStepNumText}>1</Text></View>
              <Text style={styles.watchTipStepText}>On your Apple Watch, open the <Text style={{ fontWeight: '800' }}>Workout</Text> app</Text>
            </View>
            <View style={styles.watchTipStep}>
              <View style={styles.watchTipStepNum}><Text style={styles.watchTipStepNumText}>2</Text></View>
              <Text style={styles.watchTipStepText}>Select any workout type — <Text style={{ fontWeight: '800' }}>"Other"</Text> works great</Text>
            </View>
            <View style={styles.watchTipStep}>
              <View style={styles.watchTipStepNum}><Text style={styles.watchTipStepNumText}>3</Text></View>
              <Text style={styles.watchTipStepText}>Tap <Text style={{ fontWeight: '800' }}>Start Monitoring</Text> in this app — you'll get readings every 1-2 seconds</Text>
            </View>
            <TouchableOpacity style={styles.watchTipBtn} onPress={() => setWatchTipDismissed(true)}>
              <Text style={styles.watchTipBtnText}>Got it</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.verseCard}>
          <View style={styles.verseHeader}>
            <View style={[styles.iconBox, { backgroundColor: themeColor + '15' }]}><Ionicons name="book" size={18} color={themeColor} /></View>
            <Text style={[styles.verseLabel, { color: themeColor }]}>{activeContent.emotion.toUpperCase()}</Text>
          </View>
          <Text style={styles.verseRef}>{activeContent.verse}</Text>
          <Text style={styles.verseText}>"{activeContent.text}"</Text>
          <Text style={styles.adviceText}>{activeContent.advice}</Text>
        </View>

        <View style={styles.logSection}>
          <Text style={styles.logHeading}>Sync History</Text>
          {logs.length === 0 ? (
            <View style={styles.emptyLogContainer}><Text style={styles.emptyLogText}>No readings yet.</Text></View>
          ) : (
            logs.map((item) => (
              <TouchableOpacity key={item.id} style={styles.logItem} onPress={() => { setSelectedLog(item); setModalVisible(true); }}>
                <View style={styles.logLeft}>
                  <Ionicons name="time-outline" size={16} color="#8E8E93" />
                  <Text style={styles.logTime}>{item.time}</Text>
                </View>
                <Text style={styles.logBpm}>{item.bpm} BPM</Text>
                <Ionicons name="chevron-forward" size={16} color="#C7C7CC" />
              </TouchableOpacity>
            ))
          )}
        </View>

        <View style={{ height: 120 }} />
      </ScrollView>

      <Modal animationType="fade" transparent={true} visible={modalVisible} onRequestClose={() => setModalVisible(false)}>
        <Pressable style={styles.modalOverlay} onPress={() => setModalVisible(false)}>
          <View style={styles.modalContent}>
            <View style={[styles.modalHeader, { backgroundColor: getActiveContent(selectedLog?.bpm || 0).color }]}>
              <Text style={styles.modalHeaderTitle}>Session Details</Text>
              <TouchableOpacity onPress={() => setModalVisible(false)}><Ionicons name="close" size={24} color="#FFF" /></TouchableOpacity>
            </View>
            <View style={styles.modalBody}>
              <View style={styles.modalRow}>
                <View><Text style={styles.modalLabel}>TIME</Text><Text style={styles.modalValue}>{selectedLog?.time}</Text></View>
                <View style={{ alignItems: 'flex-end' }}><Text style={styles.modalLabel}>DATE</Text><Text style={styles.modalValue}>{selectedLog?.date}</Text></View>
              </View>
              <View style={styles.modalBpmBox}>
                <Text style={styles.modalBpmValue}>{selectedLog?.bpm}</Text>
                <Text style={styles.modalBpmLabel}>Beats Per Minute</Text>
              </View>
              <View style={styles.modalVerseBox}>
                <Text style={[styles.modalVerseRef, { color: getActiveContent(selectedLog?.bpm || 0).color }]}>{selectedLog?.verse}</Text>
                <Text style={styles.modalFullText}>"{selectedLog?.fullText}"</Text>
              </View>
            </View>
          </View>
        </Pressable>
      </Modal>

      <View style={styles.buttonContainer}>
        {/* DEV-only simulate button — tests real-time UI without a real Watch */}
        {__DEV__ && !effectiveMonitoring && (
          <TouchableOpacity
            style={[styles.syncBtn, { backgroundColor: '#5856D6', marginBottom: 12 }]}
            onPress={() => {
              const bpmSequence = [62, 75, 88, 101, 115, 95, 78, 65, 72, 83, 110, 70];
              let idx = 0;
              setIsSimulating(true);
              const firstBpm = bpmSequence[idx++ % bpmSequence.length];
              setSimBpm(firstBpm);
              handleNewBpm(firstBpm, new Date());
              simulatePollInterval.current = setInterval(() => {
                const fakeBpm = bpmSequence[idx++ % bpmSequence.length];
                console.log('[SIM] fake BPM:', fakeBpm);
                setSimBpm(fakeBpm);
                handleNewBpm(fakeBpm, new Date());
              }, 3000);
            }}
          >
            <Ionicons name="flask" size={22} color="#FFF" style={{ marginRight: 10 }} />
            <Text style={styles.syncBtnText}>SIMULATE (DEV)</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity style={[styles.syncBtn, { backgroundColor: effectiveMonitoring ? '#FF3B30' : themeColor }]} onPress={toggleMonitoring}>
          <Ionicons name={effectiveMonitoring ? 'stop-circle' : 'pulse'} size={22} color="#FFF" style={{ marginRight: 10 }} />
          <Text style={styles.syncBtnText}>{effectiveMonitoring ? (isSimulating ? 'STOP SIMULATION' : 'STOP MONITORING') : 'START MONITORING'}</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F8F9FB', paddingTop: Platform.OS === 'android' ? StatusBar.currentHeight : 0 },
  scrollContainer: { paddingHorizontal: 20, paddingTop: 35 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 25 },
  welcomeText: { fontSize: 28, fontWeight: '800', color: '#1C1C1E' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4 },
  statusDot: { width: 6, height: 6, borderRadius: 3, marginRight: 6 },
  statusText: { fontSize: 12, color: '#8E8E93', fontWeight: '600' },
  profileCircle: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#FFF', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#E5E5EA' },
  mainCard: { backgroundColor: '#FFF', borderRadius: 32, padding: 20, marginBottom: 20, borderWidth: 1.5, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 15, elevation: 4 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  cardTitle: { fontSize: 12, fontWeight: '800', color: '#AEAEC0', textTransform: 'uppercase' },
  liveTag: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  liveTagText: { color: '#FFF', fontSize: 10, fontWeight: '900' },
  staleTag: { flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: '#FFF3E0', borderWidth: 1, borderColor: '#FF950040' },
  staleTagText: { color: '#FF9500', fontSize: 10, fontWeight: '800' },
  waitingText: { fontSize: 12, color: '#AEAEC0', fontWeight: '600', textAlign: 'center', lineHeight: 18 },
  errorBanner: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FFF1F0', borderRadius: 12, padding: 10, marginTop: 12, borderWidth: 1, borderColor: '#FF3B3030' },
  errorBannerText: { flex: 1, fontSize: 12, color: '#FF3B30', fontWeight: '600' },
  monitorContent: { alignItems: 'center', paddingBottom: 10 },
  outerCircle: { width: 160, height: 160, borderRadius: 80, borderWidth: 4, alignItems: 'center', justifyContent: 'center', backgroundColor: '#FDFDFF' },
  bpmNumber: { fontSize: 52, fontWeight: '800', color: '#1C1C1E' },
  bpmSubtext: { fontSize: 12, color: '#AEAEC0', fontWeight: '700' },
  verseCard: { backgroundColor: '#FFF', borderRadius: 28, padding: 22, marginBottom: 25 },
  verseHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 15 },
  iconBox: { padding: 8, borderRadius: 12, marginRight: 10 },
  verseLabel: { fontSize: 12, fontWeight: '900' },
  verseRef: { fontSize: 22, fontWeight: '700', color: '#1C1C1E', marginBottom: 8 },
  verseText: { fontSize: 16, color: '#48484A', lineHeight: 24, fontStyle: 'italic' },
  adviceText: { fontSize: 13, color: '#8E8E93', marginTop: 12, fontWeight: '500' },
  watchBanner: { flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: '#FFF3E0', borderRadius: 16, padding: 14, marginBottom: 20, borderWidth: 1, borderColor: '#FFCC0040' },
  watchBannerText: { flex: 1, fontSize: 12, color: '#FF9500', fontWeight: '600' },
  watchTipCard: { backgroundColor: '#FFF', borderRadius: 24, padding: 20, marginBottom: 20, borderWidth: 1.5, borderColor: '#FF950030', shadowColor: '#FF9500', shadowOpacity: 0.08, shadowRadius: 12, elevation: 3 },
  watchTipHeader: { flexDirection: 'row', alignItems: 'center', gap: 12, marginBottom: 16 },
  watchTipIconBox: { width: 40, height: 40, borderRadius: 12, backgroundColor: '#FFF3E0', justifyContent: 'center', alignItems: 'center' },
  watchTipTitle: { fontSize: 15, fontWeight: '800', color: '#1C1C1E' },
  watchTipSubtitle: { fontSize: 11, color: '#8E8E93', fontWeight: '500', marginTop: 2 },
  watchTipDivider: { height: 1, backgroundColor: '#F2F2F7', marginBottom: 16 },
  watchTipStep: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  watchTipStepNum: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#FF9500', justifyContent: 'center', alignItems: 'center', marginTop: 1 },
  watchTipStepNumText: { color: '#FFF', fontSize: 12, fontWeight: '900' },
  watchTipStepText: { flex: 1, fontSize: 13, color: '#48484A', lineHeight: 20, fontWeight: '500' },
  watchTipBtn: { marginTop: 6, backgroundColor: '#FF9500', borderRadius: 14, paddingVertical: 12, alignItems: 'center' },
  watchTipBtnText: { color: '#FFF', fontWeight: '800', fontSize: 14 },
  logSection: { width: '100%' },
  logHeading: { fontSize: 18, fontWeight: '800', color: '#1C1C1E', marginBottom: 15 },
  logItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#FFF', padding: 18, borderRadius: 20, marginBottom: 12 },
  logLeft: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  logTime: { fontSize: 14, color: '#8E8E93', fontWeight: '600' },
  logBpm: { fontSize: 16, fontWeight: '700', color: '#1C1C1E' },
  emptyLogContainer: { padding: 30, alignItems: 'center', borderRadius: 20, borderWidth: 1, borderColor: '#E5E5EA', borderStyle: 'dashed' },
  emptyLogText: { color: '#AEAEC0', fontWeight: '600' },
  buttonContainer: { position: 'absolute', bottom: 35, left: 20, right: 20 },
  syncBtn: { flexDirection: 'row', paddingVertical: 22, borderRadius: 24, justifyContent: 'center', alignItems: 'center', elevation: 8 },
  syncBtnText: { color: '#FFF', fontWeight: '800', fontSize: 16 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  modalContent: { backgroundColor: '#FFF', width: '100%', borderRadius: 32, overflow: 'hidden' },
  modalHeader: { padding: 20, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  modalHeaderTitle: { color: '#FFF', fontWeight: '800', fontSize: 18 },
  modalBody: { padding: 25 },
  modalRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 25 },
  modalLabel: { fontSize: 11, fontWeight: '800', color: '#AEAEC0' },
  modalValue: { fontSize: 16, fontWeight: '700', color: '#1C1C1E' },
  modalBpmBox: { alignItems: 'center', paddingVertical: 20, backgroundColor: '#F8F9FB', borderRadius: 24, marginBottom: 25 },
  modalBpmValue: { fontSize: 52, fontWeight: '800', color: '#1C1C1E' },
  modalBpmLabel: { fontSize: 12, fontWeight: '700', color: '#8E8E93' },
  modalVerseBox: { borderTopWidth: 1, borderColor: '#F2F2F7', paddingTop: 20 },
  modalVerseRef: { fontSize: 18, fontWeight: '800', marginBottom: 10 },
  modalFullText: { fontSize: 15, color: '#48484A', lineHeight: 22, fontStyle: 'italic' }
});