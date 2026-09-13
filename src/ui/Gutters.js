/**
 * Draggable gutters between the side columns and the stage. Each `.gutter` carries the CSS variable it
 * drives (`data-var`), which side it belongs to (`data-dir`), and its limits; widths are written on the
 * root element and persisted so the layout survives a reload. Double-click resets a column to its default.
 */
const KEY = 'cg:layout';
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function installGutters(root, onResize) {
  if (!root) return;
  let saved = {}; try { saved = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { /* no storage */ }
  const state = {};
  const apply = (k) => root.style.setProperty(`--${k}`, `${state[k]}px`);
  const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* ignore */ } };
  for (const g of root.querySelectorAll('.gutter')) {
    const k = g.dataset.var; if (!k) continue;
    const sign = g.dataset.dir === 'right' ? -1 : 1, min = +g.dataset.min || 160, max = +g.dataset.max || 720, def = +g.dataset.default || 300;
    state[k] = clamp(+saved[k] || def, min, max); apply(k);
    g.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return; e.preventDefault(); g.setPointerCapture(e.pointerId); g.classList.add('drag');
      const x0 = e.clientX, w0 = state[k];
      const move = (ev) => { state[k] = clamp(w0 + sign * (ev.clientX - x0), min, max); apply(k); onResize?.(); };
      const up = () => { g.removeEventListener('pointermove', move); g.classList.remove('drag'); persist(); onResize?.(); };
      g.addEventListener('pointermove', move);
      g.addEventListener('pointerup', up, { once: true }); g.addEventListener('pointercancel', up, { once: true });
    });
    g.addEventListener('dblclick', () => { state[k] = def; apply(k); persist(); onResize?.(); });
  }
}