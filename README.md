# HV — Heart Vitality ❤️

A cross-platform (iOS + Android) React Native / Expo app for **live heart-rate monitoring**, step counting and basal metabolic rate, reading directly from the native health platforms:

- **iOS** → Apple HealthKit (`@kingstinct/react-native-healthkit`)
- **Android** → Google Health Connect (`react-native-health-connect`)

> **This app cannot run in Expo Go.** It depends on native modules (HealthKit, Health Connect, Nitro Modules, Reanimated worklets) that are not bundled in the Expo Go client. You must use a **development build** or a **standalone APK/IPA** — see [Running the app](#running-the-app) and [Building an Android APK](#building-an-android-apk).

---

## Table of contents

- [Features](#features)
- [Tech stack](#tech-stack)
- [Prerequisites](#prerequisites)
- [Project setup](#project-setup)
- [Environment variables](#environment-variables)
- [Running the app](#running-the-app)
- [Building an Android APK](#building-an-android-apk)
- [Building for Google Play (AAB)](#building-for-google-play-aab)
- [Building for iOS](#building-for-ios)
- [Health platform setup](#health-platform-setup)
- [HeartSim — simulator data source](#heartsim--simulator-data-source)
- [Demo builds & watermark](#demo-builds--watermark)
- [Project structure](#project-structure)
- [npm scripts](#npm-scripts)
- [Troubleshooting](#troubleshooting)

---

## Features

1. **Live heart-rate monitoring** — polls the platform health store and pushes new BPM readings to the UI, with a stale-data indicator after 60s without a new sample.
2. **Activity + body metrics** — step counts and basal metabolic rate, plus profile data (biological sex, blood type, date of birth) on iOS.
3. **Three data paths**, selected automatically at runtime:
   | Source | Platform | Poll interval |
   |---|---|---|
   | HeartSim HTTP server | iOS simulator (dev only) | 1s |
   | HealthKit (polling + `HKObserverQuery` push) | iOS device | 3s |
   | Health Connect (`readRecords`) | Android device | 5s |
4. **Foreground resume handling** — refreshes immediately and restarts the poll interval when the app returns to the foreground.
5. **Demo watermark** — an opt-in, build-time overlay for unpaid client test builds.

---

## Tech stack

| Layer | Choice |
|---|---|
| Framework | Expo SDK **54** |
| Runtime | React Native **0.81.5**, React **19.1** |
| Language | TypeScript (strict) |
| Routing | Expo Router v6 (file-based, `typedRoutes` enabled) |
| Architecture | React Native **New Architecture** (`newArchEnabled: true`) + React Compiler |
| Animation / gestures | Reanimated 4, Gesture Handler, Worklets |
| Native health | `@kingstinct/react-native-healthkit`, `react-native-health-connect` |
| Build service | EAS Build (project `db2a7c44-8dc6-4ad4-9181-e9096ec1f42d`) |

Bundle identifier / package name: `com.saintluwis.HV`

---

## Prerequisites

**Always required**

- **Node.js 20+** (developed against Node 25)
- **npm** (repo ships a `package-lock.json`)
- **Expo CLI** — no global install needed, use `npx expo …`

**For Android builds**

- **JDK 17** — required by Gradle 8.14 / AGP for RN 0.81. Verify with `java -version`; if it errors, install Temurin 17 (`brew install --cask temurin@17` on macOS) and set `JAVA_HOME`.
- **Android SDK** (Android Studio, or command-line tools) with:
  - Platform **API 35** (`compileSdkVersion`/`targetSdkVersion` 35)
  - Build-tools + `platform-tools` (for `adb`)
  - `ANDROID_HOME` exported and `$ANDROID_HOME/platform-tools` on `PATH`
- `minSdkVersion` is **26** (Android 8.0) — Health Connect itself needs Android 9+ (14+ has it built into the OS).

**For iOS builds**

- **macOS** with **Xcode 16+** and CocoaPods
- A physical iPhone (+ paired Apple Watch) for real heart-rate data — the simulator has no HealthKit heart-rate samples
- An Apple Developer account for device provisioning with the HealthKit entitlement

**For cloud builds**

- **EAS CLI**: `npm install -g eas-cli` (or `npx eas …`), then `eas login`

---

## Project setup

```bash
git clone <repo-url> HV
```

```bash
cd HV && npm install
```

> **`android/` and `ios/` are git-ignored** (see `.gitignore` → "generated native folders"). On a fresh clone they will not exist. Generate them from `app.json` with:

```bash
npx expo prebuild
```

Use `npx expo prebuild -p android` or `-p ios` to generate just one platform. Add `--clean` to regenerate from scratch after changing `app.json`, plugins, or native dependencies.

---

## Environment variables

Expo only exposes variables prefixed with `EXPO_PUBLIC_` to app code, and inlines them **at bundle time** — changing one requires restarting Metro (and rebuilding for a standalone binary).

`.env`:

```bash
EXPO_PUBLIC_BUILD_TYPE=demo
```

| Variable | Values | Effect |
|---|---|---|
| `EXPO_PUBLIC_BUILD_TYPE` | `demo` | Renders the full-screen [demo watermark](#demo-builds--watermark) on physical devices |
| | anything else / unset | Normal build, no watermark |

---

## Running the app

### 1. Development build (recommended)

Compiles the native project once, installs a dev client on the device/emulator, then hot-reloads JS from Metro.

Android:

```bash
npx expo run:android
```

iOS:

```bash
npx expo run:ios
```

Add `--device` to pick a physical device, or `--variant release` / `--configuration Release` to run an optimized build.

Once the dev client is installed, subsequent JS-only work just needs the bundler:

```bash
npx expo start
```

Press `a` for Android, `i` for iOS, `r` to reload. Use `--tunnel` if the phone can't reach your machine on the LAN (`@expo/ngrok` is already a devDependency).

### 2. Web

```bash
npm run web
```

Web runs the UI shell only — HealthKit and Health Connect are native-only, so no live health data.

---

## Building an Android APK

There are three routes. Pick based on whether you want a cloud build, a local build via EAS, or a raw Gradle build.

### Option A — EAS cloud build (easiest, no local Android SDK)

The `preview` profile in `eas.json` is already configured to emit an **APK** (`buildType: "apk"`) rather than an AAB:

```bash
eas build --platform android --profile preview
```

EAS uploads the project, builds it on Expo's infrastructure, and gives you a download URL plus a QR code. First run will offer to generate an Android keystore for you and store it on Expo's servers.

Build profiles available in [eas.json](eas.json):

| Profile | Output | Notes |
|---|---|---|
| `development` | APK with dev client | `developmentClient: true`, internal distribution — install this to debug against Metro |
| `preview` | **APK** | Internal distribution — the one to hand to testers |
| `production` | AAB | `autoIncrement: true`, for Play Store submission |

### Option B — EAS build, run locally

Same configuration, but compiled on your machine (needs JDK 17 + Android SDK):

```bash
eas build --platform android --profile preview --local
```

The finished `.apk` is written to the project root.

### Option C — Plain Gradle (fastest iteration, full control)

Generate the native project if you haven't already:

```bash
npx expo prebuild -p android
```

Then build:

```bash
cd android && ./gradlew assembleRelease
```

Outputs:

| Command | APK path |
|---|---|
| `./gradlew assembleDebug` | `android/app/build/outputs/apk/debug/app-debug.apk` |
| `./gradlew assembleRelease` | `android/app/build/outputs/apk/release/app-release.apk` |

Install it on a connected device or emulator:

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Clean rebuild when things get weird:

```bash
cd android && ./gradlew clean
```

### ⚠️ Release signing

`android/app/build.gradle` currently signs **release builds with the debug keystore** — this is the Expo template default and it is **not** suitable for distribution. Such an APK installs fine for testing, but cannot be published and cannot be upgraded later by a properly signed build.

To sign properly, generate your own keystore:

```bash
keytool -genkeypair -v -storetype PKCS12 -keystore hv-release.keystore -alias hv-key -keyalg RSA -keysize 2048 -validity 10000
```

Put the credentials in `~/.gradle/gradle.properties` (never commit them — `*.jks`/`*.p12`/`*.key` are already git-ignored):

```
HV_UPLOAD_STORE_FILE=hv-release.keystore
HV_UPLOAD_KEY_ALIAS=hv-key
HV_UPLOAD_STORE_PASSWORD=*****
HV_UPLOAD_KEY_PASSWORD=*****
```

Then add a `release` entry to `signingConfigs` in `android/app/build.gradle` referencing those properties and point `buildTypes.release.signingConfig` at it. Note that `npx expo prebuild --clean` regenerates this file, so for a durable setup either keep the keystore in EAS (Option A handles signing automatically) or move the change into a config plugin under `plugins/`.

---

## Building for Google Play (AAB)

Cloud:

```bash
eas build --platform android --profile production
```

Local Gradle equivalent — output at `android/app/build/outputs/bundle/release/app-release.aab`:

```bash
cd android && ./gradlew bundleRelease
```

`appVersionSource` is set to `remote` in `eas.json`, so EAS manages the `versionCode`; `production` builds auto-increment it. Submit with:

```bash
eas submit --platform android --latest
```

---

## Building for iOS

Requires macOS + Xcode.

Local dev build on a connected device:

```bash
npx expo run:ios --device --configuration Release
```

Cloud build (`.ipa` for TestFlight / internal distribution):

```bash
eas build --platform ios --profile preview
```

The `@kingstinct/react-native-healthkit` config plugin injects the HealthKit entitlement and the `NSHealthShareUsageDescription` / `NSHealthUpdateUsageDescription` strings from `app.json`, so no manual Xcode capability wiring is needed — but the provisioning profile must have HealthKit enabled (EAS handles this when it manages your credentials).

---

## Health platform setup

### Android — Health Connect

1. On Android 14+, Health Connect is part of the OS. On Android 9–13, install **Health Connect** from the Play Store.
2. Health Connect is a **store, not a sensor** — it only returns records that another app has written. Install and sign into a source app (Samsung Health, Google Fit, a Wear OS companion, Fitbit, etc.) and confirm it is syncing heart-rate data into Health Connect.
3. Launch HV and grant the heart-rate read permission when prompted. If the prompt fails to appear, grant it manually under **Settings → Apps → Health Connect → App permissions → HV**.

Permissions declared in `app.json`: `READ_HEART_RATE`, `READ_STEPS`, `READ_BASAL_METABOLIC_RATE`. The local config plugin [`plugins/withHealthConnectAndroid14.js`](plugins/withHealthConnectAndroid14.js) adds the `VIEW_PERMISSION_USAGE` intent filter that Android 14+ requires for Health Connect apps.

### iOS — HealthKit + Apple Watch

1. HealthKit heart-rate data only exists on a physical iPhone with a paired Apple Watch (or another HR-writing device).
2. Grant access when the Health permission sheet appears; you can revisit it in **Settings → Health → Data Access & Devices → HV**.
3. **Latency caveat:** iPhone can only read samples the Watch has *already written and synced*. Idle background writes can be 10–15 minutes apart. Start a workout on the Watch and samples arrive roughly every 5s with much lower sync latency. True sub-second streaming would require a watchOS companion app using `HKWorkoutSession` + `WatchConnectivity`, which this project does not include. This is documented in detail at the top of [hooks/useHeartRateMonitor.ts](hooks/useHeartRateMonitor.ts).

---

## HeartSim — simulator data source

Because the iOS simulator has no HealthKit heart-rate data, the hook first probes a local HTTP server on **`http://127.0.0.1:7777`**. If it responds with JSON containing a numeric `bpm` field, HV polls it every second instead of HealthKit and labels the source `heartsim`.

Expected response shape:

```json
{ "bpm": 72 }
```

`NSAllowsLocalNetworking` is already enabled in `app.json` so the simulator can reach loopback. The server itself is **not part of this repo** — run any small local HTTP service that returns the payload above. On a real device the probe simply times out after 600ms and HV falls through to HealthKit.

---

## Demo builds & watermark

[`components/DemoWatermark.tsx`](components/DemoWatermark.tsx) renders a full-screen, non-interactive overlay reading "DEMO VERSION — UNPAID CLIENT TEST BUILD" plus a red footer bar. It is mounted globally in [app/_layout.tsx](app/_layout.tsx).

It renders **only** when both are true:

- `EXPO_PUBLIC_BUILD_TYPE === 'demo'`
- The app is running on a physical device (`expo-device`'s `Device.isDevice`) — it is hidden on simulators/emulators so it doesn't get in the way during development.

To ship a clean build, change the value in `.env` before building:

```bash
EXPO_PUBLIC_BUILD_TYPE=production
```

Since the value is inlined at bundle time, you must rebuild the binary (or restart Metro for a dev build) after changing it — flipping it on an already-built APK has no effect.

---

## Project structure

```text
HV/
├── app/                      # Expo Router routes (file-based)
│   ├── _layout.tsx           # Root layout, mounts DemoWatermark
│   ├── (tabs)/_layout.tsx    # Main monitoring UI + tab navigator
│   ├── (tabs)/index.tsx
│   ├── (tabs)/explore.tsx
│   ├── profile.tsx           # Health profile (sex, blood type, DOB, steps)
│   └── modal.tsx
├── components/               # Reusable UI (themed text/view, DemoWatermark, …)
├── hooks/
│   └── useHeartRateMonitor.ts  # ★ core health-data logic for both platforms
├── constants/theme.ts        # Colors + typography
├── plugins/
│   └── withHealthConnectAndroid14.js   # Local Expo config plugin
├── assets/                   # Icons, splash, fonts
├── scripts/reset-project.js
├── app.json                  # Expo config: permissions, plugins, build props
├── eas.json                  # EAS build profiles (development/preview/production)
├── android/  ios/            # Generated native projects (git-ignored)
└── package.json
```

Start with `hooks/useHeartRateMonitor.ts` — it is the bridge between the native health stores and the UI, and it carries the platform caveats in its header comment.

---

## npm scripts

| Script | Command | Purpose |
|---|---|---|
| `npm start` | `expo start` | Start the Metro dev server |
| `npm run android` | `expo run:android` | Build + install the Android dev build |
| `npm run ios` | `expo run:ios` | Build + install the iOS dev build |
| `npm run web` | `expo start --web` | Run in the browser (no health data) |
| `npm run lint` | `expo lint` | ESLint (`eslint-config-expo`) |
| `npm run reset-project` | `node ./scripts/reset-project.js` | Move starter code to `app-example/` and start blank ⚠️ destructive to `app/` |

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Unable to locate a Java Runtime` on `./gradlew` | Install JDK 17 and export `JAVA_HOME` |
| `SDK location not found` | Set `ANDROID_HOME`, or add `sdk.dir=/path/to/Android/sdk` to `android/local.properties` |
| App crashes instantly in **Expo Go** | Expected — native modules aren't in Expo Go. Use a dev build. |
| `android/` or `ios/` missing after clone | Run `npx expo prebuild` — they're git-ignored |
| Native config changes in `app.json` not applied | `npx expo prebuild --clean`, then rebuild |
| BPM stays `null` on iOS device | Confirm Health permissions are granted; start a workout on the Apple Watch to force frequent writes |
| BPM stays `null` on Android | Confirm Health Connect is installed **and** a source app has written heart-rate records; HV falls back to a 24h lookback window before giving up |
| "Health Connect is not available" | Install Health Connect from the Play Store (Android 9–13) |
| Permission dialog never appears on Android | Grant manually: Settings → Apps → Health Connect → App permissions |
| Stale-data warning after 60s | Working as designed (`STALE_THRESHOLD_MS`) — no new sample has arrived from the platform |
| Metro cache weirdness | `npx expo start --clear` |
| Gradle build fails after dependency changes | `cd android && ./gradlew clean`, then rebuild |

---

## Learn more

- [Expo documentation](https://docs.expo.dev/)
- [Development builds](https://docs.expo.dev/develop/development-builds/introduction/)
- [EAS Build](https://docs.expo.dev/build/introduction/)
- [Android Health Connect](https://developer.android.com/health-and-fitness/guides/health-connect)
- [Apple HealthKit](https://developer.apple.com/documentation/healthkit)
