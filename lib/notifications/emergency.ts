/**
 * lib/notifications/emergency.ts
 *
 * Emergency contact hand-off for Level 3 alerts.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * The app does NOT send messages by itself.
 *
 * The study describes Level 3 as alerting pre-specified emergency contacts.
 * This build opens the phone's SMS composer with the message and recipients
 * pre-filled, and the user presses send.
 *
 * That is deliberate. A false positive here texts someone's family that they
 * are in medical distress. The classifier's own cross-validated accuracy is
 * well short of what silently dispatching that message would require, and the
 * study itself specifies a manual override precisely so users can cancel an
 * alert in case of a false reading. Keeping a human in the loop is the same
 * safeguard, applied one step earlier.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as SMS from 'expo-sms';

import { listContacts } from '../db';

export interface EmergencyDispatch {
  /** False when the device cannot send SMS at all (e.g. a tablet). */
  available: boolean;
  /** Contacts the message was addressed to. */
  recipients: string[];
  /** The composed message. */
  message: string;
  /** What the composer reported: sent, cancelled, unknown, or unavailable. */
  result: 'sent' | 'cancelled' | 'unknown' | 'unavailable' | 'no_contacts';
}

export function composeEmergencyMessage(bpm: number, at: Date): string {
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    `This is an automated message from HV, a heart-rate monitoring app. ` +
    `At ${time} it detected a sustained high-stress episode with a heart rate of ` +
    `${Math.round(bpm)} bpm. Please check on me.`
  );
}

/**
 * Open the SMS composer addressed to every saved emergency contact.
 *
 * Returns without doing anything when no contacts are saved — an emergency
 * alert with nobody to notify should fail quietly rather than throwing in the
 * middle of the monitoring tick.
 */
export async function dispatchEmergencySms(
  bpm: number,
  at: Date = new Date(),
): Promise<EmergencyDispatch> {
  const message = composeEmergencyMessage(bpm, at);
  const contacts = await listContacts();
  const recipients = contacts.map((c) => c.phone);

  if (recipients.length === 0) {
    return { available: false, recipients, message, result: 'no_contacts' };
  }

  const available = await SMS.isAvailableAsync();
  if (!available) {
    return { available: false, recipients, message, result: 'unavailable' };
  }

  const { result } = await SMS.sendSMSAsync(recipients, message);
  return {
    available: true,
    recipients,
    message,
    result: result === 'sent' ? 'sent' : result === 'cancelled' ? 'cancelled' : 'unknown',
  };
}
