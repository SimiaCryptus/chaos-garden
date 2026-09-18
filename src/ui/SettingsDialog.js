import { SCHEMA } from '../core/Params.js';

/**
 * The one place every run parameter is edited (§ notes). The depth H is the centrepiece control (§9.2): a
 * log-scaled slider with k_h ↔ geometric-scale crossover markers, full width at the top of the dialog.
 * Derived quantities (ν, Re_eff, Re_h) and the live solver status are shown in the footer; ν is editable.
 */
const LG0 = Math.log10(SCHEMA.H.min),
  LG1 = Math.log10(SCHEMA.H.max);
const toH = (s) => 10 ** (LG0 + (s / 1000) * (LG1 - LG0)),
  toS = (H) => Math.round(((Math.log10(H) - LG0) / (LG1 - LG0)) * 1000);
const GROUPS = [
  { title: 'Depth — the centrepiece control', keys: ['H'], wide: true },
  { title: 'Flow', keys: ['flow', 'Re', 'nu', 'inflow', 'perturb', 'seed'] },
  { title: 'Domain & boundaries', keys: ['topology', 'spanwise', 'walls'] },
  { title: 'Measurement', keys: ['twin'] },
  { title: 'Painting', keys: ['inkBudget'] },
  { title: 'Machine (changing these reloads the page)', keys: ['tier', 'backend'] },
];
const DERIVED = {
  nu: {
    label: 'Kinematic viscosity ν',
    desc: 'ν = 1/Re in units of the reference speed × Ly. How "thick" the water is — honey has a large ν, water a small one. Editing ν rewrites Re; the two describe the same fluid.',
  },
};
export class SettingsDialog {
  constructor({ params, notify, bus, barrier }) {
    this.params = params;
    this.notify = notify;
    this.bus = bus;
    this.barrier = barrier;
    this.grid = null;
    this.scales = null;
    this.info = '';
    const d = (this.el = document.createElement('dialog'));
    d.className = 'settings';
    document.body.appendChild(d);
    d.innerHTML = `<form method="dialog">
      <header><h2>Settings</h2><span class="hint">Every value is a run parameter: it is written into the share URL and folded into the run hash, so two runs with different settings never compare. Hotkeys [ and ] nudge the depth without opening this dialog.</span><button value="close" aria-label="close">✕</button></header>
      <div class="body"></div>
      <footer><div class="status"><span data-v="derived"></span><span data-v="info" title="tier · backend · grid · Re_h · k_h · Δt · diffusion scheme · pressure iterations"></span></div><button type="button" data-act="defaults" title="Reset every flow/domain parameter (tier and backend are left alone)">Restore defaults</button><button value="close">Close</button></footer></form>`;
    const body = d.querySelector('.body');
    for (const g of GROUPS) {
      const sec = document.createElement('section');
      if (g.wide) sec.className = 'wide';
      sec.innerHTML = `<h3>${g.title}</h3>`;
      for (const k of g.keys) sec.appendChild(this._row(k));
      body.appendChild(sec);
    }
    this.range = d.querySelector('[data-k=Hs]');
    this.out = d.querySelector('[data-v=H]');
    this.cv = d.querySelector('canvas.markers');
    this.range.addEventListener('input', () => {
      const H = toH(+this.range.value);
      this.out.value = H.toFixed(3);
      d.querySelector('[data-k=H]').value = H.toFixed(4);
      this.drawMarkers(H);
    });
    this.range.addEventListener('change', () =>
      params.set('H', +toH(+this.range.value).toFixed(4))
    );
    body.addEventListener('change', (e) => {
      const k = e.target.dataset.k;
      if (k && k !== 'Hs') this._change(e.target);
    });
    d.querySelector('[data-act=defaults]').addEventListener('click', () => {
      const patch = {};
      for (const k in SCHEMA) if (k !== 'tier' && k !== 'backend') patch[k] = SCHEMA[k].default;
      params.set(patch);
      this.sync();
    });
    bus?.on('params:change', () => {
      if (d.open) this.sync();
    });
    bus?.on('design:change', () => this.refreshScales());
  }
  _row(k) {
    const def = SCHEMA[k] || DERIVED[k],
      row = document.createElement('div');
    row.className = 'row';
    if (k === 'H') {
      row.className = 'row depth';
      row.innerHTML = `<label><span class="name">${def.label}<code>${k}</code></span><input type="number" data-k="H" min="${def.min}" max="${def.max}" step="${def.step}"></label>
        <div class="H"><input type="range" min="0" max="1000" data-k="Hs" aria-label="Slab aspect H, logarithmic"><output data-v="H"></output></div>
        <canvas class="markers" height="18" title="k_h against the painted geometry: orange = obstacle sizes, cyan = gaps, band = crossover region, white = current depth"></canvas>
        <p class="desc">${def.desc}</p><p class="desc" data-v="cross"></p>`;
      return row;
    }
    let ctl;
    if (!SCHEMA[k]) ctl = `<input type="number" data-k="${k}" step="any" min="0">`;
    else if (def.type === 'number')
      ctl = `<input type="number" data-k="${k}" min="${def.min}" max="${def.max}" step="${def.step}">`;
    else if (def.type === 'enum')
      ctl = `<select data-k="${k}">${def.values.map((v) => `<option>${v}</option>`).join('')}</select>`;
    else ctl = `<input type="checkbox" data-k="${k}">`;
    row.innerHTML = `<label><span class="name">${def.label}<code>${k}</code></span>${ctl}</label><p class="desc">${def.desc || ''}</p>`;
    return row;
  }
  _change(t) {
    const k = t.dataset.k;
    if (!k) return;
    if (k === 'nu') {
      const v = +t.value;
      if (v > 0) this.params.set('Re', 1 / v);
      this.sync();
      return;
    }
    const def = SCHEMA[k],
      v = def.type === 'boolean' ? t.checked : def.type === 'number' ? +t.value : t.value;
    this.params.set(k, v);
    const after = this.params.get(k);
    if (def.type === 'number' && Number.isFinite(v) && after !== v)
      this.notify.show(`${k}: ${v} clamped to ${after}`, { kind: 'warn' });
    this.sync();
  }
  sync() {
    const p = this.params;
    for (const el of this.el.querySelectorAll('[data-k]')) {
      const k = el.dataset.k;
      if (k === 'Hs') el.value = toS(p.get('H'));
      else if (k === 'nu') el.value = (1 / p.get('Re')).toExponential(3);
      else if (el.type === 'checkbox') el.checked = p.get(k);
      else el.value = p.get(k);
    }
    this.out.value = p.get('H').toFixed(3);
    const U = Math.abs(p.get('flow')),
      Re = p.get('Re');
    this.el.querySelector('[data-v=derived]').textContent =
      `ν = ${(1 / Re).toExponential(2)} · Re_eff = |U₀|·Re = ${(U * Re).toFixed(0)} · Re_h = Re·H = ${(Re * p.get('H')).toFixed(0)} · flow ${p.get('flow') < 0 ? '← right to left' : p.get('flow') > 0 ? '→ left to right' : 'still'}${p.get('topology') === 'torus' ? ' · torus' : ''}`;
    this.el.querySelector('[data-v=info]').textContent = this.info;
    if (this.el.open) this.drawMarkers(p.get('H'));
  }
  /** The grid changes with tier and H; the geometric scales are measured in units of hy. */
  setGrid(grid) {
    this.grid = grid;
    this.refreshScales();
  }
  refreshScales() {
    if (!this.grid) return;
    this.scales = this.barrier.geometricScales(this.grid.hy);
    if (this.el.open) this.drawMarkers(this.params.get('H'));
  }
  /** Live solver status line (built by App); only touches the DOM while the dialog is open. */
  setInfo(info) {
    this.info = info;
    if (this.el.open) this.el.querySelector('[data-v=info]').textContent = info;
  }
  /** Crossover: k_h = π/(H·Ly) equals k_ℓ = 2π/ℓ when H* = ℓ/(2·Ly). */
  drawMarkers(H) {
    const cv = this.cv,
      W = cv.clientWidth || 400,
      dpr = devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(18 * dpr);
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, 18);
    const X = (h) => ((Math.log10(h) - LG0) / (LG1 - LG0)) * W;
    const s = this.scales,
      all = s ? [...s.gaps, ...s.obstacles].map((q) => q.scale / 2) : [];
    if (all.length) {
      const lo = Math.min(...all),
        hi = Math.max(...all);
      g.fillStyle = 'rgba(255,180,84,0.18)';
      g.fillRect(
        X(Math.max(0.01, lo / 1.5)),
        0,
        X(Math.min(1, hi * 1.5)) - X(Math.max(0.01, lo / 1.5)),
        18
      );
    }
    if (s) {
      for (const q of s.obstacles) {
        g.fillStyle = `rgba(255,180,84,${0.4 + 0.6 * q.weight})`;
        g.fillRect(X(q.scale / 2) - 1, 2, 2, 14);
      }
      for (const q of s.gaps) {
        g.fillStyle = `rgba(108,196,255,${0.4 + 0.6 * q.weight})`;
        g.fillRect(X(q.scale / 2) - 1, 2, 2, 14);
      }
    }
    g.fillStyle = '#dfe3ea';
    g.fillRect(X(H) - 1, 0, 2, 18);
    g.fillStyle = '#8a93a3';
    g.font = '10px system-ui';
    g.fillText('0.01', 2, 12);
    g.fillText('0.1', X(0.1) + 3, 12);
    g.fillText('1', W - 8, 12);
    const inBand = all.some((h) => Math.abs(Math.log10(h / H)) < 0.18);
    this.el.querySelector('[data-v=cross]').textContent = all.length
      ? `Markers: the confinement wavenumber k_h = π/(H·Ly) matches a painted scale ℓ when H = ℓ/2. Orange ticks are obstacle sizes, cyan ticks are gaps, the band spans their range.${inBand ? ' ⚠ The current depth sits inside the crossover band — the flow is most sensitive to H here.' : ''}`
      : 'Paint an obstacle to see its geometric scales marked against the depth.';
  }
  open() {
    if (!this.el.open) this.el.showModal();
    this.sync();
  }
}
