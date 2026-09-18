export class Notify {
  constructor(el) {
    this.el = el;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closePopovers();
    });
  }
  show(msg, { kind = 'info', timeout = 3500 } = {}) {
    const t = document.createElement('div');
    t.className = `toast ${kind}`;
    t.textContent = msg;
    this.el.appendChild(t);
    if (timeout) setTimeout(() => t.remove(), timeout);
    return t;
  }
  /**
   * Persistent definition popover, one per title: invoking it again while it is open closes it instead of
   * stacking a duplicate. Dismiss with ✕, a click on the header, or Escape; the body scrolls and is selectable.
   */
  popover(title, body) {
    const open = [...this.el.querySelectorAll('.toast.pop')].find((p) => p.dataset.title === title);
    if (open) {
      open.remove();
      return null;
    }
    const t = document.createElement('div');
    t.className = 'toast pop';
    t.dataset.title = title;
    t.innerHTML = `<div class="pop-head"><h4></h4><button type="button" class="x" aria-label="close" title="close (Esc)">✕</button></div><pre></pre>`;
    t.querySelector('h4').textContent = title;
    t.querySelector('pre').textContent = body;
    t.querySelector('.pop-head').addEventListener('click', () => t.remove());
    this.el.appendChild(t);
    return t;
  }
  closePopovers() {
    for (const t of this.el.querySelectorAll('.toast.pop')) t.remove();
  }
}
