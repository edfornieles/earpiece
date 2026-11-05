# Mother Programs — proposed behaviour

A mostly scripted performance with freedom for Mother to adapt; either independent participant progress or a shared timeline. After a controller intervention, Mother decides when to return to the score. The controller can always pause, resume, skip, repeat, or take over. This is a proposal, not an implemented playback engine.

## Page and workflow

Add Programs to the Workspace navigation. A program has a title, description, ordered cue list, version, voice settings, and a rehearsal preview. Select a cue to edit its script, delivery, timing, adaptation rules, and exit condition. The live desk shows each participant's program, current cue, elapsed time, next cue, and whether Mother is following the score, listening, conversing, returning, or waiting for the desk.

A readable example:

1. SAY: Walk towards the far wall. Take your time.
2. SILENCE: 8 seconds after the spoken audio actually ends.
3. SAY, hesitant delivery: I wonder… perhaps stop here for a moment.
4. REPLY: What catches your attention? Wait for a reply; allow 30 seconds before a fallback question.
5. CONVERSATION: Respond to their observation. Keep it brief, remain in this area, and return to cue 6 once the exchange reaches a natural pause. Maximum two exchanges, then return or flag the desk.
6. SAY: Turn back towards the centre of the room.

Hesitation has three distinct controls: an exact silent duration, a delivery instruction within a spoken line, and a responsive wait for a participant or controller. Synthesized delivery needs auditioning; use a recorded or pre-rendered clip when the precise sound and timing matter. Do not treat punctuation alone as a reliable timing instruction.

## Adaptation and interruptions

Each passage has required content, permissible variations, optional additions, and an exit condition. Mother may rephrase within those boundaries; critical phrases and fixed audio cues remain exact. Participant replies can trigger a brief response or a designated conversation section.

Controller speech interrupts the current voice and suspends progression. On release, Mother receives the controller's transcribed intervention and the saved cue position. It may respond, wait for the participant, or propose a return. A bounded decision chooses the next valid cue; the server validates it. The controller sees the reason and can override it. Use maximum conversation turns/time and an explicit fallback so the agent cannot drift indefinitely. A failed decision pauses and flags the desk rather than skipping material silently.

For speech interrupted mid-line, keep the interrupted cue and distinguish rendered audio from audio actually delivered. Initially resume at a sentence boundary or replay the cue with desk control. Exact sample-level resume is appropriate for fixed audio clips, while generated adaptive speech needs a semantic handoff.

## Timing modes

Independent mode maintains one playhead per participant. Shared mode follows a server clock with explicit synchronization points. Decide cue behaviour when a participant is still in conversation at a synchronization point: catch up, wait, or ask the desk. Never silently stall everyone or replay missed cues in a burst. Shared cues do not require sharing participant microphone audio.

## Implementation

Run cue execution on the server, not in an open browser tab. Persist program versions separately from the session; each run records its version, participant visit token, cue transitions, delivered text/audio, interruptions, and timing. Pre-render fixed passages and cache them; generate adapted passages and conversational replies as needed.

Give the program executor, conversational agent, and live controller one explicit audio owner at a time. Entering a program suspends the existing automatic idle/nudge loop; ending or pausing it has an explicit transition. Advance after playback completes, not when speech generation completes. Cancel stale generation and timers on visit end, slot replacement, program changes, or disconnect, using the existing visit token plus a run token.

Preserve current isolation: participant microphone returns only to desk/recording and that participant's agent. Program sync shares cue timing, never microphone audio. Phone disconnects, missing headsets, or ambiguous state should pause affected delivery and surface it at the desk.

Build in stages: cue editor with fixed speech, recorded audio, silence and rehearsal; individual execution with operator controls; bounded conversations and agent-managed return; shared-clock synchronization. Validate interruptions and reconnects before real participant runs.
