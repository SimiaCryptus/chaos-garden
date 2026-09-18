# Chaos Garden

## What is this?

Chaos Garden is an interactive simulation of water moving through a
hand-painted channel. You look down on the "garden" from directly
above — a plan view, like an architect's drawing — and you paint
banks, obstacles, and depth into the landscape. The water then finds
its own way through what you've built, twisting, splitting, and
swirling in ways that are surprisingly hard to predict from the shape
alone.

The name is a small joke and a small truth at once. A garden is a
place you shape by hand; chaos is what happens once you let it grow
on its own terms. Real channels — streams, tidal creeks, lava flows,
even the eddies behind a bridge piling — behave the same way. Simple
rules, applied to a shape you can see and touch, produce motion that
never quite repeats itself.

## How it works, without the mathematics

At its heart, the simulation treats the water as a shallow layer
sliding across a landscape you've painted. Where you make the channel
deep, water moves fast and smooth. Where you narrow it, add a rock, or
carve a side pool, the flow has to bend, squeeze, and let go — and
that's where the interesting behavior appears: eddies peel off
obstacles, currents braid around islands, and small changes in your
painting can lead to very different patterns downstream.

The screen is organized simply:

- A **toolbar** at the top lets you switch between modes — painting,
  running the simulation, stepping through time, resetting the garden —
  and opens the settings, sharing and saving.
- A **palette of tools** on the left lets you lay down banks and place
  obstacles. Drag the thin gutter beside it to make the column wider or
  narrower.
- The **main canvas** in the middle is your garden, viewed from above,
  where you paint and watch the water move.
- An **airfoil rig** replaces the palette in Airfoil mode: whatever you
  have painted becomes a set of rigid bodies that the water pushes
  around, by pressure and by skin friction. Pin a point with an anchor
  (one anchor lets it swing, two hold it still), tether it with springs
  to read the force off their stretch, or generate a standard NACA
  section already rigged the way a wind-tunnel model would be. Rigs
  are saved and exported together with the design.
- An **orbit view** lifts you out of the plan: the same water drawn as
  translucent 3D voxels in a box you can spin and zoom. The thin layer
  is stretched to a fixed proportion so every garden fills the same
  volume, and the internal structure — eddies stacked through the
  depth, dye threading around obstacles — becomes visible.
- A **measurements panel** on the right reports what's happening in the
  flow — things like speed, depth, or how "mixed up" the current has
  become — and, in Airfoil mode, the forces on every body and the
  reading of every spring. Its sections fold away, and it too is
  resizable.
- A **settings dialog** (⚙ on the toolbar, or the `,` key) holds every
  parameter with a plain-language description: the depth of the water
  on a slider marked with the sizes of what you've painted, the flow
  rate (which may be negative, sending the water right to left), the
  viscosity, and the shape of the world itself — an open channel or a
  torus where the water circulates forever, side walls that are
  periodic or ideally slippery, a bed and lid that grip or don't.

There is no fixed goal or score. You paint, you run the water, you
watch, and you adjust — much like tending an actual garden bed to see
how rain will drain through it.

## Why it's interesting

Fluid flow is one of the best everyday examples of chaos: a system
that is completely deterministic (there is no randomness in the
underlying rules) yet whose long-term behavior is essentially
impossible to predict just by looking at the starting shape. Two
channels that look nearly identical can send their currents in
noticeably different directions a few moments later. This is the same
sensitivity that makes weather hard to forecast and rivers hard to
tame — except here, you can paint a new "river" in seconds, run it
again, and directly compare.

Watching the simulation also builds a kind of visual intuition for
things that are normally hidden underwater: why river bends erode on
the outside and deposit sediment on the inside, why a single boulder
can create a calm pocket downstream, why deltas braid into many
channels instead of one. None of this requires reading an equation —
it emerges from playing with the shapes.

## Who this is for

- Anyone curious about **chaos and complex systems** who wants a
  hands-on, visual way to explore the idea rather than reading about
  it abstractly.
- Students and teachers of **earth science, hydrology, or geography**
  looking for an intuitive companion to lessons on rivers, erosion,
  and deltas.
- People interested in **generative art and simulation**, who enjoy
  watching organic, unrepeatable patterns emerge from simple painted
  rules.
- Anyone who simply likes the meditative quality of watching water
  find its way — no prior knowledge of fluid dynamics required.
