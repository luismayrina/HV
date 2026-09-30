/**
 * constants/monitor.ts
 *
 * Display constants shared by the monitoring screens.
 */

import type { EmotionClass, MonitorState } from '@/lib/rprv/types';

export const STATE_COLOR: Record<MonitorState, string> = {
  CALM: '#4CD964',
  ELEVATED: '#FFCC00',
  STRESS: '#FF9500',
  ACUTE: '#FF3B30',
};

export const STATE_LABEL: Record<MonitorState, string> = {
  CALM: 'Calm',
  ELEVATED: 'Elevated',
  STRESS: 'Stress',
  ACUTE: 'Acute',
};

/** What each state means in plain language, for the UI. */
export const STATE_DESCRIPTION: Record<MonitorState, string> = {
  CALM: 'Your baseline. No notification is sent.',
  ELEVATED: 'Mild stress or agitation. Level 1 — verses of peace and comfort.',
  STRESS: 'Sustained stress. Level 2 — verses of strength and hope.',
  ACUTE: 'Acute stress. Level 3 — verses of protection, plus emergency contacts.',
};

export const EMOTION_COLOR: Record<EmotionClass, string> = {
  calm: '#4CD964',
  peace: '#34AADC',
  stress: '#FF9500',
  anxiety: '#FF3B30',
  sadness: '#5856D6',
};

export const EMOTION_LABEL: Record<EmotionClass, string> = {
  calm: 'Calm',
  peace: 'Peace',
  stress: 'Stress',
  anxiety: 'Anxiety',
  sadness: 'Sadness',
};

/** Shared surface palette, matching the existing screens. */
export const UI = {
  background: '#F2F2F7',
  card: '#FFFFFF',
  border: '#E5E5EA',
  text: '#1C1C1E',
  muted: '#8E8E93',
  faint: '#AEAEC0',
  accent: '#007AFF',
} as const;

/** Human-readable feature names for the algorithm screen. */
export const FEATURE_LABEL: Record<string, string> = {
  meanRR: 'Mean pulse interval',
  sdnn: 'SDNN',
  rmssd: 'RMSSD',
  pnn50: 'pNN50',
  lfPower: 'LF power',
  hfPower: 'HF power',
  lfHfRatio: 'LF/HF ratio',
  entropy: 'Sample entropy',
  entropyRatio: 'Entropy vs baseline',
  inactivityMinutes: 'Inactivity',
  hourOfDay: 'Hour of day',
  meanBpm: 'Mean heart rate',
};

export const FEATURE_UNIT: Record<string, string> = {
  meanRR: 'ms',
  sdnn: 'ms',
  rmssd: 'ms',
  pnn50: '',
  lfPower: 'ms²',
  hfPower: 'ms²',
  lfHfRatio: '',
  entropy: '',
  entropyRatio: '×',
  inactivityMinutes: 'min',
  hourOfDay: 'h',
  meanBpm: 'bpm',
};
