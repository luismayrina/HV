/**
 * hooks/useRprvMonitor.ts
 *
 * Wires the live heart-rate feed into the RPRV analysis engine.
 *
 * useHeartRateMonitor owns the platform plumbing — permissions, polling,
 * HealthKit observers, HeartSim. This hook owns what happens to the readings:
 * storing them, running the evaluation tick on the study's 30-second cadence,
 * and surfacing the result to the UI.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import type { AppStateStatus } from 'react-native';

import { useHeartRateMonitor } from './useHeartRateMonitor';
import type { HeartRateMonitorState } from './useHeartRateMonitor';

import {
  TICK_INTERVAL_MS, ingestSample, peekPendingEmergency, runTick, takePendingEmergency,
} from '@/lib/monitoring/engine';
import type { PendingEmergency, TickResult } from '@/lib/monitoring/engine';
import { dispatchEmergencySms } from '@/lib/notifications/emergency';
import type { EmergencyDispatch } from '@/lib/notifications/emergency';
import { configureNotifications } from '@/lib/notifications';
import { registerBackgroundTick } from '@/lib/monitoring/background';
import { getPendingCheckin } from '@/lib/db';
import type { CheckinRow } from '@/lib/db';

export interface RprvMonitorState {
  /** The underlying heart-rate feed. */
  monitor: HeartRateMonitorState;
  /** The most recent evaluation tick, or null before the first one. */
  tick: TickResult | null;
  /** True while a tick is running. */
  isAnalysing: boolean;
  /** An unanswered wellbeing check-in, when one is outstanding. */
  pendingCheckin: CheckinRow | null;
  /** A Level 3 alert whose contacts have not been messaged yet. */
  pendingEmergency: PendingEmergency | null;
  /** Force an evaluation now rather than waiting for the next tick. */
  analyseNow: () => Promise<void>;
  /** Open the SMS composer for a pending Level 3 alert. */
  sendEmergencySms: () => Promise<EmergencyDispatch | null>;
  /** Clear the outstanding check-in from local state once answered. */
  clearPendingCheckin: () => void;
}

export function useRprvMonitor(): RprvMonitorState {
  const [tick, setTick] = useState<TickResult | null>(null);
  const [isAnalysing, setIsAnalysing] = useState(false);
  const [pendingCheckin, setPendingCheckin] = useState<CheckinRow | null>(null);
  const [pendingEmergency, setPendingEmergency] = useState<PendingEmergency | null>(null);

  const tickTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isMountedRef = useRef(true);
  // Guards against overlapping ticks: a tick that runs long (a large backfill,
  // a slow query) must not have a second one start underneath it and write a
  // duplicate window row.
  const inFlightRef = useRef(false);

  useEffect(() => {
    isMountedRef.current = true;
    return () => { isMountedRef.current = false; };
  }, []);

  /** Every accepted reading is written to the database before anything else. */
  const handleNewBpm = useCallback(async (bpm: number, at: Date) => {
    try {
      await ingestSample(bpm, at, 'monitor');
    } catch (err) {
      console.warn('[RPRV] failed to store sample', err);
    }
  }, []);

  const monitor = useHeartRateMonitor(handleNewBpm);

  const analyse = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    if (isMountedRef.current) setIsAnalysing(true);

    try {
      const result = await runTick(new Date());
      if (isMountedRef.current) setTick(result);

      const [checkin, emergency] = await Promise.all([
        getPendingCheckin(),
        peekPendingEmergency(),
      ]);
      if (isMountedRef.current) {
        setPendingCheckin(checkin);
        setPendingEmergency(emergency);
      }
    } catch (err) {
      console.warn('[RPRV] tick failed', err);
    } finally {
      inFlightRef.current = false;
      if (isMountedRef.current) setIsAnalysing(false);
    }
  }, []);

  // ── One-time setup: notifications and the periodic background backfill ───
  useEffect(() => {
    configureNotifications().catch((err) =>
      console.warn('[RPRV] notification setup failed', err),
    );
    registerBackgroundTick()
      .then((status) => {
        if (status !== 'registered') {
          console.log(`[RPRV] background ticks unavailable: ${status}`);
        }
      })
      .catch((err) => console.warn('[RPRV] background registration failed', err));
  }, []);

  // ── Tick loop, running only while monitoring is active ───────────────────
  useEffect(() => {
    if (!monitor.isMonitoring) {
      if (tickTimerRef.current) {
        clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
      }
      return;
    }

    // Evaluate immediately on start rather than waiting out the first interval.
    void analyse();
    tickTimerRef.current = setInterval(() => { void analyse(); }, TICK_INTERVAL_MS);

    return () => {
      if (tickTimerRef.current) {
        clearInterval(tickTimerRef.current);
        tickTimerRef.current = null;
      }
    };
  }, [monitor.isMonitoring, analyse]);

  // ── Re-evaluate on foreground ────────────────────────────────────────────
  // Coming back to the app is the one moment we are certain fresh platform
  // data has had a chance to sync, and it is also when the daily summary most
  // needs re-scheduling with current figures.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') void analyse();
    });
    return () => sub.remove();
  }, [analyse]);

  const sendEmergencySms = useCallback(async (): Promise<EmergencyDispatch | null> => {
    const pending = await takePendingEmergency();
    setPendingEmergency(null);
    if (!pending) return null;
    return await dispatchEmergencySms(pending.bpm, new Date(pending.at));
  }, []);

  const clearPendingCheckin = useCallback(() => setPendingCheckin(null), []);

  return {
    monitor,
    tick,
    isAnalysing,
    pendingCheckin,
    pendingEmergency,
    analyseNow: analyse,
    sendEmergencySms,
    clearPendingCheckin,
  };
}
