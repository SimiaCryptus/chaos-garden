import { Rng } from '../core/Rng.js';

export const SOLVER_VERSION = '0.6.0-cpu'; // 0.6: signed flow (inlet on either face), torus topology, moving-solid velocities; 0.5: one-way convective outlet; 0.4: gather-table SOR, shared-stencil tracers

/**
 * Reference incompressible solver on a thin slab (§5). Collocated grid, clamped
 * MacCormack advection, explicit/Jacobi viscosity, red-black SOR projection.
 * Fully deterministic: fixed Δt, fixed iteration counts, seeded RNG only.
 * No vorticity confinement, ever.
 *
 * Columns 0 and Nx−1 are boundary columns that are never solved: in a channel they hold the inlet
 * (Dirichlet) and the one-way convective outlet — on whichever face the signed U₀ dictates — and in a
 * torus they are periodic ghosts (column 0 ≡ Nx−2, Nx−1 ≡ 1) with a body force driving the mean flow.
 * Solid cells may carry a prescribed velocity (moving rigid bodies, Airfoil mode).
 */
export class CpuSolver {
  constructor(grid, params, opts = {}) {
    this.grid = grid; this.params = { ...params };
    this.U0 = params.flow ?? 1; this.nu = 1 / params.Re; // U₀ is signed: negative flow enters through the right face
    this.torus = params.topology === 'torus'; this.driveTau = 0.25; // torus: the mean flow is relaxed toward U₀ on this time scale
    this.bodyU = null; this.bodyV = null; // velocity carried by solid cells (moving rigid bodies); null ⇒ walls at rest
    this.pIters = opts.pIters ?? 40; this.sor = opts.sor ?? 1.5; this.jacobiIters = 16;
    this.pTol = opts.pTol ?? 1e-6; // SOR stops when max|Δp| in a sweep drops below this (state-dependent ⇒ deterministic, §5.4)
    this.cfl = 0.5; this.dt = this.cfl * Math.min(grid.hx, grid.hy) / this.Uref;
    this.K = opts.tracerCount ?? 16;
    this.periodicY = params.spanwise !== 'freeslip';
    this.zsT = params.walls === 'freeslip' ? 1 : -1; // ghost sign for tangential velocity at z walls
    this.perturb = params.perturb ?? 0.01;
    const N = grid.N, f = () => new Float32Array(N);
    this.u = f(); this.v = f(); this.w = f();
    this.ua = f(); this.va = f(); this.wa = f();
    this.ub = f(); this.vb = f(); this.wb = f();
    this.mn = [f(), f(), f()]; this.mx = [f(), f(), f()];
    this.p = new Float32Array(N + 1); // +1: sentinel cell (index N) that is always 0, gathered for missing/solid neighbours
    this.div = f(); this.wx = f(); this.wy = f(); this.wz = f();
    this.solid = new Uint8Array(N); this.hasSolid = false; this.barrierVersion = -1;
    this.pNb = new Int32Array(6 * N); this.pInv = new Float32Array(N); this._buildPressureCoeffs();
    this.tracers = []; this.tracerTmp = [];
    for (let c = 0; c < this.K; c++) { this.tracers.push(f()); this.tracerTmp.push(f()); }
    this.inletNoise = new Float32Array(grid.Ny * grid.Nz);
    this.reverse = false; this.viscous = true; this.forcing = null;
    this.t = 0; this.stepCount = 0; this._mm = [0, 0];
    this.report = { t: 0, substeps: 1, divMax: 0, divNorm: 0, pIters: this.pIters, diffusion: 'explicit', drive: 0 };
    this.reset(params.seed);
  }
  profile(k) { const z = (k + 0.5) / this.grid.Nz; return this.params.inflow === 'parabolic' ? 6 * z * (1 - z) : 1; }
  /** Backend identity folded into score strings and run hashes. */
  get backend() { return 'cpu'; }
  get precision() { return 'f32'; }
  get version() { return SOLVER_VERSION.replace(/cpu$/, this.backend); }
  /** |U₀| floored so Δt and the normalizers stay finite when the flow rate is dialled to zero. */
  get Uref() { const a = Math.abs(this.U0); return a > 0.05 ? a : 0.05; }
  /** Flow direction: true when water enters on the left face (U₀ ≥ 0). */
  get fwd() { return this.U0 >= 0; }
  /** Last solved column on the downstream side — throughput Q and the dye information Î are measured here. */
  get outCol() { return this.fwd ? this.grid.Nx - 2 : 1; }
  /** Boundary column that carries the inlet profile (and the dye bands). */
  get inCol() { return this.fwd ? 0 : this.grid.Nx - 1; }
  /**
   * Asynchronous backends return a promise from sync() that resolves once the CPU-visible arrays reflect
   * every submitted step, and need upload() after the arrays are edited. The CPU solver *is* the state.
   */
  get isAsync() { return false; }
  sync() { return null; }
  upload() { /* CPU arrays are the state */ }
  setBarriers(bf) {
    bf.extrude(this.grid, this.solid);
    let any = 0; const bu = this.bodyU, bv = this.bodyV;
    for (let n = 0; n < this.grid.N; n++) if (this.solid[n]) { any = 1; this.u[n] = bu ? bu[n] : 0; this.v[n] = bv ? bv[n] : 0; this.w[n] = this.p[n] = 0; for (const T of this.tracers) T[n] = 0; }
    this.hasSolid = !!any; this.barrierVersion = bf.version;
    this._buildPressureCoeffs();
  }
  /**
   * Velocity carried by solid cells (moving rigid bodies). Pass 2D (Nx·Ny) arrays, which are extruded
   * through the slab; pass null to return every solid to rest. Fluid neighbours see this velocity in the
   * divergence, so a moving body pushes water; the projection still treats the body as impermeable.
   */
  setSolidVelocity(bu2, bv2) {
    const g = this.grid;
    if (!bu2) { this.bodyU = this.bodyV = null; return; }
    if (!this.bodyU) { this.bodyU = new Float32Array(g.N); this.bodyV = new Float32Array(g.N); }
    for (let k = 0; k < g.Nz; k++) { this.bodyU.set(bu2, k * g.sz); this.bodyV.set(bv2, k * g.sz); }
  }
  /**
   * Poisson gather table + inverse diagonal. Missing or solid neighbours point at the sentinel zero
   * cell (index N) and are dropped from the diagonal (homogeneous Neumann); the outlet column keeps
   * p = 0 (Dirichlet reference) on the downstream face. In a torus the x neighbours wrap (column 1 ↔ Nx−2)
   * and a tiny leak toward p = 0 (1e-5·cx on the diagonal) keeps the otherwise singular Neumann system
   * pinned so the pressure level cannot drift. Depends only on geometry, so it is rebuilt only when barriers change.
   */
  _buildPressureCoeffs() {
    const g = this.grid, Nx = g.Nx, Ny = g.Ny, Nz = g.Nz, N = g.N, sy = Nx, sz = Nx * Ny, per = this.periodicY, solid = this.solid;
    const cx = 1 / (g.hx * g.hx), cy = 1 / (g.hy * g.hy), cz = 1 / (g.hz * g.hz), nb = this.pNb, inv = this.pInv;
    const torus = this.torus, fwd = this.fwd, wrap = Nx - 3;
    nb.fill(N); inv.fill(0);
    for (let k = 0; k < Nz; k++) for (let j = 0; j < Ny; j++) for (let i = 1; i < Nx - 1; i++) {
      const n = i + j * sy + k * sz; if (solid[n]) continue;
      const m = 6 * n; let d = torus ? 1e-5 * cx : 0;
      // x neighbours: -1 = dropped (Neumann), N = sentinel zero (Dirichlet reference), otherwise a cell
      let L = -1, R = -1;
      if (i === 1) { if (torus) L = n + wrap; else if (!fwd) L = N; } else L = n - 1;
      if (i === Nx - 2) { if (torus) R = n - wrap; else if (fwd) R = N; } else R = n + 1;
      if (L >= 0 && (L === N || !solid[L])) { nb[m] = L; d += cx; }
      if (R >= 0 && (R === N || !solid[R])) { nb[m + 1] = R; d += cx; }
      const jm = j === 0 ? (per ? n + (Ny - 1) * sy : -1) : n - sy, jp = j === Ny - 1 ? (per ? n - (Ny - 1) * sy : -1) : n + sy;
      if (jm >= 0 && !solid[jm]) { nb[m + 2] = jm; d += cy; }
      if (jp >= 0 && !solid[jp]) { nb[m + 3] = jp; d += cy; }
      if (k > 0 && !solid[n - sz]) { nb[m + 4] = n - sz; d += cz; }
      if (k < Nz - 1 && !solid[n + sz]) { nb[m + 5] = n + sz; d += cz; }
      inv[n] = d > 0 ? 1 / d : 0;
    }
  }
  reset(seed = this.params.seed) {
    const g = this.grid, rng = new Rng(seed); this.rng = rng;
    for (let n = 0; n < this.inletNoise.length; n++) this.inletNoise[n] = rng.next() * 2 - 1;
    const amp = 0.1 * this.perturb;
    for (let k = 0; k < g.Nz; k++) { const pr = this.profile(k); for (let j = 0; j < g.Ny; j++) for (let i = 0; i < g.Nx; i++) {
      const n = g.idx(i, j, k);
      if (this.solid[n]) { this.u[n] = this.bodyU ? this.bodyU[n] : 0; this.v[n] = this.bodyV ? this.bodyV[n] : 0; this.w[n] = 0; continue; }
      this.u[n] = this.U0 * pr * (1 + amp * (rng.next() - 0.5)); this.v[n] = amp * (rng.next() - 0.5); this.w[n] = 0;
    } }
    this.p.fill(0); for (const T of this.tracers) T.fill(0);
    this.t = 0; this.stepCount = 0; this.applyBoundaries();
  }
  /** Boundary columns: inlet / one-way outlet on the faces chosen by the sign of U₀, periodic ghosts in a torus, both faces Dirichlet while rewinding. */
  applyBoundaries() {
    const g = this.grid, Nx = g.Nx, Ny = g.Ny, Nz = g.Nz, sy = Nx, sz = Nx * Ny;
    const U = this.U0, c = this.dt * Math.abs(U) / g.hx, amp = this.perturb, fwd = this.fwd, torus = this.torus, rev = this.reverse;
    const { u, v, w, solid, tracers, K } = this, bu = this.bodyU, bv = this.bodyV;
    for (let k = 0; k < Nz; k++) { const pr = this.profile(k); for (let j = 0; j < Ny; j++) {
      const i0 = j * sy + k * sz, i1 = i0 + Nx - 1;
      const inl = fwd ? i0 : i1, out = fwd ? i1 : i0, nbr = fwd ? i1 - 1 : i0 + 1, noise = amp * U * pr * this.inletNoise[j + Ny * k];
      if (torus) { // periodic ghosts: column 0 ≡ Nx−2, column Nx−1 ≡ 1
        u[i0] = u[i1 - 1]; v[i0] = v[i1 - 1]; w[i0] = w[i1 - 1]; u[i1] = u[i0 + 1]; v[i1] = v[i0 + 1]; w[i1] = w[i0 + 1];
      } else if (rev) { // rewind probe: both faces carry the negated inflow
        u[inl] = -U * pr; v[inl] = noise; w[inl] = 0; u[out] = -U * pr; v[out] = 0; w[out] = 0;
      } else {
        u[inl] = U * pr; v[inl] = noise; w[inl] = 0;
        u[out] -= c * (u[out] - u[nbr]); v[out] -= c * (v[out] - v[nbr]); w[out] -= c * (w[out] - w[nbr]);
        // The open face is one-way. Re-entry against the p = 0 reference column is an energy pump: an exiting
        // vortex core (low p) is sucked back and accelerated by the outlet pressure gradient every step, which
        // surfaces as a high-energy jet reflected upstream. Tangential components still leave convectively.
        if (fwd ? u[out] < 0 : u[out] > 0) u[out] = 0;
      }
      const band = Math.floor(j * K / Ny);
      for (let ch = 0; ch < K; ch++) { const T = tracers[ch]; T[inl] = ch === band ? 1 : 0; if (!rev) T[out] -= c * (T[out] - T[nbr]); }
    } }
    if (this.hasSolid) for (let n = 0; n < g.N; n++) if (solid[n]) { u[n] = bu ? bu[n] : 0; v[n] = bv ? bv[n] : 0; w[n] = 0; }
  }
  /** Copy the periodic ghost columns of the given fields (torus diagnostics such as vorticity). */
  _wrapX(fields) {
    const Nx = this.grid.Nx, N = this.grid.N;
    for (let row = 0; row < N; row += Nx) for (const f of fields) { f[row] = f[row + Nx - 2]; f[row + Nx - 1] = f[row + 1]; }
  }
  /** Trilinear sample at cell coordinates (center of cell i is i+0.5). zs/ys are ghost signs. */
  sample(f, x, y, z, zs, ys, mm) {
    const g = this.grid, Nx = g.Nx, Ny = g.Ny, Nz = g.Nz, sy = Nx, sz = Nx * Ny;
    let fx = x - 0.5, fy = y - 0.5, fz = z - 0.5;
    if (fx < 0) fx = 0; else if (fx > Nx - 1) fx = Nx - 1;
    if (fz < -0.5) fz = -0.5; else if (fz > Nz - 0.5) fz = Nz - 0.5;
    let i0 = Math.floor(fx); if (i0 > Nx - 2) i0 = Nx - 2; const tx = fx - i0;
    const k0 = Math.floor(fz), tz = fz - k0;
    let ka = k0, kb = k0 + 1, sa = 1, sb = 1;
    if (ka < 0) { ka = 0; sa = zs; } if (kb > Nz - 1) { kb = Nz - 1; sb = zs; }
    let ja, jb, ra = 1, rb = 1, ty;
    if (this.periodicY) { const j0 = Math.floor(fy); ty = fy - j0; ja = ((j0 % Ny) + Ny) % Ny; jb = ja + 1; if (jb === Ny) jb = 0; }
    else { if (fy < -0.5) fy = -0.5; else if (fy > Ny - 0.5) fy = Ny - 0.5; const j0 = Math.floor(fy); ty = fy - j0; ja = j0; jb = j0 + 1; if (ja < 0) { ja = 0; ra = ys; } if (jb > Ny - 1) { jb = Ny - 1; rb = ys; } }
    const b00 = i0 + ja * sy + ka * sz, b10 = i0 + jb * sy + ka * sz, b01 = i0 + ja * sy + kb * sz, b11 = i0 + jb * sy + kb * sz;
    const c000 = f[b00] * ra * sa, c100 = f[b00 + 1] * ra * sa, c010 = f[b10] * rb * sa, c110 = f[b10 + 1] * rb * sa;
    const c001 = f[b01] * ra * sb, c101 = f[b01 + 1] * ra * sb, c011 = f[b11] * rb * sb, c111 = f[b11 + 1] * rb * sb;
    if (mm) {
      let lo = c000, hi = c000;
      // unrolled: this runs millions of times per step, an array literal here dominated the advection cost
      if (c100 < lo) lo = c100; else if (c100 > hi) hi = c100;
      if (c010 < lo) lo = c010; else if (c010 > hi) hi = c010;
      if (c110 < lo) lo = c110; else if (c110 > hi) hi = c110;
      if (c001 < lo) lo = c001; else if (c001 > hi) hi = c001;
      if (c101 < lo) lo = c101; else if (c101 > hi) hi = c101;
      if (c011 < lo) lo = c011; else if (c011 > hi) hi = c011;
      if (c111 < lo) lo = c111; else if (c111 > hi) hi = c111;
      this._mm[0] = lo; this._mm[1] = hi;
    }
    const x00 = c000 + tx * (c100 - c000), x10 = c010 + tx * (c110 - c010), x01 = c001 + tx * (c101 - c001), x11 = c011 + tx * (c111 - c011);
    const y0 = x00 + ty * (x10 - x00), y1 = x01 + ty * (x11 - x01);
    return y0 + tz * (y1 - y0);
  }
  _advectVel(SU, SV, SW, OU, OV, OW, dt, dir, mm) {
    const g = this.grid, Nx = g.Nx, Ny = g.Ny, Nz = g.Nz, sy = Nx, sz = Nx * Ny;
    const u = this.u, v = this.v, w = this.w, solid = this.solid, zsT = this.zsT, bu = this.bodyU, bv = this.bodyV;
    const ax = dt * dir / g.hx, ay = dt * dir / g.hy, az = dt * dir / g.hz;
    const [mn0, mn1, mn2] = this.mn, [mx0, mx1, mx2] = this.mx;
    for (let k = 0; k < Nz; k++) for (let j = 0; j < Ny; j++) {
      const row = j * sy + k * sz, e = row + Nx - 1;
      OU[row] = SU[row]; OV[row] = SV[row]; OW[row] = SW[row]; OU[e] = SU[e]; OV[e] = SV[e]; OW[e] = SW[e];
      for (let i = 1; i < Nx - 1; i++) {
        const n = row + i;
        if (solid[n]) { OU[n] = bu ? bu[n] : 0; OV[n] = bv ? bv[n] : 0; OW[n] = 0; continue; } // solids keep the body's velocity through the step
        const x = i + 0.5, y = j + 0.5, z = k + 0.5;
        const xm = x - 0.5 * ax * u[n], ym = y - 0.5 * ay * v[n], zm = z - 0.5 * az * w[n];
        const um = this.sample(u, xm, ym, zm, zsT, 1, false), vm = this.sample(v, xm, ym, zm, zsT, -1, false), wm = this.sample(w, xm, ym, zm, -1, 1, false);
        const xb = x - ax * um, yb = y - ay * vm, zb = z - az * wm;
        OU[n] = this.sample(SU, xb, yb, zb, zsT, 1, mm); if (mm) { mn0[n] = this._mm[0]; mx0[n] = this._mm[1]; }
        OV[n] = this.sample(SV, xb, yb, zb, zsT, -1, mm); if (mm) { mn1[n] = this._mm[0]; mx1[n] = this._mm[1]; }
        OW[n] = this.sample(SW, xb, yb, zb, -1, 1, mm); if (mm) { mn2[n] = this._mm[0]; mx2[n] = this._mm[1]; }
      }
    }
  }
  _advectTracers(dt) {
    const K = this.K; if (!K) return;
    const g = this.grid, Nx = g.Nx, Ny = g.Ny, Nz = g.Nz, sy = Nx, sz = Nx * Ny, per = this.periodicY;
    const u = this.u, v = this.v, w = this.w, solid = this.solid, zsT = this.zsT, T = this.tracers, O = this.tracerTmp;
    const ax = dt / g.hx, ay = dt / g.hy, az = dt / g.hz;
    for (let k = 0; k < Nz; k++) for (let j = 0; j < Ny; j++) {
      const row = j * sy + k * sz, e = row + Nx - 1;
      for (let c = 0; c < K; c++) { O[c][row] = T[c][row]; O[c][e] = T[c][e]; }
      for (let i = 1; i < Nx - 1; i++) {
        const n = row + i;
        if (solid[n]) { for (let c = 0; c < K; c++) O[c][n] = 0; continue; }
        const x = i + 0.5, y = j + 0.5, z = k + 0.5;
        const xm = x - 0.5 * ax * u[n], ym = y - 0.5 * ay * v[n], zm = z - 0.5 * az * w[n];
        const um = this.sample(u, xm, ym, zm, zsT, 1, false), vm = this.sample(v, xm, ym, zm, zsT, -1, false), wm = this.sample(w, xm, ym, zm, -1, 1, false);
        // Resolve the trilinear stencil of the back-traced point once; all K channels share it (was K full samples per cell).
        // Scalars use zero-gradient ghosts (sign +1), so clamping to the outermost cell centre reproduces sample()'s result.
        let fx = x - ax * um - 0.5, fy = y - ay * vm - 0.5, fz = z - az * wm - 0.5;
        if (fx < 0) fx = 0; else if (fx > Nx - 1) fx = Nx - 1;
        if (fz < 0) fz = 0; else if (fz > Nz - 1) fz = Nz - 1;
        let i0 = Math.floor(fx); if (i0 > Nx - 2) i0 = Nx - 2;
        let k0 = Math.floor(fz); if (k0 > Nz - 2) k0 = Nz - 2;
        const tx = fx - i0, tz = fz - k0;
        let ja, jb, ty;
        if (per) { const j0 = Math.floor(fy); ty = fy - j0; ja = ((j0 % Ny) + Ny) % Ny; jb = ja === Ny - 1 ? 0 : ja + 1; }
        else { if (fy < 0) fy = 0; else if (fy > Ny - 1) fy = Ny - 1; let j0 = Math.floor(fy); if (j0 > Ny - 2) j0 = Ny - 2; ty = fy - j0; ja = j0; jb = j0 + 1; }
        const b00 = i0 + ja * sy + k0 * sz, b10 = i0 + jb * sy + k0 * sz, b01 = b00 + sz, b11 = b10 + sz;
        for (let c = 0; c < K; c++) {
          const f = T[c];
          const x00 = f[b00] + tx * (f[b00 + 1] - f[b00]), x10 = f[b10] + tx * (f[b10 + 1] - f[b10]);
          const x01 = f[b01] + tx * (f[b01 + 1] - f[b01]), x11 = f[b11] + tx * (f[b11 + 1] - f[b11]);
          const y0 = x00 + ty * (x10 - x00), y1 = x01 + ty * (x11 - x01);
          O[c][n] = y0 + tz * (y1 - y0);
        }
      }
    }
    this.tracers = O; this.tracerTmp = T;
  }
  _nbSum(f, i, j, k, n, zs, ys) {
    const g = this.grid, Ny = g.Ny, Nz = g.Nz, sy = g.sy, sz = g.sz;
    const cx = this._cx, cy = this._cy, cz = this._cz;
    let s = cx * (f[n - 1] + f[n + 1]);
    if (this.periodicY) s += cy * (f[n + (j === 0 ? (Ny - 1) * sy : -sy)] + f[n + (j === Ny - 1 ? -(Ny - 1) * sy : sy)]);
    else s += cy * ((j === 0 ? ys * f[n] : f[n - sy]) + (j === Ny - 1 ? ys * f[n] : f[n + sy]));
    s += cz * ((k === 0 ? zs * f[n] : f[n - sz]) + (k === Nz - 1 ? zs * f[n] : f[n + sz]));
    return s;
  }
  _diffuse(dt) {
    const g = this.grid, Nx = g.Nx, Ny = g.Ny, Nz = g.Nz, sy = Nx, sz = Nx * Ny, a = dt * this.nu, solid = this.solid;
    const cx = this._cx = 1 / (g.hx * g.hx), cy = this._cy = 1 / (g.hy * g.hy), cz = this._cz = 1 / (g.hz * g.hz), diag = 2 * (cx + cy + cz);
    const comps = [[this.u, this.ua, this.ub, this.zsT, 1], [this.v, this.va, this.vb, this.zsT, -1], [this.w, this.wa, this.wb, -1, 1]];
    if (a * diag < 0.25) {
      this.report.diffusion = 'explicit';
      for (const [f, out, , zs, ys] of comps) {
        out.set(f);
        for (let k = 0; k < Nz; k++) for (let j = 0; j < Ny; j++) { const row = j * sy + k * sz; for (let i = 1; i < Nx - 1; i++) { const n = row + i; if (solid[n]) continue; out[n] = f[n] + a * (this._nbSum(f, i, j, k, n, zs, ys) - diag * f[n]); } }
        f.set(out);
      }
    } else {
      this.report.diffusion = 'jacobi';
      const inv = 1 / (1 + a * diag);
      for (const [f, rhs, scratch, zs, ys] of comps) {
        rhs.set(f); let x = f, xn = scratch; xn.set(f);
        for (let it = 0; it < this.jacobiIters; it++) {
          for (let k = 0; k < Nz; k++) for (let j = 0; j < Ny; j++) { const row = j * sy + k * sz; for (let i = 1; i < Nx - 1; i++) { const n = row + i; if (solid[n]) continue; xn[n] = (rhs[n] + a * this._nbSum(x, i, j, k, n, zs, ys)) * inv; } }
          const tmp = x; x = xn; xn = tmp;
        }
        if (x !== f) f.set(x);
      }
    }
  }
  /** Torus drive: uniform streamwise acceleration relaxing the mean flow toward U₀ (−U₀ while rewinding). Reported as `report.drive`. */
  _driveForce() {
    const { u, solid } = this, N = this.grid.N; let s = 0, c = 0;
    for (let n = 0; n < N; n++) if (!solid[n]) { s += u[n]; c++; }
    const target = this.reverse ? -this.U0 : this.U0, f = (target - s / Math.max(1, c)) / this.driveTau;
    this.report.drive = f; return f;
  }
  _addForces(dt) {
    const g = this.grid, N = g.N, solid = this.solid, u = this.u, v = this.v;
    if (this.torus) { const f = dt * this._driveForce(); for (let n = 0; n < N; n++) if (!solid[n]) u[n] += f; }
    if (this.forcing) {
      const { amp, k } = this.forcing;
      for (let n = 0; n < N; n++) { if (solid[n]) continue; const i = n % g.Nx, j = Math.floor(n / g.Nx) % g.Ny; u[n] += dt * amp * Math.sin(2 * Math.PI * k * (j + 0.5) / g.Ny); v[n] += dt * amp * Math.sin(2 * Math.PI * k * (i + 0.5) / g.Nx * 2); }
    }
  }
  _divergence(out) {
    const g = this.grid, Nx = g.Nx, Ny = g.Ny, Nz = g.Nz, sy = Nx, sz = Nx * Ny, per = this.periodicY;
    const u = this.u, v = this.v, w = this.w, solid = this.solid;
    const ix = 0.5 / g.hx, iy = 0.5 / g.hy, iz = 0.5 / g.hz; let mx = 0;
    for (let k = 0; k < Nz; k++) for (let j = 0; j < Ny; j++) {
      const row = j * sy + k * sz; out[row] = 0; out[row + Nx - 1] = 0;
      for (let i = 1; i < Nx - 1; i++) {
        const n = row + i; if (solid[n]) { out[n] = 0; continue; }
        const vN = j === Ny - 1 ? (per ? v[n - (Ny - 1) * sy] : -v[n]) : v[n + sy];
        const vS = j === 0 ? (per ? v[n + (Ny - 1) * sy] : -v[n]) : v[n - sy];
        const wT = k === Nz - 1 ? -w[n] : w[n + sz], wB = k === 0 ? -w[n] : w[n - sz];
        const d = (u[n + 1] - u[n - 1]) * ix + (vN - vS) * iy + (wT - wB) * iz;
        out[n] = d; const ad = d < 0 ? -d : d; if (ad > mx) mx = ad;
      }
    }
    return mx;
  }
  _pressure() {
    const g = this.grid, Nx = g.Nx, Ny = g.Ny, Nz = g.Nz, sy = Nx, sz = Nx * Ny;
    const p = this.p, rhs = this.div, nb = this.pNb, inv = this.pInv, om = this.sor, idt = 1 / this.dt, tol = this.pTol;
    const cx = 1 / (g.hx * g.hx), cy = 1 / (g.hy * g.hy), cz = 1 / (g.hz * g.hz);
    let it = 0;
    for (; it < this.pIters; it++) {
      let maxUp = 0; // largest SOR correction this sweep, fixed order ⇒ deterministic
      for (let color = 0; color < 2; color++) for (let k = 0; k < Nz; k++) for (let j = 0; j < Ny; j++) {
        const row = j * sy + k * sz;
        for (let i = 1 + ((1 + j + k + color) & 1); i < Nx - 1; i += 2) {
          const n = row + i, id = inv[n]; if (id === 0) continue; // solid or fully enclosed
          const m = 6 * n;
          const s = cx * (p[nb[m]] + p[nb[m + 1]]) + cy * (p[nb[m + 2]] + p[nb[m + 3]]) + cz * (p[nb[m + 4]] + p[nb[m + 5]]);
          const d = om * ((s - rhs[n] * idt) * id - p[n]); p[n] += d;
          const ad = d < 0 ? -d : d; if (ad > maxUp) maxUp = ad;
        }
      }
      if (maxUp < tol) { it++; break; }
    }
    this.report.pIters = it;
  }
  _project() {
    const g = this.grid, Nx = g.Nx, Ny = g.Ny, Nz = g.Nz, sy = Nx, sz = Nx * Ny, per = this.periodicY, torus = this.torus, fwd = this.fwd, wrap = Nx - 3;
    const p = this.p, u = this.u, v = this.v, w = this.w, solid = this.solid, dt = this.dt;
    const ax = dt * 0.5 / g.hx, ay = dt * 0.5 / g.hy, az = dt * 0.5 / g.hz;
    for (let k = 0; k < Nz; k++) for (let j = 0; j < Ny; j++) { const row = j * sy + k * sz; for (let i = 1; i < Nx - 1; i++) {
      const n = row + i; if (solid[n]) continue; const pc = p[n];
      let pxm, pxp; // same neighbour rules as the gather table: wrap in a torus, p = 0 reference on the outlet face, Neumann elsewhere
      if (i === 1) pxm = torus ? (solid[n + wrap] ? pc : p[n + wrap]) : (fwd ? pc : 0); else pxm = solid[n - 1] ? pc : p[n - 1];
      if (i === Nx - 2) pxp = torus ? (solid[n - wrap] ? pc : p[n - wrap]) : (fwd ? 0 : pc); else pxp = solid[n + 1] ? pc : p[n + 1];
      let pym, pyp;
      if (per) { const jm = n + (j === 0 ? (Ny - 1) * sy : -sy), jp = n + (j === Ny - 1 ? -(Ny - 1) * sy : sy); pym = solid[jm] ? pc : p[jm]; pyp = solid[jp] ? pc : p[jp]; }
      else { pym = j > 0 && !solid[n - sy] ? p[n - sy] : pc; pyp = j < Ny - 1 && !solid[n + sy] ? p[n + sy] : pc; }
      const pzm = k > 0 && !solid[n - sz] ? p[n - sz] : pc, pzp = k < Nz - 1 && !solid[n + sz] ? p[n + sz] : pc;
      u[n] -= ax * (pxp - pxm); v[n] -= ay * (pyp - pym); w[n] -= az * (pzp - pzm);
    } }
  }
  _curl() {
    const g = this.grid, Nx = g.Nx, Ny = g.Ny, Nz = g.Nz, sy = Nx, sz = Nx * Ny, per = this.periodicY, zs = this.zsT;
    const u = this.u, v = this.v, w = this.w, wx = this.wx, wy = this.wy, wz = this.wz, solid = this.solid;
    const ix = 0.5 / g.hx, iy = 0.5 / g.hy, iz = 0.5 / g.hz;
    for (let k = 0; k < Nz; k++) for (let j = 0; j < Ny; j++) for (let i = 0; i < Nx; i++) {
      const n = i + j * sy + k * sz;
      if (solid[n]) { wx[n] = wy[n] = wz[n] = 0; continue; }
      let dvdx, dwdx;
      if (i === 0) { dvdx = (v[n + 1] - v[n]) * 2 * ix; dwdx = (w[n + 1] - w[n]) * 2 * ix; }
      else if (i === Nx - 1) { dvdx = (v[n] - v[n - 1]) * 2 * ix; dwdx = (w[n] - w[n - 1]) * 2 * ix; }
      else { dvdx = (v[n + 1] - v[n - 1]) * ix; dwdx = (w[n + 1] - w[n - 1]) * ix; }
      let uN, uS, wN, wS;
      if (per) { const jp = n + (j === Ny - 1 ? -(Ny - 1) * sy : sy), jm = n + (j === 0 ? (Ny - 1) * sy : -sy); uN = u[jp]; uS = u[jm]; wN = w[jp]; wS = w[jm]; }
      else { uN = j === Ny - 1 ? u[n] : u[n + sy]; uS = j === 0 ? u[n] : u[n - sy]; wN = j === Ny - 1 ? w[n] : w[n + sy]; wS = j === 0 ? w[n] : w[n - sy]; }
      const uT = k === Nz - 1 ? zs * u[n] : u[n + sz], uB = k === 0 ? zs * u[n] : u[n - sz];
      const vT = k === Nz - 1 ? zs * v[n] : v[n + sz], vB = k === 0 ? zs * v[n] : v[n - sz];
      const dudy = (uN - uS) * iy, dwdy = (wN - wS) * iy, dudz = (uT - uB) * iz, dvdz = (vT - vB) * iz;
      wx[n] = dwdy - dvdz; wy[n] = dudz - dwdx; wz[n] = dvdx - dudy;
    }
    if (this.torus) this._wrapX([wx, wy, wz]);
  }
  /** Exactly one Δt (§5.5). @returns {StepReport} */
  step() {
    const dt = this.dt, g = this.grid, Nx = g.Nx, N = g.N;
    this.applyBoundaries();
    this._advectVel(this.u, this.v, this.w, this.ua, this.va, this.wa, dt, 1, true);
    this._advectVel(this.ua, this.va, this.wa, this.ub, this.vb, this.wb, dt, -1, false);
    const { u, v, w, ua, va, wa, ub, vb, wb, solid } = this, [mn0, mn1, mn2] = this.mn, [mx0, mx1, mx2] = this.mx;
    for (let row = 0; row < N; row += Nx) for (let n = row + 1; n < row + Nx - 1; n++) { // rows are contiguous in x: no modulo per cell
      if (solid[n]) continue;
      let c = ua[n] + 0.5 * (u[n] - ub[n]); ua[n] = c < mn0[n] ? mn0[n] : c > mx0[n] ? mx0[n] : c;
      c = va[n] + 0.5 * (v[n] - vb[n]); va[n] = c < mn1[n] ? mn1[n] : c > mx1[n] ? mx1[n] : c;
      c = wa[n] + 0.5 * (w[n] - wb[n]); wa[n] = c < mn2[n] ? mn2[n] : c > mx2[n] ? mx2[n] : c;
    }
    this.u = ua; this.ua = u; this.v = va; this.va = v; this.w = wa; this.wa = w;
    this._advectTracers(dt);
    if (this.viscous) this._diffuse(dt);
    if (this.forcing || this.torus) this._addForces(dt);
    this._divergence(this.div);
    this._pressure();
    this._project();
    this.applyBoundaries();
    const divMax = this._divergence(this.div);
    this._curl();
    this.t += dt; this.stepCount++;
    const r = this.report; r.t = this.t; r.divMax = divMax; r.divNorm = divMax * g.hx / this.Uref; // r.pIters is set by _pressure
    return r;
  }
  snapshot() {
    return { t: this.t, stepCount: this.stepCount, u: Float32Array.from(this.u), v: Float32Array.from(this.v), w: Float32Array.from(this.w), p: Float32Array.from(this.p), tracers: this.tracers.map((T) => Float32Array.from(T)), rng: this.rng.getState() };
  }
  restore(s) {
    this.t = s.t; this.stepCount = s.stepCount; this.u.set(s.u); this.v.set(s.v); this.w.set(s.w); this.p.set(s.p);
    s.tracers.forEach((T, c) => this.tracers[c]?.set(T)); this.rng.setState(s.rng); this._curl();
  }
  get state() { return { u: this.u, v: this.v, w: this.w, p: this.p, wx: this.wx, wy: this.wy, wz: this.wz, solid: this.solid, tracers: this.tracers }; }
  dispose() { /* nothing to free on CPU */ }
}