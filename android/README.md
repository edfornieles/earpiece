# Mother — Android app

The dedicated audio endpoint for Mother. Phones stay at the control desk; participants wear only their earpieces. The app shows its number, server connection, headset, battery, and current participant. There is no participant consent or “Before you begin” screen. Visits start and end at the control desk.

The foreground audio service is intended to keep running with the screen off and reconnect after network drops. Registration and consent belong to the separate registration workflow.

## Build and install

GitHub Actions builds the app when Android source changes. Download `earpiece-apk` from the successful workflow run. The APK filename and Android package identifier remain compatible with the deployment tools.

CI restores the signing PKCS12 and password from protected repository secrets (`MOTHER_KEYSTORE_BASE64` and `MOTHER_SIGNING_PASSWORD`). Never commit signing keys. The private recovery copy is maintained outside the checkout.

For a same-signature update:

```
adb install -r -g earpiece.apk
```

Historical 1.0.4 installations have a different signing certificate. A one-time migration must back up the installed APK and complete app preferences, replace the app, and restore the preferences. A normal update must never automatically uninstall the app after an installation failure.

To configure a phone from the desk:

```
adb shell am start -n com.edfornieles.earpiece/.MainActivity --es url "https://earpiece.edfornieles.com/p?k=KEY&device=1"
```

Hold the large phone number for 1.5 seconds to open operator settings. Pair the correct earpiece and verify both playback and its microphone before starting a participant. Screen pinning is optional for desk equipment.
