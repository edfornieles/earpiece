# Programs in Mother

## Prepare before recording

1. Open **Programs**. Describe the performance in “Let Mother write the first draft”, choose a role count and approximate duration, and press **Generate first draft**. Edit the generated scenes and role tracks, then save the program. A blank program and the four-role example are also available.
2. Open **Session → Performance program**. Choose a saved program, shared or independent timing, and one distinct phone per role. Press **Save program choice**.
3. Assign participants to the matching phones from the live desk. Add more permanent slots on Phones if required.
4. Press **Start session** to begin recording. The chosen program version and role assignments carry into that recording. Start each assigned participant visit at the desk and check its earpiece and audio readiness.
5. Press **Start program** in the live desk. Playback starts at scene one for all assigned roles. Starting recording does not automatically start the score.

“No program — free direction” preserves the existing AI brief and live direction workflow. You can choose or clear a program only in standby. Saving the choice copies the complete score into the session. Later library edits cannot silently change it. Load the latest version and save the choice again to adopt changes before recording.

## Writing the score

Each program has an overall brief, named roles with private instructions, and ordered scenes. Every scene has a separate cue track for each role. Add and reorder cues and scenes.

- **Speech**: exact written text, or an adaptable passage if “Mother may adapt” is enabled. Role and overall instructions constrain adaptation.
- **Silence**: a timed pause after preceding audio finishes playing. Use this for exact hesitations between passages.
- **Wait for desk**: hold until the controller presses Continue cue. Use this for actions or physical readiness the system cannot verify.
- **Question + reply**: speak a question and continue when that role replies.
- **Conversation**: speak an opening question, respond within its instructions for the specified number of exchanges, then continue. A timeout asks for desk attention rather than silently skipping.
- **Wait for role**: wait for a specific cue, or another role's end of the same scene. Circular dependencies are rejected when saving.

In **shared timing**, scenes marked “wait for all roles” hold their roles at the end until all arrive. Scenes without that barrier can overlap. **Independent timing** ignores scene barriers; explicit cross-role dependencies still apply. This version coordinates completed cues and scenes; it is not a sample-accurate common timecode sequencer.

Preview written lines at the desk before performance. Delivery instructions inform adapted and conversational text. Exact speech preserves the written text; punctuation and expressive TTS are not guaranteed to produce an exact hesitation within a sentence. Uploaded prerecorded clips are not yet supported by Programs.

## During performance

The live desk shows the selected version and each role's scene, current passage and state. Pause all roles, resume, stop, repeat/resume a role's cue, or continue past a cue. Repeating or resuming interrupted speech starts that cue again from its beginning. Stopping and starting a program restarts the whole score.

The program owns direction on its assigned phones, suppressing the ordinary automatic idle/next-direction loop. Unassigned phones retain normal live direction. Typed speech, private instructions and AI mode overrides pause the affected role; use its program controls to return to the score.

A live microphone intervention or participant speech interruption holds that role. After transcription, Mother chooses to return, wait for a reply, or speak a short response and await a reply. Conversations after interruption are bounded to two exchanges before returning. Its decision is shown at the desk. A failed/ambiguous decision or unanswered reply leaves a visible hold requiring desk action. You can override the decision with Continue cue or Repeat/resume cue.

A headset loss, phone disconnection, ended visit or new participant invalidates current work. Reconnection never silently resumes the score. Check the equipment and explicitly resume; if the participant changed, stop and restart the program. A server restart restores the selected score but does not automatically resume a run.

## Recording and isolation

The recording stores the full chosen program version and role assignments in session.json. Cue starts/ends, shared scene transitions, holds and completion are logged on the session timeline; delivered speech is included in the existing transcript and audio recordings. Edits and scripts are stored locally under server/programs, ignored by Git.

Role coordination exchanges cue state only. Participant microphones remain private to their own agent, desk monitoring and recording; they are never forwarded to another participant.

## Generating a first draft

Give Mother a broad description of the desired effect, how people should move or interact, tone, pace, hesitations, and any constraints. The writer uses the existing server OpenAI key and `OPENAI_PROGRAM_MODEL` (falling back to `OPENAI_TEXT_MODEL`, then the existing gpt-4o-mini default). Its structured-output request has a separate 14,000-token writing budget; the live director retains its short-response configuration. The output is validated against role, scene, cue and dependency rules, with one repair attempt for invalid scores. API format follows the [official OpenAI structured output documentation](https://developers.openai.com/api/docs/guides/structured-outputs).

Generation supports 1–16 roles and an approximate duration of 1–120 minutes. The editor still supports up to 32 manually authored roles. The output is an editable, unsaved program with no ID or revision. It does not change a saved program, selected session, recording or phone playback. If an editor draft is already open, the generated result waits until you explicitly open it; unsaved edits require a discard confirmation. The description is retained in this browser tab's session storage, and remains available after failure or cancellation. Cancel stops the request; one draft is generated at a time on the server.

The duration is a creative target, not a guaranteed running time. Questions, conversations and readiness holds can change the length. Review generated physical actions and cue timing during rehearsal.
