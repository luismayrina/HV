const { withAndroidManifest, withMainActivity } = require('@expo/config-plugins');

function withHealthConnectAndroid14(config) {
  // 1. Modify AndroidManifest.xml
  config = withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults.manifest;
    const mainActivity = androidManifest.application[0].activity.find(
      (a) => a['$']['android:name'] === '.MainActivity'
    );

    if (mainActivity) {
      // Add intent filter for VIEW_PERMISSION_USAGE
      if (!mainActivity['intent-filter']) {
        mainActivity['intent-filter'] = [];
      }
      
      const hasViewPermissionUsage = mainActivity['intent-filter'].some(
        (filter) =>
          filter.action &&
          filter.action.some((a) => a['$']['android:name'] === 'android.intent.action.VIEW_PERMISSION_USAGE')
      );

      if (!hasViewPermissionUsage) {
        mainActivity['intent-filter'].push({
          action: [
            {
              $: {
                'android:name': 'android.intent.action.VIEW_PERMISSION_USAGE',
              },
            },
          ],
          category: [
            {
              $: {
                'android:name': 'android.intent.category.HEALTH_PERMISSIONS',
              },
            },
          ],
        });
      }

      // Add property READ_PRIVACY_POLICY
      if (!mainActivity['property']) {
        mainActivity['property'] = [];
      }

      const hasReadPrivacyPolicy = mainActivity['property'].some(
        (p) => p['$']['android:name'] === 'android.health.connect.READ_PRIVACY_POLICY'
      );

      if (!hasReadPrivacyPolicy) {
        mainActivity['property'].push({
          $: {
            'android:name': 'android.health.connect.READ_PRIVACY_POLICY',
            'android:value': 'true',
          },
        });
      }
    }

    return config;
  });

  // 2. Modify MainActivity.kt
  config = withMainActivity(config, (config) => {
    let mainActivity = config.modResults.contents;

    if (config.modResults.language === 'kt') {
      // Inject Import Statement
      const importStr = 'import dev.matinzd.healthconnect.permissions.HealthConnectPermissionDelegate';
      if (!mainActivity.includes(importStr)) {
        mainActivity = mainActivity.replace(
          'class MainActivity :',
          `${importStr}\n\nclass MainActivity :`
        );
      }

      // Inject setPermissionDelegate in onCreate
      const delegateStr = 'HealthConnectPermissionDelegate.setPermissionDelegate(this)';
      if (!mainActivity.includes(delegateStr)) {
        mainActivity = mainActivity.replace(
          /super\.onCreate\((.*?)\)/,
          `super.onCreate($1)\n    HealthConnectPermissionDelegate.setPermissionDelegate(this)`
        );
      }
    }

    config.modResults.contents = mainActivity;
    return config;
  });

  return config;
}

module.exports = withHealthConnectAndroid14;
