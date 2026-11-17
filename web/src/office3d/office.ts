// @ts-nocheck
// The miniature 3D office, on a high floor of a tower. Everything is a box made here: no model, no texture file. Loaded lazily: three.js only downloads when 3D is picked.
// All boxes share four instanced meshes (the office lit and unlit, the city below lit and unlit), so the whole view is a handful of draw calls.
// Everything that moves comes from real events: a state change bends the person into the new pose on springs, a message is carried by a courier
// through the doors, an agent that joins walks in through the door, an agent idle for two minutes takes one coffee break.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TINT, roleOf, MAXDRAW } from './plan';
import { overlaps, pathHits } from './audit';
import { makeLayout, pathOut, breakPath, joinPath, route, walkPoints, toABox, hash, WALLH, INWALL, SEAT, SITZ, SLIDE, WALKW, WALKH, RUNH } from './layout';

const KIND = { task: 0xf2b04a, report: 0x3ecf8e, question: 0x6aa8ff, answer: 0xb48cff, info: 0x38c6d9 };
const SKIN = [0xf2cfae, 0xe9b98f, 0xb9825a, 0x8a5a3c], HAIR = [0x5a3521, 0x1d1d22, 0xd9a441, 0x9a9aa3, 0xa8472e, 0x3b2a20];
const ACCS = ['glasses', 'bun', 'phones', 'cap', 'beard', 'long', 'none'];
const PAL = {
  light: { bg: 0xe6ebef, slab: 0xb7ae9f, corridor: 0xd9d2c6, floorTeam: 0xe6c79c, floorDir: 0xd2a877, wall: 0xf4eee3, part: 0xece5d8, desk: 0xd9a565, deskLeg: 0x9a6b3e,
    chair: 0x4b5262, chairDir: 0x7a4a31, tech: 0x2b2e37, tray: 0x9aa0ad, plant: 0x4f9a5b, pot: 0xcf6f4c, rug0: 0x9cc7d8, rug1: 0xa8c9a0, rugDir: 0xb9584c, board: 0xffffff, shelf: 0x9a6638,
    cooler: 0xf2f2f2, water: 0x8fcdec, plot: 0xd3cfc8, carton: 0xc9a26b, window: 0xbfe3ff, shade: 0xffe9c4,
    glass: 0xd8efff, mull: 0xfbfcfd, sky: 0xcfe2f0, city0: 0xd9cbb8, city1: 0xb9c4d0, city2: 0xc9b3a1, roof: 0xe6e2dc, cityWin: 0x7f97ad, cityWinC: 0x8ea5b9, cityWin2: 0x8b9cae, ground: 0x9db0c3, tower: 0xaab4c0, band: 0xf3f6f9,
    door: 0xb9834f, counter: 0xefe8dc, machine: 0x33363f, frame: 0xffffff, screen: 0x20232b, cap: 0xffffff, rail: 0x4b505c },
  dark: { bg: 0x0e0e12, slab: 0x1b1a21, corridor: 0x3b3944, floorTeam: 0x9a7b5c, floorDir: 0x85654d, wall: 0x5d5b70, part: 0x565468, desk: 0xb98248, deskLeg: 0x74502c,
    chair: 0x3d4250, chairDir: 0x6a3f2a, tech: 0x1c1e25, tray: 0x6c7180, plant: 0x3f8049, pot: 0xa8563a, rug0: 0x4f7f95, rug1: 0x4d7a58, rugDir: 0x8a3f37, board: 0xe4e4e8, shelf: 0x7a4f2b,
    cooler: 0xc4c4cc, water: 0x5fa6c8, plot: 0x24232a, carton: 0x7a6444, window: 0x1a2444, shade: 0xffd9a0,
    glass: 0x7f95d8, mull: 0x4a4862, sky: 0x0b1024, city0: 0x1c2748, city1: 0x232d4f, city2: 0x1a2140, roof: 0x2c3a62, cityWin: 0xffd27a, cityWinC: 0xcfe6ff, cityWin2: 0x121a36, ground: 0x090d1e, tower: 0x232d4f, band: 0x34344f,
    door: 0x8a5f38, counter: 0xb9b3aa, machine: 0x1c1e25, frame: 0xd9d9de, screen: 0x15171d, cap: 0x8a88a0, rail: 0x23252d },
};
const LIGHTS = { light: { hemi: [0xe6f1ff, 0xdcc9ad, 1.55], sun: [0xffe1b5, 2.3], dir: [-7, 6.2, 3.5], lamp: 0, glass: 0.3 }, dark: { hemi: [0xffe9d2, 0x3a3550, 1.25], sun: [0xfff0dc, 0.95], dir: [-2.5, 9, 4], lamp: 2.4, glass: 0.2 } }; // day: a low warm sun through the glass; night: the ceiling light on, desk lamps as accents
const MAXLAMPS = 12, MAXCOURIERS = 4, BREAK_AFTER = 120; // real lamp lights, couriers at once, seconds idle before the one coffee break
const STATE_TEXT = { working: 'Working', idle: 'Idle', blocked: 'Blocked', talk: 'Talking', away: 'On a break', in: 'Arriving' };
const DARKB = 0x1d1d22, STRIDE = 0.4;
// body sizes: every part is a box
const THIGH = 0.17, SHIN = 0.16, SHOE = 0.06, LEG = THIGH + SHIN + SHOE, LEGT = 0.16, SIT = SEAT + LEGT / 2 - LEG; // seated: the thighs rest on the seat
const TORSO = [0.4, 0.32, 0.25], HEAD = [0.38, 0.34, 0.36], UARM = 0.18, FARM = 0.15, HAND = 0.08, SHX = 0.23, SHY = 0.28, HIPB = 0.08, NECK = 0.03, LEGX = 0.095; // sizes from the design board (figure 1.2 tall): chest, head, upper arm, forearm, hand, shoulder joint (0.03 in from the board: the aisle between two desks is 0.6 wide), hip block above the joint, neck, leg offset
const AZ = 0.6, EL = 0.6155; // the fixed three-quarter view: 34 degrees to the side, 35 down
const V3 = THREE.Vector3;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const backOut = (x) => { const c = 1.70158, u = clamp01(x) - 1; return 1 + (c + 1) * u * u * u + c * u * u; }; // lands with about 10% overshoot
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const damp = THREE.MathUtils.damp;
const wrap = (d) => ((((d + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
const lerpAngle = (a, b, t) => a + wrap(b - a) * t;
const esc = (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const look = (t) => { const n = Math.floor(t / 2.4), f = t / 2.4 - n, r = (i) => Math.sin(i * 127.1) * 0.9; return r(n) + (r(n + 1) - r(n)) * sstep(0.75, 1, f); }; // hold, then turn in 0.6 s

export function createOffice(opts) {
const { host, RM } = opts;
let plan = opts.plan, dark = !!opts.dark, tilt = opts.tilt !== false, sel = opts.sel || '', notes = opts.notes || {}, disposed = false;
let DT = 0, T = 0; const LOOPS = RM ? 0 : 1;
const pal = () => PAL[dark ? 'dark' : 'light'];
const tmp = new V3(), _p = new V3(), _q = new THREE.Quaternion(), _s = new V3(), _e = new THREE.Euler(), _m = new THREE.Matrix4(), _c = new THREE.Color(), ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const dampAngle = (a, b, l, dt) => a + wrap(b - a) * (1 - Math.exp(-l * dt));
function spring(s, target, dt, k = 150, z = 0.8) { // z < 1 overshoots a little: that is the settle
  if (dt <= 0) return s.x; const c = 2 * z * Math.sqrt(k), n = Math.max(1, Math.ceil(dt / 0.008)), h = dt / n;
  for (let i = 0; i < n; i++) { s.v += (-k * (s.x - target) - c * s.v) * h; s.x += s.v * h; } return s.x;
}
function* waitG(s) { let a = 0; while (a < s) { a += DT; yield; } }
// ---------- renderer, light ----------
const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: !!RM });
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.info.autoReset = false;
const canvas = renderer.domElement; canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block'; host.appendChild(canvas);
const lab = document.createElement('div'); lab.className = 'o3-li'; lab.style.cssText = 'position:absolute;inset:0'; opts.labels.appendChild(lab);
// reduced motion: no movement; a change shows as a 0.15 s cross-fade from the last picture
const fadeCv = RM ? document.createElement('canvas') : null;
if (fadeCv) { fadeCv.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;opacity:0'; host.appendChild(fadeCv); }
function rmFade() {
  if (!fadeCv || disposed) return; const w = canvas.width, h = canvas.height; if (!w || !h) return;
  if (fadeCv.width !== w || fadeCv.height !== h) { fadeCv.width = w; fadeCv.height = h; }
  fadeCv.getContext('2d').drawImage(canvas, 0, 0); fadeCv.style.transition = 'none'; fadeCv.style.opacity = '1'; void fadeCv.offsetWidth; fadeCv.style.transition = 'opacity .15s linear'; fadeCv.style.opacity = '0';
}
const scene = new THREE.Scene(); scene.background = new THREE.Color();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 400);
const hemi = new THREE.HemisphereLight(); scene.add(hemi); const sunAt = new THREE.Vector3();
const sun = new THREE.DirectionalLight(); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; scene.add(sun, sun.target);
const lamps = Array.from({ length: MAXLAMPS }, () => { const l = new THREE.PointLight(0xffb46b, 0, 4.5, 1.6); scene.add(l); return l; });

// ---------- boxes: five instanced meshes hold every box (the office lit and unlit, the glass, the city lit and unlit) ----------
function makePool(kind) {
  let cap = kind === 'glass' ? 256 : 2048, n = 0; const lit = kind === 'lit' || kind === 'cityLit', shadow = kind === 'lit';
  const mat = kind === 'glass' ? new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.25, depthWrite: false }) : lit ? new THREE.MeshLambertMaterial() : new THREE.MeshBasicMaterial();
  mat.onBeforeCompile = (sh) => { // per-box opacity as a dither, so a fading person needs no sorting and no second material
    sh.vertexShader = 'attribute float iA;\nvarying float vA;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvA = iA;');
    sh.fragmentShader = 'varying float vA;\n' + sh.fragmentShader.replace('void main() {', 'void main() {\nif (vA < 0.999 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) > vA) discard;');
  };
  const P = { mesh: null, alpha: null, mat, colDirty: false, aDirty: false,
    build(old) {
      const geo = new THREE.BoxGeometry(1, 1, 1); P.alpha = new THREE.InstancedBufferAttribute(new Float32Array(cap).fill(1), 1); P.alpha.setUsage(THREE.DynamicDrawUsage); geo.setAttribute('iA', P.alpha);
      const m = new THREE.InstancedMesh(geo, mat, cap); m.frustumCulled = false; m.castShadow = m.receiveShadow = shadow; m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.setColorAt(0, _c.set(0xffffff));
      if (kind === 'glass') m.renderOrder = 2;
      if (old) { m.instanceMatrix.array.set(old.mesh.instanceMatrix.array); m.instanceColor.array.set(old.mesh.instanceColor.array); P.alpha.array.set(old.alpha.array); scene.remove(old.mesh); old.mesh.geometry.dispose(); old.mesh.dispose(); }
      m.count = n; P.mesh = m; scene.add(m);
    },
    add() { if (n === cap) { const old = { mesh: P.mesh, alpha: P.alpha }; cap *= 2; P.build(old); } P.mesh.count = ++n; return n - 1; },
    reset() { n = 0; P.mesh.count = 0; P.alpha.array.fill(1); P.aDirty = true; },
    flush() { P.mesh.instanceMatrix.needsUpdate = true; if (P.colDirty) { P.mesh.instanceColor.needsUpdate = true; P.colDirty = false; } if (P.aDirty) { P.alpha.needsUpdate = true; P.aDirty = false; } },
    dispose() { P.mesh.geometry.dispose(); mat.dispose(); P.mesh.dispose(); },
  };
  P.build(null); return P;
}
const POOL = { lit: makePool('lit'), un: makePool('un'), glass: makePool('glass'), cityLit: makePool('cityLit'), cityUn: makePool('cityUn') }, POOLS = Object.values(POOL);
const ents = new Set(), statics = [], _c2 = new THREE.Color(); let curEnt = null;
function paint(vb, hex) { _c.setHex(hex ?? (typeof vb.col === 'string' ? pal()[vb.col] : vb.col)); if (vb.tint) _c.lerp(_c2.setHex(pal().sky), vb.tint); vb.pool.mesh.setColorAt(vb.i, _c); vb.pool.colDirty = true; }
function place(vb) { vb.i = vb.pool.add(); paint(vb); if (!vb.node) vb.pool.mesh.setMatrixAt(vb.i, vb.local); }
/** One box. y is its bottom. node = the moving part it hangs on, or null for furniture that never moves. col = a palette name or a fixed colour. */
function box(node, w, h, d, col, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, pool = 'lit') {
  const vb = { node, col, pool: POOL[pool === true ? 'un' : pool], i: -1, local: new THREE.Matrix4().compose(_p.set(x, y + h / 2, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(w, h, d)) };
  (curEnt ? curEnt.boxes : statics).push(vb); place(vb); return vb;
}
const ubox = (node, w, h, d, col, x, y, z, rx, ry, rz) => box(node, w, h, d, col, x, y, z, rx, ry, rz, 'un');
/** obj + kind name the thing for the overlap check: 'fx' (speech bubbles, envelopes, couriers) is not furniture and is left out */
function newEnt(root, build, obj = '', kind = 'fx') { const e = { root, boxes: [], alpha: 1, _a: 1, obj, kind }, prev = curEnt; curEnt = e; build(e); curEnt = prev; ents.add(e); return e; }
function dropEnt(e) { if (!ents.delete(e)) return; for (const vb of e.boxes) vb.pool.mesh.setMatrixAt(vb.i, ZERO); }
function flushEnts() {
  for (const e of ents) {
    e.root.updateMatrixWorld(true); const gone = e.alpha <= 0.002;
    for (const vb of e.boxes) vb.pool.mesh.setMatrixAt(vb.i, gone ? ZERO : _m.multiplyMatrices(vb.node.matrixWorld, vb.local));
    if (e.alpha !== e._a) { e._a = e.alpha; for (const vb of e.boxes) { vb.pool.alpha.array[vb.i] = e.alpha; vb.pool.aDirty = true; } }
  }
  for (const p of POOLS) p.flush();
}
const node = (parent, x = 0, y = 0, z = 0) => { const o = new THREE.Object3D(); o.position.set(x, y, z); parent && parent.add(o); return o; };

// ---------- labels (HTML over the canvas, so text stays sharp) ----------
const labels = new Set();
function addLabel(cls, html, anchor, data) { const el = document.createElement('div'); el.className = cls; el.innerHTML = html; if (data) Object.assign(el.dataset, data); lab.appendChild(el); const l = { el, anchor, w: 0, lift: 0, off: null }; labels.add(l); return l; }
function dropLabel(l) { if (l) { labels.delete(l); l.el.remove(); } }

// ---------- furniture: every box comes from the layout (layout.ts), so the overlap test checks the same boxes ----------
let L = null, desks = {}, doors = [], fixedLabels = [], fixedEnts = [], bounds = new THREE.Box3();
function buildStatic() {
  const { rooms, blocks, plots, W, ZF } = plan, zb0 = blocks[0].zb; L = makeLayout(plan, notes); desks = {}; doors = [];
  const parts = {}, refs = {}; // moving parts (chairs, door leaves): one node each, at the part's own origin
  for (const [id, o] of Object.entries(L.ents)) parts[id] = { node: node(null, o[0], 0, o[1]), boxes: [], obj: id, kind: id.startsWith('leaf') ? 'door' : 'chair' };
  for (const b of L.boxes) {
    if (b.ent) { parts[b.ent].boxes.push(b); continue; }
    const vb = box(null, b.w, b.h, b.d, b.col, b.x, b.y, b.z, b.rx || 0, b.ry || 0, 0, b.pool === 'glass' ? 'glass' : b.pool === 'city' ? (b.unlit ? 'cityUn' : 'cityLit') : b.unlit ? 'un' : 'lit');
    vb.obj = b.obj; vb.kind = b.kind; if (b.tint) { vb.tint = b.tint; paint(vb); } if (b.ref) refs[b.ref] = vb;
  }
  for (const p of Object.values(parts)) { const o = p.node.position; p.ent = newEnt(p.node, () => { for (const b of p.boxes) box(p.node, b.w, b.h, b.d, b.col, b.x - o.x, b.y, b.z - o.z, b.rx || 0, b.ry || 0, 0, b.unlit ? 'un' : 'lit'); }, p.obj, p.kind); fixedEnts.push(p.ent); }
  for (const d of Object.values(L.desks)) desks[d.name] = { ...d, seat: new V3(d.seat[0], 0, d.seat[1]), tray: new V3(...d.tray), lampAt: new V3(...d.lamp), glow: refs['glow:' + d.name], chair: parts['chair:' + d.name].node, cz: d.chair[1], cs: { x: 0, v: 0 }, out: 0, gl: 0, light: null }; // out: 1 = the chair is turned to the lane, where its owner gets off and on
  doors = L.doors.map((d) => ({ ...d, node: parts['leaf:' + d.id].node, s: { x: RM ? 1 : 0, v: 0 } }));
  rooms.forEach((r) => {
    const bl = blocks[r.block], cx = (r.x0 + r.x1) / 2, top = r.block === 0 ? WALLH : INWALL;
    const sub = r.director ? '' : `<em>${r.hidden ? `${MAXDRAW} of ${r.live} live shown` : `${r.live} live`}</em>`;
    if (!r.director) fixedLabels.push(addLabel('lbl room' + (r.t ? ' pick' : ''), `<b>${esc(r.title)}</b>${sub}`, () => tmp.set(cx, top, bl.zb - 0.15), r.t ? { team: r.id } : null));
  });
  plots.forEach((t) => { const cx = (t.x0 + t.x1) / 2; fixedLabels.push(addLabel('lbl plot', `<b>${esc(t.name)}</b><em>${t.members} members · no one live</em>`, () => tmp.set(cx, 0, t.z1 - 0.15))); });
  bounds.set(new V3(-0.2, 0, zb0 - 0.2), new V3(W + 0.2, WALLH, ZF + 0.2));
  // lamp lights go to the first desks; the rest keep the glowing shade only
  const list = Object.values(desks).filter((d) => d.lit); lamps.forEach((l, i) => { const d = list[i]; if (d) { d.light = l; l.position.copy(d.lampAt); } else l.intensity = 0; });
  const c = bounds.getCenter(new V3()), span = Math.max(W, ZF - zb0) / 2 + 3;
  sunAt.copy(c); sun.target.position.copy(c); sun.position.copy(c).add(new V3(...LIGHTS[dark ? 'dark' : 'light'].dir).normalize().multiplyScalar(18)); sun.target.updateMatrixWorld(); // low, from the window side: the posts lay stripes across the floor
  Object.assign(sun.shadow.camera, { left: -span, right: span, top: span, bottom: -span, near: 1, far: 60 }); sun.shadow.camera.updateProjectionMatrix();
}
function applyTheme() {
  const l = LIGHTS[dark ? 'dark' : 'light']; sun.position.copy(sunAt).add(new V3(...l.dir).normalize().multiplyScalar(18));
  scene.background.setHex(pal().sky); hemi.color.setHex(l.hemi[0]); hemi.groundColor.setHex(l.hemi[1]); hemi.intensity = l.hemi[2]; sun.color.setHex(l.sun[0]); sun.intensity = l.sun[1]; POOL.glass.mat.opacity = l.glass;
  for (const lp of lamps) lp.visible = dark;
  for (const d of Object.values(desks)) if (d.light) d.light.intensity = l.lamp;
}
/** Furniture, rooms and plots again from the plan; every moving thing keeps its state and gets its boxes back. */
function rebuild() {
  for (const p of POOLS) p.reset(); statics.length = 0; for (const l of fixedLabels) dropLabel(l); fixedLabels = []; for (const e of fixedEnts) ents.delete(e); fixedEnts = [];
  buildStatic();
  for (const e of ents) if (!fixedEnts.includes(e)) { for (const vb of e.boxes) { vb.i = vb.pool.add(); paint(vb); } e._a = -1; }
  for (const c of Object.values(chars)) { const d = desks[c.a.name]; if (d) { d.out = c.desk.out; d.cs = c.desk.cs; d.gl = c.desk.gl; c.desk = d; } } // the desks are new objects: each person takes theirs again, chair turn and screen glow carried over
  applyTheme();
}

// ---------- blocky person: every part a box on a joint. Faces +z. ----------
function makeChar(o) {
  const g = node(null), hop = node(g), hips = node(hop, 0, LEG, 0), torso = node(hips, 0, HIPB, 0), head = node(torso, 0, TORSO[1] + NECK, 0); head.rotation.order = 'YXZ'; // yaw first, then nod about the ear axis: a turned head never rolls sideways
  const [hw, hh, hd] = HEAD, fz = hd / 2, P = { g, hop, hips, torso, head };
  P.ent = newEnt(g, () => {
    const tz = TORSO[2] / 2; box(hips, 0.38, HIPB + 0.02, 0.24, o.pants, 0, -0.02, 0); box(torso, TORSO[0], TORSO[1], TORSO[2], o.shirt); box(torso, 0.14, NECK + 0.01, 0.14, o.skin, 0, TORSO[1] - 0.01, 0);
    // what tells the roles apart besides the shirt: the director's tie and lapels, a lead's lanyard, a developer's hoodie pocket, a designer's chest stripe
    if (o.role === 'director') { box(torso, 0.07, 0.2, 0.01, 0xf2b04a, 0, 0.1, tz + 0.001); for (const s of [1, -1]) box(torso, 0.09, 0.2, 0.01, 0x54545f, s * 0.085, 0.11, tz); }
    if (o.role === 'lead') { box(torso, 0.02, 0.14, 0.01, 0xf4f4f4, 0.07, 0.16, tz); box(torso, 0.07, 0.085, 0.01, 0xf4f4f4, 0.07, 0.085, tz + 0.001); }
    if (o.role === 'dev') box(torso, 0.2, 0.09, 0.01, new THREE.Color(o.shirt).multiplyScalar(0.82).getHex(), 0, 0.03, tz);
    if (o.role === 'design') box(torso, TORSO[0], 0.05, TORSO[2] + 0.002, new THREE.Color(o.shirt).lerp(new THREE.Color(0xffffff), 0.35).getHex(), 0, 0.2, 0);
    box(head, hw, hh, hd, o.skin); box(head, hw + 0.03, 0.09, hd + 0.03, o.hair, 0, hh - 0.04, 0); box(head, hw + 0.03, 0.22, 0.08, o.hair, 0, hh - 0.24, -fz + 0.02); box(head, 0.06, 0.05, 0.03, o.skin, 0, 0.115, fz + 0.005);
    box(head, hw + 0.02, 0.06, 0.05, o.hair, 0, 0.26, fz - 0.01); for (const s of [1, -1]) { box(head, 0.04, 0.09, 0.08, o.skin, s * (hw / 2 + 0.01), 0.11, 0); box(head, 0.03, 0.13, 0.1, o.hair, s * (hw / 2), 0.2, -0.09); } // fringe, ears, hair in front of the ears
    if (o.acc === 'shades') box(head, 0.34, 0.085, 0.02, DARKB, 0, 0.15, fz + 0.01);
    else for (const s of [1, -1]) { // an eye: a white, a pupil that can look sideways; the whole eye closes to blink
      const eye = node(head, s * 0.085, 0.2, fz); box(eye, 0.075, 0.08, 0.012, 0xffffff, 0, -0.04, 0.004); const pu = node(eye, 0, 0, 0.012); box(pu, 0.04, 0.056, 0.012, DARKB, 0, -0.03, 0); P[s > 0 ? 'eyeL' : 'eyeR'] = eye; P[s > 0 ? 'puL' : 'puR'] = pu;
    }
    for (const s of [1, -1]) { const br = node(head, s * 0.085, 0.262, fz + 0.008); box(br, 0.09, 0.025, 0.016, o.hair, 0, -0.0125, 0); P[s > 0 ? 'browL' : 'browR'] = br; } // brows sit above shades too
    const mo = node(head, 0, 0.07, fz + 0.006); box(mo, 0.1, 0.022, 0.012, 0x7a3b33, 0, -0.011, 0); P.mouth = mo;
    if (o.acc === 'bun') box(head, 0.16, 0.14, 0.16, o.hair, 0, hh + 0.04, -0.1);
    if (o.acc === 'phones') { box(head, hw + 0.08, 0.05, 0.09, 0xe9e9ee, 0, hh + 0.05, 0); box(head, 0.05, 0.18, 0.14, 0xe9e9ee, hw / 2 + 0.035, 0.1, 0); box(head, 0.05, 0.18, 0.14, 0xe9e9ee, -hw / 2 - 0.035, 0.1, 0); }
    if (o.acc === 'glasses') { box(head, 0.36, 0.02, 0.014, DARKB, 0, 0.215, fz + 0.022); box(head, 0.02, 0.09, 0.014, DARKB, 0.175, 0.13, fz + 0.022); box(head, 0.02, 0.09, 0.014, DARKB, -0.175, 0.13, fz + 0.022); }
    if (o.acc === 'cap') { box(head, hw + 0.04, 0.1, hd + 0.04, 0x2a9d8f, 0, hh - 0.03, 0); box(head, 0.28, 0.03, 0.14, 0x2a9d8f, 0, hh - 0.03, fz + 0.08); }
    if (o.acc === 'beard') box(head, hw + 0.02, 0.1, 0.03, o.hair, 0, 0, fz);
    if (o.acc === 'long') { box(head, 0.05, 0.3, 0.26, o.hair, hw / 2 + 0.01, -0.02, -0.03); box(head, 0.05, 0.3, 0.26, o.hair, -hw / 2 - 0.01, -0.02, -0.03); }
    for (const s of [1, -1]) { // arm: shoulder, elbow, hand. leg: hip, knee, shoe
      const sh = node(torso, s * SHX, SHY, 0), el = node(sh, 0, -UARM, 0); sh.rotation.order = 'YXZ'; box(sh, 0.12, UARM, 0.14, o.shirt, 0, -UARM, 0); box(el, 0.11, FARM, 0.12, o.sleeve ? o.shirt : o.skin, 0, -FARM, 0); box(el, 0.12, HAND, 0.13, o.skin, 0, -FARM - HAND, 0); // shoulder: swing first, then turn inward (crossed arms)
      const hp = node(hips, s * LEGX, 0, 0), kn = node(hp, 0, -THIGH, 0); box(hp, 0.15, THIGH, LEGT, o.pants, 0, -THIGH, 0); box(kn, 0.14, SHIN, 0.14, o.pants, 0, -SHIN, 0); box(kn, 0.15, SHOE, 0.21, DARKB, 0, -SHIN - SHOE, 0.03);
      Object.assign(P, s > 0 ? { armL: sh, elL: el, legL: hp, knL: kn } : { armR: sh, elR: el, legR: hp, knR: kn });
    }
    P.mug = node(P.elR, 0, -FARM - HAND - 0.01, 0.1); P.mug.scale.setScalar(0.001); box(P.mug, 0.07, 0.08, 0.07, 0xf4f4f4, 0, -0.04, 0); // the coffee mug, in the right hand during a break
  }, 'person:' + o.name, 'person');
  return P;
}
function makeBubble() { const g = node(null); g.scale.setScalar(0); return { g, ent: newEnt(g, () => { ubox(g, 0.4, 0.26, 0.04, 0xffffff); ubox(g, 0.1, 0.1, 0.04, 0xffffff, -0.08, -0.05, 0, 0, 0, Math.PI / 4); [-0.1, 0, 0.1].forEach((x) => ubox(g, 0.05, 0.05, 0.02, DARKB, x, 0.105, 0.03)); }) }; }
function makeSign() { const g = node(null); g.scale.setScalar(0); return { g, ent: newEnt(g, () => { ubox(g, 0.26, 0.32, 0.05, 0xffb21e); ubox(g, 0.06, 0.14, 0.02, DARKB, 0, 0.14, 0.035); ubox(g, 0.06, 0.06, 0.02, DARKB, 0, 0.05, 0.035); }) }; }
function makeEnvelope(kind) { const g = node(null); return { g, ent: newEnt(g, () => { box(g, 0.3, 0.035, 0.2, 0xffffff); box(g, 0.3, 0.04, 0.06, KIND[kind] || KIND.info, 0, 0, -0.07); }) }; }
/** A line to walk: where you are after s metres, and which way you face there. */
function track(pts) {
  const P = pts.map((p) => new V3(p[0], 0, p[1])), at = [0]; for (let i = 1; i < P.length; i++) at.push(at[i - 1] + P[i].distanceTo(P[i - 1]));
  const seg = (s) => { let i = 1; while (i < P.length - 1 && at[i] < s) i++; return i; };
  return { len: at[at.length - 1], pos(s, out) { const i = seg(s); return out.lerpVectors(P[i - 1], P[i], clamp01((s - at[i - 1]) / Math.max(1e-6, at[i] - at[i - 1]))); }, yaw(s) { const i = seg(s); return Math.atan2(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z); } };
}

// the pose: one number per joint, each on its own spring. a = shoulder, e = elbow, l = hip, k = knee (negative swings forward; a knee bends back)
const JK = ['hip', 'lean', 'twist', 'roll', 'hp', 'hy', 'aL', 'aR', 'aLz', 'aRz', 'aLy', 'aRy', 'eL', 'eR', 'lL', 'lR', 'kL', 'kR', 'brow', 'squash'];
const chars = {}, couriers = [], trayEnvs = new Set(), breakers = {}; // breakers: room id -> who is at the coffee point (one at a time)
const endBreak = (c) => { for (const k in breakers) if (breakers[k] === c) delete breakers[k]; }; let fx = [], queue = [], seedN = 0;
const defOf = (a) => { const h = hash(a.name), boss = a.name === 'root'; return { name: a.name, skin: SKIN[boss ? 1 : h % 4], hair: HAIR[boss ? 3 : (h >>> 8) % 6], acc: boss ? 'shades' : ACCS[(h >>> 16) % ACCS.length], shirt: TINT[roleOf(a.name)], role: roleOf(a.name), sleeve: boss || roleOf(a.name) === 'lead', pants: [0x2d3142, 0x3b3f52, 0x4a3f38][(h >>> 22) % 3], seed: ++seedN }; };

class Char {
  constructor(a, desk) {
    Object.assign(this, { a, def: defOf(a), desk, state: a.state, mode: 'seat', talk: 0, speaking: false, notice: 0, moving: false, phase: 0, hopY: 0, yaw: 0, co: null, fa: null, onBreak: false, arriving: false, holding: false, swiv: false, air: false, trayEnv: null, trayT: 0, key: '', alpha: 1, rise: 0, gone: false, first: true });
    this.idleT = a.state === 'idle' && a.idleSince ? Math.max(0, (Date.now() - a.idleSince) / 1000) : 0; this.tookBreak = this.idleT >= BREAK_AFTER; // already idle for long when the page opened: no walk now
    this.pos = desk.seat.clone(); this.home = desk.seat.clone(); this.p = makeChar(this.def);
    this.j = {}; for (const k of JK) this.j[k] = { x: k === 'squash' ? 1 : 0, v: 0 };
    this.w = { type: 0, idle: 0, blk: 0, walk: 0, talk: 0, sip: 0 }; this.bubble = makeBubble(); this.sign = makeSign(); this.bs = { x: 0, v: 0 }; this.ss = { x: 0, v: 0 };
    this.anchor = new V3(this.pos.x, 1.4, this.pos.z);
    this.label = addLabel('lbl fig', '', () => tmp.copy(this.anchor), { n: a.name }); this.label.lift = 1;
    chars[a.name] = this;
  }
  busy() { return !!this.co || this.mode !== 'seat' || this.gone; }
  pose() {
    const P = { hip: 0, lean: 0, twist: 0, roll: 0, hp: 0, hy: 0, aL: 0.04, aR: 0.04, aLz: 0.02, aRz: 0.02, aLy: 0, aRy: 0, eL: -0.12, eR: -0.12, lL: 0, lR: 0, kL: 0, kR: 0, brow: 0, squash: 1 };
    if (this.mode === 'seat') {
      P.hip = SIT; P.lL = P.lR = -Math.PI / 2; P.kL = P.kR = Math.PI / 2;
      if (this.swiv) { P.aL = P.aR = -1.05; P.eL = P.eR = -0.9; } // turning the chair: hands up, clear of the desk edge
      else if (this.talk) { P.twist = this.talk > 0 ? 0.3 : -0.08; P.hy = this.talk > 0 ? 0.3 : -0.17; // the one who would turn away from the camera turns less, so the face stays visible
        P.aL = P.aR = -1.0; P.eL = P.eR = -1.0; if (this.speaking && RM) { P.aR = -1.0; P.eR = -1.5; P.aRz = 0.25; } }
      else if (this.state === 'working') { P.lean = 0.1; P.hp = 0.16; P.aL = P.aR = -1.05; P.eL = P.eR = -0.85; } // forearms level, hands over the keys
      else if (this.state === 'blocked') { P.lean = 0.17; P.hp = 0.55; P.aL = P.aR = -1.15; P.eL = P.eR = -2.2; P.aLz = P.aRz = -0.2; P.brow = 1; } // elbows forward, head down in both hands
      else { P.lean = -0.1; P.aL = -0.8; P.aR = -0.7; P.eL = -1.62; P.eR = -1.42; P.aLy = P.aRy = 1.1; } // idle: sits back, arms crossed. At a desk the hands never go below the desk top: on the way back up they would cut through it
      if (this.notice > 0 && !this.talk) { P.hy = 0.45; P.hp = 0.2; P.brow = -0.6; if (this.state === 'working') P.lean = 0.1; }
    }
    return P;
  }
  update(t) {
    const snap = RM;
    if (this.co && this.co.next().done) this.co = null;
    if (this.fa && this.fa.next().done) this.fa = null;
    if (this.notice > 0) this.notice -= DT;
    const seat = this.mode === 'seat', d = this.desk;
    // idle for two minutes: one coffee break, then sit and wait
    if (this.state !== 'idle') { this.idleT = 0; this.tookBreak = false; } else if (seat && !this.co) { this.idleT += DT; if (this.idleT >= BREAK_AFTER && !this.tookBreak && d.room.cooler && !breakers[d.room.id] && !this.gone) { this.tookBreak = true; breakers[d.room.id] = this; this.co = this.breakWalk(); } }
    const P = this.pose(), j = this.j, w = this.w, LP = LOOPS;
    for (const k of JK) { if (snap || this.first) { j[k].x = P[k]; j[k].v = 0; } else spring(j[k], P[k], DT, k === 'squash' ? 300 : 150, k === 'squash' ? 0.42 : 0.8); }
    const W = { type: seat && !this.talk && this.state === 'working' && this.notice <= 0, idle: seat && !this.talk && this.state === 'idle', blk: seat && this.state === 'blocked', walk: this.moving, talk: !!this.talk && this.speaking, sip: this.mode === 'sip' };
    for (const k in w) w[k] = snap || this.first ? +W[k] : damp(w[k], +W[k], 7, DT);
    this.first = false;
    const tt = t + this.def.seed * 7.3, burst = LP ? sstep(-0.9, -0.2, Math.sin(tt * 0.8) + Math.sin(tt * 0.31 + 1.7)) : 0;
    const tap = 0.24 * burst * w.type, sw = Math.sin(this.phase), cw = Math.cos(this.phase), lk = LP * look(tt);
    const swA = 0.4 * (1 - 0.7 * (this.turnK || 0)) * sw * w.walk; let aL = j.aL.x - swA, eL = j.eL.x - tap * Math.max(0, Math.sin(tt * 13)) - 0.35 * w.walk; // a key tap lifts the hand: it never dips into the desk
    let aR = j.aR.x + swA, eR = j.eR.x - tap * Math.max(0, Math.sin(tt * 13 + Math.PI)) - 0.35 * w.walk;
    let hp = j.hp.x + 0.03 * burst * w.type * Math.sin(tt * 6.5) + w.blk * LP * 0.03 * Math.sin(tt * 1.1);
    const hy = j.hy.x + w.idle * 0.4 * lk + w.type * LP * 0.08 * Math.sin(tt * 0.6) + w.blk * LP * 0.1 * Math.sin(tt * 1.5);
    const lL = j.lL.x + 0.6 * sw * w.walk, lR = j.lR.x - 0.6 * sw * w.walk; // the knee bends while its leg swings forward
    const kL = j.kL.x + 0.9 * Math.max(0, -cw) * w.walk - w.idle * LP * 0.1 * (0.5 + 0.5 * Math.sin(tt * 1.7)), kR = j.kR.x + 0.9 * Math.max(0, cw) * w.walk - w.idle * LP * 0.1 * (0.5 + 0.5 * Math.sin(tt * 1.7 + 2.2));
    const y = this.hopY + Math.abs(sw) * 0.04 * w.walk; let mouth = 0;
    let zL = 0, tw = 0, br = 0;
    if (this.talk && LP) { const u = this.gt || 0; // the design board's talk: the speaker makes three gestures of 0.9 s in a turn of 2.7 s, the listener nods every 1.6 s
      if (this.speaking) { const g = Math.min(2, Math.floor(u / 0.9)), v = u - g * 0.9, e = TALKK * backOut(v / 0.22) * (1 - sstep(0.66, 0.88, v));
        if (g === 0) { aL -= 1.0 * e; eL -= 0.85 * e; zL = 0.3 * e; } // open palm
        else if (g === 1) { aR -= 0.75 * e; eR -= (1.4 - 0.35 * Math.sin(v * 2 * Math.PI * 2.2)) * e; } // chop, twice
        else { aL -= 1.4 * e; tw = 0.12 * e * Math.sign(this.talk); } // point at the other
        br = 0.3 * e; hp += 0.1 * Math.sin(Math.PI * clamp01(v / 0.3)); mouth = clamp01(0.55 + 0.6 * Math.sin(t * 2 * Math.PI * 5.5) * Math.sin(t * 2 * Math.PI * 1.3 + 1)); }
      else { hp += 0.18 * Math.sin(Math.PI * clamp01(((t + this.def.seed) % 1.6) / 0.4)); br = 0.5; } }
    else if (w.talk > 0.01) mouth = 0.6 * w.talk;
    if (w.sip > 0.01) { const s = LP ? sstep(0.3, 0.7, Math.sin(tt * 1.3)) : 1; aR -= w.sip * (0.45 + 0.35 * s); eR -= w.sip * (1.15 + 0.7 * s); hp -= w.sip * 0.16 * s; }
    // the chair turns about its own middle and its owner rides it: person and chair stay one piece, so knees never cut the seat
    const ty = d.side * (Math.PI / 2) * d.out + (seat && this.talk && !this.swiv ? (this.talk > 0 ? 0.4 : -0.3) : 0), ry = snap ? ty : spring(d.cs, ty, DT, 110, 0.95); d.chair.rotation.y = ry; d.chair.position.z = d.cz - 0.075 * sstep(0, 0.3, Math.abs(ry)) * (1 - sstep(0.95, 1.5, Math.abs(ry))); // rolls back a little in mid turn, so a shoulder clears the desk edge
    if (seat && !this.air) { this.pos.set(d.chair.position.x + Math.sin(ry) * SITZ, 0, d.chair.position.z + Math.cos(ry) * SITZ); this.yaw = ry; }
    const p = this.p, s = j.squash.x, inv = 1 / Math.sqrt(Math.max(0.3, s));
    p.g.position.set(this.pos.x, this.rise, this.pos.z); p.g.rotation.y = this.yaw; p.hop.position.y = y; p.hop.scale.set(inv, s, inv);
    p.hips.position.y = LEG + j.hip.x; p.torso.rotation.set(j.lean.x + 0.07 * w.walk, j.twist.x + tw, j.roll.x + 0.04 * sw * w.walk); p.torso.scale.y = 1 + 0.014 * LP * Math.sin(tt * 1.8); // breathing: the chest, not the seat
    p.head.rotation.set(hp, Math.max(-0.45, Math.min(0.45, hy)), 0);
    const sa = seat ? -0.75 : 9; p.armL.rotation.set(Math.min(sa, aL), -j.aLy.x, j.aLz.x + zL); p.armR.rotation.set(Math.min(sa, aR), j.aRy.x, -j.aRz.x); const lv = (a) => (seat ? Math.min(0, -1.85 - Math.min(sa, a) - j.lean.x) : 0); p.elL.rotation.x = Math.min(lv(aL), eL); p.elR.rotation.x = Math.min(lv(aR), eR); // seated: the elbows stay above the desk top and a forearm never points below level, whatever the shoulder and the lean do (a spring that overshoots would dip it into the desk)
    p.legL.rotation.x = lL; p.legR.rotation.x = lR; p.knL.rotation.x = kL; p.knR.rotation.x = kR;
    if (p.eyeL) { // face: blink, look where the head turns, brows tell the mood
      const bl = LP && (tt / 3.7 + this.def.seed * 0.37) % 1 < 0.035 ? 0.12 : this.state === 'blocked' && seat ? 0.6 : 1, px = 0.014 * Math.max(-1, Math.min(1, w.idle * lk * 1.4 + j.hy.x * 2));
      p.eyeL.scale.y = p.eyeR.scale.y = bl; p.puL.position.x = p.puR.position.x = px;
    }
    const bw = j.brow.x + br; p.browL.rotation.z = -0.4 * bw; p.browR.rotation.z = 0.4 * bw; p.browL.position.y = p.browR.position.y = 0.262 + 0.012 * Math.abs(bw);
    p.mouth.scale.set(1 - 0.3 * mouth - 0.25 * w.blk, 1 + 3 * mouth + 1.2 * w.sip, 1); p.mug.scale.setScalar(this.holding ? 1 : 0.001);
    p.ent.alpha = this.alpha;
    const here = seat && !this.gone && this.alpha > 0.5; // the desk shows its owner's state only while the owner sits there
    const on = !here ? 0.12 : this.state === 'working' ? 0.6 + 0.4 * (LP ? burst : 1) : this.state === 'blocked' ? 0.7 + 0.3 * LP * Math.sin(tt * 2.2) : 0.22;
    d.gl = snap ? on : damp(d.gl, on, 6, DT); d.glow.pool.mesh.setColorAt(d.glow.i, _c.setHex(here && this.state === 'blocked' ? 0xffb21e : 0x8fd8ff).multiplyScalar(d.gl)); d.glow.pool.colDirty = true;
    if (this.trayEnv) { this.trayT -= DT; if (this.trayT < 0) { const k = RM ? 0 : 1 + this.trayT / 0.2; if (k <= 0) { if (RM) rmFade(); dropTray(this); } else this.trayEnv.g.scale.setScalar(k); } }
    p.g.updateMatrixWorld(true); p.head.getWorldPosition(this.anchor); this.anchor.y += HEAD[1] + 0.1; // the label hangs on the head: it goes where the person goes
    const top = this.anchor.y, show = (o, sp, vis, yy) => { const v = snap ? +vis : spring(sp, +vis, DT, 220, 0.5); if (v > 0.02 && this.alpha > 0.5) { o.g.position.set(this.anchor.x, yy, this.anchor.z); o.g.scale.setScalar(Math.max(0.001, v)); o.g.quaternion.copy(camera.quaternion); } else o.g.scale.setScalar(0); };
    show(this.bubble, this.bs, this.talk && this.speaking, top + 0.42); show(this.sign, this.ss, seat && this.state === 'blocked', top + 0.44 + 0.03 * LP * Math.sin(tt * 2.2));
    const lb = this.label; lb.el.style.opacity = this.alpha < 1 ? this.alpha.toFixed(2) : ''; lb.up = this.talk && this.speaking ? [0.42, 0.26] : seat && this.state === 'blocked' ? [0.47, 0.32] : null; // the bubble or the sign above the head: how far up it starts and how tall it is. The label goes above it
    const st = this.talk ? 'talk' : this.arriving ? 'in' : !seat || this.onBreak ? 'away' : this.state, me = this.a.name === sel, key = st + (me ? '|' + (this.a.model || '') : '') + (this.a.desk.alt ? 'a' : '');
    if (key !== this.key) { this.key = key; lb.w = 0; const boss = this.a.name === 'root';
      lb.el.className = 'lbl fig' + (this.a.desk.alt ? ' alt' : '') + (me ? ' sel' : '') + (boss ? ' dir' : ''); lb.el.dataset.s = st;
      lb.el.innerHTML = `<span><i class="g g-${st === 'in' ? 'away' : st}"></i><b>${boss ? 'Director' : esc(this.a.name)}</b></span><em>${boss ? 'root · ' : ''}${STATE_TEXT[st]}${me && this.a.model ? ' · ' + esc(this.a.model) : ''}</em>`; }
  }
  *appear() { const dur = RM ? 0.15 : 0.3; let u = 0; while (u < 1) { u = Math.min(1, u + DT / dur); this.alpha = u; this.rise = RM ? 0 : (sstep(0, 1, u) - 1) * 0.35; yield; } this.rise = 0; }
  *vanish() { const dur = RM ? 0.15 : 0.25; let u = 0; while (u < 1) { u = Math.min(1, u + DT / dur); this.alpha = 1 - u; this.rise = RM ? 0 : -sstep(0, 1, u) * 0.35; yield; } }
  *reseat() { yield* this.vanish(); this.co = null; endBreak(this); this.moving = false; this.onBreak = this.arriving = this.holding = this.swiv = this.air = false; this.hopY = 0; this.mode = 'seat'; this.desk.out = 0; this.desk.cs.x = this.desk.cs.v = 0; this.yaw = 0; this.pos.copy(this.desk.seat); this.key = ''; yield* this.appear(); }
  *leave() { yield* this.vanish(); endBreak(this); this.gone = true; }
  seatOut() { const d = this.desk; return new V3(d.chair.position.x + d.side * SITZ, 0, d.chair.position.z); } // where the owner sits while the chair is turned to the lane
  *swivel(o) { const d = this.desk; if (RM) { d.out = o; this.swiv = false; return; } this.swiv = true; if (o) yield* waitG(0.16); d.out = o; yield* waitG(0.45); if (!o) this.swiv = false; }
  *hop(to, yaw, mode, sw = 0.6, dur = 0.36, turnBy = 1) { // one hop: squash, arc, land. Used to leave and take a chair. sw = when in the hop the legs change between sitting and standing
    if (RM) { rmFade(); this.pos.copy(to); this.yaw = yaw; this.mode = mode; return; }
    const from = this.pos.clone(), y0 = this.yaw; this.air = true; if (this.mode !== 'seat') this.j.squash.x = 0.86; yield* waitG(0.08); // no squash on a chair: it would press the legs into the seat
    let u = 0, done = false; while (u < 1) { u = Math.min(1, u + DT / dur); const e = sstep(0, 1, u); this.pos.lerpVectors(from, to, e); this.hopY = Math.sin(Math.PI * u) * 0.24; this.yaw = lerpAngle(y0, yaw, sstep(0, turnBy, u)); if (!done && u > sw) { this.mode = mode; done = true; } yield; }
    this.hopY = 0; this.air = false; if (mode !== 'seat') { this.j.squash.x = 0.84; this.j.squash.v = 0; }
  }
  *walk(pts) { // along the line, speed eases in and out, steps follow the distance so feet do not slide
    const end = pts[pts.length - 1]; if (RM) { rmFade(); this.pos.set(end[0], 0, end[1]); return; }
    const tr = track(pts); let s = 0, v = 0; this.moving = true;
    while (s < tr.len) { const vt = Math.min(1.05, Math.sqrt(2 * 4 * (tr.len - s)) + 0.12); v += Math.sign(vt - v) * Math.min(Math.abs(vt - v), 4 * DT); const ds = v * DT; s = Math.min(tr.len, s + ds); this.phase += (ds / STRIDE) * Math.PI;
      tr.pos(s, this.pos); const y0 = this.yaw; this.yaw = dampAngle(this.yaw, tr.yaw(s), 12, DT); this.turnK = damp(this.turnK || 0, clamp01(Math.abs(lerpAngle(0, this.yaw - y0, 1)) / DT / 2.5), 10, DT); yield; } // turnK: how hard the walker turns; the arms swing less in a corner, so a hand stays inside the walkway
    this.turnK = 0;
    this.moving = false; this.phase = 0; this.j.squash.v -= 1;
  }
  *turn(yaw, d = 0.3) { if (RM) { this.yaw = yaw; return; } const y0 = this.yaw; let u = 0; while (u < 1) { u = Math.min(1, u + DT / d); this.yaw = lerpAngle(y0, yaw, sstep(0, 1, u)); yield; } }
  *breakWalk() { // off the chair, behind the row to the lane, out through the door, along the corridor to the coffee point, a mug, a few sips, and back
    const d = this.desk, r = d.room, path = breakPath(d), hop = new V3(d.hop[0], 0, d.hop[1]);
    breakers[r.id] = this; this.onBreak = true;
    try {
      if (RM) { const e = path[path.length - 1]; rmFade(); this.pos.set(e[0], 0, e[1]); this.yaw = 1.5; this.mode = 'sip'; this.holding = true; yield* waitG(4.2); rmFade(); this.holding = false; this.mode = 'seat'; return; } // reduced motion: stands at the coffee point with the mug, then is back in the chair; no walk
      yield* this.swivel(1); yield* this.hop(hop, Math.PI, 'stand');
      yield* this.walk(path);
      yield* this.turn(Math.PI); yield* waitG(0.45); this.holding = true; yield* this.turn(1.5, 0.5); this.mode = 'sip'; yield* waitG(3.6); this.mode = 'stand'; yield* waitG(0.3); // mug taken, then turns to the room to drink: the face is to the camera, the arm moves over the corridor
      yield* this.walk(path.slice().reverse()); this.holding = false; // the mug goes back on the desk
      this.swiv = true; yield* this.hop(this.seatOut(), d.side * Math.PI / 2, 'seat', 0.3, 0.5, 0.3); yield* this.swivel(0); // turns its back to the chair first, then the legs come up
    } finally { endBreak(this); this.onBreak = false; this.holding = false; }
  }
  *joinWalk() { // someone new walks in: along the corridor, through the door, to the chair
    const d = this.desk, path = joinPath(d, plan); this.arriving = true; this.mode = 'stand'; this.pos.set(path[0][0], 0, path[0][1]); this.yaw = -Math.PI / 2; d.out = 1; d.cs.x = d.side * Math.PI / 2; d.cs.v = 0;
    try { yield* this.walk(path); this.swiv = true; yield* this.hop(this.seatOut(), d.side * Math.PI / 2, 'seat', 0.3, 0.5, 0.3); yield* this.swivel(0); } finally { this.arriving = false; }
  }
}
function dropTray(c) { if (c.trayEnv) { dropEnt(c.trayEnv.ent); trayEnvs.delete(c.trayEnv); c.trayEnv = null; } }
function land(env, to) { env.g.position.copy(to.desk.tray); env.g.rotation.set(0, 0.2, 0); env.g.scale.setScalar(1); dropTray(to); to.trayEnv = env; trayEnvs.add(env); to.trayT = 3.4; to.notice = 1.4; }
function toss(env, to) { // the envelope flies the last bit onto the tray
  const p0 = env.g.position.clone(), r0 = env.g.rotation.x;
  fx.push((function* () { let u = 0; while (u < 1) { u = Math.min(1, u + DT / 0.32); env.g.position.lerpVectors(p0, to.desk.tray, u); env.g.position.y += Math.sin(Math.PI * u) * 0.45; env.g.rotation.set(r0 + (Math.PI * 2 - r0) * sstep(0, 1, u), 0.2 * u, 0); yield; } if (to.gone) dropEnt(env.ent); else land(env, to); })());
}

class Courier { // the messenger: a small box that carries one envelope in the colour of the message kind
  constructor(kind) {
    const g = node(null), b = node(g); g.scale.setScalar(0);
    this.ent = newEnt(g, () => { box(b, 0.26, 0.24, 0.26, KIND[kind] || KIND.info, 0, 0.06, 0); box(b, 0.09, 0.06, 0.13, DARKB, 0.07, 0, 0.01); box(b, 0.09, 0.06, 0.13, DARKB, -0.07, 0, 0.01); box(b, 0.045, 0.07, 0.02, 0x15161a, 0.06, 0.17, 0.131); box(b, 0.045, 0.07, 0.02, 0x15161a, -0.06, 0.17, 0.131); });
    this.env = makeEnvelope(kind); this.carry = true;
    Object.assign(this, { g, b, sc: { x: 0, v: 0 }, scT: 1, phase: 0, co: null, dead: false }); couriers.push(this);
  }
  update() {
    if (this.co && this.co.next().done) this.co = null;
    this.g.scale.setScalar(Math.max(0.001, spring(this.sc, this.scT, DT, 260, 0.5)));
    const a = Math.abs(Math.sin(this.phase)), s = 0.86 + 0.2 * a, inv = 1 / Math.sqrt(s); this.b.position.y = a * 0.2; this.b.scale.set(inv, s, inv);
    if (this.carry) { const e = this.env.g, k = this.g.scale.x; e.position.set(this.g.position.x, (this.b.position.y + 0.36 * s) * k, this.g.position.z); e.rotation.set(-0.25, this.g.rotation.y, 0, 'YXZ'); e.scale.setScalar(k); }
  }
}
function send(a, b, kind) {
  if (RM) { rmFade(); land(makeEnvelope(kind), b); return; } // reduced motion: the envelope is simply on the tray
  const c = new Courier(kind), tr = track(route(a.desk, b.desk, L.sideX));
  tr.pos(0, c.g.position); c.g.rotation.y = tr.yaw(0);
  c.co = (function* () {
    yield* waitG(0.18); let s = 0, v = 0;
    while (s < tr.len) { const vt = Math.min(2.2, Math.sqrt(2 * 8 * (tr.len - s)) + 0.3); v += Math.sign(vt - v) * Math.min(Math.abs(vt - v), 8 * DT); const ds = v * DT; s = Math.min(tr.len, s + ds); c.phase += (ds / 0.7) * Math.PI;
      tr.pos(s, c.g.position); c.g.rotation.y = dampAngle(c.g.rotation.y, tr.yaw(s), 14, DT); yield; }
    c.phase = 0; c.carry = false; toss(c.env, b);
    yield* waitG(0.14); c.scT = 0; yield* waitG(0.28); dropEnt(c.ent); c.dead = true;
  })();
}
const TURN = 2.7, TALKK = 1; // one speaker turn; TALKK scales the three gestures
function talk(a, b, dur = 5.4) {
  const dir = Math.sign(b.pos.x - a.pos.x) || 1; a.talk = dir; b.talk = -dir;
  a.co = (function* () { let t = 0; try { while (t < dur && !a.gone && !b.gone) { t += DT; const sp = Math.floor(t / TURN) % 2 === 0; a.speaking = sp; b.speaking = !sp; a.gt = b.gt = t % TURN; yield; } } finally { a.talk = b.talk = 0; a.speaking = b.speaking = false; } })(); b.co = waitG(dur);
}
/** One real message. Desk neighbours turn and talk; everyone else gets a courier. */
function deliver(m) {
  const a = chars[m.from], b = chars[m.to]; if (!a || !b || a.gone || b.gone) return;
  const A = a.desk, B = b.desk;
  if (A.room === B.room && A.row === B.row && Math.abs(A.x - B.x) < 2.1 && !a.busy() && !b.busy()) { talk(a, b); const e = makeEnvelope(m.kind); if (RM) { rmFade(); land(e, b); } else { e.g.position.set(a.pos.x, 1.0, a.pos.z); toss(e, b); } return; } // reduced motion: the two are turned to each other with the bubble, the envelope is on the tray
  send(a, b, m.kind);
}
/** Doors: the leaf slides open on a spring when a walker or a courier comes near, and closes behind them. Reduced motion: drawn open. */
function updateDoors() {
  for (const d of doors) {
    let near = false; const hit = (x, z) => Math.abs(x - d.x) < 0.7 && Math.abs(z - d.z) < 1.1;
    for (const c of Object.values(chars)) if (c.mode !== 'seat' && !c.gone && hit(c.pos.x, c.pos.z)) { near = true; break; }
    if (!near) for (const c of couriers) if (hit(c.g.position.x, c.g.position.z)) { near = true; break; }
    const o = RM ? 1 : clamp01(spring(d.s, +near, DT, 90, 0.9)); d.node.position.x = d.x + d.dir * SLIDE * o;
  }
}

// ---------- camera: orthographic, fixed three-quarter view; drag turns it a little, wheel pans, pinch zooms, Fit goes back ----------
const DIR = new V3(Math.cos(EL) * Math.sin(AZ), Math.sin(EL), Math.cos(EL) * Math.cos(AZ));
const view = { target: new V3(), half: 5 }, goal = { target: new V3(), half: 5 }, focus = new V3(); let aspect = 1.6, firstFit = true, controls = null;
function fitBox(b) { const c = b.getCenter(new V3()), r = new V3().crossVectors(new V3(0, 1, 0), DIR).normalize(), u = new V3().crossVectors(DIR, r).normalize(); let mx = 0, my = 0;
  for (let i = 0; i < 8; i++) { tmp.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).sub(c); mx = Math.max(mx, Math.abs(tmp.dot(r))); my = Math.max(my, Math.abs(tmp.dot(u))); }
  return { target: c, half: Math.max(my, mx / aspect) * 1.07 }; }
function viewBox() { // wide screens: the whole office. Narrow screens: one room (the picked agent's, else the first team room)
  if (aspect >= 1.2) return bounds;
  const picked = sel.startsWith('team:') ? plan.rooms.find((r) => r.id === sel.slice(5)) : plan.byName[sel] && plan.rooms.find((r) => r.id === plan.byName[sel].room);
  const r = picked || plan.rooms[1] || plan.rooms[0];
  return new THREE.Box3(new V3(r.x0 - 0.1, 0, r.zb - 0.15), new V3(r.x1 + 0.1, 1.6, r.z0 + 1.0));
}
function snapView() { view.target.copy(goal.target); view.half = goal.half; camera.zoom = 1; camera.position.copy(view.target).addScaledVector(DIR, 60); if (controls) { controls.target.copy(view.target); controls.update(); } else camera.lookAt(view.target); }
function setGoal() { const b = viewBox(), f = fitBox(b); goal.target.copy(f.target); goal.half = f.half; focus.set(f.target.x, 0.5, f.target.z - (aspect >= 1.2 ? 1.0 : 0.6)); if (firstFit || RM) { snapKeep(); firstFit = false; } }
function snapKeep() { tmp.copy(goal.target).sub(view.target); view.target.add(tmp); camera.position.add(tmp); if (controls) controls.target.add(tmp); view.half = goal.half; if (firstFit) snapView(); }

// ---------- tilt-shift: two blur passes; only the far top and bottom edges of the picture blur, and a zoomed-in view stays sharp ----------
let rtA = null, rtB = null, pr = Math.min(devicePixelRatio || 1, 1.5);
const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2)), quadScene = new THREE.Scene(), quadCam = new THREE.Camera(); quad.frustumCulled = false; quadScene.add(quad);
const blurMat = () => new THREE.ShaderMaterial({ depthTest: false, depthWrite: false, uniforms: { tDiffuse: { value: null }, uDir: { value: new THREE.Vector2() }, uFocus: { value: 0.5 }, uBand: { value: 0.36 }, uFeather: { value: 0.14 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D tDiffuse; uniform vec2 uDir; uniform float uFocus, uBand, uFeather; varying vec2 vUv;\nvoid main(){ float k = smoothstep(uBand, uBand + uFeather, abs(vUv.y - uFocus)); vec4 c = vec4(0.0); float ws = 0.0;\nfor (int i = -5; i <= 5; i++) { float f = float(i); float w = exp(-f * f / 10.0); c += texture2D(tDiffuse, vUv + uDir * f * 0.2 * k) * w; ws += w; }\ngl_FragColor = c / ws;\n#include <colorspace_fragment>\n}' });
const matH = blurMat(), matV = blurMat();
function resize() {
  const w = host.clientWidth, h = host.clientHeight; if (!w || !h || disposed) return; const Wp = Math.round(w * pr), Hp = Math.round(h * pr);
  renderer.setPixelRatio(1); renderer.setSize(Wp, Hp, false); aspect = w / h; lab.classList.toggle('sm', w < 560 || perf.agents > 14); // crowded or narrow: name and state mark only
  rtA && rtA.dispose(); rtB && rtB.dispose(); rtA = new THREE.WebGLRenderTarget(Wp, Hp, { samples: 4, colorSpace: THREE.SRGBColorSpace }); rtB = new THREE.WebGLRenderTarget(Wp, Hp, { depthBuffer: false, colorSpace: THREE.SRGBColorSpace });
  setGoal(); for (const l of labels) l.w = 0;
}
const perf = { ft: [], calls: 0, tris: 0, agents: 0, boxes: 0, dpr: pr };
function render(dtReal) {
  const k = RM ? 1 : 1 - Math.exp(-5 * dtReal); tmp.copy(goal.target).sub(view.target).multiplyScalar(k); view.target.add(tmp); controls.target.add(tmp); camera.position.add(tmp); view.half += (goal.half - view.half) * k;
  camera.top = view.half; camera.bottom = -view.half; camera.right = view.half * aspect; camera.left = -camera.right; camera.updateProjectionMatrix(); controls.update();
  const Wc = host.clientWidth, Hc = host.clientHeight;
  // a label that would not fit inside the view is not drawn at all (never cut by the edge); sideways it is pushed in. A person's label sits above the head, its pointer on the head.
  const ppu = (Hc * camera.zoom) / (2 * view.half), upK = Math.sin(controls.getPolarAngle()), hp = (0.42 / (2 * view.half)) * Hc, heads = []; // screen pixels per unit; a height above the floor shows shorter by upK, a sign that faces the camera does not
  // a head's size on screen; a person's label never covers another person's head: it goes up by its own height
  for (const l of labels) if (l.lift) { const v = l.anchor().project(camera); l.sx = (v.x * 0.5 + 0.5) * Wc; l.sy = (-v.y * 0.5 + 0.5) * Hc; if (Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05) heads.push(l); }
  for (const l of labels) { const v = l.anchor().project(camera); if (!l.w) { l.el.style.display = ''; l.w = l.el.offsetWidth; l.h = l.el.offsetHeight; l.off = null; }
    const hw = l.w / 2 + 4; let gap = !l.lift ? 0 : l.up ? (l.up[0] * upK + l.up[1]) * ppu + 6 : 7, hi = false; if (l.lift) { const y0 = l.sy - gap; for (const o of heads) if (o !== l && Math.abs(o.sx - l.sx) < l.w / 2 + hp / 2 && y0 > o.sy + hp * 0.25 && y0 - l.h < o.sy + hp * 1.15) { hi = true; break; } if (hi) gap += l.h + 6; if (hi !== l.hi) { l.hi = hi; l.el.classList.toggle('hi', hi); l.el.style.setProperty('--stem', (l.h + 11) + 'px'); } }
    const py = (-v.y * 0.5 + 0.5) * Hc - gap, top = py - (l.lift || 0) * l.h, off = Math.abs(v.x) > 1.02 || top < 40 || top + l.h > Hc - 28 || Wc < l.w + 8;
    if (off !== l.off) { l.off = off; l.el.style.display = off ? 'none' : ''; } if (off) continue;
    const px = Math.min(Wc - hw, Math.max(hw, (v.x * 0.5 + 0.5) * Wc));
    l.el.style.transform = `translate(${px.toFixed(1)}px,${py.toFixed(1)}px) translate(-50%,${(-(l.lift || 0) * 100).toFixed(0)}%)`; }
  renderer.info.reset(); renderer.setRenderTarget(rtA); renderer.render(scene, camera);
  const r = tilt ? 0.008 * rtA.height * clamp01((1.8 - camera.zoom) / 0.8) : 0, fy = tmp.copy(focus).project(camera).y * 0.5 + 0.5;
  matH.uniforms.tDiffuse.value = rtA.texture; matH.uniforms.uDir.value.set(r / rtA.width, 0); matH.uniforms.uFocus.value = fy; quad.material = matH; renderer.setRenderTarget(rtB); renderer.render(quadScene, quadCam);
  matV.uniforms.tDiffuse.value = rtB.texture; matV.uniforms.uDir.value.set(0, r / rtA.height); matV.uniforms.uFocus.value = fy; quad.material = matV; renderer.setRenderTarget(null); renderer.render(quadScene, quadCam);
  perf.calls = renderer.info.render.calls; perf.tris = renderer.info.render.triangles; perf.boxes = POOLS.reduce((n, p) => n + p.mesh.count, 0); perf.pools = Object.fromEntries(Object.entries(POOL).map(([k, p]) => [k, p.mesh.count]));
}
function tick(dt) {
  DT = dt; if (dt <= 0) return; T += dt;
  const now = performance.now(); queue = queue.filter((q) => now - q.at < 20000);
  while (queue.length && couriers.length < MAXCOURIERS) deliver(queue.shift().m);
  for (const c of Object.values(chars)) { c.update(T); if (c.gone) { dropEnt(c.p.ent); dropEnt(c.bubble.ent); dropEnt(c.sign.ent); dropTray(c); dropLabel(c.label); delete chars[c.a.name]; } }
  for (const c of couriers) c.update(); for (let i = couriers.length - 1; i >= 0; i--) if (couriers[i].dead) couriers.splice(i, 1);
  fx = fx.filter((g) => !g.next().done);
  updateDoors(); flushEnts();
}

// ---------- people from the plan ----------
function syncPeople(first) {
  const want = new Set(), had = Object.keys(chars).length, fresh = plan.agents.filter((a) => a.drawn && !chars[a.name]).length, walkIn = !first && !RM && had > 0 && fresh <= 3; // a page that is still loading its people seats them; only a real newcomer walks in
  for (const a of plan.agents) {
    if (!a.drawn) continue; want.add(a.name); const d = desks[a.name], c = chars[a.name];
    if (!c) { const n = new Char(a, d); if (!first) { n.alpha = 0; n.fa = n.appear(); if (walkIn) n.co = n.joinWalk(); } continue; }
    const moved = c.home.distanceTo(d.seat) > 0.05; c.home.copy(d.seat); c.a = a; c.state = a.state; c.desk = d; c.gone = false; c.key = '';
    if (moved) c.fa = c.reseat(); else if (c.fa && c.alpha < 1 && !c.co) c.fa = c.appear();
  }
  for (const c of Object.values(chars)) if (!want.has(c.a.name) && !c.leaving) { c.leaving = true; c.fa = c.leave(); }
  perf.agents = want.size; lab.classList.toggle('sm', host.clientWidth < 560 || want.size > 14);
}

// ---------- boot ----------
buildStatic(); applyTheme(); syncPeople(true);
{
  // wheel: ctrl/meta (trackpad pinch) zooms, plain wheel (two-finger scroll) pans. Registered before OrbitControls so it runs first.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault(); e.stopImmediatePropagation(); if (disposed) return;
    const m = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.clientHeight : 1, dx = e.deltaX * m, dy = e.deltaY * m;
    if (e.ctrlKey || e.metaKey) camera.zoom = Math.max(controls.minZoom, Math.min(controls.maxZoom, camera.zoom * Math.exp(-dy * 0.01)));
    else { const px = (2 * view.half) / camera.zoom / host.clientHeight, mv = new V3(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(dx * px).addScaledVector(new V3(0, 1, 0).applyQuaternion(camera.quaternion), -dy * px); camera.position.add(mv); controls.target.add(mv); }
    camera.updateProjectionMatrix(); controls.update(); wake();
  }, { passive: false });
  controls = new OrbitControls(camera, canvas);
  Object.assign(controls, { enableDamping: !RM, dampingFactor: 0.12, rotateSpeed: 0.5, screenSpacePanning: true, minZoom: 0.5, maxZoom: 5, minAzimuthAngle: AZ - 0.5, maxAzimuthAngle: AZ + 0.5, minPolarAngle: Math.PI / 2 - EL - 0.2, maxPolarAngle: Math.PI / 2 - EL + 0.22 });
}
resize(); DT = 0; for (const c of Object.values(chars)) c.update(0); flushEnts();

// ---------- loop: stops while the tab is hidden ----------
let raf = 0, last = performance.now();
const hud = new URLSearchParams(location.hash.split('?')[1] || '').get('hud') === '1' ? addLabel('hud', '', () => tmp.set(0, 0, 0)) : null; if (hud) labels.delete(hud);
function frame(now) {
  raf = 0; if (disposed) return; const ms = now - last, dt = Math.min(0.05, ms / 1000); last = now; tick(dt); render(dt);
  const ft = perf.ft; ft.push(ms); if (ft.length > 600) ft.shift();
  if (ft.length >= 60 && ft.length % 60 === 0) { const avg = ft.slice(-60).reduce((x, y) => x + y, 0) / 60; if (avg > 18.5 && pr > 1) { pr = Math.max(1, pr - 0.25); perf.dpr = pr; resize(); } // slow machine: fewer pixels before fewer frames
    if (hud) hud.el.textContent = `${(1000 / avg).toFixed(0)} fps · ${perf.calls} draw calls · ${perf.tris.toLocaleString('en')} triangles · ${perf.agents} people`; }
  schedule();
}
let held = false;
function schedule() { if (!raf && !held && !document.hidden && !disposed) raf = requestAnimationFrame(frame); }
function wake() { if (!raf) { last = performance.now(); schedule(); } }
document.addEventListener('visibilitychange', wake);
const ro = new ResizeObserver(() => { resize(); wake(); }); ro.observe(host);

// ---------- picking: a click on a person or its label, or on a team room's name ----------
let down = null;
const onDown = (e) => { down = [e.clientX, e.clientY]; };
const onUp = (e) => {
  const d = down; down = null; if (!d || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 6 || !opts.onPick) return;
  const rc = canvas.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top; let best = 40, who = '';
  for (const c of Object.values(chars)) { if (c.gone) continue; const v = tmp.set(c.pos.x, 0.7, c.pos.z).project(camera), dd = Math.hypot((v.x * 0.5 + 0.5) * rc.width - x, (-v.y * 0.5 + 0.5) * rc.height - y); if (dd < best) { best = dd; who = c.a.name; } }
  opts.onPick(who);
};
canvas.addEventListener('pointerdown', onDown); canvas.addEventListener('pointerup', onUp);
const onLab = (e) => { if (!opts.onPick) return; const f = e.target.closest?.('.fig'), r = e.target.closest?.('.room.pick'); if (f) opts.onPick(f.dataset.n); else if (r) opts.onPick('team:' + r.dataset.team); };
lab.addEventListener('click', onLab);
schedule();

return {
  perf, chars, couriers, get layout() { return L; },
  /** n frames of the real work, timed (for measuring only) */
  bench(n = 240) { const out = [], gl = renderer.getContext(), px = new Uint8Array(4); for (let i = 0; i < n; i++) { const t1 = performance.now(); tick(1 / 60); render(1 / 60); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); out.push(performance.now() - t1); } return out; },
  /** camera numbers (checks only) */
  cam() { return [camera.position.x, camera.position.y, camera.position.z, camera.zoom].map((v) => +v.toFixed(2)).join(' '); },
  /** put the camera where cam() said, looking down the fixed view (checks only) */
  setCam(s) { const [x, y, z, zoom] = String(s).split(' ').map(Number); camera.position.set(x, y, z); camera.zoom = zoom; controls.target.copy(camera.position).addScaledVector(DIR, -60); view.target.copy(controls.target); goal.target.copy(controls.target); camera.updateProjectionMatrix(); controls.update(); wake(); },
  /** stop the clock and draw exactly dt seconds later (frame strips only) */
  step(dt) { held = true; cancelAnimationFrame(raf); raf = 0; tick(dt); render(dt); },
  /** The overlap check on what is drawn right now: every box of the office and of every person, as placed, and every walk line against the furniture. Nothing may sit inside anything else. (checks only) */
  audit(detail) { // detail: name the two boxes of each hit (box number after #), to find what touches what
    const list = [];
    for (const vb of statics) if (vb.kind !== 'city') list.push({ obj: vb.obj, kind: vb.kind, m: Array.from(vb.local.elements) });
    for (const e of ents) { if (e.kind === 'fx' || e.alpha < 0.5) continue; e.root.updateMatrixWorld(true); for (const vb of e.boxes) list.push({ obj: e.obj, kind: e.kind, m: Array.from(_m.multiplyMatrices(vb.node.matrixWorld, vb.local).elements) }); }
    if (detail) { list.forEach((b, i) => { b.base = b.obj; b.obj += '#' + i; }); const base = (s) => s.replace(/#\d+$/, ''), r = overlaps(list), at = (n) => { const m = list[+n.split('#').pop()].m; return [m[12], m[13], m[14]].map((v) => +v.toFixed(2)).join(' ') + ' size ' + [Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10])].map((v) => +v.toFixed(2)).join('x'); }; return r.hits.filter((h) => base(h.a) !== base(h.b)).map((h) => ({ ...h, aAt: at(h.a), bAt: at(h.b) })); }
    const r = overlaps(list), furn = list.filter((b) => b.kind !== 'person' && b.kind !== 'door'), walks = walkPoints(L), ph = [];
    for (const d of L.doors) for (const b of L.boxes) if (b.ent === 'leaf:' + d.id) furn.push({ ...toABox(b, d.dir * SLIDE), obj: b.obj + ':open' }); // a walker meets the leaf slid open
    for (const g of walks) ph.push(...pathHits('walker ' + g.w + ' wide', g.pts, furn, [], g.w, g.w === WALKW ? WALKH : RUNH));
    return { people: perf.agents, objects: r.objects, boxes: r.boxes, pairsTested: r.pairs, overlaps: r.hits, walkLines: walks.reduce((n, g) => n + g.paths, 0), walkPoints: walks.reduce((n, g) => n + g.pts.length, 0), walkHits: ph,
      figBoxes: Math.min(...Object.values(chars).map((c) => c.p.ent.boxes.length)), armBoxes: Math.min(...Object.values(chars).map((c) => c.p.ent.boxes.filter((vb) => vb.node === c.p.armL || vb.node === c.p.armR || vb.node === c.p.elL || vb.node === c.p.elR).length)) }; // the fewest boxes any person is made of, and the fewest arm boxes: a figure that lost a part shows here
  },
  setSel(n) { sel = n || ''; for (const c of Object.values(chars)) c.key = ''; if (aspect < 1.2) setGoal(); wake(); },
  resetView() { setGoal(); snapView(); wake(); },
  setDark(d) { if (dark === !!d) return; dark = !!d; applyTheme(); for (const vb of statics) paint(vb); for (const e of ents) for (const vb of e.boxes) if (typeof vb.col === 'string') paint(vb); wake(); },
  setTilt(on) { tilt = !!on; wake(); },
  /** notes: team id -> the status of each open team task (at most 12 are drawn) */
  setNotes(n) { notes = n || {}; if (RM) rmFade(); rebuild(); wake(); },
  /** a new plan (someone joined or left, a team changed): furniture is rebuilt, people keep their state; someone new walks in through the door */
  setPlan(p) { if (RM) rmFade(); plan = p; rebuild(); syncPeople(false); setGoal(); wake(); },
  /** rows: name -> {state, model}; same layout, only the state changed */
  setState(rows) {
    let ch = false;
    for (const a of plan.agents) { const r = rows[a.name]; if (!r || (a.state === r.state && a.model === r.model)) continue; a.state = r.state; a.model = r.model; ch = true; const c = chars[a.name]; if (c) { c.state = r.state; c.key = ''; } }
    if (ch && RM) rmFade(); wake();
  },
  /** one real message: m = {from, to, kind}; skipped when either end has no desk in this office */
  pushMsg(m) { if (!chars[m.from] || !chars[m.to] || m.from === m.to) return; queue.push({ m, at: performance.now() }); if (queue.length > 30) queue.shift(); wake(); },
  dispose() {
    disposed = true; cancelAnimationFrame(raf); ro.disconnect(); controls.dispose(); document.removeEventListener('visibilitychange', wake);
    canvas.removeEventListener('pointerdown', onDown); canvas.removeEventListener('pointerup', onUp); lab.removeEventListener('click', onLab);
    for (const p of POOLS) p.dispose(); quad.geometry.dispose(); matH.dispose(); matV.dispose(); rtA?.dispose(); rtB?.dispose(); sun.shadow.map?.dispose();
    renderer.dispose(); renderer.forceContextLoss(); canvas.remove(); fadeCv?.remove(); lab.remove();
  },
};
}
