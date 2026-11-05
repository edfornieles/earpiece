# Mother

Mother directs and records a gallery performance. Dedicated phones remain at the control centre; participants wear only their earpieces and microphones. The Studio interface combines live human direction, a private AI director per phone, and prepared scores with multiple roles. Cameras, room microphones and phone conversations can be recorded together.

## Install and start

Use Node.js 22 or newer. From this repository:

```sh
cd server
npm install
npm start
```

The existing performance installation is a standalone copy at `~/Downloads/earpiece`; run `npm start` there when using that installation. Keep its `.env`, keys, settings, programs, registrations and recordings in place when updating source files. Copying a checkout does not copy that runtime data automatically.

Set `OPENAI_API_KEY` in `.env` for transcription, direction and script writing. Run the local Pocket-TTS service at `http://localhost:8123`, or configure `POCKET_TTS_URL`. Speech generation and voice previews require that service. Camera and room microphone recording require `ffmpeg` (`brew install ffmpeg` on macOS).

The server prints its operator and phone links. The live desk connects immediately when opened; there is no **Start control room** gate. Use **Enable sound** to monitor phone returns and **Enable microphone** to allow live talk. Denying desk microphone permission does not block the desk or listening. Wear headphones at the desk to avoid feedback.

## Prepare and record

- The server starts in **standby**: nothing is recorded. Prepare the session title, notes, documents, participants and optional score. Cameras can show live and phones can connect.
- **Start session** starts recording and adopts the prepared details, people, documents and selected program version.
- Start each participant's visit from the desk. A connected phone alone does not start a visit or open its participant microphone feed.
- If using a score, press **Start program** separately after its assigned visits and earpieces are ready. This lets you record the lead-in.
- **End session** stops recording, saves and exports, and returns to standby.
- `Ctrl+C` stops the server; during recording it saves first. Wait for the saved message before closing the terminal.
- `START_RECORDING=1 npm start` skips standby; ordinarily prepare the session before starting recording.

The sidebar groups the operator pages: **Workspace** (Live desk, Session, Programs), **People** (Registrations), **Equipment** (Phones, Screens), and **Archive** (Library, Files, Trash). Group headings have distinct accents in both light and dark themes. On smaller screens navigation moves above the page.

## Let Mother write the first script

Open **Programs → Let Mother write the first draft**. Describe the desired experience, how it develops, movement, relationships between people, tone, pauses, and constraints. Choose **1–16 roles** and an approximate duration, then **Generate first draft**.

Mother creates named roles and an ordered score of scenes and cue tracks. The result opens as an **unsaved, editable draft**. Edit the title, overall brief, private role instructions, scene order and individual cues, then press **Save program**. If you already have a program open, generation waits for you to choose whether to open its result; it does not replace ongoing edits automatically. Cancelling or a failed request preserves your description and editor draft.

Generation uses the configured OpenAI key and a separate long-form writing request. It does not change the live director's short replies, save a program automatically, change the selected session, start recording or send speech to phones. Treat the requested minutes as a creative target: conversations and manual readiness holds affect the actual duration.

## Choose a score before recording

In **Session → Performance program**, select a saved program, set **shared scenes** or **independent** timing, assign a distinct phone to every role, and press **Save program choice**. Add more permanent phone slots on Phones if needed. Choose **No program — free direction** to use the ordinary AI brief and live controls instead.

The selected script is copied into the prepared session, with its version and assignments, and carries into the recording. Later library edits cannot silently change it. Before recording, load the latest version and save the choice again to adopt an edit. The program choice and assignments are locked while recording.

Each role has its own position in the score. In shared timing, marked scene boundaries wait for every role; independent timing allows separate progress. Explicit cross-role dependencies work in either mode. Cues support speech, timed silence, desk confirmation, questions, bounded conversations, and waiting for another role's cue. Shared timing coordinates cues and scenes; it is not sample-accurate common timecode. Prerecorded clip uploads are not yet supported by Programs.

During live intervention, the affected role is held while the controller speaks. After transcription, Mother can return to the score, wait for a reply, or give a bounded conversational response. Its state and reason appear on the desk. Failed decisions and reply timeouts ask for desk attention. You can always override with repeat/resume or continue. Resuming interrupted speech repeats the current cue from its beginning; stopping and starting the whole program begins at scene one. Reconnecting equipment never silently resumes a paused score, and a changed participant requires stopping and restarting it.

See [Programs: authoring, runtime controls and limitations](docs/programs.md) for full details. The editor supports up to 32 manually authored roles; first-draft generation currently supports up to 16.

## Phones

Open **Phones** under Equipment in the sidebar. Each phone has a permanent numbered slot and connection link. Choose a slot to scan its QR code, or click **Add phone** to create another slot. You can use more than four phones; new slots appear in the control room immediately and are saved across server restarts. The Phones page shows whether each phone is connected and has enabled audio.

First-time setup for a dedicated Android phone, plugged in over USB:
```
brew install android-platform-tools     # once
./phone-setup.sh 1                      # 1 = the slot for this phone
```
This keeps the screen on while charging, turns on Do Not Disturb, and installs and opens the bundled Android app. If no APK is available it opens the browser version instead. For Android setup, scan the slot QR code and choose **Open Mother app**, or **Install Mother for Android** if needed. Merely opening that setup URL does not take the slot away from an existing native connection. For browser-only use, choose **Enable browser audio**, allow microphone access, and keep the browser page active. Opening an actual second endpoint for the same slot replaces the previous one.

Keep the phones in the control centre; participants wear only their earpieces. Enable audio on each phone during setup (the browser may need a tap to allow microphone access and playback). From the desk, use **Start on phone** in Arrivals or start someone from their person card. When they're done, click **End participant → ready for next**. The desk starts and ends each visit; the microphone feed is muted between visits and resumes automatically for the next visit on an already prepared phone.

Participant microphone audio goes only to the control desk and that phone's recording, never to another participant. The director can talk to one selected phone, or explicitly to everyone; each AI voice goes only to its assigned phone. Losing the desk connection or moving away from its browser window releases push-to-talk.

Pair the intended earpiece and verify that both playback and microphone use it, away from the phone. Test Bluetooth range and whether headsets reconnect or switch to another nearby device. A connected phone or an enabled audio service is not proof that its earpiece microphone is in use. The desk flags a reported missing earpiece; known native routing and Android-version limitations are recorded in the [Android review](docs/android-app-review.md).

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

**Registrations** (`/people`) lists everyone who has registered. To connect someone to a session by hand — they didn't agree to face matching, matching missed them, or they were added as a walk-in — open their card, **Connect to a session…**, pick the session and either the phone visit that was them or "they were there". Names, exports and the catalogue update.

Registrations are kept in `participants/` (personal data — never share or commit that folder).

### Face matching

For people who ticked the face-matching box, the catalogue looks for their face in the camera footage during their visit (± 30 s), every 2 seconds, and records which camera they're on when. Results: `catalogue/appearances.json`, `catalogue/faces.jsonl`, the best crops per person in `catalogue/faces/` to check, and a "Who is on which camera" section in the edit notes. Faces of anyone else are compared and discarded — nothing about them is kept. It runs on this Mac only.

One-time setup: `npm run setup-faces` (needs Python 3: `brew install python` if it's missing). Matching is automatic and can be wrong — the crops are there so you can check.

## Live desk controls

- Select a phone in the participant list to see its controls, status and transcript. The list scales beyond four phones.
- **Hold to talk**, or hold number keys **1–9**, addresses the matching phone. Hold **Space** to address everyone; **L** latches talk-to-all. Higher numbered phones use their on-screen controls. Enable the desk microphone first. Losing focus or the connection releases talk.
- **My own voice** sends the controller's voice directly; **As the AI voice** transcribes it and speaks it in the selected voice after release.
- Unassigned phones use **AI directing — on / off**, **Next direction**, typed speech, and private AI instructions. A selected program owns direction on its assigned phones, suppressing the ordinary idle/nudge loop; their advance button becomes **Continue program cue**. Typed speech or private overrides hold an affected program role for desk recovery.
- The program panel shows each role's scene, current passage, state and any hold reason. It provides **Start program**, **Pause all roles**, **Resume program**, **Stop program**, and per-role repeat/resume or continue.
- **Mark** (`M`) drops a labelled marker on the recording timeline.
- **Session** contains the program selection, AI brief, title, notes and documents. Brief edits are saved to `brief.txt`, with a copy in the session; they do not interrupt speech already playing.
- **Screens** opens camera monitor windows and provides display links for other devices.

## Local data and updates

- `.env`, `.keys.json`, `.settings.json`: service credentials, stable access links, voice choices and phone slot count.
- `programs/`: saved private scores and versions. These are separate from recordings and ignored by Git.
- `recordings/_next/`: standby preparation, including the copied program and assignments.
- `recordings/<timestamp>/`: completed or current recording, including its immutable score copy, transcripts and cue events.
- `participants/`: registration details, consent forms and photos; keep these private.

Back up these separately from source control. Do not replace them when updating the application. Android signing material also remains outside the checkout.

## What a session folder contains

```
recordings/2026-11-05-14-03-12/
  session.json        start time, participants, cameras, files, selected program version and role assignments
  transcript.txt      who said what, when, including your private notes to the AI
  events.jsonl        timed events, including program cues, holds and scene transitions
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

Word timings use OpenAI transcription; API usage is charged to the configured account. Build it again for an old session with `node catalogue.js recordings/<session>`.

## Settings (.env)

```dotenv
OPENAI_API_KEY=...                         # required for AI features; keep private
OPENAI_TEXT_MODEL=gpt-4o-mini              # existing live-direction default
OPENAI_PROGRAM_MODEL=gpt-4o-mini           # optional writer override; defaults to text model
OPENAI_TRANSCRIBE_MODEL=gpt-4o-mini-transcribe
POCKET_TTS_URL=http://localhost:8123        # local speech service
AI_IDLE_SECS=20                            # free direction only; programs own their pacing
AI_MODE=auto                               # off starts free-direction phones silently
PUBLIC_URL=https://earpiece.edfornieles.com
PORT=8080                                 # set 8787 for the existing local installation
MAX_PHONES=4                              # initial slots; add more on Phones
```

If a network-dependent feature drops out, check the phone Wi-Fi, public connection, OpenAI response and local TTS service separately. Heavy streaming applications can interfere with a performance network; isolate and rehearse the actual setup before use.

## Verification

```sh
npm test
```

The automated suite uses disposable copies, mock speech and isolated recordings. It covers phone audio isolation, active visits, talk ownership, stale transcription, program version adoption, cue progression, dependencies, interruptions, draft validation/repair, cancellation and protection of existing edits. Real OpenAI script generation has also been checked in the browser. Full multi-phone audio routing, adaptive conversation quality and headset walking range still require hardware rehearsal.
