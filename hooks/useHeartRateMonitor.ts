/**
 * useHeartRateMonitor.ts
 *
 * Reusable heart-rate monitoring hook for the HV (Heart Vitality) app.
 * Supports three data paths, tried in order on iOS:
 *   1. HeartSim HTTP server  — simulator only, zero-latency loopback polling.
 *   2. HealthKit polling     — real device, interval-based getMostRecentQuantitySample.
 *   3. HealthKit observer    — real device, useSubscribeToQuantitySamples push delivery.
 *
 * On Android:
 *   - Health Connect polling via readRecords('HeartRate', …).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PLATFORM LIMITATIONS (important — read before changing this file)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * iOS / Apple Watch:
 *   iPhone HealthKit can only READ heart-rate samples that the Apple Watch has
 *   ALREADY written and synced to the Health store. iOS controls the sync
 *   schedule and it is NOT instant. While the Apple Watch is running an active
 *   HKWorkoutSession the Watch writes samples far more frequently (~every 5s)
 *   and syncs them to the paired iPhone with much lower latency.
 *
 *   For TRUE real-time Apple Watch heart rate (sub-second) on iPhone, you need:
 *     1. A watchOS companion app running HKWorkoutSession + HKLiveWorkoutBuilder.
 *     2. WatchConnectivity (WCSession) to stream live BPM to the iPhone.
 *   This project currently has only an iPhone app, so we rely on HealthKit
 *   observer + foreground polling as the best available approach.
 *
 * Android / Health Connect:
 *   Health Connect stores health records written by other apps (e.g. Samsung
 *   Health, Google Fit, Wear OS companion apps). It does NOT stream live sensor
 *   data. readRecords() returns whatever has been written since the last sync.
 *   Foreground polling gives us the freshest available data, but "fresh" is
 *   bounded by how often the companion wear app syncs to Health Connect.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';

import {
  getMostRecentQuantitySample,
  isHealthDataAvailable,
  requestAuthorization,
  useSubscribeToQuantitySamples,
} from '@kingstinct/react-native-healthkit';

// Android-only imports (guarded at runtime)
import * as HealthConnect from 'react-native-health-connect';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration constants
// ─────────────────────────────────────────────────────────────────────────────

/** Foreground poll interval for iOS HealthKit mode (ms). */
export const IOS_HEART_RATE_POLL_INTERVAL_MS = 3_000;

/** Foreground poll interval for Android Health Connect mode (ms). */
export const ANDROID_HEART_RATE_POLL_INTERVAL_MS = 5_000;

/** Foreground poll interval for HeartSim HTTP server mode (ms). */
export const HEARTSIM_POLL_INTERVAL_MS = 1_000;

/** A sample older than this (ms) triggers the "stale" indicator in the UI. */
export const STALE_THRESHOLD_MS = 60_000;

/** HeartSim local HTTP server URL (simulator loopback). */
const HEARTSIM_URL = 'http://127.0.0.1:7777';

/** Android Health Connect lookback window for polling (ms). */
const ANDROID_POLL_LOOKBACK_MS = 30 * 60 * 1_000; // 30 minutes

/** Android Health Connect extended lookback window used as fallback (ms). */
const ANDROID_FALLBACK_LOOKBACK_MS = 24 * 60 * 60 * 1_000; // 24 hours

// ─────────────────────────────────────────────────────────────────────────────
// Public interface
// ─────────────────────────────────────────────────────────────────────────────

export type HeartRateSource = 'heartsim' | 'healthkit' | 'health-connect' | null;

export interface HeartRateMonitorState {
  /** Latest BPM reading. null = no reading yet. */
  bpm: number | null;
  /** Timestamp of the latest sample from the health platform. */
  lastUpdated: Date | null;
  /** True when the latest sample is older than STALE_THRESHOLD_MS. */
  isStale: boolean;
  /** True while monitoring is active (interval running). */
  isMonitoring: boolean;
  /** True during the initial permission + first-fetch sequence. */
  isLoading: boolean;
  /** Human-readable error string, or null when healthy. */
  error: string | null;
  /** True when health permission has been granted for the current session. */
  permissionGranted: boolean;
  /** Which data source is currently active. */
  source: HeartRateSource;
  /** Begin monitoring. Requests permissions and starts polling. */
  startMonitoring: () => Promise<void>;
  /** Stop monitoring and clear all intervals cleanly. */
  stopMonitoring: () => void;
  /** Manually trigger one fetch cycle outside the normal interval. */
  refreshNow: () => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hook implementation
// ─────────────────────────────────────────────────────────────────────────────

export function useHeartRateMonitor(
  /** Optional callback fired every time a new BPM value is received. */
  onNewBpm?: (bpm: number, updatedAt: Date) => void,
): HeartRateMonitorState {

  // ── React state (drives UI re-renders) ────────────────────────────────────
  const [bpm, setBpm] = useState<number | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isStale, setIsStale] = useState(false);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const [source, setSource] = useState<HeartRateSource>(null);

  // ── Refs (mutable, no re-render) ──────────────────────────────────────────
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const staleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);
  const isMonitoringRef = useRef(false);          // sync mirror of isMonitoring state
  const lastSampleDateRef = useRef<Date | null>(null); // endDate of last processed sample
  const sourceRef = useRef<HeartRateSource>(null); // sync mirror of source state

  // Stable ref to the onNewBpm callback so interval closures never go stale
  const onNewBpmRef = useRef(onNewBpm);
  useEffect(() => { onNewBpmRef.current = onNewBpm; });

  // Keep monitoring ref in sync with state
  useEffect(() => { isMonitoringRef.current = isMonitoring; }, [isMonitoring]);
  useEffect(() => { sourceRef.current = source; }, [source]);

  // ── Unmount guard ─────────────────────────────────────────────────────────
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      _clearAllTimers();
    };
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────

  /** Clear the poll interval and stale detection timer. */
  function _clearAllTimers() {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
      console.log('[HeartRate] interval cleared');
    }
    if (staleTimerRef.current !== null) {
      clearTimeout(staleTimerRef.current);
      staleTimerRef.current = null;
    }
  }

  /**
   * Core update routine called whenever a new BPM reading is confirmed.
   * Accepts only samples newer than the last processed sample to avoid
   * re-processing the same reading in rapid successive polls.
   *
   * @param newBpm       Raw BPM integer value.
   * @param sampleTime   Timestamp of this sample from the health platform.
   * @param force        When true, bypass the "is newer?" check (e.g. first read).
   */
  function _applyNewSample(newBpm: number, sampleTime: Date, force = false) {
    const isNewer = force
      || !lastSampleDateRef.current
      || sampleTime > lastSampleDateRef.current;

    if (!isNewer) {
      console.log(
        `[HeartRate] no newer sample found — last: ${lastSampleDateRef.current?.toISOString()}, got: ${sampleTime.toISOString()}`,
      );
      return;
    }

    lastSampleDateRef.current = sampleTime;
    console.log(`[HeartRate] latest sample: ${newBpm} BPM @ ${sampleTime.toISOString()} via ${sourceRef.current}`);

    if (isMountedRef.current) {
      setBpm(newBpm);
      setLastUpdated(sampleTime);
      setIsStale(false);
      setError(null);
    }

    // Reset stale detection timer
    if (staleTimerRef.current !== null) clearTimeout(staleTimerRef.current);
    staleTimerRef.current = setTimeout(() => {
      if (isMountedRef.current) setIsStale(true);
    }, STALE_THRESHOLD_MS);

    // Fire the external callback
    onNewBpmRef.current?.(newBpm, sampleTime);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // HeartSim HTTP helpers (simulator / development)
  // ─────────────────────────────────────────────────────────────────────────

  async function _probeHeartSim(): Promise<boolean> {
    try {
      const probe = await fetch(HEARTSIM_URL, { signal: AbortSignal.timeout(600) });
      if (!probe.ok) return false;
      const json = await probe.json();
      return typeof json.bpm === 'number';
    } catch {
      return false;
    }
  }

  async function _fetchHeartSimBpm(): Promise<number> {
    const res = await fetch(HEARTSIM_URL, { signal: AbortSignal.timeout(800) });
    if (!res.ok) throw new Error(`HeartSim HTTP ${res.status}`);
    const json = await res.json();
    if (typeof json.bpm !== 'number') throw new Error('HeartSim: invalid response shape');
    return json.bpm;
  }

  function _startHeartSimPolling() {
    console.log('[HeartRate] startMonitoring — HeartSim HTTP mode');
    if (isMountedRef.current) setSource('heartsim');
    sourceRef.current = 'heartsim';

    pollIntervalRef.current = setInterval(async () => {
      if (!isMonitoringRef.current) return;
      console.log('[HeartRate] polling tick (HeartSim)');
      try {
        const latestBpm = await _fetchHeartSimBpm();
        if (latestBpm > 0) {
          _applyNewSample(latestBpm, new Date(), /* force= */ true); // HeartSim always "new"
        }
      } catch (e) {
        console.log('[HeartRate] HeartSim poll error:', e);
      }
    }, HEARTSIM_POLL_INTERVAL_MS);

    console.log('[HeartRate] interval started (HeartSim) every', HEARTSIM_POLL_INTERVAL_MS, 'ms');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // iOS HealthKit helpers
  // ─────────────────────────────────────────────────────────────────────────

  async function _fetchLatestHealthKitSample(): Promise<void> {
    const sample = await getMostRecentQuantitySample('HKQuantityTypeIdentifierHeartRate');
    if (sample && sample.quantity) {
      const sampleEnd = new Date(sample.endDate);
      _applyNewSample(Math.round(sample.quantity), sampleEnd);
    } else {
      console.log('[HeartRate] no recent HealthKit sample found');
    }
  }

  function _startHealthKitPolling() {
    console.log('[HeartRate] startMonitoring — HealthKit mode');
    if (isMountedRef.current) setSource('healthkit');
    sourceRef.current = 'healthkit';

    // Fire immediately (best-effort; not blocking)
    _fetchLatestHealthKitSample().catch(e =>
      console.log('[HeartRate] HealthKit initial fetch error:', e),
    );

    pollIntervalRef.current = setInterval(async () => {
      if (!isMonitoringRef.current) return;
      console.log('[HeartRate] polling tick (HealthKit)');
      try {
        await _fetchLatestHealthKitSample();
      } catch (e) {
        console.log('[HeartRate] HealthKit poll error:', e);
      }
    }, IOS_HEART_RATE_POLL_INTERVAL_MS);

    console.log('[HeartRate] interval started (HealthKit) every', IOS_HEART_RATE_POLL_INTERVAL_MS, 'ms');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Android Health Connect helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Read heart rate records from Health Connect within a given lookback window,
   * flatten all samples across all records, and return the single newest BPM.
   *
   * NOTE: Health Connect records can arrive in any order — we must sort
   * all samples by their timestamp to reliably find the newest one.
   *
   * @param lookbackMs  How far back to search (milliseconds from now).
   * @returns The newest BPM reading, or null if no samples found.
   */
  async function _fetchAndroidHeartRate(
    lookbackMs: number,
  ): Promise<{ bpm: number; time: Date } | null> {
    if (Platform.OS !== 'android') return null;
    
    const endTime = new Date().toISOString();
    const startTime = new Date(Date.now() - lookbackMs).toISOString();

    const result = await HealthConnect.readRecords('HeartRate', {
      timeRangeFilter: { operator: 'between', startTime, endTime },
    });
    const records = (result?.records ?? []) as any[];
    console.log('[HeartRate] Android readRecords result count:', records.length, `(lookback ${lookbackMs / 60_000}min)`);

    if (records.length === 0) return null;

    // Flatten all samples from all records into one array
    type RawSample = { beatsPerMinute: number; time: string };
    const allSamples: RawSample[] = records.flatMap(
      (r: any) => (Array.isArray(r?.samples) ? r.samples : []),
    );

    if (allSamples.length === 0) {
      console.log('[HeartRate] Android: records found but no samples inside');
      return null;
    }

    // Sort by sample.time descending, pick newest
    allSamples.sort(
      (a, b) => new Date(b.time).getTime() - new Date(a.time).getTime(),
    );
    const newest = allSamples[0];
    const bpmValue = Math.round(newest.beatsPerMinute ?? 0);
    console.log(`[HeartRate] latest sample: ${bpmValue} BPM @ ${newest.time} via health-connect`);
    return { bpm: bpmValue, time: new Date(newest.time) };
  }

  async function _pollAndroidOnce(): Promise<void> {
    // Try narrow window first; fall back to 24h if empty
    let result = await _fetchAndroidHeartRate(ANDROID_POLL_LOOKBACK_MS);
    if (!result) {
      console.log('[HeartRate] Android: 30-min window empty, trying 24h fallback');
      result = await _fetchAndroidHeartRate(ANDROID_FALLBACK_LOOKBACK_MS);
    }

    if (result && result.bpm > 0) {
      _applyNewSample(result.bpm, result.time);
    } else {
      console.log('[HeartRate] Android: no samples in last 24h');
    }
  }

  function _startAndroidPolling() {
    console.log('[HeartRate] startMonitoring — Health Connect mode');
    if (isMountedRef.current) setSource('health-connect');
    sourceRef.current = 'health-connect';

    // Fire immediately
    _pollAndroidOnce().catch(e =>
      console.log('[HeartRate] Android initial poll error:', e),
    );

    pollIntervalRef.current = setInterval(async () => {
      if (!isMonitoringRef.current) return;
      console.log('[HeartRate] polling tick (Android Health Connect)');
      try {
        await _pollAndroidOnce();
      } catch (e) {
        console.log('[HeartRate] Android poll error:', e);
      }
    }, ANDROID_HEART_RATE_POLL_INTERVAL_MS);

    console.log('[HeartRate] interval started (Android) every', ANDROID_HEART_RATE_POLL_INTERVAL_MS, 'ms');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // iOS HealthKit subscription (push delivery via HKObserverQuery)
  // ─────────────────────────────────────────────────────────────────────────
  //
  // useSubscribeToQuantitySamples is called UNCONDITIONALLY (hook rules), but
  // the callback is gated by isMonitoringRef so it only acts when active.
  //
  // Under New Architecture + React Compiler the callback must be stable.
  // We use a ref wrapper so the hook registration never changes identity,
  // while the inner logic always sees fresh state via the ref.
  //
  // NOTE: This observer fires when the Apple Watch writes a new HR sample to
  // HealthKit. On a real device without an active Watch workout session,
  // the Watch may only write samples every 10–15 minutes (background rate).
  // During an active workout session, samples arrive every 5s or faster.
  //
  useSubscribeToQuantitySamples(
    'HKQuantityTypeIdentifierHeartRate',
    useCallback(async () => {
      if (Platform.OS !== 'ios') return;
      if (!isMonitoringRef.current) return;
      console.log('[HeartRate] iOS subscription fired');
      try {
        const sample = await getMostRecentQuantitySample('HKQuantityTypeIdentifierHeartRate');
        if (sample && sample.quantity) {
          const sampleEnd = new Date(sample.endDate);
          _applyNewSample(Math.round(sample.quantity), sampleEnd);
        } else {
          console.log('[HeartRate] iOS subscription fired but no sample found');
        }
      } catch (err) {
        console.log('[HeartRate] iOS subscription callback error:', err);
      }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []), // stable — inner logic uses refs only
  );

  // ─────────────────────────────────────────────────────────────────────────
  // AppState handler — resumes/refreshes on foreground
  // ─────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const handleAppStateChange = async (nextState: AppStateStatus) => {
      console.log('[HeartRate] app state changed →', nextState);
      if (nextState !== 'active' || !isMonitoringRef.current) return;

      // Restart the interval if it was somehow cleared while in background
      if (pollIntervalRef.current === null) {
        console.log('[HeartRate] restarting interval after foreground resume');
        const src = sourceRef.current;
        if (src === 'heartsim') _startHeartSimPolling();
        else if (src === 'healthkit') _startHealthKitPolling();
        else if (src === 'health-connect') _startAndroidPolling();
      }

      // Trigger an immediate refresh on foreground
      try {
        if (Platform.OS === 'ios' && sourceRef.current === 'healthkit') {
          await _fetchLatestHealthKitSample();
        } else if (Platform.OS === 'android' && sourceRef.current === 'health-connect') {
          await _pollAndroidOnce();
        }
      } catch (e) {
        console.log('[HeartRate] foreground refresh error:', e);
      }
    };

    const sub = AppState.addEventListener('change', handleAppStateChange);
    return () => sub.remove();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable — all inner logic uses refs

  // ─────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────

  const startMonitoring = useCallback(async () => {
    if (isMonitoringRef.current) {
      console.log('[HeartRate] startMonitoring called but already monitoring — ignoring');
      return;
    }

    console.log('[HeartRate] startMonitoring');
    if (isMountedRef.current) {
      setIsLoading(true);
      setError(null);
    }
    lastSampleDateRef.current = null; // reset so next session starts fresh

    try {
      if (Platform.OS === 'ios') {
        // ── Step 1: probe HeartSim (simulator / development) ────────────────
        const simReachable = await _probeHeartSim();
        if (simReachable) {
          if (isMountedRef.current) {
            setPermissionGranted(true);
            setIsMonitoring(true);
          }
          isMonitoringRef.current = true;
          _startHeartSimPolling();

          // Fire HeartSim once immediately
          try {
            const firstBpm = await _fetchHeartSimBpm();
            if (firstBpm > 0) _applyNewSample(firstBpm, new Date(), true);
          } catch (_) { /* no-op; poll will catch it */ }
          return;
        }

        // ── Step 2: HealthKit (real device) ─────────────────────────────────
        if (!isHealthDataAvailable()) {
          if (isMountedRef.current) setError('Apple Health is not available on this device.');
          return;
        }

        await requestAuthorization({
          toRead: [
            'HKQuantityTypeIdentifierHeartRate',
            'HKCharacteristicTypeIdentifierBiologicalSex',
            'HKCharacteristicTypeIdentifierBloodType',
            'HKCharacteristicTypeIdentifierDateOfBirth',
          ],
        });
        console.log('[HeartRate] HealthKit permission granted');
        if (isMountedRef.current) setPermissionGranted(true);

        // ✅ FIX: Set monitoring = true and start the interval BEFORE
        // checking for an existing sample. This ensures the interval always
        // starts, even if no sample exists yet (Apple Watch not yet synced).
        if (isMountedRef.current) setIsMonitoring(true);
        isMonitoringRef.current = true;
        _startHealthKitPolling(); // interval starts immediately

      } else if (Platform.OS === 'android') {
        // ── Android: Health Connect ──────────────────────────────────────────
        const initialized = await HealthConnect.initialize();
        if (!initialized) {
          if (isMountedRef.current) setError('Health Connect is not available. Please install it from the Play Store.');
          console.log('[HeartRate] permission denied — Health Connect not available');
          return;
        }

        // 🕒 Give the native bridge time to register the permission launcher
        await new Promise(resolve => setTimeout(resolve, 500));

        let granted: any[] = [];
        // Check if we already have the permissions
        try {
          const existingPermissions = await HealthConnect.getGrantedPermissions();
          const alreadyGranted = Array.isArray(existingPermissions) && existingPermissions.some(
            (p: any) => p.recordType === 'HeartRate' && p.accessType === 'read',
          );
          if (alreadyGranted) {
            console.log('[HeartRate] Permissions already granted via Health Connect');
            granted = existingPermissions;
          }
        } catch (e) {
          console.log('[HeartRate] Could not check existing permissions:', e);
        }

        // Only request if not already granted
        if (granted.length === 0) {
          try {
            granted = await HealthConnect.requestPermission([
              { accessType: 'read', recordType: 'HeartRate' },
            ]);
          } catch (permError) {
            console.log('[HeartRate] Error requesting Android permissions:', permError);
            if (isMountedRef.current) setError('Failed to open Health Connect permissions. Please go to Android Settings > Apps > Health Connect to grant Heart Rate permissions manually.');
            return;
          }
        }

        const heartRateGranted = Array.isArray(granted) && granted.some(
          (p: any) => p.recordType === 'HeartRate' && p.accessType === 'read',
        );
        
        if (!heartRateGranted) {
          if (isMountedRef.current) setError('Heart rate permission was denied. Please grant it in Health Connect settings.');
          console.log('[HeartRate] permission denied — HeartRate read not granted');
          return;
        }

        console.log('[HeartRate] Health Connect permission granted');
        if (isMountedRef.current) setPermissionGranted(true);

        // ✅ FIX: Set monitoring = true and start interval BEFORE first fetch
        if (isMountedRef.current) setIsMonitoring(true);
        isMonitoringRef.current = true;
        _startAndroidPolling(); // interval starts immediately
      }

    } catch (err: any) {
      console.log('[HeartRate] startMonitoring error:', err);
      if (isMountedRef.current) setError(err?.message ?? String(err));
      // Roll back if something threw
      if (isMountedRef.current) setIsMonitoring(false);
      isMonitoringRef.current = false;
      _clearAllTimers();
    } finally {
      if (isMountedRef.current) setIsLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // stable — all inner logic uses refs/helpers defined outside

  const stopMonitoring = useCallback(() => {
    console.log('[HeartRate] stopMonitoring');
    _clearAllTimers();
    isMonitoringRef.current = false;
    lastSampleDateRef.current = null;
    if (isMountedRef.current) {
      setIsMonitoring(false);
      setSource(null);
      setIsStale(false);
    }
    sourceRef.current = null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshNow = useCallback(async () => {
    if (!isMonitoringRef.current) return;
    console.log('[HeartRate] refreshNow called manually');
    try {
      if (Platform.OS === 'ios' && sourceRef.current === 'healthkit') {
        await _fetchLatestHealthKitSample();
      } else if (Platform.OS === 'ios' && sourceRef.current === 'heartsim') {
        const latestBpm = await _fetchHeartSimBpm();
        if (latestBpm > 0) _applyNewSample(latestBpm, new Date(), true);
      } else if (Platform.OS === 'android' && sourceRef.current === 'health-connect') {
        await _pollAndroidOnce();
      }
    } catch (e) {
      console.log('[HeartRate] refreshNow error:', e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    bpm,
    lastUpdated,
    isStale,
    isMonitoring,
    isLoading,
    error,
    permissionGranted,
    source,
    startMonitoring,
    stopMonitoring,
    refreshNow,
  };
}
