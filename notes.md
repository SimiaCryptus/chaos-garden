Addressed:
* Skin friction on rigid bodies — wall shear ν·Δu_t/h over exposed faces, added to the pressure force
  (toggle in the rig panel; pressure/friction split visible in the readout).
* Rig (bodies, anchors, springs) is serialized with the design (Save / Export / Load / Import).
* Both side columns are resizable (drag the gutters, double-click to reset; widths persist).
* Forces readout moved to the right panel as cards of atomic label/value cells with tooltips.
* Right panel: collapsible sections (state persists), visible scrollbar.
* Bottom bar removed; depth slider (with k_h markers) and every other parameter live in ⚙ Settings.
  Solver status moved to the Score section; the settling badge to the HUD.
* Evolve mode removed.
* About popover is a singleton (press ? again or Esc to close), scrollable, with a close button.

Open ideas:
* Save the rig in the share URL as well (currently only slots / JSON carry it, to keep the fragment short).
* A proper wall model for skin friction (log-law) instead of the one-cell gradient.