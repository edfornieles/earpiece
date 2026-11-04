# Earpiece — Android app

The dedicated-phone side of the Earpiece command system. Same protocol as the web phone page (`/p`), but native, so it:

- keeps the mic and earphones running with the screen off (foreground service, wake lock, wifi lock)
- reconnects on its own after network drops, and resumes the participant
- remembers its slot and server, so there's no link or QR code to scan
- shows a fresh consent screen for each participant (the control room's **End participant** sends it back)
- pins itself, so participants can't leave it; it can also be set as the phone's home screen

## Install

Every push builds the app on GitHub (Actions → latest run → `earpiece-apk`). Install over USB:

```
adb install -r earpiece.apk
adb shell am start -n com.edfornieles.earpiece/.MainActivity --es url "https://earpiece.edfornieles.com/p?k=KEY&device=1"
```

`-r` installs over an existing copy (builds are signed with the same key, so updates install cleanly).

## Setup on the phone

The setup script in the main project does all of this. To change the server or slot by hand, hold "Phone N" in the top-right corner for 3 seconds. That screen also has **Unpin and exit**.
