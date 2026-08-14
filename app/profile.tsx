import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, SafeAreaView, ActivityIndicator, Platform } from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { 
  getBiologicalSexAsync, 
  getBloodTypeAsync, 
  getDateOfBirthAsync,
  BiologicalSex,
  BloodType,
  requestAuthorization
} from '@kingstinct/react-native-healthkit';

interface ProfileData {
  // iOS fields
  dob: string;
  sex: string;
  bloodType: string;
  // Android fields
  lastHeartRate: string;
  lastSteps: string;
}

export default function ProfileScreen() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [profile, setProfile] = useState<ProfileData>({
    dob: 'Not Set',
    sex: 'Not Set',
    bloodType: 'Not Set',
    lastHeartRate: 'No data',
    lastSteps: 'No data',
  });

  useEffect(() => {
    fetchProfileData();
  }, []);

  const fetchProfileData = async () => {
    try {
      setLoading(true);
      setError(null);

      if (Platform.OS === 'ios') {
        await requestAuthorization({ 
          toRead: [
            'HKCharacteristicTypeIdentifierBiologicalSex',
            'HKCharacteristicTypeIdentifierBloodType',
            'HKCharacteristicTypeIdentifierDateOfBirth'
          ] 
        });

        const biologicalSex = await getBiologicalSexAsync();
        const bloodTypeResult = await getBloodTypeAsync();
        const dateOfBirth = await getDateOfBirthAsync();

        setProfile(prev => ({
          ...prev,
          sex: mapBiologicalSex(biologicalSex),
          bloodType: mapBloodType(bloodTypeResult),
          dob: dateOfBirth
            ? new Date(dateOfBirth).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
            : 'Not Set',
        }));

      } else if (Platform.OS === 'android') {
        const { initialize, requestPermission, readRecords } = await import('react-native-health-connect');
        const initialized = await initialize();
        if (!initialized) throw new Error('Health Connect is not available on this device.');

        await requestPermission([
          { accessType: 'read', recordType: 'HeartRate' },
          { accessType: 'read', recordType: 'Steps' },
        ]);

        const endTime = new Date().toISOString();
        const startTime = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const todayStart = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

        const hrResult = await readRecords('HeartRate', {
          timeRangeFilter: { operator: 'between', startTime, endTime },
        });
        const hrRecords = hrResult?.records ?? [];
        let lastHR = 'No data';
        if (hrRecords.length > 0) {
          const latest = hrRecords[hrRecords.length - 1] as any;
          const samples = latest?.samples ?? [];
          if (samples.length > 0) {
            lastHR = `${Math.round(samples[samples.length - 1]?.beatsPerMinute ?? 0)} BPM`;
          }
        }

        const stepsResult = await readRecords('Steps', {
          timeRangeFilter: { operator: 'between', startTime: todayStart, endTime },
        });
        const stepsRecords = stepsResult?.records ?? [];
        const totalSteps = stepsRecords.reduce((sum: number, r: any) => sum + (r?.count ?? 0), 0);
        const lastSteps = totalSteps > 0 ? totalSteps.toLocaleString() : 'No data';

        setProfile(prev => ({
          ...prev,
          lastHeartRate: lastHR,
          lastSteps: lastSteps,
        }));
      }

    } catch (err: any) {
      console.error("Error fetching profile data:", err);
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  };

  const mapBiologicalSex = (val: BiologicalSex): string => {
    switch(val) {
      case BiologicalSex.female: return 'Female';
      case BiologicalSex.male: return 'Male';
      case BiologicalSex.other: return 'Other';
      default: return 'Not Set';
    }
  };

  const mapBloodType = (val: BloodType): string => {
    switch(val) {
      case BloodType.aPositive: return 'A+';
      case BloodType.aNegative: return 'A-';
      case BloodType.bPositive: return 'B+';
      case BloodType.bNegative: return 'B-';
      case BloodType.abPositive: return 'AB+';
      case BloodType.abNegative: return 'AB-';
      case BloodType.oPositive: return 'O+';
      case BloodType.oNegative: return 'O-';
      default: return 'Not Set';
    }
  };

  const isAndroid = Platform.OS === 'android';

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity style={styles.backButton} onPress={() => router.back()}>
          <Ionicons name="close" size={28} color="#1C1C1E" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Profile</Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={styles.content}>
        <View style={styles.avatarContainer}>
          <View style={styles.avatar}>
            <Ionicons name="person" size={40} color="#8E8E93" />
          </View>
          <Text style={styles.avatarText}>Health Profile</Text>
          <Text style={styles.avatarSubtext}>{isAndroid ? 'Google Health Connect' : 'Apple Health'}</Text>
        </View>

        {loading ? (
          <View style={styles.centerContainer}>
            <ActivityIndicator size="large" color="#5856D6" />
          </View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Ionicons name="warning" size={24} color="#FF3B30" style={{ marginBottom: 10 }} />
            <Text style={styles.errorText}>Could not fetch data.</Text>
            <Text style={styles.errorSubtext}>{error}</Text>
          </View>
        ) : isAndroid ? (
          // Android: show heart rate and steps from Health Connect
          <View style={styles.card}>
            <View style={styles.row}>
              <View style={[styles.iconBox, { backgroundColor: '#FF3B3015' }]}>
                <Ionicons name="heart" size={16} color="#FF3B30" />
              </View>
              <View style={styles.infoCol}>
                <Text style={styles.infoLabel}>LAST HEART RATE</Text>
                <Text style={styles.infoValue}>{profile.lastHeartRate}</Text>
              </View>
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <View style={[styles.iconBox, { backgroundColor: '#34C75915' }]}>
                <Ionicons name="footsteps" size={16} color="#34C759" />
              </View>
              <View style={styles.infoCol}>
                <Text style={styles.infoLabel}>STEPS TODAY</Text>
                <Text style={styles.infoValue}>{profile.lastSteps}</Text>
              </View>
            </View>
            <View style={styles.divider} />
            <View style={[styles.noteBox]}>
              <Ionicons name="information-circle-outline" size={14} color="#8E8E93" style={{ marginRight: 6 }} />
              <Text style={styles.noteText}>Personal details like DOB and blood type are not available through Health Connect.</Text>
            </View>
          </View>
        ) : (
          // iOS: show HealthKit characteristics
          <View style={styles.card}>
            <View style={styles.row}>
              <View style={styles.iconBox}>
                <Ionicons name="calendar" size={16} color="#5856D6" />
              </View>
              <View style={styles.infoCol}>
                <Text style={styles.infoLabel}>DATE OF BIRTH</Text>
                <Text style={styles.infoValue}>{profile.dob}</Text>
              </View>
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <View style={styles.iconBox}>
                <Ionicons name="male-female" size={16} color="#FF9500" />
              </View>
              <View style={styles.infoCol}>
                <Text style={styles.infoLabel}>BIOLOGICAL SEX</Text>
                <Text style={styles.infoValue}>{profile.sex}</Text>
              </View>
            </View>
            <View style={styles.divider} />
            <View style={styles.row}>
              <View style={styles.iconBox}>
                <Ionicons name="water" size={16} color="#FF3B30" />
              </View>
              <View style={styles.infoCol}>
                <Text style={styles.infoLabel}>BLOOD TYPE</Text>
                <Text style={styles.infoValue}>{profile.bloodType}</Text>
              </View>
            </View>
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F8F9FB',
    paddingTop: 50,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 15,
    paddingTop: 10,
    paddingBottom: 20,
  },
  backButton: {
    padding: 8,
    marginLeft: -8,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1C1C1E',
  },
  content: {
    paddingHorizontal: 15,
  },
  avatarContainer: {
    alignItems: 'center',
    marginBottom: 30,
    marginTop: 10,
  },
  avatar: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: '#FFF',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#E5E5EA',
    marginBottom: 12,
    shadowColor: '#000',
    shadowOpacity: 0.05,
    shadowRadius: 10,
    elevation: 3,
  },
  avatarText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#1C1C1E',
    marginBottom: 2,
  },
  avatarSubtext: {
    fontSize: 12,
    color: '#8E8E93',
    fontWeight: '500',
  },
  card: {
    backgroundColor: '#FFF',
    borderRadius: 20,
    padding: 16,
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 12,
    elevation: 3,
    borderWidth: 1,
    borderColor: '#F2F2F7',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  iconBox: {
    width: 36,
    height: 36,
    borderRadius: 12,
    backgroundColor: '#F8F9FB',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  infoCol: {
    flex: 1,
  },
  infoLabel: {
    fontSize: 12,
    color: '#8E8E93',
    fontWeight: '600',
    marginBottom: 2,
  },
  infoValue: {
    fontSize: 15,
    fontWeight: '700',
    color: '#1C1C1E',
  },
  divider: {
    height: 1,
    backgroundColor: '#F2F2F7',
    marginVertical: 12,
  },
  centerContainer: {
    padding: 40,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorBox: {
    backgroundColor: '#FFF',
    borderRadius: 20,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#FF3B3040',
  },
  errorText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#1C1C1E',
    marginBottom: 4,
  },
  errorSubtext: {
    fontSize: 12,
    color: '#8E8E93',
    textAlign: 'center',
  },
  noteBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#F8F9FB',
    borderRadius: 10,
    padding: 10,
  },
  noteText: {
    fontSize: 12,
    color: '#8E8E93',
    flex: 1,
    lineHeight: 17,
  }
});
