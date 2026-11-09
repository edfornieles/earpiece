const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { Ptz, approachPoint, parsePresets } = require('../ptz');
const { CameraViews, chooseView } = require('../camera-views');
const { RoomObserver } = require('../room');

const plan = { widthM: 4, depthM: 4, heightM: 3, doors: [], footprints: [] };
// Picture (u, v) → floor (4u, 4v) for the reference position; a camera turned right sees x shifted.
const H = (dx = 0) => [4, 0, 4 * dx, 0, 4, 0, 0, 0, 1];
const nap = () => Promise.resolve();

test('moves to a position arrive from the left and from above', async () => {
  assert.deepEqual(approachPoint([0.2, -0.1]).map((v) => +v.toFixed(3)), [0.15, -0.05]);
  assert.deepEqual(approachPoint([-0.98, 0.99]), [-1, 1]);
  const xml = '<tptz:Preset token="2"><tt:Name>mother_home</tt:Name><tt:PTZPosition><tt:PanTilt x="-0.15" y="-0.03" space="s"></tt:PanTilt></tt:PTZPosition></tptz:Preset>';
  assert.deepEqual(parsePresets(xml), [{ token: '2', name: 'mother_home', pos: [-0.15, -0.03] }]);

  const sent = []; let pos = [0.3, -0.2];
  const request = async (body) => {
    const op = /<s:Body><(\w+)/.exec(body)[1]; sent.push(op);
    if (op === 'GetProfiles') return '<trt:Profiles token="prof">';
    if (op === 'GetPresets') return xml;
    if (op === 'RelativeMove') { const [, x, y] = /x="([-\d.]+)" y="([-\d.]+)"/.exec(body); pos = [pos[0] + Number(x), pos[1] + Number(y)]; sent.push(pos.map((v) => +v.toFixed(3))); }
    if (op === 'GotoPreset') pos = [-0.15, -0.03];
    return `<tt:PanTilt x="${pos[0]}" y="${pos[1]}"/>`;
  };
  const ptz = new Ptz('rtsp://user:secret@10.0.0.9/stream1', { request });
  const end = await ptz.goto('2', async () => {});
  const at = sent.indexOf('RelativeMove');
  assert.deepEqual(sent[at + 1], [-0.2, 0.02], 'passes just left of and above the preset');
  assert.ok(sent.indexOf('GotoPreset') > at, 'then settles on the preset');
  assert.deepEqual(end, [-0.15, -0.03]);
});

test('chooses the position that covers where the person was heading', () => {
  const views = [
    { id: 'home', pos: [0, 0], calibration: { H: H(0) } },        // sees x 0..4 (whole width)
    { id: 'left', pos: [-0.3, 0], calibration: { H: [8, 0, -4, 0, 4, 0, 0, 0, 1] } },  // sees x -4..4 squeezed; centre at x 0
    { id: 'right', pos: [0.3, 0], calibration: null },
  ];
  const narrow = [2, 0, 2, 0, 4, 0, 0, 0, 1];   // current view sees x 2..4 only
  const current = { id: 'cur', pos: [0.1, 0], H: narrow };
  // Walked out of the left edge towards x ≈ 0.5: 'left' sees it nearer the middle than 'home'.
  assert.equal(chooseView({ views, current, plan, last: { box: { x: 0.01, y: 0.3, w: 0.1, h: 0.5 }, floor: [1.6, 2], vel: [-1, 0] } }), 'left');
  // Still well inside this picture and not at an edge: hidden, not gone. Stay.
  assert.equal(chooseView({ views, current, plan, last: { box: { x: 0.4, y: 0.3, w: 0.1, h: 0.5 }, floor: [3, 2], vel: [0, 0] } }), null);
  // Left by the right edge with no floor position: next position to the right, even uncalibrated.
  assert.equal(chooseView({ views, current, plan, last: { box: { x: 0.9, y: 0.3, w: 0.09, h: 0.5 }, floor: null } }), 'right');
});

function setup(t, register) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mother-views-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cam = { id: 'cam2', name: 'Tapo', main: 'rtsp://user:secret@10.0.0.9/stream1', status() { return { id: 'cam2' }; } };
  const room = new RoomObserver(path.join(dir, '.room.json'), { cameras: () => [cam], maxPhones: () => 4 });
  room.config.floorPlan = plan; room.config.calibrations = { cam2: { H: H(0), camera: { x: 2, y: -0.2, z: 2.3 } } };
  const calls = [];
  class FakePtz {
    async position() { return [0, 0]; }
    async savePreset(name) { calls.push(['save', name]); return 't' + calls.length; }
    async nudge(dx, dy) { calls.push(['nudge', dx, dy]); return [dx, dy]; }
    async goto(token) { calls.push(['goto', token]); return [0, 0]; }
    async removePreset(token) { calls.push(['remove', token]); }
  }
  const views = new CameraViews({ root: dir, cameras: [cam], room, PtzImpl: FakePtz, nap, grab: async () => Buffer.from('jpeg'), register: register || (async () => ({ ok: true, G: [1, 0, 0.02, 0, 1, 0, 0, 0, 1], shift: [0.02, 0], inliers: 900 })) });
  return { room, views, calls, dir };
}

test('a saved position keeps the calibration it was made with; aiming by hand drops it', async (t) => {
  const { room, views } = setup(t);
  const v = await views.save('cam2', 'Home');
  assert.deepEqual(room.cals().cam2.H, H(0));
  assert.ok(fs.existsSync(path.join(views.dir, v.ref)), 'reference picture saved');
  await views.nudge('cam2', 0.1, 0);
  assert.equal(room.cals().cam2, undefined, 'no floor positions from an uncalibrated aim');
  const other = await views.save('cam2', 'Armchair');
  assert.equal(other.calibration, null, 'a new aim needs its own calibration');
  assert.equal(views.status('cam2').views.length, 2);
});

test('arriving at a position corrects its calibration by how far the picture moved', async (t) => {
  const { room, views } = setup(t);
  const home = await views.save('cam2', 'Home');
  await views.nudge('cam2', 0.2, 0);
  const c = await views.goto('cam2', home.id);
  assert.equal(c.ok, true);
  // The picture moved 0.02 right: what is now at u = 0.52 is what the calibration saw at 0.5.
  const Hc = room.cals().cam2.H, u = 0.52, v = 0.5, w = Hc[6] * u + Hc[7] * v + Hc[8];
  assert.ok(Math.abs((Hc[0] * u + Hc[1] * v + Hc[2]) / w - 2) < 1e-9 && Math.abs((Hc[3] * u + Hc[4] * v + Hc[5]) / w - 2) < 1e-9);
  assert.equal(room.activeView().cam2.moving, false);
});

test('a position the camera clearly missed is not trusted', async (t) => {
  const { room, views } = setup(t, async () => ({ ok: true, G: [1, 0, 0.2, 0, 1, 0, 0, 0, 1], shift: [0.2, 0], inliers: 300 }));
  const home = await views.save('cam2', 'Home');
  const c = await views.goto('cam2', home.id);
  assert.equal(c.ok, false); assert.match(c.error, /stopped somewhere else/);
  assert.equal(room.cals().cam2, undefined);
});

test('follow turns the camera when the followed person walks out of the picture', async (t) => {
  const { room, views, calls } = setup(t);
  const home = await views.save('cam2', 'Home');
  await views.nudge('cam2', 0.3, 0);
  const right = await views.save('cam2', 'Right');
  room.config.cameraViews.cam2 = room.config.cameraViews.cam2.map((v) => v.id === right.id ? { ...v, pos: [0.3, 0], calibration: { H: [2, 0, 3, 0, 4, 0, 0, 0, 1] } } : { ...v, pos: [0, 0] });
  await views.goto('cam2', home.id);
  views.st('cam2').lastMove = null;
  views.setFollow('cam2', { on: true, wanted: 'auto' });
  let tracks = [{ id: 'P1', visible: true, box: { x: 0.85, y: 0.3, w: 0.12, h: 0.5 }, floor: [3.6, 2], binding: null }];
  room.tracking.cameraId = 'cam2'; room.tracking.view = () => ({ running: true, tracks });
  let now = 1e6;
  views.tick(now); views.tick(now += 300);
  tracks = [{ ...tracks[0], box: { x: 0.97, y: 0.3, w: 0.03, h: 0.5 }, floor: [3.95, 2] }]; views.tick(now += 300);
  tracks = [];
  assert.equal(views.tick(now += 500), null, 'waits a moment before deciding they left');
  const target = views.tick(now += 1000);
  assert.equal(target, right.id);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls.at(-1), ['goto', views.views('cam2').find((v) => v.id === right.id).token]);
  assert.equal(views.tick(now += 2000), null, 'one turn per disappearance');
});
