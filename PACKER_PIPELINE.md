# Facility packing pipeline

`packBins` in `solver_pipeline.js` converts continuous recipe activity from the
material LP into the facility counts, loads, bar segments, and power totals used
by the UI.

## Facility types

Single-formula facilities (`cacheSlots <= 1`) cannot co-locate formulas.

- Dedicated mode uses `sum(ceil(recipe demand))` buildings.
- Time-share mode uses `ceil(sum(recipe demand))` buildings.

Multi-formula facilities currently comprise Reactor Crucible (`mix_pool_1`, 5
slots) and Expanded Crucible (`mix_pool_2`, 8 slots). Recipes with identical
inputs, outputs, and crafting time are facility twins. Phase 1 keeps one LP
variable per logical twin, while the packer can assign its demand to either
physical host.

## Two packers: exact on settle, bounded during drag

`packBins` picks by the `lite` flag (`lite === _solverDragging`):

- **Settled solve — `packMultiFormula`.** The exact variant MILP: integer
  building counts `x_v` per variant, continuous scale `u_v`, strict-equality
  demand, minimising buildings with power as a tiebreak. Solved through HiGHS on
  the main thread, bounded by `_packTimeLimit` (2 s). This matches the reference
  implementation, which also runs an integer packing MIP rather than a heuristic.

  `enumerateVariants` performs the **full borderline-regime sweep**: for each
  shape it emits one variant per subset of the items that are both produced and
  consumed inside that shape, forcing those to net zero and leaving the rest
  external on a port (plus the demand-aligned direction). Netting *everything*
  is only one of `2^b` regimes and is not always port-cheapest — enumerating the
  rest is what lets a 5-slot Reactor host shapes the fully-netted direction
  cannot. Capped by `REGIME_ITEM_LIMIT` (10). This sweep is only affordable
  because the MILP no longer runs per slider frame.
- **Slider drag — `packMultiFormulaFast`.** The bounded greedy path below.
- **Fallback.** If the MILP is infeasible or HiGHS is not loaded, `packBins`
  falls back to the fast packer (never to singleton bins, which are worse).

Both packers receive the *same* per-recipe demands from Phase 2, so they produce
**identical item rates** — only the building/power split differs. That is what
makes the drag/settle split safe: production numbers are exact and live while
dragging, and only the physical layout is refined once the slider settles.
Measured on the reference plan: fast 2.5 ms, exact ~750 ms, item rates
byte-identical. With the regime sweep the exact path reproduces the reference
implementation's plan on both comparison configs — 246 buildings / 4885 kW
(10 Expanded + 5 Reactor) and 240 buildings / 4795 kW.

### Port caps

The cap set matches the reference exactly, and getting it wrong is not
cosmetic:

| port | capped? |
| ---- | ------- |
| pipe-in (distinct liquids) | **yes**, `pipeInPorts` |
| pipe-out | yes, `pipeOutPorts` |
| belt-out | yes, `beltOutPorts` |
| belt-in (distinct solids) | **no** — many belts feed the shared cache |
| inner slots | yes, `cacheSlots` |

This was previously inverted: belt-in was capped and pipe-in ran free. The
crucible recipes are liquid-heavy, so the missing pipe-in cap admitted variants
that cannot physically exist. The MILP used them to reach a 9 Expanded + 6
Reactor split which scores better under our objective (15.12 vs 15.125) than the
reference's 10 + 5 — it was simply not buildable.

Fixing the caps also made the model tractable. Before, HiGHS could not prove
optimality and exhausted `_packTimeLimit` at every `mip_rel_gap` from 0 to 0.02,
returning whichever incumbent it happened to hold. With the correct caps the
exact solve **terminates** in ~0.9 s and returns the reference plan. The single
weighted objective (buildings + 1e-4·power per building) therefore reproduces
the reference's lex buildings → power result on every config tested; the third
lex pass (compactness) is a cosmetic tiebreak we do not need.

Keep `_packMipGap` at 0. A non-zero gap accepts an early incumbent — 1e-3
returns 11 + 4 — and buys nothing now that the solve terminates.

## Bounded deterministic packer

`packMultiFormulaFast` does not invoke HiGHS and does not enumerate every recipe
subset.

1. Collapse active twins by the facility-independent recipe signature.
2. Generate demand-aligned, balanced, and equal-layer candidates for compatible
   recipe groups.
3. Retain a beam of at most 96 partial groups and consider at most 8 recipes per
   shared bin.
4. Choose candidates lexicographically by building savings, then power savings,
   deterministic facility/recipe IDs, and allocate their covered demand.
5. Emit remaining demand as singleton stacks on the lowest-power compatible
   host.

The candidate checks enforce cache slots, solid belt inputs, belt outputs, and
pipe outputs. Pipe-input type count is intentionally unrestricted: Reactor and
Expanded Reactor may accept any number of liquid types, as required by this
calculator.

This replaces the previous subset-variant packing MIP. On the eight-logical
stress case the previous MIP consumed its 2-second limit; the bounded packer
finishes in roughly 2 ms. The supplied seven-target plan normally packs in less
than 1 ms.

## Output model

`packBins(recipeFacilityCounts, graph)` returns:

```text
facilityBuildings : Map<facilityId, whole physical buildings>
facilityLoad      : Map<facilityId, active slot-equivalents>
facilitySegments  : Map<facilityId, displayed item contributions>
bins              : physical host, recipe IDs, building count, active rates
recipeAlloc       : recipe ID to bin indices
warnings          : safety-fallback messages
```

`buildPlanAggregates` consumes this result once per render. The resource graph,
facility graph, total facility counter, and power counter all read the same
aggregate, so Reactor/Expanded placement cannot diverge between views.

## Drag behavior

Packing is cheap enough to run for every accepted slider solve; there is no
stale-bin replay on the live path. The expensive integer gas-placement model is
relaxed only while dragging. Pointer release schedules an exact settled solve,
which canonicalizes the recipe mix and refreshes physical facility, power, and
sustain-resource counts.

The latest-only scheduler never queues obsolete slider positions. Its worker
solve cadence starts at 65 ms and adapts to measured solve time.

## Invariants

- Recipe demand allocated across emitted bins equals the solved demand within
  floating-point tolerance.
- Every emitted bin fits its host's slot and constrained-port budgets.
- Building choice minimizes count first and power second among generated
  candidates.
- Twin choice changes placement only; it does not change recipe material flow.
- A settled result uses exact whole gas placements even though live drag uses a
  continuous preview.
