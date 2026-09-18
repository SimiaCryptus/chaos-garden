/**
 * Airfoil-mode tools column and canvas interaction: place anchors and springs on rigid bodies, generate NACA rigs.
 * The force / spring readout lives with the other measurements in the right panel (MetricsPanel.updateRig) and
 * is refreshed through the `readout` callback.
 */
const RIGS = {
  pivot:
    'anchor at the quarter chord (aerodynamic centre) + a pitch spring at 3c/4: the section weathervanes until the spring balances the moment',
  sprung:
    'lift, drag and pitch springs at c/4 and 3c/4, no anchor: every force component is read from a spring extension',
  fixed:
    'two anchors (c/4 and 3c/4): held still, the force comes straight from the pressure and shear integrals',
  free: 'no constraints: the section is carried by the current',
};
export class RigTool {
  constructor(panel, { rig, canvas, view, notify, bus, solver, readout }) {
    Object.assign(this, { panel, rig, canvas, view, notify, bus, solver, readout });
    this.enabled = false;
    this.tool = 'move';
    this.pending = null;
    this.drag = null;
    this.k = 2;
    this.minR = 0.5;
    this.maxR = 1.5;
    this._build();
    this._bind();
  }
  _build() {
    const tools = [
      ['move', 'drag a free body; a pivoted body swings about its anchor'],
      ['anchor', 'click a body: pin that point in space (1 anchor = pivot, 2 = fixed)'],
      ['spring', 'click a world point, then a point on a body'],
      ['delete', 'click an anchor, a spring end or a body'],
    ];
    this.panel.innerHTML = `<h3>Airfoil rig</h3>
      <div class="row tools">${tools.map(([t, tip]) => `<button data-tool="${t}" title="${tip}">${t}</button>`).join('')}</div>
      <label title="Body density relative to the water — sets mass and moment of inertia of bodies created from now on">ρ_b/ρ <input type="number" data-k="density" min="0.2" max="50" step="0.1" value="2" style="width:64px"></label>
      <label title="Velocity damping rate (per unit time) standing in for the unresolved near-wall dissipation">damping <input type="number" data-k="damping" min="0" max="20" step="0.1" value="0.5" style="width:64px"></label>
      <label title="Skin friction: the wall shear ν·Δu_t/h across every exposed body face is integrated and added to the pressure force. Off reproduces the pressure-only model."><span>skin friction</span><input type="checkbox" data-k="friction" checked></label>
      <label title="Spring constant k for new springs: force per unit extension in units where the water density is 1 (stiffness above the explicit-stability cap is clamped and flagged)">k <input type="number" data-k="k" min="0.01" max="1000" step="0.1" value="2" style="width:64px"></label>
      <label title="Hard minimum / maximum length of new springs as multiples of the rest length L₀; beyond them a much stiffer spring takes over">L limits ×L₀ <span><input type="number" data-k="minR" min="0" max="1" step="0.05" value="0.5" style="width:46px"> <input type="number" data-k="maxR" min="1" max="10" step="0.05" value="1.5" style="width:46px"></span></label>
      <h3>Generate</h3>
      <label title="NACA 4-digit code: max camber in % of chord · camber position in tenths of chord · thickness in % of chord">NACA <input type="text" data-k="naca" value="2412" maxlength="4" style="width:56px"></label>
      <label title="Chord length as a fraction of the channel width Ly">chord/Ly <input type="number" data-k="chord" min="0.1" max="0.9" step="0.05" value="0.35" style="width:64px"></label>
      <label title="Angle of attack in degrees, nose up positive (relative to the current, whichever way it flows)">AoA ° <input type="number" data-k="aoa" min="-30" max="30" step="0.5" value="6" style="width:64px"></label>
      <label title="How the section is held">rig <select data-k="rig">${Object.keys(RIGS)
        .map((r) => `<option value="${r}" title="${RIGS[r]}">${r}</option>`)
        .join('')}</select></label>
      <div class="hint" data-v="rigdesc">${RIGS.pivot}</div>
      <div class="row"><button data-act="gen" title="Add a section on the centreline, quarter chord in the upstream half">Generate</button><button data-act="clear" title="Remove every body, anchor and spring">Clear</button><button data-act="bake" title="Freeze the bodies into the painted design and return to Paint">Bake</button></div>
      <div class="hint">Everything painted moves with the water unless anchored. Forces, aerodynamic coefficients and spring readings are in the <b>Airfoil rig</b> section of the right panel — hover any value for its definition. Save / Export keep the rig together with the design.</div>`;
    this.panel.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.tool) this.setTool(b.dataset.tool);
      else if (b.dataset.act === 'gen') this.generate();
      else if (b.dataset.act === 'clear') {
        this.rig.clear();
        this.syncSolver();
        this.update();
      } else if (b.dataset.act === 'bake') this.bus.emit('ui:mode', 'paint');
    });
    this.panel.addEventListener('input', (e) => {
      const k = e.target.dataset.k;
      if (!k) return;
      if (k === 'friction') {
        this.rig.skinFriction = e.target.checked;
        return;
      }
      if (k === 'rig') {
        this.panel.querySelector('[data-v=rigdesc]').textContent = RIGS[e.target.value];
        return;
      }
      const v = +e.target.value;
      if (k === 'density' && v > 0) this.rig.density = v;
      else if (k === 'damping' && v >= 0) this.rig.damping = v;
      else if (k === 'k' && v > 0) this.k = v;
      else if (k === 'minR' && v >= 0) this.minR = v;
      else if (k === 'maxR' && v >= 1) this.maxR = v;
    });
    this.setTool('move');
  }
  setTool(t) {
    this.tool = t;
    this.pending = null;
    for (const b of this.panel.querySelectorAll('[data-tool]'))
      b.classList.toggle('active', b.dataset.tool === t);
  }
  setEnabled(v) {
    this.enabled = v;
    this.panel.hidden = !v;
    this.pending = null;
    this.drag = null;
    this.view.rigOverlay = v ? (d, Nx, Ny) => this.rig.drawOverlay(d, Nx, Ny, this.pending) : null;
    this.canvas.style.cursor = v ? 'pointer' : 'default';
    if (v) {
      this.syncControls();
      this.update();
    }
  }
  /** Reflect rig-level settings (possibly restored with a design) in the controls. */
  syncControls() {
    const q = (k) => this.panel.querySelector(`[data-k=${k}]`);
    q('density').value = this.rig.density;
    q('damping').value = this.rig.damping;
    q('friction').checked = this.rig.skinFriction;
  }
  _val(k) {
    return this.panel.querySelector(`[data-k=${k}]`).value;
  }
  generate() {
    const solver = this.solver(),
      fwd = solver.fwd;
    const b = this.rig.addAirfoil({
      code: this._val('naca'),
      chord: +this._val('chord'),
      aoa: +this._val('aoa'),
      rig: this._val('rig'),
      k: this.k,
      minRatio: this.minR,
      maxRatio: this.maxR,
      x: fwd ? 0.75 : 1.25,
      y: 0.5,
      fwd,
    });
    if (!b) {
      this.notify.show('Section too thin for this grid — raise the chord or the thickness digits', {
        kind: 'warn',
      });
      return;
    }
    this.syncSolver();
    this.update();
    this.notify.show(
      `${b.name} · chord ${b.chord.toFixed(2)} Ly · ${b.cells} cells · rig: ${this._val('rig')}`
    );
  }
  phys(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 2, y: 1 - (e.clientY - r.top) / r.height };
  }
  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', () => {
      this.drag = null;
    });
    c.addEventListener('pointerleave', () => {
      this.drag = null;
    });
  }
  _down(e) {
    if (!this.enabled || e.button !== 0) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    const P = this.phys(e),
      rig = this.rig,
      b = rig.bodyAt(P.x, P.y);
    switch (this.tool) {
      case 'move':
        if (!b) break;
        if (b.anchors.length >= 2) {
          this.notify.show(`${b.name} is fixed by two anchors`, { kind: 'warn' });
          break;
        }
        {
          const l = rig.local(b, P.x, P.y);
          this.drag = { b, lx: l.lx, ly: l.ly };
        }
        break;
      case 'anchor':
        if (b) {
          rig.addAnchor(b, P.x, P.y);
          this.notify.show(
            `${b.name}: ${b.anchors.length === 1 ? 'pivot placed — it can only swing now' : `${b.anchors.length} anchors — held fixed`}`
          );
        } else this.notify.show('Click on a body to anchor it', { kind: 'warn' });
        break;
      case 'spring':
        if (!this.pending) this.pending = { X: P.x, Y: P.y, hx: P.x, hy: P.y };
        else if (b) {
          const s = rig.addSpring(b, this.pending.X, this.pending.Y, P.x, P.y, {
            k: this.k,
            minRatio: this.minR,
            maxRatio: this.maxR,
          });
          this.pending = null;
          this.notify.show(`spring ${s.id} → ${b.name}: L₀ ${s.L0.toFixed(3)}, k ${s.k}`);
        } else this.notify.show('The second click must land on a body', { kind: 'warn' });
        break;
      case 'delete': {
        const hit = rig.pick(P.x, P.y, 1.5 * rig.h);
        if (hit) {
          rig.remove(hit.item);
          this.syncSolver();
          this.notify.show(`removed ${hit.kind}`);
        }
        break;
      }
    }
    this.update();
  }
  _move(e) {
    if (!this.enabled) return;
    const P = this.phys(e);
    if (this.pending) {
      this.pending.hx = P.x;
      this.pending.hy = P.y;
    }
    if (!this.drag) return;
    const { b, lx, ly } = this.drag,
      rig = this.rig;
    if (b.anchors.length === 1) {
      const a = b.anchors[0];
      b.th = Math.atan2(P.y - a.Y, P.x - a.X) - Math.atan2(ly - a.ly, lx - a.lx);
      rig._placeOnPivot(b, a);
    } else {
      const c = Math.cos(b.th),
        s = Math.sin(b.th);
      b.x = P.x - (c * lx - s * ly);
      b.y = P.y - (s * lx + c * ly);
    }
    b.vx = b.vy = b.om = 0;
    this.syncSolver();
  }
  /** Push the composed mask (and rest velocities) to the solver — needed while the clock is paused, when the rig does not step. */
  syncSolver() {
    const solver = this.solver();
    if (this.rig.compose()) {
      solver.setSolidVelocity(this.rig.bu, this.rig.bv);
      solver.setBarriers(this.rig.barrier);
    }
  }
  /** Refresh the readout in the measurements panel. */
  update() {
    this.readout?.();
  }
}
