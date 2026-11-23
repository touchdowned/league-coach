/**
 * three.js view of the lane simulation. Game x maps to world x, game y to world z,
 * and up is +y. One world unit is one game unit, so ranges and hitboxes are true size.
 *
 * The camera copies League's broad setup: a perspective camera tilted steeply over
 * the ground, locked to your champion. Riot doesn't publish the exact numbers; the
 * pitch and field of view here are tuned so about 2,400 units of lane fit across a
 * 16:9 view, and zoom can be adjusted.
 */
import * as THREE from "three";
import type { LaneShot, LaneState, Team, Unit } from "../../../core/mechanics/lane";
import { LANE, timeToReachShot } from "./laneMath";
import type { Vec } from "../../../core/mechanics/sim";

const PITCH = (56 * Math.PI) / 180;
const FOV = 38;

const COLORS = {
  blue: 0x4f9dff,
  red: 0xff5a5f,
  you: 0x5cc8ff,
  ground: 0x1d2a1f,
  lane: 0x5a4a36,
  wall: 0x2b2f38,
  brush: 0x1f4d2b,
  move: 0x3ddc97,
};

interface UnitView {
  root: THREE.Group;
  body: THREE.Mesh;
  ring: THREE.Mesh;
  glow: THREE.Mesh | null;
  height: number;
}

interface ShotView {
  obj: THREE.Object3D;
  telegraph: THREE.Mesh | null;
}

export class LaneScene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private units = new Map<number, UnitView>();
  private shots = new Map<number, ShotView>();
  private moveMarker: THREE.Mesh;
  private moveMarkerAge = 99;
  private indicator: THREE.Mesh;
  private indicatorCircle: THREE.Mesh;
  private ghost: THREE.Line;
  private ghostAge = 99;
  private flashes: { obj: THREE.Mesh; age: number }[] = [];
  private raycaster = new THREE.Raycaster();
  private groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  zoom = 1;
  private camTarget = new THREE.Vector3();

  constructor(private canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.camera = new THREE.PerspectiveCamera(FOV, 16 / 9, 50, 12000);
    this.scene.background = new THREE.Color(0x0b0f0c);
    this.scene.fog = new THREE.Fog(0x0b0f0c, 3800, 7000);
    this.buildWorld();

    this.moveMarker = new THREE.Mesh(new THREE.RingGeometry(26, 36, 32), new THREE.MeshBasicMaterial({ color: COLORS.move, transparent: true, depthWrite: false }));
    this.moveMarker.rotation.x = -Math.PI / 2;
    this.moveMarker.position.y = 3;
    this.scene.add(this.moveMarker);

    this.indicator = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false }));
    this.indicator.rotation.x = -Math.PI / 2;
    this.indicator.visible = false;
    this.scene.add(this.indicator);
    this.indicatorCircle = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 64), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }));
    this.indicatorCircle.rotation.x = -Math.PI / 2;
    this.indicatorCircle.visible = false;
    this.scene.add(this.indicatorCircle);

    this.ghost = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: COLORS.move, dashSize: 30, gapSize: 20, transparent: true }));
    this.ghost.visible = false;
    this.scene.add(this.ghost);
  }

  private buildWorld() {
    const hemi = new THREE.HemisphereLight(0xdfeaff, 0x2a3320, 1.7);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1d6, 2.2);
    sun.position.set(-900, 2200, 1200);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera as THREE.OrthographicCamera;
    sc.left = -2600;
    sc.right = 2600;
    sc.top = 1600;
    sc.bottom = -1600;
    sc.far = 6000;
    sun.target.position.set(LANE.x1 / 2, 0, 0);
    this.scene.add(sun, sun.target);

    // Ground with a painted dirt lane, so depth and distance read at a glance.
    const tex = new THREE.CanvasTexture(groundCanvas());
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(LANE.x1 + 3000, 4000), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(LANE.x1 / 2, 0, 0);
    ground.receiveShadow = true;
    this.scene.add(ground);

    // Walls and brush beyond the lane edges.
    const rock = new THREE.MeshStandardMaterial({ color: COLORS.wall, roughness: 0.9, flatShading: true });
    const brush = new THREE.MeshStandardMaterial({ color: COLORS.brush, roughness: 1, flatShading: true });
    const rand = mulberry(7);
    for (let x = -400; x < LANE.x1 + 400; x += 170) {
      for (const side of [-1, 1]) {
        const h = 160 + rand() * 220;
        const r = new THREE.Mesh(new THREE.DodecahedronGeometry(140 + rand() * 90, 0), rock);
        r.position.set(x + rand() * 80, h * 0.35, side * (LANE.wall + 120 + rand() * 260));
        r.scale.y = h / 320;
        r.castShadow = true;
        r.receiveShadow = true;
        this.scene.add(r);
        if (rand() < 0.45) {
          const b = new THREE.Mesh(new THREE.IcosahedronGeometry(70 + rand() * 40, 0), brush);
          b.position.set(x + rand() * 120, 30, side * (LANE.halfWidth + 60 + rand() * 90));
          b.scale.y = 0.6;
          this.scene.add(b);
        }
      }
    }
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Ground point (game coordinates) under a screen position. */
  pick(clientX: number, clientY: number): Vec | null {
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, p)) return null;
    return { x: p.x, y: p.z };
  }

  /** Screen position (CSS px, relative to the canvas) of a point above the ground. */
  project(p: Vec, height: number): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(p.x, height, p.y).project(this.camera);
    return { x: ((v.x + 1) / 2) * this.canvas.clientWidth, y: ((1 - v.y) / 2) * this.canvas.clientHeight, visible: v.z < 1 };
  }

  showMoveMarker(p: Vec) {
    this.moveMarker.position.set(p.x, 3, p.y);
    this.moveMarkerAge = 0;
  }

  showGhost(from: Vec, to: Vec) {
    this.ghost.geometry.setFromPoints([new THREE.Vector3(from.x, 6, from.y), new THREE.Vector3(to.x, 6, to.y)]);
    this.ghost.computeLineDistances();
    this.ghostAge = 0;
  }

  /** Skillshot indicator while a key is held (quick cast with indicator). */
  setIndicator(from: Vec | null, to: Vec | null, a: { shape: string; range: number; width: number } | null) {
    this.indicator.visible = false;
    this.indicatorCircle.visible = false;
    if (!from || !to || !a) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const d = Math.hypot(dx, dy) || 1;
    if (a.shape === "circle") {
      const reach = Math.min(d, a.range);
      this.indicatorCircle.position.set(from.x + (dx / d) * reach, 4, from.y + (dy / d) * reach);
      this.indicatorCircle.scale.set(a.width, a.width, 1);
      this.indicatorCircle.visible = true;
    } else {
      this.indicator.scale.set(a.range, a.width, 1);
      this.indicator.position.set(from.x + (dx / d) * (a.range / 2), 4, from.y + (dy / d) * (a.range / 2));
      this.indicator.rotation.z = -Math.atan2(dy, dx);
      this.indicator.visible = true;
    }
  }

  burst(p: Vec, color: number) {
    const m = new THREE.Mesh(new THREE.RingGeometry(10, 22, 32), new THREE.MeshBasicMaterial({ color, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(p.x, 60, p.y);
    this.scene.add(m);
    this.flashes.push({ obj: m, age: 0 });
  }

  render(s: LaneState, dt: number, youId: number) {
    this.syncUnits(s, youId);
    this.syncShots(s);

    // Locked camera that eases onto your champion.
    const me = s.units.find((u) => u.id === youId);
    if (me) this.camTarget.lerp(new THREE.Vector3(me.pos.x, 0, me.pos.y), Math.min(1, dt * 10));
    const dist = 2350 * this.zoom;
    this.camera.position.set(this.camTarget.x, Math.sin(PITCH) * dist, this.camTarget.z + Math.cos(PITCH) * dist);
    this.camera.lookAt(this.camTarget);

    this.moveMarkerAge += dt;
    const mk = this.moveMarker.material as THREE.MeshBasicMaterial;
    mk.opacity = Math.max(0, 1 - this.moveMarkerAge / 0.45);
    this.moveMarker.scale.setScalar(1.3 - Math.min(1, this.moveMarkerAge / 0.45) * 0.5);

    this.ghostAge += dt;
    this.ghost.visible = this.ghostAge < 1.1;
    (this.ghost.material as THREE.LineDashedMaterial).opacity = Math.max(0, 1 - this.ghostAge / 1.1);

    for (const f of this.flashes) {
      f.age += dt;
      f.obj.scale.setScalar(1 + f.age * 10);
      (f.obj.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 1 - f.age / 0.35);
    }
    for (const f of this.flashes.filter((x) => x.age > 0.35)) {
      this.scene.remove(f.obj);
      disposeObj(f.obj);
    }
    this.flashes = this.flashes.filter((x) => x.age <= 0.35);

    this.renderer.render(this.scene, this.camera);
  }

  private syncUnits(s: LaneState, youId: number) {
    const live = new Set<number>();
    for (const u of s.units) {
      live.add(u.id);
      let v = this.units.get(u.id);
      if (!v) {
        v = makeUnit(u, u.id === youId);
        this.units.set(u.id, v);
        this.scene.add(v.root);
      }
      v.root.visible = !u.dead;
      v.root.position.set(u.pos.x, 0, u.pos.y);
      v.root.rotation.y = -Math.atan2(u.facing.y, u.facing.x);
      // Wind-up is the tell: the body leans in and the weapon glows.
      const wind = u.winding > 0 ? 1 - u.winding / Math.max(u.windup, 0.01) : 0;
      v.body.rotation.z = -0.35 * wind;
      if (v.glow) {
        v.glow.visible = u.winding > 0 || u.casting > 0;
        v.glow.scale.setScalar(0.6 + 0.8 * (u.casting > 0 ? 1 : wind));
      }
    }
    for (const [id, v] of this.units) {
      if (!live.has(id)) {
        this.scene.remove(v.root);
        disposeObj(v.root);
        this.units.delete(id);
      }
    }
  }

  unitHeight(id: number) {
    return this.units.get(id)?.height ?? 150;
  }

  private syncShots(s: LaneState) {
    const live = new Set<number>();
    for (const shot of s.shots) {
      live.add(shot.id);
      let v = this.shots.get(shot.id);
      if (!v) {
        v = makeShot(shot);
        this.shots.set(shot.id, v);
        this.scene.add(v.obj);
        if (v.telegraph) this.scene.add(v.telegraph);
      }
      updateShot(v, shot);
    }
    for (const [id, v] of this.shots) {
      if (!live.has(id)) {
        this.scene.remove(v.obj);
        if (v.telegraph) this.scene.remove(v.telegraph);
        disposeObj(v.obj);
        if (v.telegraph) disposeObj(v.telegraph);
        this.shots.delete(id);
      }
    }
  }

  dispose() {
    this.scene.traverse((o) => disposeObj(o, false));
    this.renderer.dispose();
  }
}

function teamColor(team: Team, isYou: boolean) {
  return isYou ? COLORS.you : team === "blue" ? COLORS.blue : COLORS.red;
}

/** Original stylised figures: champions are hooded casters with a weapon, minions are squat and small. */
function makeUnit(u: Unit, isYou: boolean): UnitView {
  const color = teamColor(u.team, isYou);
  const root = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x15181f, roughness: 0.8 });
  const body = new THREE.Mesh();
  let height: number;
  let glow: THREE.Mesh | null = null;
  const fig = new THREE.Group();
  if (u.kind === "champ") {
    height = 240;
    fig.scale.setScalar(1.25);
    const pads = new THREE.Mesh(new THREE.SphereGeometry(24, 10, 8), mat);
    pads.position.set(0, 138, 40);
    const pads2 = pads.clone();
    pads2.position.z = -40;
    fig.add(pads, pads2);
    const robe = new THREE.Mesh(new THREE.ConeGeometry(58, 150, 10), mat);
    robe.position.y = 75;
    const head = new THREE.Mesh(new THREE.SphereGeometry(30, 16, 12), dark);
    head.position.y = 168;
    const hood = new THREE.Mesh(new THREE.ConeGeometry(36, 60, 10), mat);
    hood.position.y = 190;
    const staff = new THREE.Mesh(new THREE.CylinderGeometry(5, 5, 170, 6), dark);
    staff.position.set(42, 95, 28);
    glow = new THREE.Mesh(new THREE.SphereGeometry(18, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfff2c4 }));
    glow.position.set(42, 185, 28);
    glow.visible = false;
    fig.add(robe, head, hood, staff, glow);
  } else {
    height = u.kind === "melee" ? 95 : 105;
    const b = new THREE.Mesh(u.kind === "melee" ? new THREE.BoxGeometry(70, 70, 70) : new THREE.CylinderGeometry(26, 38, 80, 8), mat);
    b.position.y = 40;
    const h = new THREE.Mesh(new THREE.SphereGeometry(22, 10, 8), dark);
    h.position.y = 92;
    fig.add(b, h);
    if (u.kind === "caster") {
      const orb = new THREE.Mesh(new THREE.SphereGeometry(10, 8, 6), new THREE.MeshBasicMaterial({ color }));
      orb.position.set(30, 70, 0);
      fig.add(orb);
    }
  }
  fig.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
  });
  body.add(fig);
  root.add(body);

  // Selection ring = the gameplay hitbox, as in the game.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(u.radius - 6, u.radius, 48),
    new THREE.MeshBasicMaterial({ color: u.kind === "champ" ? (isYou ? COLORS.move : COLORS.red) : color, transparent: true, opacity: u.kind === "champ" ? 0.9 : 0.35, depthWrite: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 2;
  root.add(ring);
  return { root, body, ring, glow, height };
}

function makeShot(shot: LaneShot): ShotView {
  const enemyShot = shot.team === "red";
  const color = enemyShot ? 0xff7a6b : 0x7fd8ff;
  const a = shot.ability;
  if (a.shape === "circle") {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(a.width - 10, a.width, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    const fill = new THREE.Mesh(new THREE.CircleGeometry(a.width, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, depthWrite: false }));
    fill.rotation.x = -Math.PI / 2;
    fill.name = "fill";
    g.add(ring, fill);
    g.position.set(shot.target.x, 4, shot.target.y);
    return { obj: g, telegraph: null };
  }
  // Line: a glowing bolt with a trail.
  const g = new THREE.Group();
  const core = new THREE.Mesh(new THREE.SphereGeometry(Math.max(18, a.width / 2), 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  const halo = new THREE.Mesh(new THREE.SphereGeometry(Math.max(28, a.width / 2 + 14), 16, 12), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, depthWrite: false }));
  const trail = new THREE.Mesh(new THREE.PlaneGeometry(1, a.width), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide }));
  trail.rotation.x = -Math.PI / 2;
  trail.name = "trail";
  g.add(core, halo, trail);
  g.position.y = 90;
  g.visible = false;
  return { obj: g, telegraph: null };
}

function updateShot(v: ShotView, shot: LaneShot) {
  const a = shot.ability;
  if (a.shape === "circle") {
    const land = timeToReachShot(shot);
    const k = Math.min(1, shot.age / Math.max(land, 0.01));
    const fill = v.obj.getObjectByName("fill");
    if (fill) fill.scale.setScalar(Math.max(0.02, k));
    return;
  }
  if (shot.age < a.delay) {
    v.obj.visible = false;
    return;
  }
  v.obj.visible = true;
  const tip = { x: shot.origin.x + shot.dir.x * shot.travelled, y: shot.origin.y + shot.dir.y * shot.travelled };
  v.obj.position.set(tip.x, 90, tip.y);
  v.obj.rotation.y = -Math.atan2(shot.dir.y, shot.dir.x);
  const trail = v.obj.getObjectByName("trail");
  if (trail) {
    const l = Math.min(260, shot.travelled);
    trail.scale.x = Math.max(1, l);
    trail.position.set(-l / 2, -86, 0);
  }
}

function groundCanvas(): HTMLCanvasElement {
  const W = 2048;
  const H = 1024;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  // Mapped onto a (LANE.x1 + 3000) x 4000 plane centred on the lane.
  g.fillStyle = "#2a3b28";
  g.fillRect(0, 0, W, H);
  const rand = mulberry(3);
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = `rgba(${40 + rand() * 30}, ${60 + rand() * 40}, ${35 + rand() * 20}, ${0.25 + rand() * 0.3})`;
    g.fillRect(rand() * W, rand() * H, 2 + rand() * 6, 2 + rand() * 6);
  }
  const laneHalf = (LANE.halfWidth / 4000) * H;
  const grad = g.createLinearGradient(0, H / 2 - laneHalf * 1.25, 0, H / 2 + laneHalf * 1.25);
  grad.addColorStop(0, "rgba(90,74,54,0)");
  grad.addColorStop(0.12, "rgba(98,80,58,0.95)");
  grad.addColorStop(0.88, "rgba(98,80,58,0.95)");
  grad.addColorStop(1, "rgba(90,74,54,0)");
  g.fillStyle = grad;
  g.fillRect(0, H / 2 - laneHalf * 1.25, W, laneHalf * 2.5);
  for (let i = 0; i < 5000; i++) {
    g.fillStyle = `rgba(${120 + rand() * 40}, ${100 + rand() * 30}, ${70 + rand() * 20}, ${0.15 + rand() * 0.2})`;
    g.fillRect(rand() * W, H / 2 - laneHalf + rand() * laneHalf * 2, 2 + rand() * 5, 2 + rand() * 4);
  }
  return c;
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function disposeObj(o: THREE.Object3D, deep = true) {
  const visit = (x: THREE.Object3D) => {
    const m = x as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
    else mat?.dispose();
  };
  if (deep) o.traverse(visit);
  else visit(o);
}
