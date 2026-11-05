# Mother

Mother is a performance direction and recording system for a gallery. Participants wear an earpiece and microphone; dedicated phones remain at the control centre. A human controller, an AI director, or a prepared multi-role score directs each participant.

Participant microphone audio returns to the desk, recording and that participant's agent. It is never relayed to another participant's earpiece. The controller can deliberately address one phone or everyone.

## Start here

- [Server and operator guide](server/README.md): installation, phones, the Studio desk, recording, cameras and exports.
- [Programs guide](server/docs/programs.md): AI script drafting, role tracks, scene coordination and running a score.
- [Android guide](android/README.md): installing, configuring and updating the dedicated phone app.

From a fresh checkout, use Node.js 22 or newer:

```sh
cd server
npm install
npm start
```

Configure the server's OpenAI key and local Pocket-TTS service as described in the server guide. The server prints the operator and phone links and starts in standby. Local keys, phone settings, scripts, recordings and registrations are not committed to Git.

## Write, prepare, perform

1. In **Programs**, describe what you want to achieve and how. Choose a role count and approximate duration, then **Generate first draft**.
2. Edit the generated scenes, role instructions, speech, pauses and conversations. **Save program** adds it to your library; generation alone does not save it.
3. In **Session**, select the program, choose shared or independent timing, assign a different phone to each role, then **Save program choice**. The session keeps a copy of that version.
4. At **Live desk**, assign participants, **Start session** to record, start their visits, and **Start program** when everyone is ready. Recording and score playback are separate actions.
5. Use live talk, global pause/resume/stop, and individual repeat/continue controls during the performance. **End session** saves the recording and returns to standby.

You can also select **No program — free direction** and work from the AI brief and live controls. Phones are added on **Phones**, camera displays on **Screens**, and completed recordings appear in **Library** and **Files**.

## Development

```sh
cd server
npm test
```

Tests use disposable server copies, mock speech and isolated recordings. See the operator guide for what still requires hardware rehearsal. Android CI builds when Android source or its workflow changes; the artifact remains named `earpiece-apk`. Existing domains and the Android package identity retain their original `earpiece` names for compatibility.
