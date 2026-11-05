# Earpiece

A command system for the gallery. Dedicated phones with earphones connect to a control room on this Mac. An AI director (OpenAI listening and thinking, the Watercooler voice speaking) directs each participant, and you can cut in at any time. Cameras are shown live and recorded. Every session becomes one folder, ready to edit.

## Run a session

```
cd ~/Downloads/earpiece
npm start
```

- **Control room** opens in the browser (the link stays the same every time, so bookmark it). Headphones on, click **Start control room**.
- It starts in **standby**: nothing is recorded. Prepare the next session — name, notes, documents, people, arrivals. Cameras show live and phones can connect.
- **● Start session** starts recording, taking over everything you prepared.
- **End session** stops recording, saves and exports, and goes back to standby for the next one.
- **Library** and **Files**: the links in the top right.
- `Ctrl+C` stops everything (if a session is recording it's saved first — wait for "saved:").
- `START_RECORDING=1 npm start` skips standby.

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

**Testing without the Tapos:** use this Mac's own camera. Put this in `cameras.json`:

```json
[ { "name": "Mac camera", "main": "mac" } ]
```

The first time, macOS asks whether Terminal may use the camera — say yes (System Settings → Privacy & Security → Camera if you missed it). `"main": "mac:1"` picks a second camera; `"main": "test"` is a generated test picture. Mix them freely with Tapos.

## Room microphones

Copy `roommics.example.json` to `roommics.json`:

```json
{ "device": "default", "channels": 1, "names": ["Mac mic"] }
```

- `device`: `default` is the Mac's built-in mic (fine for testing). For an interface such as the Zoom F4 over USB, run `npm run devices`, find it under *audio devices*, and put its name, e.g. `"ZOOM F4"`.
- `channels` and `names`: one name per input, e.g. `["Window", "Bench", "Door", "Centre"]`. Each becomes its own file.

Levels show under the cameras in the control room. Recording is 48 kHz 24-bit. macOS asks for microphone access the first time.

## Welcome station and registration

A separate computer in its own space plays the intro film next to a QR code. People scan it with their own phone and register: name, email, confirm they're 18+, take a photo, read and sign the consent form (typed name), and optionally agree to face matching. They get a number to show at the desk.

1. Save the film as `intro.mp4` (or `.mov`) in this folder.
2. Write the consent form: copy `consent.example.md` to `consent.md` and edit it — fill in the [brackets] and have it checked. Each registration stores the exact text that person agreed to.
3. On the welcome computer open **Registrations → Welcome screen** (or `/welcome?k=<screen key>`), click Start: full screen, with sound. Add `&video=0` for a QR-only screen.
4. For people on mobile data the code must point at the public address, so start with `PUBLIC_URL=https://earpiece.edfornieles.com npm start`.

New registrations appear in the control room under **Arrivals** (with a chime): check their photo against the person, pick a phone, **Start on phone**. Their photo and signed consent are copied into the session folder.

**Registrations** (`/people`) lists everyone who has registered. To connect someone to a session by hand — they didn't agree to face matching, matching missed them, or they started on a phone without registering — open their card, **Connect to a session…**, pick the session and either the phone visit that was them or "they were there". Names, exports and the catalogue update.

Registrations are kept in `participants/` (personal data — never share or commit that folder).

### Face matching

For people who ticked the face-matching box, the catalogue looks for their face in the camera footage during their visit (± 30 s), every 2 seconds, and records which camera they're on when. Results: `catalogue/appearances.json`, `catalogue/faces.jsonl`, the best crops per person in `catalogue/faces/` to check, and a "Who is on which camera" section in the edit notes. Faces of anyone else are compared and discarded — nothing about them is kept. It runs on this Mac only.

One-time setup: `npm run setup-faces` (needs Python 3: `brew install python` if it's missing). Matching is automatic and can be wrong — the crops are there so you can check.

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
                      room-<name>.wav (one per room mic)
  video/<camera>/     .mp4 per 10-minute chunk
  catalogue/          built in the background after the session (see below)
  exports/
    timeline.fcpxml   every audio track and camera clip lined up, with markers
    markers.csv       directions, notes, interruptions, dropouts, your marks
    phoneN.srt        subtitles per phone
```

All audio tracks start at the session start. Camera clips are placed by when they started recording, to within about a second. For frame-accurate sync, clap once in view of the camera near a phone at the start, or let Resolve's "auto sync audio" line up the camera's sound with the phone mics.

**In Resolve:** File → Import → Timeline → `timeline.fcpxml`. **In Premiere:** File → Import → `timeline.fcpxml`.

### The catalogue

When a session ends, the catalogue builds itself in the background (the library shows progress, and you can rebuild it there). It's laid out so a person — or an AI editor — can find any moment fast:

```
catalogue/
  EDIT_NOTES.md       start here: participants, every file, the whole script with timecodes, marks
  utterances.jsonl    one line per thing said: speaker, words, start/end, word-by-word timings,
                      voice/emotion/pitch/speed, the file and position, which cameras and room mics were rolling
  manifest.json       every file with its kind, start on the session clock and real-world time
  mixes/phoneN-conversation.wav   participant on the left, what they heard on the right
  proxies/<camera>/   light 720p copies for scrubbing
  thumbs/<camera>/    a still every 10 s, named by session time (00h12m30s.jpg)
  sheets/<camera>/    contact sheets: each row is one minute
```

Word timings use OpenAI Whisper (a few pence per hour of speech). Build it again for an old session with `node catalogue.js recordings/<session>`.

## Settings (.env)

```
OPENAI_API_KEY=...                         required
OPENAI_TEXT_MODEL=gpt-4o-mini              the AI's mind; try gpt-4.1 for better direction
AI_IDLE_SECS=20                            silence before the AI moves on
AI_MODE=auto                               or off = AI starts silent
PUBLIC_URL=https://earpiece.edfornieles.com
MAX_PHONES=4
```
