import React from 'react';
import { StyleSheet, Text, View, Dimensions, Platform } from 'react-native';
import * as Device from 'expo-device';

/**
 * DemoWatermark Component
 * 
 * Displays a persistent, semi-transparent watermark across the entire application.
 * Only renders if the environment variable EXPO_PUBLIC_BUILD_TYPE is set to 'demo'.
 * 
 * TO DISABLE FOR PRODUCTION:
 * Set EXPO_PUBLIC_BUILD_TYPE to anything else (or leave empty) in your .env or build command.
 */
export const DemoWatermark = () => {
  const isDemo = process.env.EXPO_PUBLIC_BUILD_TYPE === 'demo';

  // Check if running on a simulator/emulator using expo-device
  const isSimulator = !Device.isDevice;

  console.log('[Watermark Debug] Values:', {
    isDevice: Device.isDevice,
    deviceName: Device.modelName,
    isSimulator,
    isDemo,
  });

  if (!isDemo || isSimulator) return null;

  return (
    <View style={styles.container} pointerEvents="none">
      {/* Main Diagonal Watermark */}
      <View style={styles.diagonalWrapper}>
        <Text style={styles.watermarkText}>
          DEMO VERSION{'\n'}UNPAID CLIENT TEST BUILD
        </Text>
      </View>

      {/* Repeating background text for extra security */}
      <View style={[styles.overlay, { opacity: 0.03 }]}>
         {Array.from({ length: 15 }).map((_, i) => (
           <Text key={i} style={styles.repeatingText}>UNPAID BUILD • DEMO VERSION • CLIENT TEST • </Text>
         ))}
      </View>

      {/* Bottom Footer Label */}
      <View style={styles.footer}>
        <Text style={styles.footerText}>
          Demo build for client testing only • HV v1.0.0
        </Text>
      </View>
    </View>
  );
};

const { width, height } = Dimensions.get('window');

const styles = StyleSheet.create({
  container: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9999, // Highest possible priority on iOS
    elevation: 99, // Highest possible priority on Android
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  diagonalWrapper: {
    transform: [{ rotate: '-35deg' }],
    width: width * 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  watermarkText: {
    fontSize: 40,
    fontWeight: '900',
    color: 'rgba(0, 0, 0, 0.15)', // Semi-transparent black/grey
    textAlign: 'center',
    lineHeight: 50,
    letterSpacing: 2,
    textTransform: 'uppercase',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: 10,
  },
  repeatingText: {
    fontSize: 12,
    fontWeight: 'bold',
    color: '#000',
  },
  footer: {
    position: 'absolute',
    bottom: Platform.OS === 'ios' ? 40 : 20,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(255, 59, 48, 0.8)', // Semi-transparent red
    paddingVertical: 4,
    alignItems: 'center',
  },
  footerText: {
    color: '#FFF',
    fontSize: 10,
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
});
