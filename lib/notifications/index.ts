/**
 * lib/notifications/index.ts
 *
 * Delivery of the three-tier alert model, the daily summary, and the
 * post-emergency wellbeing check-in.
 *
 * Every notification that goes out is also written to the notifications table,
 * so the analysis screens can reconcile what the user was told against what
 * the algorithm saw at the time.
 */

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { dayKey, insertCheckin, insertNotification } from '../db';
import type { EmotionClass, MonitorState, NotificationTier } from '../rprv/types';
import type { Verse } from '../verses/corpus';

/** Android notification channels, one per tier so importance can differ. */
export const CHANNELS = {
  tier1: 'hv-gentle',
  tier2: 'hv-moderate',
  tier3: 'hv-emergency',
  summary: 'hv-summary',
  checkin: 'hv-checkin',
} as const;

/** Identifier for the scheduled daily summary, so it can be replaced. */
const DAILY_SUMMARY_ID = 'hv-daily-summary';

export async function configureNotifications(): Promise<boolean> {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });

  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync(CHANNELS.tier1, {
      name: 'Gentle reminders',
      importance: Notifications.AndroidImportance.DEFAULT,
      vibrationPattern: [0, 120],
    });
    await Notifications.setNotificationChannelAsync(CHANNELS.tier2, {
      name: 'Stress alerts',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 200, 100, 200],
    });
    await Notifications.setNotificationChannelAsync(CHANNELS.tier3, {
      name: 'Emergency alerts',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 400, 150, 400, 150, 400],
      bypassDnd: true,
    });
    await Notifications.setNotificationChannelAsync(CHANNELS.summary, {
      name: 'Daily summary',
      importance: Notifications.AndroidImportance.DEFAULT,
    });
    await Notifications.setNotificationChannelAsync(CHANNELS.checkin, {
      name: 'Wellbeing check-in',
      importance: Notifications.AndroidImportance.HIGH,
    });
  }

  const existing = await Notifications.getPermissionsAsync();
  if (existing.status === 'granted') return true;
  const requested = await Notifications.requestPermissionsAsync();
  return requested.status === 'granted';
}

const TIER_TITLES: Record<NotificationTier, string> = {
  0: '',
  1: 'A moment of peace',
  2: 'Strength for right now',
  3: 'Check in with yourself',
};

const CHANNEL_FOR_TIER: Record<NotificationTier, string> = {
  0: CHANNELS.summary,
  1: CHANNELS.tier1,
  2: CHANNELS.tier2,
  3: CHANNELS.tier3,
};

export interface TierNotificationInput {
  tier: NotificationTier;
  state: MonitorState;
  emotion: EmotionClass;
  verse: Verse;
  meanBpm: number;
  episodeId: number | null;
}

/**
 * Deliver a tier notification carrying a verse.
 *
 * @returns The notifications-table row id, used to attach verse feedback.
 */
export async function presentTierNotification(
  input: TierNotificationInput,
): Promise<number> {
  const { tier, state, emotion, verse, meanBpm, episodeId } = input;
  const body = `${verse.reference}\n${verse.text}`;

  const notificationId = await insertNotification({
    day: dayKey(),
    at: Date.now(),
    kind: 'tier',
    tier,
    state,
    emotion,
    verse_id: verse.id,
    episode_id: episodeId,
    body,
  });

  await Notifications.scheduleNotificationAsync({
    content: {
      title: tier === 3
        ? `${TIER_TITLES[3]} — ${Math.round(meanBpm)} bpm`
        : TIER_TITLES[tier],
      body,
      // The row id travels with the notification so a tap can open straight to
      // the verse and its feedback prompt.
      data: { notificationId, verseId: verse.id, tier, kind: 'tier' },
      ...(Platform.OS === 'android' ? { channelId: CHANNEL_FOR_TIER[tier] } : {}),
    },
    trigger: null, // deliver immediately
  });

  return notificationId;
}

/**
 * Deliver the plain high-heart-rate warning.
 *
 * Kept separate from the tier notifications because it answers a different
 * question: the tier notification is about emotional state, this one is about
 * a number crossing a line, and conflating them would bury the safety message
 * underneath scripture.
 */
export async function presentHighBpmWarning(
  bpm: number,
  threshold: number,
): Promise<number> {
  const body = `Your heart rate reached ${Math.round(bpm)} bpm, above your ${threshold} bpm warning level. If you feel unwell, stop and rest.`;

  const notificationId = await insertNotification({
    day: dayKey(),
    at: Date.now(),
    kind: 'high_bpm',
    tier: 0,
    state: null,
    emotion: null,
    verse_id: null,
    episode_id: null,
    body,
  });

  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'High heart rate',
      body,
      data: { notificationId, kind: 'high_bpm' },
      ...(Platform.OS === 'android' ? { channelId: CHANNELS.tier2 } : {}),
    },
    trigger: null,
  });

  return notificationId;
}

/**
 * Schedule the daily summary for the configured time.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS IS RESCHEDULED RATHER THAN SET ONCE
 * ───────────────────────────────────────────────────────────────────────────
 * The summary has to state the day's peak heart rate, which is not known until
 * the moment it fires. A local notification's text is fixed when it is
 * scheduled, and neither iOS nor Android will reliably wake the app at an
 * exact time to compose one.
 *
 * So the summary is re-scheduled with the latest figures every time the app
 * runs a monitoring tick. If the app has been opened at any point during the
 * afternoon the figure is current; if it has not been opened since the morning
 * the notification still fires, but reports the peak as of the last time the
 * app ran, and says so. The daily summary screen always shows the true figure.
 * ───────────────────────────────────────────────────────────────────────────
 */
export async function scheduleDailySummary(opts: {
  hour: number;
  minute: number;
  maxBpm: number | null;
  maxBpmAt: number | null;
  verse: Verse | null;
  asOf: number;
  sampleCount: number;
}): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(DAILY_SUMMARY_ID).catch(() => {
    // No summary was scheduled yet — nothing to cancel.
  });

  const peakLine = opts.maxBpm === null
    ? 'No heart-rate readings were recorded today.'
    : `Highest heart rate today: ${Math.round(opts.maxBpm)} bpm` +
      (opts.maxBpmAt
        ? ` at ${new Date(opts.maxBpmAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
        : '.');

  const staleness = Date.now() - opts.asOf > 30 * 60_000
    ? ' (as of the last time HV was open)'
    : '';

  const verseLine = opts.verse
    ? `\n\n${opts.verse.reference}\n${opts.verse.text}`
    : '';

  await Notifications.scheduleNotificationAsync({
    identifier: DAILY_SUMMARY_ID,
    content: {
      title: 'Your day in review',
      body: `${peakLine}${staleness}${verseLine}`,
      data: {
        kind: 'daily_summary',
        verseId: opts.verse?.id ?? null,
        maxBpm: opts.maxBpm,
      },
      ...(Platform.OS === 'android' ? { channelId: CHANNELS.summary } : {}),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DAILY,
      hour: opts.hour,
      minute: opts.minute,
    },
  });
}

/**
 * Ask the user whether they are all right, after an emergency alert.
 *
 * Delayed rather than immediate: asking "are you okay?" in the same second as
 * the emergency alert itself adds noise at the worst moment. The delay gives
 * the episode time to pass.
 */
export const CHECKIN_DELAY_MS = 10 * 60_000;

export async function scheduleWellbeingCheckin(
  episodeId: number | null,
  delayMs: number = CHECKIN_DELAY_MS,
): Promise<number> {
  const checkinId = await insertCheckin(episodeId, Date.now());

  await Notifications.scheduleNotificationAsync({
    content: {
      title: 'Are you okay?',
      body: 'HV noticed a high-stress episode a few minutes ago. Tap to let us know how you are — it helps tune what the app does next time.',
      data: { kind: 'checkin', checkinId, episodeId },
      ...(Platform.OS === 'android' ? { channelId: CHANNELS.checkin } : {}),
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
      seconds: Math.max(1, Math.round(delayMs / 1000)),
      repeats: false,
    },
  });

  return checkinId;
}
