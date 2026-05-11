import React, { useState, useEffect } from 'react';
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
  Pressable
} from 'react-native';
import { Stack } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Notifications from 'expo-notifications';
import { requestAuthorization, getMostRecentQuantitySample, HKQuantityTypeIdentifier } from '@kingstinct/react-native-healthkit';

// --- NOTIFICATION HANDLER ---
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

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
  const [bpm, setBpm] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [hasPermission, setHasPermission] = useState(false);
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [selectedLog, setSelectedLog] = useState<SyncLog | null>(null);
  const [modalVisible, setModalVisible] = useState(false);

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

  const activeContent = getActiveContent(bpm);
  const themeColor = activeContent.color;

  useEffect(() => {
    setupNotifications();
  }, []);

  const setupNotifications = async () => {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('messages', {
        name: 'Heart Guidance',
        importance: Notifications.AndroidImportance.MAX,
      });
    }
    const { status } = await Notifications.getPermissionsAsync();
    setHasPermission(status === 'granted');
  };

  const syncHealthData = async () => {
    if (!hasPermission) {
      const { status } = await Notifications.requestPermissionsAsync();
      setHasPermission(status === 'granted');
      if (status !== 'granted') return;
    }

    setIsSyncing(true);

    let actualBpm = 0;

    try {
      if (Platform.OS === 'ios') {
        // Request HealthKit permission and fetch
        await requestAuthorization([HKQuantityTypeIdentifier.heartRate]);
        const sample = await getMostRecentQuantitySample(HKQuantityTypeIdentifier.heartRate);
        if (sample && sample.quantity) {
          actualBpm = Math.round(sample.quantity);
        }
      } else if (Platform.OS === 'android') {
        alert("Android Health Connect support is coming soon!");
        setIsSyncing(false);
        return;
      }
    } catch (error) {
      console.error("Error fetching health data:", error);
    }

    if (actualBpm === 0) {
      alert("No recent heart rate data found on your device. Please ensure your watch is synced with Health/Fit.");
      setIsSyncing(false);
      return;
    }

    const now = new Date();
    const content = getActiveContent(actualBpm);

    const newLog: SyncLog = {
      id: Math.random().toString(),
      time: now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      date: now.toLocaleDateString([], { month: 'long', day: 'numeric' }),
      bpm: actualBpm,
      status: content.emotion,
      verse: content.verse,
      fullText: content.text
    };

    setBpm(actualBpm);
    setIsSyncing(false);
    setLogs(prev => [newLog, ...prev].slice(0, 10));

    await Notifications.scheduleNotificationAsync({
      content: {
        title: `💬 Heart Guidance: ${content.emotion}`,
        subtitle: `${content.verse} • ${actualBpm} BPM`,
        body: `"${content.text}"`,
        ios: { interruptionLevel: 'timeSensitive' },
        ...Platform.select({ android: { channelId: 'messages' } })
      },
      trigger: null,
    });
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
              <View style={[styles.statusDot, { backgroundColor: hasPermission ? '#4CD964' : '#FF3B30' }]} />
              <Text style={styles.statusText}>{hasPermission ? "Watch Active" : "Disconnected"}</Text>
            </View>
          </View>
          <TouchableOpacity style={styles.profileCircle}><Ionicons name="person" size={20} color="#8E8E93" /></TouchableOpacity>
        </View>

        <View style={[styles.mainCard, { borderColor: themeColor + '40' }]}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>Live Monitoring</Text>
            {bpm > 0 && <View style={[styles.liveTag, { backgroundColor: themeColor }]}><Text style={styles.liveTagText}>LIVE</Text></View>}
          </View>
          <View style={styles.monitorContent}>
            <View style={[styles.outerCircle, { borderColor: isSyncing ? themeColor : '#F2F2F7' }]}>
              {isSyncing ? <ActivityIndicator size="large" color={themeColor} /> : (
                <View style={{ alignItems: 'center' }}>
                  <Ionicons name="heart" size={32} color={themeColor} />
                  <Text style={styles.bpmNumber}>{bpm === 0 ? "--" : bpm}</Text>
                  <Text style={styles.bpmSubtext}>BPM</Text>
                </View>
              )}
            </View>
          </View>
        </View>

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
        <TouchableOpacity style={[styles.syncBtn, { backgroundColor: themeColor }]} onPress={syncHealthData} disabled={isSyncing}>
          <Ionicons name={isSyncing ? "sync" : "pulse"} size={22} color="#FFF" style={{ marginRight: 10 }} />
          <Text style={styles.syncBtnText}>{isSyncing ? "SYNCING..." : "SYNC HEART RATE"}</Text>
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