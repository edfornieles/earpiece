# Mother — Android app

The dedicated audio endpoint for Mother. Phones stay at the control desk; participants wear only their earpieces. The app shows its number, server connection, headset, battery, and current participant. There is no participant consent or “Before you begin” screen. Visits start and end at the control desk.

## How the phone fits into a performance

Create a permanent slot on the server's **Phones** page; more than four slots are supported. Scan that slot's QR code and use **Open Mother app**, or **Install Mother for Android** to obtain the server's current APK. Opening the setup web page alone does not replace an existing native connection; connecting a second actual endpoint to the same slot does.

The phone is an audio endpoint. Script generation, role assignment, timing, conversations and recording are controlled by the server. Select the saved score and map its roles to phone slots in **Session** before recording. At **Live desk**, start recording, start the assigned participant visits, then start the program. The phone does not need a script editor or a participant start/consent screen. A role is assigned to a phone slot at the desk, not chosen on the handset.

Participant microphone audio is muted between visits. During a visit it returns to the desk, recording and that participant's agent; it is never relayed to another participant's earpiece. Controller speech and the assigned role's speech play to that phone.

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

## Readiness and rehearsal

Check connection, audio readiness and earpiece input/output separately. A connected service alone does not prove that the correct headset microphone is active. Missing headsets are flagged at the desk; Programs refuses a start when a phone reports its headset missing. Equipment loss during a run pauses the affected role, with explicit recovery from the desk. Replacing a participant requires stopping and restarting the program.

Known limitations include native speaker fallback, incomplete route verification, Bluetooth permissions on newer Android versions and the limited local slot picker. Use the slot's connection link for higher slots, and consult the [Android app review](../server/docs/android-app-review.md) for the historical findings and completed follow-ups. Do not interpret automatic network reconnection as verified earpiece routing or assume a prepared program will resume automatically.

Rehearse both directions through the actual earpiece, away from the phone, and test walking range and reconnect behaviour. The current workflow has automated server/audio isolation tests and a verified Android installation, but full performance hardware endurance is not yet established.

See the [server guide](../server/README.md) for operating the desk and the [Programs guide](../server/docs/programs.md) for script generation and multi-role scores.
