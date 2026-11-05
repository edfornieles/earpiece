# Android app review — 5 November 2026

## Verified state

- GitHub account and repository access confirmed for `edfornieles/earpiece`, with push permission.
- A real checkout is at `/Users/edfornieles/Downloads/earpiece-repo`, on `codex/control-centre-review` with `origin` pointing to the requested repository. The existing working server code and tests have been copied into its `server/` directory. No recordings, registrations, runtime keys, `.env`, or device configuration were copied. Changes have not been pushed.
- The performance server remains in `/Users/edfornieles/Downloads/earpiece`. It listens on port 8787. The browser had been displaying the stopped temporary test server on port 57270; that tab has been redirected to the live control room.
- The live server was in standby, with no participant active. It was restarted in standby to load the new API and pages. Phone 1 reconnected automatically and is waiting for the desk.
- A Samsung SM-A202F, Android 11 (API 30), is reachable over Android debugging. Its installed app is version 1.0.4. Its saved server and phone key match the current performance system.
- Phone 1 reports no headset. Android's audio service independently reports no connected Bluetooth headset and an inactive SCO call-audio route. This is separate from the functioning phone-to-server connection.
- GitHub's latest successful build is run 6, from commit `96238883df990778a04380f6ab4f1640290d79cb`. Its source already has a desk-oriented operator screen.
- The installed APK and latest build have different signing certificates. This was checked by extracting and comparing their APK v2 signer certificates, without installing or uninstalling either app.

No participant was started, no audio was played, and no Android update was installed during this review.

## Findings and recommended changes

### 1. Updates currently cannot preserve the installed app [P1]

`android/app/build.gradle.kts` falls back to the Android debug key when `app/earpiece.keystore` is absent. The workflow does not restore a persistent signing key. The installed 1.0.4 certificate differs from build 6's certificate, so an in-place update from that build will fail.

`server/phone-setup.sh` currently responds to an installation failure by uninstalling the existing app. That removes its saved server, key, slot, headset choice, and permissions. A generic installation failure must not trigger an uninstall.

Use one protected, persistent signing identity in CI, report signature mismatch explicitly, and make any unavoidable one-time migration preserve operator configuration and require an explicit reinstall action. Do not put a private signing key in this public repository.

### 2. The app deliberately falls back to the phone speaker and room microphone [P1]

`AudioService.kt:337–391` checks available output devices and calls `routeSpeaker()` when no headset is present. The active-visit microphone loop checks only `micOn` and `connected`; it does not require an approved headset input.

For this performance, losing the intended earpiece should pause the participant's audio path and alert the desk. The phone should not silently play the private direction aloud or substitute a microphone sitting in the control room. Any speaker test mode should be explicit and visibly distinct from performance mode.

### 3. New native-app messages are not implemented by the server [P1]

The app sends `device` metadata and a `did` device identity, and expects `who`, `identify`, and `setSlot` messages. The current server does not handle these. Its `welcome` sends `name` and `waiting`, whereas native `readWho()` looks for structured `person`, `next`, and `standby` fields.

Consequences include missing model/battery/version information, no desk-driven identification or renumbering, and the native screen potentially displaying “Free” while a visit is active. Document and test a shared, versioned protocol before treating build 6 and the desk as an integrated release.

### 4. Native readiness is not announced while waiting [P2]

`AudioService.kt:187–191` sends `hello` only when its previous local state is not waiting. A newly connected native phone normally starts waiting and sends no microphone frames. The new desk therefore cannot distinguish a prepared native audio service from one that has not enabled audio: this can make a prepared native phone appear unready. The installed older app initially reported unready after restart and later reported audio enabled, while the headset remained disconnected.

Add an explicit readiness message after successful playback and microphone initialization, independently of whether a participant is active. Report authentication, audio initialization, headset input/output routing, and active visit separately. A WebSocket upgrade alone must not count as authenticated or ready.

### 5. Bluetooth permission support is incomplete for newer phones [P1 for Android 12+]

The manifest declares the legacy `BLUETOOTH` permission only through API 30. The app targets API 34 but neither declares nor requests `BLUETOOTH_CONNECT` for Android 12+. Permission failures in routing are swallowed, so operators could see a headset as available without knowing that selecting it failed.

Implement the permissions required by the Bluetooth operations used, report failures, and test both Android 11 and Android 12+ devices. This finding does not explain the current Android 11 phone's missing headset.

Reference: [Android Bluetooth permissions](https://developer.android.com/develop/connectivity/bluetooth/bt-permissions).

### 6. Device availability is not proof that the earpiece microphone is in use [P2]

The app chooses the first available SCO/wired output and records a product name. It does not verify the actual `AudioRecord` input route or the actual playback route. Product names are also not reliable unique identities when several identical headsets are nearby.

Verify actual input and output routing, check the result of selecting a communication device, and report the selected routes to the desk. Test by speaking into the earpiece away from the phone, with no sound reaching the phone's own microphone.

References: [AudioRecord](https://developer.android.com/reference/android/media/AudioRecord), [AudioManager](https://developer.android.com/reference/android/media/AudioManager).

### 7. Native settings still offer only eight numbered slots [P2]

`MainActivity.kt:313–327` renders slots 1–8. The desk now supports adding further slots. Native configuration should use slots supplied by the server, with stable phone identity and explicit reassignment. Receiving a link for slot 9 already parses, but the local slot picker does not offer it.

### 8. Audio and reconnect lifecycle needs hardening [P2]

Audio readiness is not conditional on checked `AudioRecord`/`AudioTrack` state, and microphone errors can leave a service that appears connected but cannot capture audio. `micOn` is shared across socket and microphone threads without a visibility guarantee. Audio-device callbacks and pending main-thread work are not unregistered/cleared when the service stops. Socket callbacks do not consistently reject callbacks from an older connection generation.

Make audio initialization fail visibly, recreate failed audio resources, use thread-safe visit state, scope callbacks to the current connection/service generation, and release callbacks and audio-routing state during teardown. Reconnection should clear old playback and resume only the visit confirmed by the server.

## Required app behaviour

The Android app is a dedicated audio endpoint operated at the control centre. Participants never operate the phone.

1. **Provision once:** assign the live server, permanent slot, and expected earpiece; retain those through normal updates and network interruptions. Browser QR onboarding must offer a native-app handoff rather than silently creating a second browser phone connection.
2. **Show distinct states:** server reachable, authenticated, audio initialized, correct headset input/output active, waiting, participant active, and a specific failure reason.
3. **Follow the desk:** only the desk starts/ends visits. End immediately mutes the uplink and discards old queued playback. No consent, name-entry, or participant start screen on the phone.
4. **Enforce audio isolation:** participant mic → desk and that participant's recording; director/AI → selected earpiece; no participant-to-participant relay. Preserve explicit director-to-all as a separate desk action.
5. **Survive ordinary use:** screen locked, app backgrounded, Wi-Fi reconnection, a server restart between sessions, and earpiece disconnection/reconnection. Reconnection must retain identity and must not replay stale directions to a new participant.
6. **Fail visibly:** no silent speaker or room-mic fallback; show the problem on both phone and desk. Require an explicit operator action for tests or reassignment.
7. **Support a fleet:** more than four phones, per-device battery/charging/version, actual headset routes, last contact, Identify, and an operator-controlled sound/mic test.
8. **Update reliably:** persistent signing identity, visible version compatibility, and no automatic uninstall on update failure.

## Validation before a performance

- Pair and verify the actual earpiece model; confirm its microphone is the input.
- Verify one phone, then multiple simultaneous phones, including a slot above eight.
- Test per-participant mic isolation, targeted director audio, targeted AI audio, and deliberate director-to-all.
- End/restart visits while transcription or AI audio is pending.
- Disconnect/reconnect the headset: no speaker output or room-mic substitution.
- Lock the phone screen and background the app during a visit.
- Interrupt Wi-Fi, restart the server in standby, and test reconnect without losing the slot.
- Install a same-signer update over an existing app and confirm settings survive.
- Walk every intended gallery route while monitoring two-way audio and dropouts.

The 13 server regression tests pass in the connected checkout. Real earpiece routing, walking range, locked-screen endurance, and Android 12+ permissions were not physically validated in this review.

## Outstanding operator decisions

- Which headset/earpiece model is used, and does it have a microphone?
- How far and through which rooms/walls will participants move from the control centre?
- Should locked-screen operation be the normal mode? The native service is intended to support it; the browser page currently relies on remaining awake.
