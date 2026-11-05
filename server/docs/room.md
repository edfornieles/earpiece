# Room — studio/gallery vision trial

## Start with the studio camera

1. Open **Room** in Workspace. Select **Mac camera**, or another configured camera. Cameras use the existing `cameras.json` pipeline; a local camera uses `"main":"mac"`, a network camera uses its configured stream. See the server README for camera setup.
2. Press **Analyse once**. Optionally ask a question such as “What objects are visible?” The camera frame is sent to the configured OpenAI vision service. Analysis is independent of recording and does not play audio or move a program forward.
3. Select **Analysed frame** to inspect the exact captured image, approximate object/person regions, description, uncertainty, capture time and processing delay. **Live view** remains the live feed and deliberately has no AI overlays: observations belong to their captured frame.
4. Choose **Name & keep** on a suggested object. Correct its name, description and permitted use, then **Confirm & save**. Or draw a rectangle around an object in the analysed frame and name it yourself. Use **Edit → Redraw this region on the image** to correct an existing landmark. Reviewed green regions are preserved when the model matches that landmark later; blue regions remain unverified model estimates.
5. Use **Start observing** for repeated analyses. The minimum gap can be 5–120 seconds (UI presets cover 5–60); a request must finish before the next starts. Actual update speed depends on analysis latency. Press **Stop** when finished. Observation also stops after a service failure, room metadata edit or server restart. The sidebar displays “Vision on” while continuous observation is enabled, including on other pages.

Continuous mode continues when browsing another page; it is not a video-rate tracker. It never starts automatically on server restart. Images are sent only when an observation is requested or continuous mode is enabled. Frames are held in memory (the last three analysed frames); room metadata persists separately. Any normal session camera recording is controlled by Start session/End session, as before.

## Room inventory

Give the room a name and useful context. AI object suggestions are unconfirmed. Only names and regions the operator explicitly saves enter the reviewed inventory. Each object has a stable ID, camera ID, approximate normalized image region, description and permitted-use notes. These are camera-image regions, not physical distances or a calibrated floor plan. Re-map them if the camera position or scene changes. A model match to an inventory item is still a visual estimate.

The local `.room.json` file is private, ignored by Git, and should be included in runtime backups. It stores room setup and reviewed objects, not images or person matches. Simultaneous metadata edits use a revision check so an older form cannot silently replace another operator's changes. Editing metadata stops in-flight and continuous observation.

## People and roles

People are described anonymously, without face recognition or emotion/identity inference. The operator can associate a person in the current analysed frame with a phone/role. This confirmation is limited to that observation and expires when a new observation arrives; confirmations on frames over a minute old are rejected. Role labels can come from the program already selected in Session.

This first version does **not** maintain identities as people walk, pass behind objects, or move between cameras. Dedicated tracking, cross-camera association and room calibration remain future work. Never treat a frame label as continuous tracking.

## Optional context for direction agents

“Let directors use reviewed landmarks and fresh observations” is off by default. When enabled, the server adds descriptive room context to ordinary AI direction and adaptive program speech/conversation. Exact script lines remain exact. Visual information does not automatically advance cues or satisfy dependencies.

Only observations captured within the last 30 seconds enter director context. Older results remain visible at the desk with their age but are excluded from the agent's current view. Reviewed static inventory remains available. Context includes up to 24 reviewed landmarks, with an omitted-item count if more exist; object-use rules are preserved. In-frame phone matches are explicitly marked as frame-specific. Agents are instructed to ask for confirmation rather than infer precise distances, identity or physical readiness.

## Configuration and validation

`OPENAI_VISION_MODEL` overrides the vision model; otherwise it uses `OPENAI_TEXT_MODEL`, then the existing `gpt-4o-mini` default. It uses the server's `OPENAI_API_KEY`, structured outputs and a 60-second request timeout. There is one observation request at a time, with no frame backlog. Each request captures a fresh JPEG from the existing camera preview. Stopped or superseded work cannot publish a later result.

Desk-only APIs protect room metadata and analysed snapshots. Monitor and phone keys cannot access them. During recording, observation summaries and capture/analysis timestamps enter the event log; snapshots and confirmed phone/person matches are not persisted by the observer. Geometry, clocks, stale-frame handling, cancellation, metadata revisions, private access and opt-in context are regression tested. The room trial needs practical camera-placement and movement rehearsal before being used to make performance decisions.

## First studio trial

The built-in Mac camera successfully produced live scene descriptions and object suggestions, including artwork on the studio wall. Two analyses took approximately 7–8 seconds each in that trial, before the configured gap between requests; this is near-live sampling, not video-rate understanding. Continuous observation and stopping were checked. A reviewed “Drawing of two figures” landmark survived a server restart and was recognised in a later frame. Its automatic region needed manual correction; the drawing and redraw workflow was verified in the browser, and the correction is preserved. No people were visible in those test frames, so real moving-person association has not been verified. The trial ended with continuous observation stopped and director sharing off.
