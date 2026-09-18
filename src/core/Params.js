/**
 * @typedef {Object} CgParams
 * @property {number} H        slab aspect Lz/Ly, [0.01, 1.0]
 * @property {number} Re       Reynolds number at unit speed (ν = 1/Re), [200, 20000]
 * @property {number} flow     signed bulk speed U₀, [-3, 3]; negative flow enters through the right face
 * @property {'channel'|'torus'} topology streamwise topology: open channel or compact (periodic) dimension
 * @property {'plug'|'parabolic'} inflow
 * @property {'periodic'|'freeslip'} spanwise
 * @property {'noslip'|'freeslip'} walls
 * @property {number} seed     uint32
 * @property {'auto'|'G'|'A'|'B'|'C'|'D'} tier
 * @property {'auto'|'cpu'|'webgpu'} backend
 * @property {boolean} twin    enable Lyapunov twin
 * @property {number} inkBudget solid-fraction cap
 * @property {number} perturb  inflow perturbation amplitude
 */
export const SCHEMA = {
  H: {
    type: 'number',
    min: 0.01,
    max: 1.0,
    default: 0.2,
    step: 0.005,
    label: 'Slab aspect H = Lz/Ly',
    desc: 'How deep the water is compared with the channel width. Shallow gardens (small H) behave almost two-dimensionally: eddies are flat pancakes and energy tends to pile up at large scales. Deeper slabs let the flow twist in three dimensions. The confinement wavenumber k_h = π/Lz marks where the two regimes cross.',
  },
  Re: {
    type: 'number',
    min: 200,
    max: 20000,
    default: 2000,
    step: 50,
    label: 'Reynolds number Re = U₀·Ly/ν',
    desc: 'Ratio of inertia to viscosity at unit speed; the kinematic viscosity is ν = 1/Re. Low Re is syrupy and smooth, high Re is thin and turbulent. With a non-unit flow rate the effective Reynolds number is |U₀|·Re. Very high Re on a coarse grid raises the under-resolved flag.',
  },
  flow: {
    type: 'number',
    min: -3,
    max: 3,
    default: 1,
    step: 0.05,
    label: 'Flow rate U₀ (signed)',
    desc: 'Bulk speed imposed at the inlet, in units of the reference speed. Negative values reverse the current: water then enters through the right face and leaves through the left, and every measurement (throughput Q, dye information Î) follows the direction. Near zero the garden stands still. In a torus this is the mean speed the body force maintains. The time step scales with 1/|U₀|.',
  },
  topology: {
    type: 'enum',
    values: ['channel', 'torus'],
    default: 'channel',
    label: 'Streamwise topology',
    desc: 'channel: an inlet face and a one-way convective outlet face — water passes through once. torus: the streamwise direction is a compact (periodic) dimension, so whatever leaves the right edge re-enters on the left and the same water circulates forever, kept moving by a gentle body force toward U₀. Dye bands are still injected at the seam, so Î measures how much scrambling one circuit causes.',
  },
  inflow: {
    type: 'enum',
    values: ['plug', 'parabolic'],
    default: 'plug',
    label: 'Inflow profile p(z)',
    desc: 'Shape of the inlet velocity through the depth: plug (uniform) or parabolic (6z(1−z), a fully developed viscous profile that vanishes at the top and bottom walls).',
  },
  spanwise: {
    type: 'enum',
    values: ['periodic', 'freeslip'],
    default: 'periodic',
    label: 'Spanwise y± boundary',
    desc: 'What happens at the two long sides of the garden. periodic: the span is itself a compact dimension (a cylinder) — a vortex leaving the top re-enters at the bottom. freeslip: ideal, stress-free side walls that water slides along without friction.',
  },
  walls: {
    type: 'enum',
    values: ['noslip', 'freeslip'],
    default: 'noslip',
    label: 'Wall z± boundary',
    desc: 'Bed and lid of the slab. noslip: real walls, the water sticks (velocity zero) and a boundary layer forms. freeslip: an ideal surface — the tangential velocity is mirrored, so the walls exert no shear at all.',
  },
  seed: {
    type: 'number',
    min: 0,
    max: 4294967295,
    default: 1337,
    step: 1,
    integer: true,
    label: 'Run seed',
    desc: 'Seeds the inlet noise and the initial perturbation. The simulation is otherwise fully deterministic, so the same seed, design and parameters reproduce the same run on the same backend.',
  },
  tier: {
    type: 'enum',
    values: ['auto', 'G', 'A', 'B', 'C', 'D'],
    default: 'auto',
    label: 'Quality tier',
    desc: 'Grid size and pressure-solver effort. auto picks from a start-up benchmark. G is the WebGPU tier (192×96); A–D run on the CPU from 128×64 down to 48×24. Changing it reloads the page.',
  },
  backend: {
    type: 'enum',
    values: ['auto', 'cpu', 'webgpu'],
    default: 'auto',
    label: 'Compute backend',
    desc: 'auto uses WebGPU whenever a device is available; cpu forces the deterministic reference solver. Scores are comparable only within one backend. Changing it reloads the page.',
  },
  twin: {
    type: 'boolean',
    default: true,
    label: 'Lyapunov twin solver',
    desc: 'Run a second, slightly perturbed copy of the flow to measure how fast tiny differences grow (the Lyapunov exponent λ). Doubles the cost; turn off on slow machines.',
  },
  inkBudget: {
    type: 'number',
    min: 0.02,
    max: 0.5,
    default: 0.22,
    step: 0.01,
    label: 'Ink budget (solid fraction cap)',
    desc: 'Maximum fraction of the garden you may fill with banks and rocks. Keeps designs comparable and stops the channel being walled off.',
  },
  perturb: {
    type: 'number',
    min: 0,
    max: 0.1,
    default: 0.01,
    step: 0.001,
    label: 'Inflow perturbation amplitude',
    desc: 'Amplitude of the fixed, seeded spanwise wobble added to the inlet velocity, relative to U₀. Without it a symmetric design may stay laminar for a very long time.',
  },
};
/** Short keys used by HashCodec to keep URL fragments compact. */
export const SHORT_KEYS = {
  H: 'H',
  Re: 'R',
  flow: 'f',
  topology: 'o',
  inflow: 'i',
  spanwise: 's',
  walls: 'w',
  seed: 'd',
  tier: 't',
  backend: 'g',
  twin: 'T',
  inkBudget: 'b',
  perturb: 'p',
};

export function defaults() {
  const d = {};
  for (const k in SCHEMA) d[k] = SCHEMA[k].default;
  return d;
}

/** @returns {{ok:boolean, errors:string[], normalized:CgParams}} */
export function validate(p = {}) {
  const errors = [],
    normalized = defaults();
  for (const [k, def] of Object.entries(SCHEMA)) {
    if (!(k in p) || p[k] == null) continue;
    let v = p[k];
    if (def.type === 'number') {
      v = Number(v);
      if (!Number.isFinite(v)) {
        errors.push(`${k}: not a number`);
        continue;
      }
      if (def.integer) v = Math.round(v);
      if (v < def.min || v > def.max) {
        errors.push(`${k}: ${v} clamped to [${def.min}, ${def.max}]`);
        v = Math.min(def.max, Math.max(def.min, v));
      }
    } else if (def.type === 'enum') {
      if (!def.values.includes(v)) {
        errors.push(`${k}: invalid '${v}'`);
        v = def.default;
      }
    } else if (def.type === 'boolean') v = v === true || v === 'true' || v === 1;
    normalized[k] = v;
  }
  return { ok: errors.length === 0, errors, normalized };
}

/** Owns parameter state and emits 'params:change' {changed, params}. */
export class Params {
  constructor(bus, init = {}) {
    this.bus = bus;
    this._v = validate(init).normalized;
  }
  get(k) {
    return this._v[k];
  }
  get all() {
    return { ...this._v };
  }
  set(k, v, opts = {}) {
    let patch;
    if (typeof k === 'object') {
      patch = k;
      opts = v || {};
    } else patch = { [k]: v };
    const { normalized } = validate({ ...this._v, ...patch });
    const changed = Object.keys(patch).filter((key) => normalized[key] !== this._v[key]);
    if (!changed.length) return false;
    this._v = normalized;
    if (!opts.silent) this.bus?.emit('params:change', { changed, params: this.all });
    return true;
  }
  toJSON() {
    return this.all;
  }
}
