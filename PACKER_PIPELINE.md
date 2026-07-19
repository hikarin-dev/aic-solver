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

## Bounded deterministic packer

The runtime packer is `packMultiFormulaFast`. It does not invoke HiGHS and does
not enumerate every recipe subset.

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
