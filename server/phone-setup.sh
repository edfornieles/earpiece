#!/bin/bash
# Sets up an Android phone (plugged in over USB) as a dedicated earpiece phone.
# Usage:  ./phone-setup.sh 1        (use a slot already created on the Phones page)
# Needs:  brew install android-platform-tools   and USB debugging switched on on the phone
#         (Settings → About phone → tap "Build number" 7 times → Developer options → USB debugging)

set -e
cd "$(dirname "$0")"
SLOT="${1:-1}"
case "$SLOT" in *[!0-9]*|0|'') echo "Use a positive phone slot number from the Phones page."; exit 1;; esac
command -v adb >/dev/null || { echo "adb not found — run: brew install android-platform-tools"; exit 1; }
# several entries for one phone (wifi debugging lists it twice) — use the first
[ -z "$ANDROID_SERIAL" ] && export ANDROID_SERIAL=$(adb devices | awk 'NR>1 && $2=="device"{print $1; exit}')
adb get-state >/dev/null 2>&1 || { echo "No phone found. Plug it in, unlock it, and accept the 'Allow USB debugging' prompt."; exit 1; }

BASE=$(grep -E '^PUBLIC_URL=' .env 2>/dev/null | cut -d= -f2- | tr -d '"'"'")
KEY=$(node -e "try{console.log(require('./.keys.json').phone)}catch{}")
[ -n "$BASE" ] && [ -n "$KEY" ] || { echo "Start the server once (npm start) so the phone link exists, then run this again."; exit 1; }
URL="$BASE/p?k=$KEY&device=$SLOT"

echo "Phone: $(adb shell getprop ro.product.model | tr -d '\r')  →  slot $SLOT"
adb shell settings put global stay_on_while_plugged_in 7          # screen stays on while charging
adb shell settings put system screen_off_timeout 1800000           # 30 min timeout when unplugged
adb shell settings put secure lock_to_app_enabled 1 2>/dev/null || true   # allow app pinning
adb shell cmd notification set_dnd priority 2>/dev/null || adb shell cmd notification set_dnd on 2>/dev/null || true
if [ -f earpiece.apk ]; then
  echo "Installing the Mother app…"
  adb shell am force-stop com.edfornieles.earpiece 2>/dev/null || true
  if ! adb install -r -g earpiece.apk >/dev/null 2>&1; then   # -g grants the microphone permission up front
    echo "Update failed. The installed app and saved settings have been left intact."
    echo "Check the APK signing identity and phone compatibility before retrying."
    exit 1
  fi
  adb shell am start -n com.edfornieles.earpiece/.MainActivity --es url "$URL" >/dev/null
  echo
  echo "Done. The Mother app is open on the phone in slot $SLOT."
  echo "  - Pair the participant's Bluetooth headset with this phone (or plug in wired earphones)."
  echo "  - Gallery mode (pins the app): hold 'Phone $SLOT' in the top-right corner, tick Gallery mode."
else
  adb shell am start -a android.intent.action.VIEW -d "$URL" com.android.chrome >/dev/null
  echo
  echo "Done (web version — no earpiece.apk in this folder yet). On the phone:"
  echo "  1. Chrome has opened the earpiece page. Menu (⋮) → Add to Home screen → Install."
  echo "  2. Open it from the home screen icon (full screen, no browser bars)."
  echo "  3. To lock it to the app: open Recent apps, tap the app icon at the top → Pin this app."
fi
echo
echo "Link for this phone: $URL"
