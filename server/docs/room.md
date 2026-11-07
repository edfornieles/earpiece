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

## Measured base geometry

**Measured floor plan** stores the room's width, depth and ceiling height in metres separately from camera boxes. Its origin is the upper-left corner of the supplied plan, with x to the right, y down the plan and z up from the floor. Doors can have a known width and wall with an unknown exact offset. This is a static plan; it does not establish navigable routes, infer contents or calibrate the camera. Save dimension changes with **Save room setup**. The plan is included as descriptive context during room analysis and in the existing opt-in director context.

## Manual studio marker test

Open **Room → Studio marker test**. The marker labelled **You** starts at a preset test position. Click the floor or focus the map and use the arrow keys to move it in 10 cm steps. **Mark out of sight** keeps its last position visible with a dashed outline; moving it again restores visibility. Measured door openings and furniture footprints appear on the plan. Dashed footprints have an estimated outline or placement. These outlines are rehearsal references; the manual marker can cross them and does not establish a clear walking route.

**Download test log** exports timestamped manual placements and out-of-sight events in metres using the floor plan's coordinate system. The log is local to the page, starts empty and resets on reload or a change to the saved geometry. It is a rehearsal fixture, not a camera observation or an input to director cues.

## Live tracking and floor calibration

**Room → Live tracking** follows people in the live picture between the slower AI observations.

- **Detection runs in the browser.** A person detector (TensorFlow.js COCO-SSD, loaded from jsDelivr the first time, so the Mac needs internet once) looks at the live picture about five times a second. Pictures stay on this computer; only person boxes go to the server. There is no face recognition: tracks are anonymous IDs (T1, T2…) until the desk says who someone is.
- **One screen tracks at a time.** A second Room page shows the same people but cannot start its own tracker while the first is running.
- **Calibrate camera to floor.** Click a spot on the floor in the live picture, then the same spot on the plan, at least four times, spread across the visible floor. Points must be on the floor itself (a rug corner, the foot of a table leg, a door edge), never a table top. Clicks near a footprint corner, room corner or door edge snap to it. A fifth point measures accuracy: the saved calibration reports its average and worst error in centimetres. **Show the plan on the live picture** draws the room edges and footprints back onto the camera view, which is the quickest way to see a bad calibration. Re-calibrate whenever the camera moves.
- **Floor positions come from the feet.** A person's position is the bottom-centre of their box mapped through the calibration. When their feet are hidden (by the bench, or the bottom of the picture), the position is marked uncertain and the last good position is kept. Expect roughly half a metre of error.
- **Areas** are derived from the plan: *at the Double door* (within 0.8 m), *at/beside* a footprint (inside, or within 0.6 m), *by the … wall* (within 0.5 m), otherwise *open floor*. Estimated footprints give estimated areas.
- **Who is who.** Choose a phone on a track and press **This is them**. If a confirmed person goes out of sight and a new track appears within 1.2 m in the next 15 seconds, the desk is asked “Is T5 A?” — it is never assumed. **Clear** removes a match.
- **Movement** lists area changes with times (“A (phone 1): beside the Work bench → at the Double door”). During a recording, changes for confirmed people go to the event log as `room_track`.
- **Directors.** With “Let directors use…” on, directors see confirmed people only: their area, rough floor position, whether they are visible or last seen and how long ago, and recent movement. Tracking older than five seconds is withheld. Nothing advances a program cue.

### Studio notes

The bench laptop's camera sits on the bench, so the bench hides most of the floor and many feet. For floor tracking, mount a camera high in a corner looking down across the room (the ceiling arm, or an iPhone as a Continuity Camera), then calibrate it. The first trial used a still studio photo as a stand-in camera: detection ran on the browser's GPU at about 140 ms per frame, calibration and plan overlay worked, and confirmations were exercised with simulated tracks. Tracking a real person walking in the studio has not been tested yet.

## Furniture tracking

While tracking runs, the detector also follows furniture it recognises: chairs, sofas, tables, benches, bags, suitcases, plants and screens. Rugs, artworks and rolls of paper are not recognised; mark them on the plan by hand.

- **Steady sightings only.** An object appears under **Furniture** after about five clean sightings. Furniture is smoothed much more than people, so a flickering detection does not jitter its position.
- **Match it to the plan.** If a detected object sits on or near an outline, the desk is asked "Is this couch the Armchair?". Or choose a plan item and press **This is it**. Each plan item can be matched to one object.
- **The plan follows moves.** When a matched object has moved more than 35 cm and stayed put, at a similar size, for about four seconds, its outline shifts by the same amount. The outline is marked estimated, its notes say when the camera moved it, and Movement shows "Armchair moved 1.2 m: beside the Rug → by the jars wall". During a recording this is logged as `room_object_moved`. Only position is followed, not rotation.
- **People don't move furniture by standing in front of it.** While a person's box overlaps an object, the object keeps following roughly where it is (so it can be carried) but the plan is not changed until it is seen clearly again.
- **Moved while out of view.** If a matched object disappears and one object of the same kind turns up elsewhere, it is treated as the same object. With two matching chairs missing, it cannot tell them apart and waits for the desk.
- **Directors** (with sharing on) see matched furniture and moves in the last five minutes.

Matches are kept in memory: after a server restart, confirm them again (the suggestions make this one click). Plan changes made by the camera are saved.

## Wall names

The floor plan can name its walls (`wallNames` with `top`, `right`, `bottom`, `left`), so areas read "by the jars wall" instead of "by the left wall". Floor-level items (height under 5 cm, such as a rug) read "on the Rug".

## Animals (Yuri)

The detector also recognises dogs and cats. Name them in the room setup (`animals: [{kind:'dog', name:'Yuri'}]`); each kind is one track, so any dog the camera sees is Yuri. Animals get a green dot on the plan and Movement lines ("Yuri: on the Rug → by the jars wall") and are logged as `room_animal`. They are never matched to a phone and never counted as people. With sharing on, directors see where Yuri is, so they can avoid directing someone into him.
