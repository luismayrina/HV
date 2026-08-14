# Project Overview: HV (Heart Vitality)

## 📋 Executive Summary
**HV** is a high-performance cross-platform mobile application built with **Expo** and **React Native**. Its primary mission is **real-time health monitoring**, with a specific focus on live heart rate data, step counting, and metabolic tracking. It leverages platform-native health APIs to provide a seamless monitoring experience on both iOS and Android.

---

## 🛠 Tech Stack & Core Technologies

### **Framework & Language**
- **Base Framework**: [Expo](https://expo.dev/) (SDK 54)
- **Core Library**: [React Native](https://reactnative.dev/) (0.81.5)
- **Programming Language**: [TypeScript](https://www.typescriptlang.org/) (Strict typing enabled)
- **Runtime**: [React 19](https://react.dev/)

### **Navigation**
- **Expo Router**: File-based routing located in the `app/` directory.
- **Typing**: Experimental `typedRoutes` enabled for type-safe navigation.

### **Health & Biometrics Integration**
- **iOS**: Apple HealthKit integration via `@kingstinct/react-native-healthkit`.
- **Android**: Google Health Connect integration via `react-native-health-connect`.
- **Permissions**: Configured for `READ_HEART_RATE`, `READ_STEPS`, and `READ_BASAL_METABOLIC_RATE`.

### **Architecture & Performance**
- **React Native New Architecture**: Enabled (`newArchEnabled: true`) for improved performance and TurboModules support.
- **High-Performance Modules**: Uses `react-native-nitro-modules` and `react-native-worklets` for efficient cross-platform code execution.
- **React Compiler**: Experimental React Compiler enabled for optimized rendering.
- **Animations**: Driven by `react-native-reanimated`.
- **Gestures**: Managed by `react-native-gesture-handler`.

---

## 📂 Project Structure
```text
HV/
├── app/                # File-based routes (Expo Router)
├── components/         # Reusable UI components
├── hooks/              # Custom React hooks (e.g., health data polling)
├── constants/          # Application-wide constants (Colors, Typography)
├── assets/             # Images, fonts, and static media
├── ios/                # Native iOS project files (Generated)
├── android/            # Native Android project files (Generated)
├── app.json            # Expo configuration (Permissions, Plugins)
└── package.json        # Dependencies and scripts
```

---

## 🚀 Key Features
1. **Live Heart Rate Monitoring**: Real-time fetching and display of BPM data from wearable devices via HealthKit/Health Connect.
2. **Activity Tracking**: Integrated step counting and metabolic rate analysis.
3. **Cross-Platform Parity**: Unified logic for health data access across Apple and Google ecosystems.
4. **Native Performance**: Leverages the New Architecture and Worklets to ensure UI responsiveness during high-frequency data updates.

---

## 🛠 Development Commands
- `npx expo start`: Start the development server.
- `npx expo run:ios`: Build and run the iOS development client.
- `npx expo run:android`: Build and run the Android development client.
- `npx expo lint`: Run linting checks.

---

## 🤖 AI Context Notes
- This project uses **Expo Router v6**. Routes are located in `/app`.
- The `app.json` contains critical native permissions for health data access.
- Always check `hooks/` for the logic handling the bridge between native health data and the UI.
- The app uses a **Dark Theme** by default (`backgroundColor: "#1A1A1A"` in splash/icons).
