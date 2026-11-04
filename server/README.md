# Earpiece

A command system for the gallery. Dedicated phones with earphones connect to a control room on this Mac. An AI director (OpenAI listening and thinking, the Watercooler voice speaking) directs each participant, and you can cut in at any time. Cameras are shown live and recorded. Every session becomes one folder, ready to edit.

## Run a session

```
cd ~/Downloads/earpiece
npm start
```

- **Control room** opens in the browser (the link stays the same every time, so bookmark it). Headphones on, click **Start control room**.
- **Library**: the link in the top right.
- `Ctrl+C` ends the session. The video is converted for the editor and the exports are written. Wait for "saved:".

Before a session, quit **Stremio**. Its background server uses up the Mac's network connections, and then the tunnel and AI stop working.

## Phones

Each phone has a fixed slot (Phone 1–4) and its own permanent link. QR codes for each slot are on the control page.

First-time setup for a dedicated Android phone, plugged in over USB:
```
brew install android-platform-tools     # once
./phone-setup.sh 1                      # 1 = the slot for this phone
```
This keeps the screen on while charging, turns on Do Not Disturb, allows app pinning, and opens the page. Then on the phone: Chrome menu → **Add to Home screen**, open it from the icon, and pin it.

For each participant: they tick consent, tap Begin, and the AI starts. When they're done, click **End participant → ready for next** on their card. The phone goes back to the consent screen for the next person.

Use wired earphones with a mic on the phones. Bluetooth earbuds can jump to another device mid-session.

## Cameras

Copy `cameras.example.json` to `cameras.json` and fill in each camera's address. For the Tapo C260:
1. Tapo app → camera → Settings → Advanced Settings → **Camera Account**: set a username and password.
2. The IP address is in the app under Device Info.
3. `main` is `stream1` (full 4K, which is recorded), `preview` is `stream2` (small, shown live).

Recording keeps the camera's own video untouched, in 10-minute chunks. If a camera drops out it reconnects on its own, and a marker shows where. Needs `ffmpeg` (`brew install ffmpeg`).

## Controls

- **Hold to talk** (or hold `1`–`4`): speak to one phone. `space` speaks to everyone. This cuts the AI off; the AI knows what you said and carries on after you stop.
- **AI directing — on / off**, **Next direction**, **Private note to the AI** (it puts your note in its own words).
- **Mark** (`M`): drops a labelled marker on the edit timeline, e.g. "door opens".
- **AI brief**: who the AI is and how it directs. Saved to `brief.txt`, with a copy in each session.

## What a session folder contains

```
recordings/2026-11-05-14-03-12/
  session.json        start time (to the millisecond), participants, cameras, files
  transcript.txt      who said what, when, including your private notes to the AI
  events.jsonl        everything that happened, timed
  audio/              director-mic.wav, phoneN-mic.wav (what they said),
                      phoneN-ai.wav (the AI voice), phoneN-heard.wav (everything in their ear)
  video/<camera>/     .mp4 per 10-minute chunk
  exports/
    timeline.fcpxml   every audio track and camera clip lined up, with markers
    markers.csv       directions, notes, interruptions, dropouts, your marks
    phoneN.srt        subtitles per phone
```

All audio tracks start at the session start. Camera clips are placed by when they started recording, to within about a second. For frame-accurate sync, clap once in view of the camera near a phone at the start, or let Resolve's "auto sync audio" line up the camera's sound with the phone mics.

**In Resolve:** File → Import → Timeline → `timeline.fcpxml`. **In Premiere:** File → Import → `timeline.fcpxml`.

## Settings (.env)

```
OPENAI_API_KEY=...                         required
OPENAI_TEXT_MODEL=gpt-4o-mini              the AI's mind; try gpt-4.1 for better direction
AI_IDLE_SECS=20                            silence before the AI moves on
AI_MODE=auto                               or off = AI starts silent
PUBLIC_URL=https://earpiece.edfornieles.com
MAX_PHONES=4
```
