import { encodeMask, decodeMask } from '../core/HashCodec.js';

/**
 * Rigid bodies for Airfoil mode. Every painted blob (or generated NACA section) becomes a body that the
 * water pushes around by the pressure force integrated over its voxel faces plus the wall shear (skin
 * friction) across them. Anchors pin a body point in space (one anchor = a pivot the body may swing about,
 * two = fixed); springs tether a body point to a world point and read the force out through their
 * extension, with hard minimum/maximum lengths.
 * Positions are physical (Lx = 2, Ly = 1, cell size h = hx = hy); shapes are local binary images sampled
 * nearest-neighbour under the rigid transform, so a rotated body never opens holes. Each image remembers
 * the cell size it was drawn at (hImg) so a rig restored on another grid keeps its physical size.
 * The rig writes the composed mask into the BarrierField and hands the solver the solid-cell velocity, and
 * serializes to / from plain JSON so it travels with the design.
 */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const zero = () => ({ x: 0, y: 0, t: 0 });

/** Cell count, centroid (image coordinates) and second moment of a binary image. */
function moments(img, w, h) {
  let cnt = 0,
    sx = 0,
    sy = 0;
  for (let b = 0; b < h; b++)
    for (let a = 0; a < w; a++)
      if (img[a + b * w]) {
        cnt++;
        sx += a + 0.5;
        sy += b + 0.5;
      }
  if (!cnt) return null;
  const cx = sx / cnt,
    cy = sy / cnt;
  let I2 = 0;
  for (let b = 0; b < h; b++)
    for (let a = 0; a < w; a++) if (img[a + b * w]) I2 += (a + 0.5 - cx) ** 2 + (b + 0.5 - cy) ** 2;
  return { cnt, cx, cy, I2 };
}

/** NACA 4-digit section as a closed polygon in chord units (LE at the origin, chord along +x, ~2n points). */
export function nacaSection(code = '2412', n = 40) {
  const s = String(code).replace(/\D/g, '').padStart(4, '0').slice(0, 4);
  const m = +s[0] / 100,
    p = +s[1] / 10,
    t = Math.max(0.02, +s.slice(2) / 100);
  const up = [],
    lo = [];
  for (let q = 0; q <= n; q++) {
    const x = 0.5 * (1 - Math.cos((Math.PI * q) / n)); // cosine spacing clusters points at the nose
    const yt =
      5 *
      t *
      (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4); // −0.1036 closes the trailing edge
    let yc = 0,
      dyc = 0;
    if (m > 0 && p > 0) {
      if (x < p) {
        yc = (m / (p * p)) * (2 * p * x - x * x);
        dyc = ((2 * m) / (p * p)) * (p - x);
      } else {
        yc = (m / (1 - p) ** 2) * (1 - 2 * p + 2 * p * x - x * x);
        dyc = ((2 * m) / (1 - p) ** 2) * (p - x);
      }
    }
    const th = Math.atan(dyc),
      sx = yt * Math.sin(th),
      sy = yt * Math.cos(th);
    up.push([x - sx, yc + sy]);
    lo.push([x + sx, yc - sy]);
  }
  lo.reverse();
  return up.concat(lo.slice(1, -1));
}

/** Scanline fill of a polygon given in image cell coordinates. */
function rasterPoly(pts, w, h, img) {
  for (let j = 0; j < h; j++) {
    const y = j + 0.5,
      xs = [];
    for (let n = 0; n < pts.length; n++) {
      const a = pts[n],
        b = pts[(n + 1) % pts.length];
      if (a[1] > y !== b[1] > y) xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
    }
    xs.sort((p, q) => p - q);
    for (let m = 0; m + 1 < xs.length; m += 2)
      for (let i = Math.max(0, Math.ceil(xs[m] - 0.5)); i + 0.5 <= xs[m + 1] && i < w; i++)
        img[i + j * w] = 1;
  }
}

export class RigidBodyRig {
  constructor(barrier) {
    this.barrier = barrier;
    this.grid = null;
    this.bodies = [];
    this.springs = [];
    this.nextId = 1;
    this.density = 2;
    this.damping = 0.5;
    this.kHard = 20; // hard length limits act as a spring kHard× stiffer (capped for stability)
    this.skinFriction = true; // add the wall shear over exposed faces to the pressure force
    this.time = 0;
    this.moving = false;
    this.lastBaked = null;
    this.onEvent = null;
    const n = barrier.Nx * barrier.Ny;
    this.owner = new Int16Array(n);
    this.bu = new Float32Array(n);
    this.bv = new Float32Array(n);
    this._prev = new Uint8Array(n);
  }
  setGrid(grid) {
    this.grid = grid;
  }
  get h() {
    return 2 / this.barrier.Nx;
  }
  get Lz() {
    return this.grid ? this.grid.Lz : 0.2;
  }

  /* ---------------- bodies ---------------- */
  /** Body from an image placed at grid cell (i0, j0) on the current grid. */
  _body(img, w, h, i0, j0, extra = {}) {
    const m = moments(img, w, h);
    if (!m) return null;
    const hh = this.h;
    return this._make({
      img,
      w,
      h,
      hImg: hh,
      ...m,
      x: (i0 + m.cx) * hh,
      y: (j0 + m.cy) * hh,
      name: extra.name,
      chord: extra.chord ?? w * hh,
      density: this.density,
    });
  }
  /** Assemble a body record; `d.hImg` is the cell size the image was drawn at, `d.cnt/cx/cy/I2` its moments. */
  _make(d) {
    const hh = d.hImg,
      rho = d.density * this.Lz * hh * hh; // mass per image cell (fluid density 1)
    const id = d.id ?? this.nextId++;
    if (id >= this.nextId) this.nextId = id + 1;
    const body = {
      id,
      name: d.name || `body ${id}`,
      img: d.img,
      w: d.w,
      h: d.h,
      hImg: hh,
      cx: d.cx,
      cy: d.cy,
      cells: d.cnt,
      painted: d.cnt,
      chord: d.chord,
      density: d.density,
      x: d.x,
      y: d.y,
      th: d.th || 0,
      vx: 0,
      vy: 0,
      om: 0,
      mass: rho * d.cnt,
      I: rho * hh * hh * Math.max(d.I2, d.cnt / 6),
      anchors: [],
      F: zero(),
      Fp: zero(),
      Fv: zero(),
      Fs: zero(),
      Favg: zero(),
      Fpavg: zero(),
      Fvavg: zero(), // total / pressure / viscous fluid force, spring force, smoothed copies
    };
    this.bodies.push(body);
    return body;
  }
  /** Bounding radius in physical units (image extent under any rotation, plus one cell). */
  _radius(b) {
    return 0.5 * Math.hypot(b.w, b.h) * (b.hImg || this.h) + this.h;
  }
  /** Split a painted mask into 4-connected components, each becoming a free body. */
  adopt(mask) {
    this.bodies = [];
    this.springs = [];
    this.moving = false;
    const Nx = this.barrier.Nx,
      Ny = this.barrier.Ny,
      seen = new Uint8Array(Nx * Ny),
      stack = [];
    for (let s = 0; s < Nx * Ny; s++) {
      if (!mask[s] || seen[s]) continue;
      const cells = [];
      stack.push(s);
      seen[s] = 1;
      while (stack.length) {
        const n = stack.pop();
        cells.push(n);
        const i = n % Nx,
          j = (n / Nx) | 0;
        for (const m of [
          i > 0 ? n - 1 : -1,
          i < Nx - 1 ? n + 1 : -1,
          j > 0 ? n - Nx : -1,
          j < Ny - 1 ? n + Nx : -1,
        ])
          if (m >= 0 && mask[m] && !seen[m]) {
            seen[m] = 1;
            stack.push(m);
          }
      }
      let i0 = Nx,
        i1 = -1,
        j0 = Ny,
        j1 = -1;
      for (const n of cells) {
        const i = n % Nx,
          j = (n / Nx) | 0;
        if (i < i0) i0 = i;
        if (i > i1) i1 = i;
        if (j < j0) j0 = j;
        if (j > j1) j1 = j;
      }
      const w = i1 - i0 + 1,
        h = j1 - j0 + 1,
        img = new Uint8Array(w * h);
      for (const n of cells) img[(n % Nx) - i0 + (((n / Nx) | 0) - j0) * w] = 1;
      this._body(img, w, h, i0, j0);
    }
    this.compose();
    return this.bodies.length;
  }
  /**
   * Add a NACA section. The quarter-chord point lands on (x, y); the chord points downstream and is pitched
   * by the angle of attack (nose up positive). Rigs: pivot (anchor at c/4 + pitch spring at 3c/4), sprung
   * (lift, drag and pitch springs), fixed (anchors at c/4 and 3c/4), free.
   */
  addAirfoil({
    code = '2412',
    chord = 0.35,
    aoa = 6,
    x = 0.8,
    y = 0.5,
    fwd = true,
    rig = 'pivot',
    k = 2,
    minRatio = 0.5,
    maxRatio = 1.5,
  } = {}) {
    const h = this.h,
      al = (-aoa * Math.PI) / 180,
      ca = Math.cos(al),
      sa = Math.sin(al),
      mx = fwd ? 1 : -1;
    const tf = ([cx, cy]) => {
      const px = mx * (cx - 0.25) * chord,
        py = cy * chord;
      return [x + ca * px - sa * py, y + sa * px + ca * py];
    };
    const poly = nacaSection(code).map(tf),
      xs = poly.map((p) => p[0]),
      ys = poly.map((p) => p[1]);
    const i0 = Math.floor(Math.min(...xs) / h) - 1,
      j0 = Math.floor(Math.min(...ys) / h) - 1,
      i1 = Math.ceil(Math.max(...xs) / h) + 1,
      j1 = Math.ceil(Math.max(...ys) / h) + 1;
    const w = i1 - i0 + 1,
      hh = j1 - j0 + 1,
      img = new Uint8Array(w * hh);
    rasterPoly(
      poly.map(([px, py]) => [px / h - i0, py / h - j0]),
      w,
      hh,
      img
    );
    const b = this._body(img, w, hh, i0, j0, {
      chord,
      name: `NACA ${String(code).padStart(4, '0')}`,
    });
    if (!b) return null;
    const q = tf([0.25, 0]),
      t = tf([0.75, 0]),
      dy = y > 0.5 ? -0.3 : 0.3,
      side = fwd ? -0.45 : 0.45;
    const W = (px, py) => [clamp(px, 0.05, 1.95), clamp(py, 0.05, 0.95)],
      sp = { k, minRatio, maxRatio };
    if (rig === 'pivot' || rig === 'fixed') this.addAnchor(b, q[0], q[1]);
    if (rig === 'fixed') this.addAnchor(b, t[0], t[1]);
    if (rig === 'pivot' || rig === 'sprung') {
      const a = W(t[0], t[1] + dy);
      this.addSpring(b, a[0], a[1], t[0], t[1], sp).name = 'pitch';
    }
    if (rig === 'sprung') {
      const l = W(q[0], q[1] - dy),
        d = W(q[0] + side, q[1]);
      this.addSpring(b, l[0], l[1], q[0], q[1], sp).name = 'lift';
      this.addSpring(b, d[0], d[1], q[0], q[1], sp).name = 'drag';
    }
    this.compose();
    return b;
  }
  world(b, lx, ly) {
    const c = Math.cos(b.th),
      s = Math.sin(b.th);
    return { x: b.x + c * lx - s * ly, y: b.y + s * lx + c * ly };
  }
  local(b, X, Y) {
    const c = Math.cos(b.th),
      s = Math.sin(b.th),
      dx = X - b.x,
      dy = Y - b.y;
    return { lx: c * dx + s * dy, ly: -s * dx + c * dy };
  }
  body(id) {
    return this.bodies.find((b) => b.id === id) || null;
  }
  bodyAt(X, Y) {
    const i = Math.floor(X / this.h),
      j = Math.floor(Y / this.h),
      Nx = this.barrier.Nx;
    if (i < 0 || j < 0 || i >= Nx || j >= this.barrier.Ny) return null;
    const id = this.owner[i + j * Nx];
    return id ? this.body(id) : null;
  }
  addAnchor(b, X, Y) {
    const l = this.local(b, X, Y),
      a = { id: this.nextId++, X, Y, lx: l.lx, ly: l.ly };
    b.anchors.push(a);
    b.vx = b.vy = b.om = 0;
    return a;
  }
  addSpring(b, X, Y, bx, by, { k = 2, L0, minRatio = 0.5, maxRatio = 1.5 } = {}) {
    const l = this.local(b, bx, by),
      L = Math.hypot(bx - X, by - Y),
      rest = L0 ?? Math.max(L, 1e-3);
    const s = {
      id: this.nextId++,
      name: '',
      body: b.id,
      X,
      Y,
      lx: l.lx,
      ly: l.ly,
      k,
      L0: rest,
      Lmin: rest * minRatio,
      Lmax: rest * maxRatio,
      L,
      F: 0,
      Px: bx,
      Py: by,
      clamped: false,
    };
    this.springs.push(s);
    return s;
  }
  /** Nearest anchor or spring end within r, else the body under the point. */
  pick(X, Y, r) {
    let best = null,
      bd = r;
    for (const b of this.bodies)
      for (const a of b.anchors) {
        const d = Math.hypot(a.X - X, a.Y - Y);
        if (d < bd) {
          bd = d;
          best = { kind: 'anchor', item: a, body: b };
        }
      }
    for (const s of this.springs) {
      const d = Math.min(Math.hypot(s.X - X, s.Y - Y), Math.hypot(s.Px - X, s.Py - Y));
      if (d < bd) {
        bd = d;
        best = { kind: 'spring', item: s };
      }
    }
    if (best) return best;
    const b = this.bodyAt(X, Y);
    return b ? { kind: 'body', item: b } : null;
  }
  remove(item) {
    if (this.bodies.includes(item)) {
      this.bodies = this.bodies.filter((b) => b !== item);
      this.springs = this.springs.filter((s) => s.body !== item.id);
      return;
    }
    this.springs = this.springs.filter((s) => s !== item);
    for (const b of this.bodies) b.anchors = b.anchors.filter((a) => a !== item);
  }
  clear() {
    this.bodies = [];
    this.springs = [];
    this.compose();
  }

  /* ---------------- persistence: the rig travels with the design ---------------- */
  /** Plain-JSON form of bodies (RLE image, pose, anchors) and springs; null when there is nothing to save. */
  serialize() {
    if (!this.bodies.length) return null;
    return {
      density: this.density,
      damping: this.damping,
      skinFriction: this.skinFriction,
      bodies: this.bodies.map((b) => ({
        id: b.id,
        name: b.name,
        img: encodeMask(b.img, b.w, b.h),
        hImg: b.hImg,
        chord: b.chord,
        density: b.density,
        x: b.x,
        y: b.y,
        th: b.th,
        anchors: b.anchors.map((a) => ({ X: a.X, Y: a.Y, lx: a.lx, ly: a.ly })),
      })),
      springs: this.springs.map((s) => ({
        name: s.name,
        body: s.body,
        X: s.X,
        Y: s.Y,
        lx: s.lx,
        ly: s.ly,
        k: s.k,
        L0: s.L0,
        Lmin: s.Lmin,
        Lmax: s.Lmax,
      })),
    };
  }
  /**
   * Replace the rig with a serialized one (null clears it). Does not touch the barrier: the caller either
   * re-enters Airfoil mode (which keeps this rig because `lastBaked` is set to the current design) or calls compose().
   * @returns {number} bodies restored
   */
  deserialize(o) {
    this.bodies = [];
    this.springs = [];
    this.moving = false;
    this.lastBaked = null;
    if (!o?.bodies?.length) return 0;
    if (o.density > 0) this.density = o.density;
    if (o.damping >= 0) this.damping = o.damping;
    if (typeof o.skinFriction === 'boolean') this.skinFriction = o.skinFriction;
    for (const d of o.bodies) {
      const { w, h, mask: img } = decodeMask(d.img),
        m = moments(img, w, h);
      if (!m) continue;
      const b = this._make({
        id: d.id,
        name: d.name,
        img,
        w,
        h,
        hImg: d.hImg > 0 ? d.hImg : this.h,
        ...m,
        x: d.x,
        y: d.y,
        th: d.th,
        chord: d.chord ?? w * this.h,
        density: d.density > 0 ? d.density : this.density,
      });
      for (const a of d.anchors || [])
        b.anchors.push({ id: this.nextId++, X: a.X, Y: a.Y, lx: a.lx, ly: a.ly });
    }
    for (const d of o.springs || []) {
      const b = this.body(d.body);
      if (!b) continue;
      const P = this.world(b, d.lx, d.ly);
      this.springs.push({
        id: this.nextId++,
        name: d.name || '',
        body: d.body,
        X: d.X,
        Y: d.Y,
        lx: d.lx,
        ly: d.ly,
        k: d.k,
        L0: d.L0,
        Lmin: d.Lmin,
        Lmax: d.Lmax,
        L: Math.hypot(P.x - d.X, P.y - d.Y),
        F: 0,
        Px: P.x,
        Py: P.y,
        clamped: false,
      });
    }
    this.lastBaked = Uint8Array.from(this.barrier.mask); // the design on screen is this rig's bake ⇒ enter() keeps it
    return this.bodies.length;
  }

  /* ---------------- mode lifecycle ---------------- */
  /** Entering Airfoil mode: keep the rig if the design is still what we baked last time, else split the paint into bodies. */
  enter(mask) {
    const same =
      this.lastBaked &&
      this.lastBaked.length === mask.length &&
      this.lastBaked.every((v, n) => v === mask[n]);
    if (!same || !this.bodies.length) this.adopt(mask);
    else this.compose();
    return this.bodies.length;
  }
  /** Leaving: the bodies at their current poses become the painted design. */
  leave() {
    this.compose();
    this.lastBaked = Uint8Array.from(this.barrier.mask);
    this.bu.fill(0);
    this.bv.fill(0);
  }

  /* ---------------- rasterization ---------------- */
  _raster(b, mask) {
    const Nx = this.barrier.Nx,
      Ny = this.barrier.Ny,
      h = this.h,
      hi = b.hImg || h,
      pc = this.barrier.protectedCols,
      own = this.owner,
      bu = this.bu,
      bv = this.bv;
    const R = this._radius(b);
    const i0 = Math.max(pc, Math.floor((b.x - R) / h)),
      i1 = Math.min(Nx - pc - 1, Math.ceil((b.x + R) / h));
    const j0 = Math.max(0, Math.floor((b.y - R) / h)),
      j1 = Math.min(Ny - 1, Math.ceil((b.y + R) / h));
    const c = Math.cos(b.th),
      s = Math.sin(b.th);
    let painted = 0;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const X = (i + 0.5) * h - b.x,
          Y = (j + 0.5) * h - b.y,
          lx = c * X + s * Y,
          ly = -s * X + c * Y;
        const a = Math.floor(lx / hi + b.cx),
          bb = Math.floor(ly / hi + b.cy); // image lookup in the cells the image was drawn at
        if (a < 0 || bb < 0 || a >= b.w || bb >= b.h || !b.img[a + bb * b.w]) continue;
        const n = i + j * Nx;
        mask[n] = 1;
        own[n] = b.id;
        painted++;
        bu[n] = b.vx - b.om * Y;
        bv[n] = b.vy + b.om * X; // rigid-body velocity v + ω × r
      }
    return painted;
  }
  /** Rasterize every body into the barrier mask and the solid-velocity field. @returns {boolean} whether the mask changed */
  compose() {
    const mask = this.barrier.mask,
      N = mask.length,
      prev = this._prev;
    prev.set(mask);
    mask.fill(0);
    this.owner.fill(0);
    this.bu.fill(0);
    this.bv.fill(0);
    for (const b of this.bodies) b.painted = this._raster(b, mask);
    let changed = false;
    for (let n = 0; n < N; n++)
      if (mask[n] !== prev[n]) {
        changed = true;
        break;
      }
    if (changed) this.barrier.bump();
    return changed;
  }

  /* ---------------- dynamics ---------------- */
  /**
   * Fluid force over the body's exposed voxel faces (all Nz slices), torque about the centroid:
   *   pressure  −∮ p n dA, and
   *   skin friction  ∮ ν (∂u_t/∂n) t dA, with the wall gradient taken as the tangential slip between the
   *   fluid neighbour and the body's own velocity across one cell, (u_f − u_body)·t / h.
   * The two parts are kept separately (Fp, Fv) and summed into F; each has a ~20-step smoothed copy.
   */
  _fluidForce(b, solver) {
    const g = this.grid,
      Nx = g.Nx,
      Ny = g.Ny,
      Nz = g.Nz,
      sz = g.sz,
      h = this.h,
      p = solver.p,
      u = solver.u,
      v = solver.v,
      mask = this.barrier.mask,
      own = this.owner,
      per = solver.periodicY,
      fa = h * g.hz;
    const nu = this.skinFriction ? solver.nu : 0,
      bu = this.bu,
      bv = this.bv;
    let Px = 0,
      Py = 0,
      Pt = 0,
      Vx = 0,
      Vy = 0,
      Vt = 0;
    // n: the body's 2D cell, m2: the neighbour across the face, (nx, ny): unit normal from the body into the fluid, (X, Y): cell centre relative to the centroid
    const face = (n, m2, nx, ny, X, Y) => {
      if (m2 < 0 || mask[m2]) return;
      const tx = -ny,
        ty = nx,
        ub = bu[n],
        vb = bv[n];
      let ps = 0,
        ts = 0;
      for (let k = 0; k < Nz; k++) {
        const q = m2 + k * sz;
        ps += p[q];
        ts += (u[q] - ub) * tx + (v[q] - vb) * ty;
      }
      const rx = X + 0.5 * h * nx,
        ry = Y + 0.5 * h * ny;
      const f = -ps * fa,
        fx = f * nx,
        fy = f * ny; // pressure pushes along −n
      Px += fx;
      Py += fy;
      Pt += rx * fy - ry * fx;
      if (nu) {
        const s = ((nu * ts) / h) * fa,
          sx = s * tx,
          sy = s * ty;
        Vx += sx;
        Vy += sy;
        Vt += rx * sy - ry * sx;
      } // shear drags the body along the slip
    };
    const R = this._radius(b);
    const i0 = Math.max(0, Math.floor((b.x - R) / h)),
      i1 = Math.min(Nx - 1, Math.ceil((b.x + R) / h)),
      j0 = Math.max(0, Math.floor((b.y - R) / h)),
      j1 = Math.min(Ny - 1, Math.ceil((b.y + R) / h));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const n = i + j * Nx;
        if (own[n] !== b.id) continue;
        const X = (i + 0.5) * h - b.x,
          Y = (j + 0.5) * h - b.y;
        face(n, i + 1 < Nx ? n + 1 : -1, 1, 0, X, Y);
        face(n, i > 0 ? n - 1 : -1, -1, 0, X, Y);
        face(n, j + 1 < Ny ? n + Nx : per ? n - (Ny - 1) * Nx : -1, 0, 1, X, Y);
        face(n, j > 0 ? n - Nx : per ? n + (Ny - 1) * Nx : -1, 0, -1, X, Y);
      }
    b.Fp.x = Px;
    b.Fp.y = Py;
    b.Fp.t = Pt;
    b.Fv.x = Vx;
    b.Fv.y = Vy;
    b.Fv.t = Vt;
    b.F.x = Px + Vx;
    b.F.y = Py + Vy;
    b.F.t = Pt + Vt;
    const a = 0.05,
      ema = (acc, cur) => {
        acc.x += a * (cur.x - acc.x);
        acc.y += a * (cur.y - acc.y);
        acc.t += a * (cur.t - acc.t);
      };
    ema(b.Favg, b.F);
    ema(b.Fpavg, b.Fp);
    ema(b.Fvavg, b.Fv);
  }
  _springForces(dt) {
    for (const b of this.bodies) {
      b.Fs.x = 0;
      b.Fs.y = 0;
      b.Fs.t = 0;
    }
    for (const s of this.springs) {
      const b = this.body(s.body);
      if (!b) continue;
      const P = this.world(b, s.lx, s.ly),
        dx = P.x - s.X,
        dy = P.y - s.Y,
        L = Math.hypot(dx, dy);
      s.L = L;
      s.Px = P.x;
      s.Py = P.y;
      if (L < 1e-9) {
        s.F = 0;
        continue;
      }
      const ux = dx / L,
        uy = dy / L,
        kmax = (0.25 * b.mass) / (dt * dt); // explicit-integration stability cap
      const k = Math.min(s.k, kmax),
        kh = Math.min(this.kHard * s.k, kmax);
      s.clamped = s.k > kmax;
      let f = -k * (L - s.L0); // along u (anchor → body point): pulls the body back when stretched
      if (L > s.Lmax) f -= kh * (L - s.Lmax);
      else if (L < s.Lmin) f -= kh * (L - s.Lmin);
      const rx = P.x - b.x,
        ry = P.y - b.y,
        vr = (b.vx - b.om * ry) * ux + (b.vy + b.om * rx) * uy;
      f -= 0.2 * Math.sqrt(k * b.mass) * vr; // 10 % of critical damping along the spring
      s.F = -f; // tension positive
      const fx = f * ux,
        fy = f * uy;
      b.Fs.x += fx;
      b.Fs.y += fy;
      b.Fs.t += rx * fy - ry * fx;
    }
  }
  _placeOnPivot(b, a) {
    const c = Math.cos(b.th),
      s = Math.sin(b.th);
    b.x = a.X - (c * a.lx - s * a.ly);
    b.y = a.Y - (s * a.lx + c * a.ly);
  }
  /** Semi-implicit Euler with damping; speed is capped at half a cell per step so the advection stays consistent. @returns {boolean} moving */
  _integrate(b, dt) {
    const na = b.anchors.length,
      Fx = b.F.x + b.Fs.x,
      Fy = b.F.y + b.Fs.y,
      T = b.F.t + b.Fs.t,
      dmp = Math.exp(-this.damping * dt),
      h = this.h;
    if (na >= 2) {
      b.vx = b.vy = b.om = 0;
      return false;
    }
    const vmax = (0.5 * h) / dt,
      omax = vmax / this._radius(b);
    if (na === 1) {
      const a = b.anchors[0],
        rx = b.x - a.X,
        ry = b.y - a.Y,
        IA = b.I + b.mass * (rx * rx + ry * ry);
      b.om = clamp((b.om + (dt * (T + rx * Fy - ry * Fx)) / IA) * dmp, -omax, omax);
      b.th += dt * b.om;
      this._placeOnPivot(b, a);
      b.vx = -b.om * (b.y - a.Y);
      b.vy = b.om * (b.x - a.X);
      return Math.abs(b.om) > 1e-9;
    }
    let vx = (b.vx + (dt * Fx) / b.mass) * dmp,
      vy = (b.vy + (dt * Fy) / b.mass) * dmp;
    const sp = Math.hypot(vx, vy);
    if (sp > vmax) {
      vx *= vmax / sp;
      vy *= vmax / sp;
    }
    b.om = clamp((b.om + (dt * T) / b.I) * dmp, -omax, omax);
    b.vx = vx;
    b.vy = vy;
    b.x += dt * vx;
    b.y += dt * vy;
    b.th += dt * b.om;
    return sp > 1e-9 || Math.abs(b.om) > 1e-9;
  }
  _inside(b) {
    const pc = this.barrier.protectedCols * this.h;
    return b.painted > 0 && b.x > pc && b.x < 2 - pc && b.y > 0 && b.y < 1;
  }
  /** One rig update before the solver advances by dt (a whole frame batch on asynchronous backends). */
  step(solver, twin, dt) {
    if (!this.bodies.length) return;
    this.time += dt;
    for (const b of this.bodies) this._fluidForce(b, solver);
    this._springForces(dt);
    let moving = false;
    for (const b of this.bodies) if (this._integrate(b, dt)) moving = true;
    const gone = this.bodies.filter((b) => !this._inside(b));
    if (gone.length) {
      for (const b of gone) this.remove(b);
      this.onEvent?.(`${gone.map((b) => b.name).join(', ')} washed out of the garden`);
    }
    const changed = this.compose();
    if (moving || this.moving) solver.setSolidVelocity(this.bu, this.bv); // one extra push so a body that just stopped reads zero
    this.moving = moving;
    if (changed) solver.setBarriers(this.barrier);
    if (twin) {
      const s = twin.solver;
      s.hasSolid = solver.hasSolid;
      s.bodyU = solver.bodyU;
      s.bodyV = solver.bodyV;
    }
  }

  /* ---------------- overlay ---------------- */
  /** Paint anchors (orange), springs (cyan) and centroids into the plan-view RGBA buffer. */
  drawOverlay(d, Nx, Ny, pending = null) {
    const h = this.h,
      px = (X) => Math.round(X / h - 0.5),
      py = (Y) => Math.round(Y / h - 0.5);
    const put = (i, j, r, g, b) => {
      if (i < 0 || j < 0 || i >= Nx || j >= Ny) return;
      const o = (i + j * Nx) * 4;
      d[o] = r;
      d[o + 1] = g;
      d[o + 2] = b;
    };
    const line = (x0, y0, x1, y1, r, g, b) => {
      let dx = Math.abs(x1 - x0),
        dy = -Math.abs(y1 - y0),
        sx = x0 < x1 ? 1 : -1,
        sy = y0 < y1 ? 1 : -1,
        e = dx + dy;
      for (let n = 0; n < 4096; n++) {
        put(x0, y0, r, g, b);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * e;
        if (e2 >= dy) {
          e += dy;
          x0 += sx;
        }
        if (e2 <= dx) {
          e += dx;
          y0 += sy;
        }
      }
    };
    const cross = (i, j, r, g, b) => {
      for (let t = -1; t <= 1; t++) {
        put(i + t, j, r, g, b);
        put(i, j + t, r, g, b);
      }
    };
    for (const s of this.springs) {
      line(px(s.X), py(s.Y), px(s.Px), py(s.Py), 108, 196, 255);
      cross(px(s.X), py(s.Y), 108, 196, 255);
    }
    for (const b of this.bodies) {
      put(px(b.x), py(b.y), 255, 255, 255);
      for (const a of b.anchors) cross(px(a.X), py(a.Y), 255, 180, 84);
    }
    if (pending) {
      line(px(pending.X), py(pending.Y), px(pending.hx), py(pending.hy), 108, 196, 255);
      cross(px(pending.X), py(pending.Y), 108, 196, 255);
    }
  }
}
