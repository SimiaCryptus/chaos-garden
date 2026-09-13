import { LineChart } from '../Charts/LineChart.js';
import { WEIGHTS, DEFINITIONS, NORMALIZERS } from '../../metrics/Score.js';
import { lut } from '../../render/Palette.js';

/** [key, label, definition popover] — every metric has a one-click definition (§12). */
const ROWS = [
  ['E', 'E', 'Kinetic energy E = ½⟨|u|²⟩ over fluid cells, units of U₀².'],
  ['Z', 'Z', 'Enstrophy Z = ½⟨|ω|²⟩ over fluid cells.'],
  ['P', 'P', `Palinstrophy P = ½⟨|∇ω|²⟩ — resolution health. P·hx²/Z above ${NORMALIZERS.resolutionRatio} raises the under-resolved flag.`],
  ['eps', 'ε', 'Dissipation ε = ν⟨|∇u|²⟩ (gradient form, interior cells).'],
  ['divNorm', '‖∇·u‖∞', `Max divergence after projection, scaled by hx/U₀. Solver trust indicator; above ${NORMALIZERS.epsDiv} the run is invalid.`],
  ['cfl', 'CFL', 'Courant number from the largest cell speed at the fixed Δt (substepping is not used; CFL > 1 means the flow outran the design speed).'],
  ['Q', 'Q', `Throughput: mean streamwise velocity at the outlet plane / U₀. Score is multiplied by min(1, Q/${NORMALIZERS.Qmin}) so blocking the channel cannot fake information loss.`],
  ['lambda', 'λ', DEFINITIONS.lyapunov],
  ['Hw', 'H_ω', 'Normalized Shannon entropy of the log|ω| histogram (256 bins, fixed range [1e-3, 1e3]) over the analysis window.'],
  ['Hang', 'H_θ', 'Normalized Shannon entropy of the velocity-direction histogram (64 bins). Prevents "fast but laminar" from scoring on entropy.'],
  ['I', 'Î', 'Inlet-band → outlet-band mutual information, 16 bands, flux-weighted, bits / log₂16. Score uses 1 − Î.'],
  ['Drev', 'D_rev', DEFINITIONS.rewind + ' Run the probe in Rewind mode (W).'],
  ['breadth', 'B', DEFINITIONS.breadth],
];
const SWEEP_KEYS = [['lambda', 'λ(H)'], ['Hw', 'Ĥ_ω(H)'], ['infoLoss', '1−Î(H)'], ['Drev', 'D̂_rev(H)'], ['breadth', 'B̂(H)'], ['score', 'S(H)']];
const fmt = (v) => (v == null || !Number.isFinite(v) ? '—' : Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(2) : v.toFixed(Math.abs(v) >= 100 ? 1 : 3));
const LAYOUT_KEY = 'cg:side'; // which sections are collapsed

export class MetricsPanel {
  constructor(el, { notify }) {
    this.el = el; this.notify = notify; this.mode = null; this.sweep = null; this.rew = null; this._lastSpec = null; this._rigCards = new Map();
    el.innerHTML = `
      <details data-sec="score" open><summary>Score</summary><div class="big" data-v="score">—</div><div class="parts"></div><div class="flags"></div><div class="solver" data-v="meta"></div><div class="solver" data-v="solver" title="tier · backend · grid · Re_h · k_h · Δt · diffusion scheme · pressure iterations"></div><div class="job" data-v="job" hidden></div></details>
      <details data-sec="rig" data-s="rig" open hidden><summary>Airfoil rig <small>(hover a value for its definition)</small></summary><div data-v="rig"></div><div class="hint" data-v="rignone">— no bodies. Generate a NACA rig, or paint shapes in Paint mode and come back —</div></details>
      <details data-sec="measure" open><summary>Measurements <small>(click a name for its definition)</small></summary><table>${ROWS.map(([k, l]) => `<tr><td data-def="${k}">${l}</td><td data-r="${k}">—</td></tr>`).join('')}</table></details>
      <details data-sec="spectra" open><summary>Spectra · analysis window</summary><canvas class="chart" data-c="spec"></canvas><canvas class="chart small" data-c="flux"></canvas><canvas class="chart small" data-c="deff"></canvas></details>
      <details data-sec="history" open><summary>History</summary><canvas class="chart small" data-c="hist"></canvas></details>
      <details data-sec="rewind" data-s="rewind" open hidden><summary>Rewind</summary><div data-v="rewind">Press W to run the reversibility probe.</div></details>
      <details data-sec="sweep" data-s="sweep" open hidden><summary>Sweep fingerprint</summary><div class="grid2">${SWEEP_KEYS.map(([k]) => `<canvas class="chart small" data-sw="${k}"></canvas>`).join('')}</div><canvas class="chart" data-c="heat" title="Π(k, H): red forward, blue inverse"></canvas></details>`;
    // collapsed state persists across reloads; reopening a section forces the spectra to redraw at the new size
    let saved = {}; try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}; } catch { /* no storage */ }
    for (const d of el.querySelectorAll('details[data-sec]')) {
      if (saved[d.dataset.sec] === false) d.open = false;
      d.addEventListener('toggle', () => { saved[d.dataset.sec] = d.open; try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(saved)); } catch { /* ignore */ } if (d.open) this._lastSpec = null; });
    }
    this.charts = {}; for (const c of el.querySelectorAll('canvas[data-c]')) this.charts[c.dataset.c] = new LineChart(c);
    this.sweepCharts = {}; for (const c of el.querySelectorAll('canvas[data-sw]')) this.sweepCharts[c.dataset.sw] = new LineChart(c);
    for (const [k, , def] of ROWS) el.querySelector(`[data-def=${k}]`).title = def;
    el.addEventListener('click', (e) => { const td = e.target.closest('td[data-def]'); if (!td) return; const row = ROWS.find((r) => r[0] === td.dataset.def); if (row) notify.popover(row[1], row[2]); });
  }
  setMode(m) { this.mode = m; this._vis(); }
  _vis() {
    const m = this.mode, show = { sweep: m === 'sweep' || !!this.sweep?.length, rewind: m === 'rewind' || !!this.rew, rig: m === 'airfoil' };
    for (const s of this.el.querySelectorAll('[data-s]')) s.hidden = !show[s.dataset.s];
  }
  setJobProgress(label, p) { const j = this.el.querySelector('[data-v=job]'); j.hidden = !label; if (label) j.textContent = `${label} · ${((p || 0) * 100).toFixed(0)}%`; }
  update({ raw, res, spectra, kh, label, hash, recorder, info }) {
    const q = (s) => this.el.querySelector(s);
    const sc = q('[data-v=score]'); sc.textContent = `S ${res.score.toFixed(1)}`;
    sc.classList.toggle('invalid', !res.valid && !res.flags.includes('settling')); sc.classList.toggle('settling', res.flags.includes('settling'));
    const parts = q('.parts'); parts.textContent = '';
    for (const k of Object.keys(WEIGHTS)) {
      const d = document.createElement('div'), a = document.createElement('span'), b = document.createElement('span');
      a.textContent = k; a.title = DEFINITIONS[k]; b.textContent = k in res.parts ? `${res.parts[k].toFixed(2)} × w ${res.weights[k].toFixed(2)}` : 'n/a'; d.append(a, b); parts.appendChild(d);
    }
    const fl = q('.flags'); fl.textContent = '';
    for (const f of res.flags) { const s = document.createElement('span'); s.textContent = f; fl.appendChild(s); }
    if (res.gate < 1) { const s = document.createElement('span'); s.textContent = `gate ×${res.gate.toFixed(2)}`; fl.appendChild(s); }
    q('[data-v=meta]').textContent = `${label} · run ${hash}`;
    if (info != null) q('[data-v=solver]').textContent = info;
    for (const [k] of ROWS) q(`[data-r=${k}]`).textContent = fmt(raw[k]);
    if (spectra && spectra !== this._lastSpec) { this._lastSpec = spectra; this._drawSpectra(spectra, kh); }
    if (recorder) { const E = recorder.series('E'), Hw = recorder.series('Hw'); this.charts.hist.draw([{ x: E.x, y: E.y, color: '#6cc4ff', label: 'E' }, { x: Hw.x, y: Hw.y, color: '#ffb454', label: 'H_ω' }], { title: 'time series (t)' }); }
  }
  /**
   * Airfoil rig readout: one card per body and per spring, made of atomic label/value cells that each carry a
   * definition tooltip. The DOM is keyed by id and updated in place so tooltips do not flicker under the pointer.
   */
  updateRig(rig, solver) {
    if (!rig || !solver) return;
    const host = this.el.querySelector('[data-v=rig]'), none = this.el.querySelector('[data-v=rignone]');
    const U = solver.Uref, Lz = rig.Lz, sgn = solver.U0 < 0 ? -1 : 1, live = new Set();
    const card = (key, title, tip) => {
      live.add(key); let c = this._rigCards.get(key);
      if (!c) { c = document.createElement('div'); c.className = 'card'; c.innerHTML = '<div class="title"></div><div class="kvs"></div>'; this._rigCards.set(key, c); host.appendChild(c); }
      const t = c.firstChild; t.textContent = title; t.title = tip; return c.lastChild;
    };
    const kv = (kvs, items) => { // items: [label, value, tooltip, class?]
      while (kvs.children.length > items.length) kvs.lastChild.remove();
      items.forEach(([l, v, tip, cls], i) => {
        let el = kvs.children[i];
        if (!el) { el = document.createElement('span'); el.innerHTML = '<b></b><span></span>'; kvs.appendChild(el); }
        el.className = cls ? `kv ${cls}` : 'kv'; el.title = tip; el.firstChild.textContent = l; el.lastChild.textContent = v;
      });
    };
    const deg = (r) => (r * 180 / Math.PI).toFixed(1);
    for (const b of rig.bodies) {
      const qd = 0.5 * U * U * b.chord * Lz, F = b.Favg, P = b.Fpavg, V = b.Fvavg, na = b.anchors.length;
      const hold = na === 0 ? 'free' : na === 1 ? 'pivot' : 'fixed', cd = (f) => sgn * f.x / qd, cl = (f) => f.y / qd, ad = Math.abs(P.x) + Math.abs(V.x);
      kv(card(`b${b.id}`, `${b.name} · ${hold}`, `${hold === 'free' ? 'No anchors: carried by the current' : hold === 'pivot' ? 'One anchor: swings about it' : 'Two anchors: held still'} · chord ${b.chord.toFixed(3)} Ly · mass ${b.mass.toExponential(2)} (ρ_b/ρ = ${b.density}) · ${b.cells} image cells`), [
        ['cells', String(b.painted), 'Cells of the body currently rasterized into the garden (drops when part of it leaves the paintable area)', b.painted < b.cells ? 'warn' : ''],
        ['x', b.x.toFixed(3), 'Centroid x, units of Ly (the channel is 2 long)'],
        ['y', b.y.toFixed(3), 'Centroid y, units of Ly'],
        ['θ°', deg(b.th), 'Rotation about the centroid, degrees, counter-clockwise positive'],
        ['|v|', Math.hypot(b.vx, b.vy).toFixed(3), 'Centroid speed in units of the reference speed (capped at half a cell per step)'],
        ['ω', b.om.toFixed(3), 'Angular velocity, radians per unit time'],
        ['F_x', fmt(F.x), 'Streamwise fluid force = pressure integral + skin friction over the exposed voxel faces, exponentially smoothed over ~20 steps; fluid density 1'],
        ['F_y', fmt(F.y), 'Cross-stream fluid force (pressure + skin friction), smoothed'],
        ['τ', fmt(F.t), 'Fluid torque about the centroid, smoothed'],
        ['C_D', fmt(cd(F)), `Drag coefficient sign(U₀)·F_x / (½U₀²·chord·Lz) = pressure ${fmt(cd(P))} + friction ${fmt(cd(V))}`],
        ['C_L', fmt(cl(F)), `Lift coefficient F_y / (½U₀²·chord·Lz) = pressure ${fmt(cl(P))} + friction ${fmt(cl(V))}`],
        ['C_M', fmt(F.t / (qd * b.chord)), 'Moment coefficient τ / (½U₀²·chord²·Lz) about the centroid'],
        ['friction', ad > 0 ? `${(100 * Math.abs(V.x) / ad).toFixed(0)}%` : '—', 'Share of the streamwise force carried by skin friction, |F_x,f| / (|F_x,p| + |F_x,f|); 0 when skin friction is switched off'],
      ]);
    }
    for (const s of rig.springs) {
      const st = s.clamped ? 'k capped' : s.L > s.Lmax ? 'at max' : s.L < s.Lmin ? 'at min' : 'ok';
      kv(card(`s${s.id}`, `spring ${s.id}${s.name ? ` · ${s.name}` : ''} → ${rig.body(s.body)?.name ?? '?'}`, 'A spring from a fixed world point to a point on the body; its extension reads the force the water exerts along it.'), [
        ['L', s.L.toFixed(3), 'Current length'],
        ['L₀', s.L0.toFixed(3), 'Rest length (as placed)'],
        ['ΔL', fmt(s.L - s.L0), 'Extension L − L₀; positive when stretched'],
        ['F', fmt(s.F), 'Spring force k·ΔL (plus the hard-limit spring beyond [L_min, L_max]); positive in tension'],
        ['k', String(s.k), 'Spring constant; stiffness above the explicit-stability cap ¼m/Δt² is clamped and flagged'],
        ['L_min', s.Lmin.toFixed(3), 'Hard minimum length: a much stiffer spring takes over below it'],
        ['L_max', s.Lmax.toFixed(3), 'Hard maximum length: a much stiffer spring takes over beyond it'],
        ['status', st, 'ok · at min / at max: a hard length limit is active · k capped: the requested stiffness exceeds the stability cap', st === 'ok' ? '' : 'warn'],
      ]);
    }
    for (const [k, c] of this._rigCards) if (!live.has(k)) { c.remove(); this._rigCards.delete(k); }
    none.hidden = rig.bodies.length > 0;
  }
  _drawSpectra(s, kh) {
    const k = Array.from(s.k), kx = k.slice(1), bands = [], vlines = kh ? [{ x: kh, color: '#ffb454', label: 'k_h' }] : [];
    let m = 0; for (let i = 1; i < s.Pi.length; i++) m = Math.max(m, Math.abs(s.Pi[i]));
    if (m > 0) for (let i = 1; i < k.length; i++) { const a = Math.abs(s.Pi[i]) / m; if (a < 0.05) continue; bands.push({ x0: k[i] - s.dk / 2, x1: k[i] + s.dk / 2, color: s.Pi[i] > 0 ? `rgba(200,60,60,${0.4 * a})` : `rgba(60,120,255,${0.4 * a})` }); }
    this.charts.spec.draw([{ x: kx, y: Array.from(s.E).slice(1), color: '#dfe3ea', label: 'E(k)' }, { x: kx, y: Array.from(s.E0).slice(1), color: '#7bd88f', label: 'E₀(k)' }], { logx: true, logy: true, bands, vlines, title: 'E(k) log-log · shade = sign Π' });
    this.charts.flux.draw([{ x: kx, y: Array.from(s.Pi).slice(1), color: '#ffb454', label: 'Π(k)' }], { logx: true, yzero: true, vlines, title: 'Π(k)  >0 forward · <0 inverse' });
    this.charts.deff.draw([{ x: kx, y: Array.from(s.dEff).slice(1), color: '#6cc4ff', label: 'd_eff' }], { logx: true, ymin: 2, ymax: 3, vlines, title: 'd_eff(k) = 2 + β(k)' });
  }
  setRewind(r) {
    this.rew = r; this._vis();
    const verdict = r.D_rev < 0.1 ? 'practically reversible over this horizon' : r.D_rev < 0.5 ? 'partially reversible' : 'past is unrecoverable (D_rev ≥ 0.5)';
    this.el.querySelector('[data-v=rewind]').textContent = `D_rev = ${r.D_rev.toExponential(3)} after N = ${r.N} steps (${r.flowThroughs.toFixed(2)} flow-throughs, t = ${r.horizonTime.toFixed(2)}) — ${verdict}.`;
  }
  showSweep(results, ladder) {
    this.sweep = results; this._vis();
    const H = results.map((r) => r.H);
    const get = { lambda: (r) => r.raw.lambda, Hw: (r) => r.raw.Hw, infoLoss: (r) => (r.raw.I == null ? null : 1 - r.raw.I), Drev: (r) => r.raw.Drev, breadth: (r) => r.raw.breadth, score: (r) => r.score };
    for (const [k, label] of SWEEP_KEYS) this.sweepCharts[k].draw([{ x: H, y: results.map(get[k]), color: '#6cc4ff', marker: true }], { logx: true, title: `${label}${results.length < (ladder?.length || 0) ? ` ${results.length}/${ladder.length}` : ''}` });
    this._heat(results);
  }
  _heat(results) {
    const cv = this.el.querySelector('[data-c=heat]'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 300, Hh = cv.clientHeight || 110;
    cv.width = Math.round(W * dpr); cv.height = Math.round(Hh * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, Hh);
    g.font = '10px system-ui'; g.fillStyle = '#8a93a3'; g.fillText('Π(k, H)  red = forward, blue = inverse', 4, 10);
    const rows = results.filter((r) => r.spectra?.Pi?.length > 1).sort((a, b) => a.H - b.H); if (!rows.length) return;
    let m = 0; for (const r of rows) for (let i = 1; i < r.spectra.Pi.length; i++) m = Math.max(m, Math.abs(r.spectra.Pi[i]));
    const L = lut('coolwarm'), nk = Math.max(...rows.map((r) => r.spectra.Pi.length)) - 1, x0 = 34, T = 14, B = 12, ph = Hh - T - B, rh = ph / rows.length, cw = (W - x0 - 4) / nk;
    rows.forEach((r, ri) => { const Pi = r.spectra.Pi; for (let i = 1; i < Pi.length; i++) {
      const t = m > 0 ? 0.5 + 0.5 * Pi[i] / m : 0.5, c = Math.round(Math.max(0, Math.min(1, t)) * 255) * 3;
      g.fillStyle = `rgb(${L[c]},${L[c + 1]},${L[c + 2]})`; g.fillRect(x0 + (i - 1) * cw, T + ph - (ri + 1) * rh, Math.ceil(cw), Math.ceil(rh));
    } });
    g.fillStyle = '#8a93a3'; g.fillText(`H ${rows[rows.length - 1].H}`, 2, T + 9); g.fillText(`H ${rows[0].H}`, 2, T + ph - 2);
    g.textAlign = 'right'; g.fillText('k (linear bins) →', W - 2, Hh - 2); g.textAlign = 'left';
  }
}