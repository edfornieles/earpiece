# Performance film: format and edit system

One film per performance (one session folder → one film). Agreed with Ed, 25 Nov 2026. Not built yet.

## Structure

1. **The score** (opening screens)
   - Date, start and end time (`session.json`).
   - Who was in the control booth (desk joins in the session's log).
   - Participants' names, only where their release allows; otherwise "Participant 1", etc.
   - The instructions: every line Mother or the director gave each participant, in order, with its time
     (**the score as performed**). When the performance ran from a written Program, show the written score
     beside it.
   - Look: plain typographic title cards, one instruction per line with its time, scrolling.

2. **The footage**
   - The performance in time order; each participant's visit is a chapter, room moments link them.
   - Picture: mostly the four Tapo cameras, cutting to the one that holds whoever is speaking or acting
     (tracking proposes, comments overrule).
   - Sound moves between three layers:
     - inside the earpiece (Mother and the director, clean per phone),
     - the participant (their phone mic),
     - the room (F4 room mics and `room-speaker.wav`).
   - Earpiece speech is always captioned, styled apart from room speech.

3. **The debrief** (optional)
   - Audio only, over the participants' portraits on black: a 3D carousel. Reference: "Debrief, Full [cell]" (2019).
   - The face at the front is large and sharp, with large faces either side; the rest are smaller and blurred
     going round the back, tucked behind and between.
   - **The carousel turns to bring whoever is talking to the front, then holds while they speak.** Speaker changes
     come from the debrief recordings' timings.
   - Title in plain white uppercase, top-left: `DEBRIEF: <DATE>, <TIME OF DAY>`.
   - No debriefs recorded: this part is left out and the film ends on a closing card (date, credits).
   - Some people debriefed: everyone who took part stays on the ring; it only turns to those who speak.

## Portraits

- Each person keeps their **registration photo** (part of their signed consent; used for face recognition).
- The studio can add a better **portrait** on the People page (Add portrait). Mother records who added it and when.
- The film uses the portrait when there is one, otherwise the registration photo.
- Portraits are cropped automatically to a straight-on, face-centred square so the carousel lines up; the crop
  can be nudged.
- Portraits are also added to face recognition as an extra reference (the registration photo is never replaced).
- Consent: `consent.md` needs a line covering "any portrait you later provide to the studio".

## Edit system

The raw session is never changed. Each film is a folder of versions inside the session:

```
recordings/<session>/edits/performance-film/
    v1/  score.json · cut.json · debrief.json · preview.mp4 · notes.md
    v2/  … · changes.md        (each comment, what changed, or why not)
    comments.json              (all comments, pinned to version + timecode, open / resolved)
```

- `score.json`, `cut.json`, `debrief.json` are the edit as text: clips with session-clock in and out times, camera,
  audio layers, captions, and a one-line reason for each. Readable like a script; written and revised by Claude.
- `preview.mp4` joins all three parts with captions, for watching and commenting.
- Comments are pinned to a version and a timecode, plus general notes. Each stays open until it's answered in
  the next version's `changes.md`.
- Draft 1 is long (keeps everything meaningful); comments tighten it.
- The final version exports as a DaVinci Resolve timeline (`.fcpxml`) for colour, sound and titles.
- House rules that don't change between performances live in `EDIT_STYLE.md` and are read before every cut.

## Still open

- Who comments: Ed only, or Carlos and others too, possibly remotely (decides where the review page lives).
- Where the final polish happens: Resolve, or the final preview render.
- Check that the catalogue and Resolve export include `room-speaker.wav`.
