/**
 * lib/monitoring/background.ts
 *
 * Periodic background evaluation.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS, AND WHAT IT CAN AND CANNOT DO
 * ─────────────────────────────────────────────────────────────────────────────
 * The brief asks HV to record heart rate through the working day. A foreground
 * React Native app cannot do that on its own: when the user switches away, the
 * JavaScript runtime is suspended and the poll loop stops.
 *
 * What saves this is that HV never needed to be the recorder. Health Connect
 * and HealthKit are ALREADY storing every reading the watch writes, whether or
 * not HV is running. HV's job is to read that store and analyse it — so the
 * work that must happen periodically is a BACKFILL, not a live capture.
 *
 * This task performs that backfill. Android runs it through WorkManager and
 * iOS through BGTaskScheduler, which means:
 *
 *   - The interval is a REQUEST, not a guarantee. Fifteen minutes is the floor
 *     Android will accept; in practice the OS batches these and may run it far
 *     less often, especially in battery saver or when the app is unused.
 *   - iOS is stricter still and may not run it for hours, or at all, if the
 *     user rarely opens the app.
 *
 * So a Level 2 notification may arrive late, and the 5:01 PM summary may quote
 * a peak that was current as of the last successful run. What is NOT at risk is
 * the record itself: nothing is lost, because the platform health store keeps
 * the samples, and the next run — background or foreground — backfills every
 * reading that arrived in between and recomputes the day from scratch.
 *
 * Genuinely instant, always-on alerting would require a foreground service with
 * a persistent notification on Android, and is not possible at all on iOS
 * without a watchOS companion app streaming over WatchConnectivity.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';

import { loadSettings, isInCollectionWindow } from '../settings';
import { runTick } from './engine';

export const BACKGROUND_TICK_TASK = 'hv-background-tick';

/** Requested interval in minutes. Android's practical floor is 15. */
export const BACKGROUND_INTERVAL_MINUTES = 15;

TaskManager.defineTask(BACKGROUND_TICK_TASK, async () => {
  try {
    const now = new Date();
    const settings = await loadSettings();

    // Outside the collection window there is nothing to analyse, but the tick
    // still runs once so the day's totals and the scheduled summary stay
    // correct if the user's watch synced late.
    const inWindow = isInCollectionWindow(settings, now);

    const result = await runTick(now);

    console.log(
      `[HV background] tick at ${now.toISOString()} — ` +
      `state ${result.fsm?.to ?? 'n/a'}, ${result.sampleCount} samples, ` +
      `${inWindow ? 'in' : 'outside'} collection window` +
      (result.skipped ? ` — ${result.skipped}` : ''),
    );

    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (err) {
    console.warn('[HV background] tick failed', err);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export type BackgroundStatus =
  | 'registered'
  | 'restricted'
  | 'unavailable'
  | 'error';

/**
 * Register the periodic task.
 *
 * Safe to call on every launch: registering an already-registered task is a
 * no-op, and the check below avoids re-registering needlessly.
 */
export async function registerBackgroundTick(): Promise<BackgroundStatus> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) {
      // Background execution is switched off for this app or device-wide.
      // Monitoring still works whenever HV is open.
      return 'restricted';
    }

    const already = await TaskManager.isTaskRegisteredAsync(BACKGROUND_TICK_TASK);
    if (!already) {
      await BackgroundTask.registerTaskAsync(BACKGROUND_TICK_TASK, {
        minimumInterval: BACKGROUND_INTERVAL_MINUTES,
      });
    }
    return 'registered';
  } catch (err) {
    console.warn('[HV background] registration failed', err);
    return 'error';
  }
}

export async function unregisterBackgroundTick(): Promise<void> {
  const already = await TaskManager.isTaskRegisteredAsync(BACKGROUND_TICK_TASK);
  if (already) await BackgroundTask.unregisterTaskAsync(BACKGROUND_TICK_TASK);
}
