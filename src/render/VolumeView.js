import { lut, bandColors } from './Palette.js';

/**
 * Orbit-mode compositing: one RGBA8 voxel per solver cell, in the solver's own layout (n = i + Nx·(j + Ny·k)),
 * uploaded as a 3D texture and ray-marched by the Renderer. rgb comes from the same LUTs as the plan view; alpha
 * is an extinction density — calm fluid is glass, strong |ω_z| / |u| / dye is dense — and 255 is reserved for
 * solid voxels, which the shader draws opaque. Colour range auto-scales with the same smoothing as TopDownView.
 */
export class VolumeView {
  constructor(grid) { this.range = { vorticity: 1, speed: 1 }; this.setGrid(grid); }
  setGrid(grid) { this.grid = grid; this.data = new Uint8Array(grid.N * 4); this.scalar = new Float32Array(grid.N); }
  compose(solver, layer = 'vorticity') {
    if (layer === 'dye') return this._dye(solver);
    const N = this.grid.N, d = this.data, solid = solver.solid, f = this.scalar, speed = layer === 'speed';
    let m = 0;
    if (speed) { const { u, v, w } = solver; for (let n = 0; n < N; n++) { const a = Math.sqrt(u[n] * u[n] + v[n] * v[n] + w[n] * w[n]); f[n] = a; if (a > m) m = a; } }
    else { const wz = solver.wz; for (let n = 0; n < N; n++) { const a = wz[n]; f[n] = a; const b = a < 0 ? -a : a; if (b > m) m = b; } }
    const key = speed ? 'speed' : 'vorticity';
    this.range[key] = this.range[key] * 0.9 + Math.max(1e-6, 0.85 * m) * 0.1;
    const r = this.range[key], L = speed ? lut('viridis') : lut('coolwarm'), dens = speed ? 0.35 : 1; // a plug flow is |u| ≈ U₀ everywhere; keep it see-through
    for (let n = 0, o = 0; n < N; n++, o += 4) {
      if (solid[n]) { d[o] = 44; d[o + 1] = 46; d[o + 2] = 54; d[o + 3] = 255; continue; }
      const x = f[n] / r; let a = x < 0 ? -x : x; if (a > 1) a = 1;
      let t = speed ? x : 0.5 + 0.5 * x; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const i = Math.round(t * 255) * 3;
      d[o] = L[i]; d[o + 1] = L[i + 1]; d[o + 2] = L[i + 2]; d[o + 3] = Math.round(250 * a * a * dens);
    }
    return d;
  }
  _dye(solver) {
    const N = this.grid.N, d = this.data, solid = solver.solid, K = solver.K, cols = bandColors(K), T = solver.tracers;
    for (let n = 0, o = 0; n < N; n++, o += 4) {
      if (solid[n]) { d[o] = 44; d[o + 1] = 46; d[o + 2] = 54; d[o + 3] = 255; continue; }
      let r = 0, g = 0, b = 0, tot = 0;
      for (let c = 0; c < K; c++) { const v = T[c][n]; if (v <= 1e-4) continue; const col = cols[c]; r += v * col[0]; g += v * col[1]; b += v * col[2]; tot += v; }
      if (tot <= 1e-4) { d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0; continue; }
      const s = 255 / tot, a = tot > 1 ? 1 : tot; // hue = flux-weighted band mix, density = how much dye is here
      d[o] = Math.min(255, r * s); d[o + 1] = Math.min(255, g * s); d[o + 2] = Math.min(255, b * s); d[o + 3] = Math.round(250 * Math.sqrt(a));
    }
    return d;
  }
}