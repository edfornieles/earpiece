# Earpiece

A live direction system for participatory work: participants wear an earpiece; a director — human, AI, or both — speaks to them from a control room, while everything is recorded and catalogued for editing.

- `server/` — the control room (Node): phones, AI director (OpenAI + Pocket-TTS voice), cameras, recording, library, edit exports. See `server/README.md`.
- `android/` — the dedicated-phone app. Built automatically by GitHub Actions on every push (Actions → latest run → `earpiece-apk`).
