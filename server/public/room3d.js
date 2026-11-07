// A lightweight 3D model of the room: the floor plan's walls, door and furniture (as boxes with their
// measured heights), each calibrated camera with what it can see of the floor, and live people,
// objects and animals from tracking. Plan x → 3D x, plan y → 3D z, height → 3D y. Metres throughout.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const { api, esc } = Setup;
const el = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio)); el.append(renderer.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x101112);
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 100);
const controls = new OrbitControls(camera, renderer.domElement); controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 0.9); sun.position.set(3, 6, 2); scene.add(sun);

const roomGroup = new THREE.Group(), liveGroup = new THREE.Group(), coverageGroup = new THREE.Group();
const scanGroup = new THREE.Group();
scene.add(roomGroup, liveGroup, coverageGroup, scanGroup);
let planKey = '', plan = null, cams = {}, view = 'persp', showCoverage = true, data = null;

// ---------- helpers ----------
const P = (x, y, h = 0) => new THREE.Vector3(x, h, y);   // plan point → 3D
function label(text, color = '#ffffff', size = 0.18) {
  const c = document.createElement('canvas'), g = c.getContext('2d'), font = 48;
  g.font = `600 ${font}px system-ui`; const w = Math.ceil(g.measureText(text).width) + 24;
  c.width = w; c.height = font + 22;
  g.font = `600 ${font}px system-ui`; g.fillStyle = 'rgba(16,17,18,.72)'; g.beginPath(); g.roundRect(0, 0, w, c.height, 14); g.fill();
  g.fillStyle = color; g.textBaseline = 'middle'; g.fillText(text, 12, c.height / 2 + 2);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  s.scale.set(size * w / c.height, size, 1); s.renderOrder = 10; return s;
}
function apply(H, [u, v]) { const w = H[6] * u + H[7] * v + H[8]; if (!(w > 1e-9)) return null; return [(H[0] * u + H[1] * v + H[2]) / w, (H[3] * u + H[4] * v + H[5]) / w]; }
function dispose(group) { for (const o of [...group.children]) { group.remove(o); o.traverse?.((x) => { x.geometry?.dispose(); x.material?.map?.dispose(); x.material?.dispose?.(); }); } }

// ---------- the room (rebuilt only when the plan or calibration changes) ----------
function buildRoom(room) {
  dispose(roomGroup); dispose(coverageGroup); plan = room.floorPlan; cams = {};
  if (!plan) return;
  const { widthM: w, depthM: d, heightM: h } = plan;
  // floor and a half-metre grid
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: 0x2a2826, roughness: 1 }));
  floor.rotation.x = -Math.PI / 2; floor.position.set(w / 2, 0, d / 2); roomGroup.add(floor);
  const grid = new THREE.Group();
  for (let x = 0; x <= w + 1e-6; x += 0.5) grid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([P(x, 0, 0.002), P(x, d, 0.002)]), new THREE.LineBasicMaterial({ color: 0x3a3733 })));
  for (let y = 0; y <= d + 1e-6; y += 0.5) grid.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([P(0, y, 0.002), P(w, y, 0.002)]), new THREE.LineBasicMaterial({ color: 0x3a3733 })));
  roomGroup.add(grid);
  // walls (see-through), with their names
  const names = plan.wallNames || {}, wallMat = new THREE.MeshStandardMaterial({ color: 0xe9e4da, transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false });
  const walls = { top: [[0, 0], [w, 0]], right: [[w, 0], [w, d]], bottom: [[w, d], [0, d]], left: [[0, d], [0, 0]] };
  for (const [side, [a, b]] of Object.entries(walls)) {
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]), m = new THREE.Mesh(new THREE.PlaneGeometry(len, h), wallMat);
    m.position.set((a[0] + b[0]) / 2, h / 2, (a[1] + b[1]) / 2); m.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]); roomGroup.add(m);
    const edge = new THREE.Line(new THREE.BufferGeometry().setFromPoints([P(...a, 0), P(...b, 0), P(...b, h), P(...a, h), P(...a, 0)]), new THREE.LineBasicMaterial({ color: 0x8a857c }));
    roomGroup.add(edge);
    if (names[side]) { const s = label(names[side], '#cfc9bf', 0.16); s.position.set((a[0] + b[0]) / 2, h - 0.25, (a[1] + b[1]) / 2); roomGroup.add(s); }
  }
  // doors
  for (const door of plan.doors || []) {
    if (door.offsetM == null) continue;
    const a = door.offsetM, b = a + door.widthM, e = door.wall === 'bottom' ? d : door.wall === 'right' ? w : 0, hz = door.wall === 'top' || door.wall === 'bottom';
    const p1 = hz ? [a, e] : [e, a], p2 = hz ? [b, e] : [e, b], dh = Math.min(2.1, h);
    const m = new THREE.Mesh(new THREE.PlaneGeometry(door.widthM, dh), new THREE.MeshStandardMaterial({ color: 0x8fd19e, transparent: true, opacity: 0.35, side: THREE.DoubleSide }));
    m.position.set((p1[0] + p2[0]) / 2, dh / 2, (p1[1] + p2[1]) / 2); if (!hz) m.rotation.y = Math.PI / 2; roomGroup.add(m);
    const s = label(door.name, '#8fd19e', 0.15); s.position.set((p1[0] + p2[0]) / 2, dh + 0.15, (p1[1] + p2[1]) / 2); roomGroup.add(s);
  }
  // furniture: footprints extruded to their height (unknown height shown low and faint)
  for (const f of plan.footprints || []) {
    const low = f.heightM != null && f.heightM < 0.05, ht = f.heightM == null ? 0.3 : Math.max(0.01, f.heightM);
    const shape = new THREE.Shape(f.points.map(([x, y]) => new THREE.Vector2(x, -y)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: ht, bevelEnabled: false }); geo.rotateX(-Math.PI / 2);
    const color = low ? 0x6b4f3a : /shelf|shelves/i.test(f.name) ? 0x8a7d6b : 0xc9a46c;
    const mat = new THREE.MeshStandardMaterial({ color, transparent: true, opacity: f.estimated ? 0.45 : 0.8, roughness: 0.8 });
    const mesh = new THREE.Mesh(geo, mat); mesh.position.y = 0; roomGroup.add(mesh);
    roomGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: f.estimated ? 0x8a857c : 0xe8c27a })));
    const cx = f.points.reduce((s, p) => s + p[0], 0) / f.points.length, cy = f.points.reduce((s, p) => s + p[1], 0) / f.points.length;
    const s = label(f.name + (f.estimated ? ' (estimated)' : ''), '#f2ead9', 0.13); s.position.copy(P(cx, cy, ht + 0.18)); roomGroup.add(s);
  }
  // cameras: body, aim, and the patch of floor each can see
  for (const [id, cal] of Object.entries(room.calibrations || {})) {
    const c = cal.camera; if (!c) continue;
    const name = room.cameras?.find((x) => x.id === id)?.name || id, pos = P(c.x, c.y, c.z);
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.1, 0.14), new THREE.MeshStandardMaterial({ color: 0xffffff })); body.position.copy(pos); roomGroup.add(body);
    const s = label(name, '#ffffff', 0.14); s.position.copy(pos.clone().add(new THREE.Vector3(0, 0.22, 0))); roomGroup.add(s);
    // floor seen = image border mapped through the calibration (only the part below the horizon)
    const border = [];
    for (let i = 0; i <= 20; i++) border.push([i / 20, 1]); for (let i = 20; i >= 0; i--) border.push([1, i / 20]);
    for (let i = 20; i >= 0; i--) border.push([i / 20, 0]); for (let i = 0; i <= 20; i++) border.push([0, i / 20]);
    const pts = border.map((q) => apply(cal.H, q)).filter((q) => q && Math.hypot(q[0] - c.x, q[1] - c.y) < 15)
      .map(([x, y]) => [Math.max(-0.5, Math.min(plan.widthM + 0.5, x)), Math.max(-0.5, Math.min(plan.depthM + 0.5, y))]);
    if (pts.length > 3) {
      const shape = new THREE.Shape(pts.map(([x, y]) => new THREE.Vector2(x, -y)));
      const patch = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: 0x9bc7ff, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
      patch.rotation.x = -Math.PI / 2; patch.position.y = 0.004; coverageGroup.add(patch);
      const corners = [[0, 1], [1, 1], [0.5, 0.5]].map((q) => apply(cal.H, q)).filter(Boolean);
      for (const q of corners) coverageGroup.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([pos, P(q[0], q[1], 0)]), new THREE.LineBasicMaterial({ color: 0x9bc7ff, transparent: true, opacity: 0.5 })));
    }
    cams[id] = { pos, aim: (() => { const q = apply(cal.H, [0.5, 0.55]); return q ? P(q[0], q[1], 0.8) : P(plan.widthM / 2, plan.depthM / 2, 0.8); })() };
  }
  coverageGroup.visible = showCoverage;
  setView(view, true);
}

// ---------- the scan (optional): a phone scan of the room, placed by its walls onto the plan ----------
let scanLoaded = false;
async function loadScan() {
  try {
    const meta = await (await fetch('scans/studio.json')).json(), t = meta.planFromScan;
    const gltf = await new GLTFLoader().loadAsync(meta.file);
    // Scans often come without normals and with "metallic" materials; show their photo textures as they are.
    gltf.scene.traverse((m) => { if (m.isMesh) m.material = new THREE.MeshBasicMaterial({ map: m.material.map, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }); });
    const holder = new THREE.Group();
    // A scan turned 90° to the plan: swap its x and z first, so "x" below means the scan axis along the plan's width.
    if (meta.swapXZ) { const inner = new THREE.Group(); inner.matrixAutoUpdate = false; inner.matrix.set(0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1); inner.add(gltf.scene); holder.add(inner); }
    else holder.add(gltf.scene);
    // plan x = scale·sign·(X − origin)… expressed as a scale and offset on the 3D x / z axes
    holder.scale.set(t.x.sign * t.x.scale, 1, t.y.sign * t.y.scale);
    holder.position.set(-t.x.sign * t.x.scale * t.x.origin, -t.floorY, -t.y.sign * t.y.scale * t.y.origin);
    scanGroup.add(holder); scanLoaded = true;
    // Cut away the ceiling so you can look in from above.
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, -1, 0), (plan?.heightM || 3) - 0.15)];
    // Off by default: a scan is a snapshot of how the room once was. Switch it on to check alignment or for reference.
    scanGroup.visible = false; renderer.clippingPlanes = [];
    if (new URLSearchParams(location.search).get('scan') === '1') document.getElementById('v-scan').click();
    const b = document.getElementById('v-scan'); b.hidden = false; b.title = meta.label; b.textContent = `Scan (${meta.label.replace(/^Scan, /, '')})`;
  } catch { /* no scan for this room */ }
}
document.getElementById('v-scan').onclick = (e) => { scanGroup.visible = !scanGroup.visible; e.target.classList.toggle('on', scanGroup.visible); renderer.clippingPlanes = scanGroup.visible ? [new THREE.Plane(new THREE.Vector3(0, -1, 0), (plan?.heightM || 3) - 0.15)] : []; };
loadScan();

// ---------- live layer ----------
const COLORS = { estimate: 0xe3c28f, seated: 0x8fd19e, 'from head': 0xf08a6c, 'last seen': 0x777777, uncertain: 0x777777 };
function person(t) {
  const seated = t.certainty === 'seated', h = seated ? 1.25 : 1.7, g = new THREE.Group();
  const col = COLORS[t.visible ? t.certainty : 'last seen'] ?? 0x999999, ghost = !t.visible || t.certainty === 'uncertain';
  const mat = new THREE.MeshStandardMaterial({ color: col, transparent: ghost, opacity: ghost ? 0.35 : 1 });
  const bodyH = h - 0.25, body = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, bodyH, 18), mat); body.position.y = bodyH / 2;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 18, 12), mat); head.position.y = h - 0.12;
  g.add(body, head);
  const name = t.binding?.label || t.id;
  const s = label(`${name} · ${t.area}`, t.binding ? '#ffffff' : '#cccccc', 0.15); s.position.y = h + 0.22; g.add(s);
  g.position.copy(P(t.floor[0], t.floor[1], 0)); return g;
}
function renderLive(tr) {
  dispose(liveGroup); if (!tr || !plan) return;
  // Unnamed people only while tracking sees them; named people also where they were last seen.
  for (const t of tr.tracks || []) if (t.floor && (t.binding || (tr.running && t.visible))) liveGroup.add(person(tr.running ? t : { ...t, visible: false }));
  for (const o of tr.finder?.objects || []) {
    if (!o.floor) continue;
    const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.09), new THREE.MeshStandardMaterial({ color: 0xffd27a, emissive: 0x332200 }));
    m.position.copy(P(o.floor[0], o.floor[1], 0.12)); liveGroup.add(m);
    const s = label(o.name, '#ffd27a', 0.12); s.position.copy(P(o.floor[0], o.floor[1], 0.38)); liveGroup.add(s);
  }
  for (const a of tr.animals || []) {
    if (!a.floor) continue;
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 10), new THREE.MeshStandardMaterial({ color: 0x7fe0c0, transparent: !a.visible, opacity: a.visible ? 1 : 0.35 }));
    m.position.copy(P(a.floor[0], a.floor[1], 0.13)); liveGroup.add(m);
    const s = label(a.name, '#7fe0c0', 0.12); s.position.copy(P(a.floor[0], a.floor[1], 0.42)); liveGroup.add(s);
  }
}
function renderList(tr) {
  const people = (tr?.tracks || []).filter((t) => t.binding || (tr.running && t.visible));
  const lines = [
    ...people.map((t) => `<p><span class="dot" style="background:#${(COLORS[t.visible ? t.certainty : 'last seen'] ?? 0x999999).toString(16).padStart(6, '0')}"></span>${esc(t.binding?.label || t.id)} — ${esc(t.area)}${t.visible ? '' : ' (last seen)'}</p>`),
    ...(tr?.finder?.objects || []).filter((o) => o.visible).map((o) => `<p><span class="dot" style="background:#ffd27a"></span>${esc(o.name)}${o.area ? ' — ' + esc(o.area) : ''}</p>`),
    ...(tr?.animals || []).filter((a) => a.visible).map((a) => `<p><span class="dot" style="background:#7fe0c0"></span>${esc(a.name)} — ${esc(a.area)}</p>`),
  ];
  document.getElementById('who').innerHTML = lines.join('') || '<p class="dim">Nobody tracked right now. Start tracking on the Room page.</p>';
}

// ---------- views ----------
function setView(v, keep) {
  view = v; for (const id of ['persp', 'top', 'cam']) document.getElementById('v-' + id).classList.toggle('on', id === v);
  if (!plan) return;
  const c = P(plan.widthM / 2, plan.depthM / 2, 0.6), first = Object.values(cams)[0];
  if (v === 'top') { camera.position.set(c.x, 8.5, c.z + 0.01); controls.target.copy(P(plan.widthM / 2, plan.depthM / 2, 0)); }
  else if (v === 'cam' && first) { camera.position.copy(first.pos); controls.target.copy(first.aim); }
  else if (!keep || v === 'persp') { camera.position.set(-2.2, 5.2, plan.depthM + 3.2); controls.target.copy(c); }
  controls.update();
}
document.getElementById('v-persp').onclick = () => setView('persp');
document.getElementById('v-top').onclick = () => setView('top');
document.getElementById('v-cam').onclick = () => setView('cam');
// Links can open a particular view: room3d.html?view=top (persp, top, cam) and &scan=1 to show the scan.
{ const v = new URLSearchParams(location.search).get('view'); if (['persp', 'top', 'cam'].includes(v)) setTimeout(() => document.getElementById('v-' + v).click(), 0); }
document.getElementById('v-coverage').onclick = (e) => { showCoverage = !showCoverage; coverageGroup.visible = showCoverage; e.target.classList.toggle('on', showCoverage); };

// ---------- loop ----------
async function poll() {
  try {
    data = await api('room', undefined, { allowStatusError: true });
    const key = JSON.stringify([data.floorPlan, Object.fromEntries(Object.entries(data.calibrations || {}).map(([k, c]) => [k, [c.H, c.camera]]))]);
    if (key !== planKey) { planKey = key; buildRoom(data); }
    const tr = data.tracking; renderLive(tr); renderList(tr);
    document.getElementById('status').textContent = !data.floorPlan ? 'No floor plan saved yet.' : tr?.running ? `Live · tracking on ${data.cameras?.find((c) => c.id === tr.cameraId)?.name || tr.cameraId}` : 'Not tracking right now: showing the room and last known positions.';
  } catch (e) { document.getElementById('status').textContent = e.message; }
  setTimeout(poll, 700);
}
function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();
window.room3d = { renderer, scene, camera, controls, setView };   // for checking renders from the console
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
poll();
