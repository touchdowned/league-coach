/**
 * League replay camera <-> screen.
 *
 * The Replay API reports the camera as a position (x, height, z), where x/z are the
 * same map units as Riot's match data (x, y), plus a rotation in degrees: rotation.x is
 * yaw around the vertical axis (0 = looking toward +z, "north" on the minimap),
 * rotation.y is pitch down from horizontal. fieldOfView is the vertical field of view.
 * Those conventions were checked against screenshots of a real replay (see
 * docs/research/guided-review.md); `CAMERA` holds them so a single place changes if a
 * patch moves them.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Cam {
  pos: Vec3;
  /** Degrees. x = yaw, y = pitch down. */
  rot: Vec3;
  fov: number;
}

export const CAMERA = {
  /** Field of view is measured vertically (true) or horizontally (false). */
  verticalFov: true,
  /** Ground height used when projecting map points (Summoner's Rift floor is about here). */
  ground: 0,
  /** Sign of yaw: +1 means a positive yaw turns the view from +z toward +x. */
  yawSign: 1,
};

const rad = (d: number) => (d * Math.PI) / 180;

function basis(c: Cam) {
  const yaw = rad(c.rot.x) * CAMERA.yawSign;
  const pitch = rad(c.rot.y);
  const f = { x: Math.sin(yaw) * Math.cos(pitch), y: -Math.sin(pitch), z: Math.cos(yaw) * Math.cos(pitch) };
  // Right is horizontal and perpendicular to forward; up completes the frame.
  const r = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
  // Make sure "up" points up on screen.
  if (u.y < 0) {
    u.x = -u.x;
    u.y = -u.y;
    u.z = -u.z;
  }
  return { f, r, u };
}

const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;

/**
 * Projects a map point (Riot x/y) to viewport pixels. Null when it's behind the camera.
 * `w`/`h` are the size of the picture showing the replay.
 */
export function project(c: Cam, p: { x: number; y: number }, w: number, h: number, height = CAMERA.ground): { x: number; y: number; depth: number } | null {
  const { f, r, u } = basis(c);
  const d = { x: p.x - c.pos.x, y: height - c.pos.y, z: p.y - c.pos.z };
  const zc = dot(d, f);
  if (zc <= 1) return null;
  const aspect = w / h;
  const tv = CAMERA.verticalFov ? Math.tan(rad(c.fov) / 2) : Math.tan(rad(c.fov) / 2) / aspect;
  const th = tv * aspect;
  const nx = dot(d, r) / (zc * th);
  const ny = dot(d, u) / (zc * tv);
  return { x: (nx * 0.5 + 0.5) * w, y: (0.5 - ny * 0.5) * h, depth: zc };
}

/** A camera that frames map point `p` from `height` up at the given pitch and yaw. */
export function cameraLookingAt(p: { x: number; y: number }, height = 2200, pitch = 56, yaw = 0): { cameraPosition: Vec3; cameraRotation: Vec3 } {
  const back = height / Math.tan(rad(pitch));
  const y = rad(yaw) * CAMERA.yawSign;
  return {
    cameraPosition: { x: p.x - Math.sin(y) * back, y: height, z: p.y - Math.cos(y) * back },
    cameraRotation: { x: yaw, y: pitch, z: 0 },
  };
}

/** Camera height that keeps two map points (and some margin) in view. */
export function heightToFrame(a: { x: number; y: number }, b: { x: number; y: number }, fov = 40, min = 1900, max = 4200): number {
  const span = Math.hypot(a.x - b.x, a.y - b.y) + 1400;
  const h = span / 2 / Math.tan(rad(fov) / 2);
  return Math.max(min, Math.min(max, h * 0.62));
}
