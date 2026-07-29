# Production Solver Pipeline

This document describes the current solver architecture in
[solver_pipeline.js](solver_pipeline.js) (as of the single-LP rewrite).
`runSolver` in that file is the entry point.

If you only have time for one section, read **The end-to-end flow**.
If you're modifying the solver, read **Graph construction**, **Why the LP can
go Unbounded**, and **Known traps** before touching anything.

---

## What problem does this solve?

Given:

- A list of **production targets** (items the user wants to produce)
- **Raw resource caps** (e.g. 590 Originium Ore/min, 600 Water/min)
- **Facility caps** (e.g. 12 Forge of the Sky units)
- Optional **locked/pinned rates** (user pins a target's rate)
- Optional **time-share facilities** (one unit runs several recipes vs one recipe per unit)

Produce a recipe schedule that maximises total profit (sell price × rate)
and respects every cap. The schedule comes out as `recipeId → facility count`
(how many of each building to run), from which the UI derives per-item rates
and resource/facility usage bars.

Power (battery) consumption is **not** part of the LP — it is subtracted from
the net-rate display in `computeSummary` after solving.

---

## The end-to-end flow

`runSolver` is six phases (look for the `─── Phase N ───` banners in the source):

```
  production[], rawLimits, facilityLimits
                     │
    Phase 1 ─────────┤  buildBipartiteGraph
                     │    Step 1 — DFS from each target; add ALL viable recipes
                     │             per item (non-dismantle, non-disposal-only).
                     │             Explicit non-default recipe overrides restrict
                     │             an item to one; UI defaults keep all routes.
                     │    Step 2 — Augment: add FD-byproduct recycler recipes
                     │             (e.g. xiranite lowpoly purifier)
                     │    Step 3 — Cycle repair: inject alternate recipe for
                     │             any item stranded without a raw-material path
                     │
    Phase 2 ─────────┤  Build LP model
                     │    Variables:
                     │      x_ri       facility count for recipe r  (≥ 0)
                     │      surp_X     surplus absorber for zero-price dead ends
                     │    Constraints:
                     │      bal_X      Σ net_production(X) ≥ 0
                     │                 (= pinnedRate for pinned items)
                     │      raw_R      Σ raw consumption ≤ rawCap
                     │      fac_F      Σ facility counts ≤ facCap
                     │      ub_net_X   net_production(X) ≤ soloMaxRate[X]
                     │    Objective (single-pass weighted):
                     │      max  value − (MACHINE_PENALTY + POWER_WEIGHT·kW) · Σ x_ri
                     │      value = Σ price(X)·net_rate(X) − SURPLUS_PENALTY·Σ surp_X
                     │    Building MIP: dedicated capped single-formula facilities get
                     │      integer b_ri ≥ x_ri with Σ b_ri ≤ cap (cap binds on whole
                     │      units; production x_ri stays continuous).
                     │
    Phase 3 ─────────┤  Solve via HiGHS (CPLEX LP text → WebAssembly)
                     │    Pure LP when no generals; MIP when generals non-empty
                     │
    Phase 4 ─────────┤  Extract recipeFacilityCounts from x_ri solution values
                     │
    Phase 5 ─────────┤  Sanity check — abort if any cap exceeded by > 0.5
                     │
    Phase 6 ─────────┤  Apply results
                     │    Snap LP residuals < 1e-3 to 0
                     │    Write p.rate for non-fixed items
                     │    Cache _lastGraph / _lastFacilityCounts
                     │    computeSummary() + render
```

---

## Solver adapter (HiGHS)

All LP/MIP calls go through a small adapter at the top of `solver_pipeline.js`:

- `compileLP(model)` serialises the internal model object
  `{ optimize, opType, constraints: {name: {max|min|equal}},
  variables: {name: {[constraintOrObj]: coef}}, generals?: string[] }`
  into CPLEX LP text. Variables default to ≥ 0 (no explicit Bounds section).
  When `model.generals` is non-empty, a `General` section is appended before
  `End`, declaring those variables as integer-valued and turning the solve
  into a Mixed Integer Program.
- `solveLP(model)` runs the text through `_highs.solve(...)` and reshapes
  the result into `{ feasible: bool, result: number, [varName]: value }`.
  HiGHS handles both LP and MIP through the same call — no adapter change
  needed when switching between continuous and integer mode.

HiGHS is a WebAssembly module. `index.html` awaits `Module({...})` and then
calls `setHighsInstance(solver)` to install the resolved object. While
`_highs` is null, `isHighsReady()` returns false and `runSolver` short-
circuits with "LP solver not loaded yet".

The adapter is the only place that mentions CPLEX LP syntax. Swap
`compileLP` + `solveLP` to change solvers without touching anything else.

---

## Phase 1: Graph construction

### selectRecipe(recipes, visitedPath)

Picks one recipe for an item from a list of candidates. Filter cascade:

1. Drop dismantle recipes (recipes that consume filled-bottle items — these
   are byproduct-sink sinks, not real producers).
2. Drop disposal-only recipes (every input is a forced-disposal item; these
   re-enter via augmentation as recyclers, not as primary producers).
3. Prefer single-output recipes.
4. Within each tier, prefer a recipe whose every input is a raw material
   (terminates DFS immediately, avoids synthetic cycles).
5. If a visitedPath is provided, break ties by preferring non-circular
   candidates (no input already on the DFS stack).

### buildBipartiteGraph(targetIds, recipeOverrides)

Three-step construction:

**Step 1 — DFS.** Starting from each target item, add ALL viable recipes
(non-dismantle, non-disposal-only) and recurse into every recipe's inputs.
User `recipeOverrides` restricts an item to one pinned recipe. Stop at
`forcedRawSet` items or dead-end items (no producer in the recipe data).
Multiple recipes per item enter the LP as separate `x_ri` variables; the
power-weighted penalty in the objective steers the solver toward lower-power
paths when profit is otherwise equal.

**Step 1b — Gas-environment injection.** Recipes with `gasEnv` require an
always-on Gas Dispersing Unit. Its synthetic `vaporize_*` recipe has no output,
so backward traversal cannot discover it. The graph builder injects the matching
consumer recipe and traverses its gas input before the other augmentation passes.

Transmuter catalyst drains are also graph dependencies even though they are not
ordinary recipe inputs. This ensures their entire supply chain is present before
the LP is built.

**Step 2 — Augmentation.** Scan all recipes already in the graph. For each
forced-disposal output of an existing recipe, look up consuming recipes. A
consuming recipe is added if:

- All its inputs are forced-disposal (`isDisposalOnlyRecipe`).
- It produces at least one item already in the graph.

This brings in recycler recipes like `liquid_purifier_xiranite_poly_1` that
convert waste `lxp_lowpoly` back to useful `lxp`. The all-FD-input guard is
critical — without it, alternate normal producers would be included and break
the LP's balance equations.

**Step 3 — Cycle repair.** Compute which items are reachable forward from raw
materials through the current recipes. Any item not yet reachable (trapped in a
cycle with no raw-material entry point) gets a new recipe injected: one not
already in the graph whose every input is reachable or raw. Repeat until
the reachable set stabilises.

#### Graph shape

```
graph = {
  itemNodes:      Map<itemId, { isRawMaterial: bool }>,
  recipeNodes:    Map<recipeId, recipe>,
  itemConsumedBy: Map<itemId, Set<recipeId>>,
  itemProducedBy: Map<itemId, Set<recipeId>>,
  recipeInputs:   Map<recipeId, Set<itemId>>,
  recipeOutputs:  Map<recipeId, Set<itemId>>,
  targets:        Set<itemId>,
  rawMaterials:   Set<itemId>,
}
```

---

## Phase 2: LP construction

### Variables

- `x_ri` (one per recipe in the graph, ≥ 0): facility count for recipe `r`.
  The LP optimises these. Post-solve, `x_ri` values are the `recipeFacilityCounts`.
- `p_gas_ri` (integer): placed-building count for every transmuter or
  gas-environment recipe, constrained by `x_ri ≤ p_gas_ri`. It carries the
  facility-cap, power and vaporizer-coverage coefficients — not the catalyst
  drain, which is charged to `x_ri`.
- `surp_X` (one per zero-price dead-end item): surplus absorber. See below.

### Balance constraints (bal_X)

For every non-raw item X:

```
Σ_r outputRate(r, X) · x_r  −  Σ_r inputRate(r, X) · x_r  ≥  0
```

If item X is pinned (locked or `tempPinnedId`), the bound becomes `= pinnedRate`
instead of `≥ 0`. Fixed items at rate ≈ 0 are excluded from pinning so the LP
treats them as free.

### Raw/facility caps (raw_R, fac_F)

Raw caps are standard linear capacity constraints. Facility caps use the
physical placement variable: gas placements use `p_gas_ri`, capped dedicated
facilities use an integer `b_ri >= x_ri`, and time-shared facilities use `x_ri`.
The building/power objective charges that same cap-authoritative variable.

```
raw_R:  Σ_r rawConsumption(r, R) · x_r  ≤  rawCap[R]
fac_F:  Σ_r physicalPlacement(r, F)  ≤  facCap[F]
```

### Net-production upper bounds (ub_net_X)

For every priced non-pinned item X:

```
Σ_r net_rate(r, X) · x_r  ≤  soloMaxRate[X]
```

`soloMaxRate[X]` is the maximum rate achievable for X alone (from a mini-LP
or facility-ceiling fallback). These constraints prevent the profit objective
from becoming unbounded when self-sustaining production cycles (e.g. the
moss/seed loop) exist without any caps. See **Why the LP can go Unbounded**.

### Gas sustain (1.4 recipes)

The gas-era recipes cannot be modeled from `inputs[]` and `outputs[]` alone:

- `transmuter_1` drains 6 Liquid Xiranite/min per building at **full load**.
- `transmuter_2` drains 6 Xiragen/min per building at **full load**.
- Recipes tagged with a gas environment require one whole Gas Dispersing Unit
  per four placed environment machines. Each unit consumes 6 of its environment
  gas/min continuously.

A placed transmuter does drain its catalyst continuously, but in-game the feed
can be pulse-width modulated or batched so a partially-loaded bank draws only
the catalyst its load actually needs. The drain is therefore charged against
**fractional recipe load `x_ri`**, not the whole placed count — a bank at load
4.87 costs `6 × 4.87`, not `6 × 5`. Charging placements instead overstated
catalyst by up to `6 × (n − load)` per recipe and understated every downstream
rate; it is what made this solver report 14.45 SC Wuling Battery on the
reference plan where the true optimum is 14.75.

`extract_recipes.py` writes the gas-environment tags, Gas Dispersing Unit, and
four zero-output `vaporize_*` recipes into the generated assets.
`installGasSustainData()` remains a duplicate-safe compatibility backstop for
older assets. `GAS_SUSTAIN_CONFIG` holds the LP mappings, and
`_addGasSustainConstraints()` adds integer placement variables and:

```text
x_recipe <= p_placed
catalyst balance contribution = -6 * x_recipe
4 * x_vaporize - sum(p_placed for recipes using that environment) >= 0
x_vaporize is integer
```

The same helper is used by the per-item max LP and the global LP. Placement
variables still own the machine/power objective coefficients, the facility-cap
coefficients and the vaporizer coverage row — those follow whole buildings and
must not go fractional. Only the catalyst moved to `x_ri`.

### Time-share facilities (the repurposed `integerOnly` flag)

The per-facility `integerOnly` flag (UI `⇄` toggle, URL `:i`) selects how a
**single-formula** facility's recipes occupy physical units:

- **off (default) — "one recipe per unit" (dedicated).** Each recipe gets whole
  dedicated buildings. The LP adds an **integer building-count variable** per
  recipe, `b_ri ≥ x_ri` (`b_ri` joins the MIP `General` section), and the cap
  becomes `Σ b_ri ≤ cap`. Production `x_ri` stays **continuous** — only the
  *building count* is whole — so the cap binds on whole units while any
  fractional rate is still producible. The packer reports `Σ_r ⌈d_r⌉` (= `Σ b_ri`).
- **on — "time-sharing".** One physical unit time-slices several recipes, so the
  facility keeps the slot cap (`Σ x_ri ≤ cap`) and the packer rounds the *shared*
  total: `⌈Σ_r d_r⌉`.

A Forge capped at 12 hosting two recipes: dedicated gives `10 + 2 = 12`
buildings (`b`), with production free to sit at 9.84/2.0; time-share gives
`⌈9.84 + 2.16⌉ = 12`. Crucially, a *lone* recipe needing 10.978 is feasible at
`b = 11 ≤ 12` — forcing `x_ri` itself integer (the earlier approach) wrongly
made that infeasible. Without any of this, dedicated would ceil per recipe to
`⌈9.84⌉ + ⌈2.16⌉ = 13`, over the cap.

The building-count MIP applies only to **capped, dedicated single-formula**
facilities. Multi-formula facilities (crucibles) ignore the flag and
slot-co-locate via the bounded deterministic packer.

### Objective — single-pass weighted

The default (non-pinAll) solve is a single HiGHS pass maximising:

```
max  value − (MACHINE_PENALTY + POWER_WEIGHT·kW) · Σ_r x_r
       where  value = Σ_X price(X)·net_rate(X) − SURPLUS_PENALTY·Σ_X surp_X
```

`SURPLUS_PENALTY` (default 0.05) nudges the LP away from generating zero-price
dead-end byproducts. `MACHINE_PENALTY` (0.001) + `POWER_WEIGHT`·kW per facility
discourage unnecessary / high-power steps when value is otherwise equal. All in
`assets/solver_config.js`.

The penalties are deliberately tiny — their real job is to act as a
**regulariser**: they break degenerate value-optima toward fewer/cheaper
facilities *consistently*, so production rates come out clean (exactly `3`, not
`2.993`). A strict lexicographic `value → buildings → power` solve was tried
and reverted: it left those ties to HiGHS and produced cosmetic rate
remainders. The crucible building-count optimisation now lives in the
**Phase-3 packer** (`packBins`,
[PACKER_PIPELINE.md](PACKER_PIPELINE.md)), independent of this objective — so
the LP objective no longer needs to reason about physical buildings.

`pinAll` (read-only solve) instead just minimises `Σ x_r` (total facilities).
`solveLexicographic` survives as a legacy helper. The packer calls HiGHS on the
settled solve (`packMultiFormula`) and stays heuristic during a drag
(`packMultiFormulaFast`) — both yield identical item rates, so only the
building/power split is deferred to settle.

### Surplus variables

A dead-end item is one that is:

- Not a production target
- Not priced
- Not consumed by any recipe in the graph

For each such item, the balance constraint is promoted from `≥ 0` to `= 0`,
and a `surp_X` variable absorbs any over-production:

```
surp_X  contributes  -1  to  bal_X
surp_X  contributes  -SURPLUS_PENALTY  to  value  (the objective)
```

Without the surplus variable, `= 0` would make the LP infeasible whenever
a recipe unavoidably generates a dead-end byproduct as a side-effect.

### Phase 3b — canonical recipe mix (determinism)

The weighted optimum isn't unique: alternate recipe combinations hit the same
target outputs, and HiGHS picks among them by simplex path. Adding a pin (even
a non-binding one — pinning a target at the value it would reach anyway) changes
the feasible region's shape, so HiGHS lands on a *different* equivalent mix,
which reshuffles the Phase-3 bins for no visible reason.

To make this deterministic, after the weighted solve runs a second pass:

1. Strip the `ub_net_X` guards (only needed while maximising; a pinned target
   skips its own, so they'd otherwise differ between inputs).
2. Pin every production target's net output at its solved value (equality).
3. Re-solve minimising `Σ x_r` (`facc`).

The result is the minimal-facility mix that hits exactly those outputs — a
deterministic *function of the outputs*. So two inputs that produce the same
outputs (e.g. the same plan with one target pinned vs. free) get the identical
recipe mix and therefore identical bins. Outputs are pinned, so displayed rates
don't move. (If two inputs genuinely produce *different* outputs — e.g. a free
target maximises higher than the pinned value — the bins still differ, correctly.)

This second pass is **skipped during an in-place slider drag** (`inPlace`) —
only the recipe *mix* is non-canonical there, not the rates. The settle solve
(debounced `SETTLE_DELAY` after the drag ends, cancelled by an immediate
re-grab) runs it, so the final bins are canonical.

The gas-placement MIP is **not** relaxed during a drag. It used to be, and that
was not a cosmetic approximation: fractional transmuter placements mean a
fractional catalyst bill, so the free targets settle on a different optimum and
their sliders visibly snapped on pointer-up (on the reference plan, Heavy
Xiranite 24.842 → 24.000 and Xiranite 0.000 → 15.520). Keeping the integrality
costs worker time, not responsiveness:

| | worker solve | main-thread |
| --- | --- | --- |
| relaxed LP (old) | ~5 ms | ~8 ms |
| exact MIP (now)  | 130–195 ms | ~8 ms |

The solve is on `solver_worker.js`, so the main thread is untouched and the
dragged slider stays pointer-smooth. The other targets refresh at roughly
5–7 Hz with true values instead of 60 Hz with wrong ones.

---

## Why the LP can go Unbounded

If a self-sustaining cycle (no external raw inputs) has a positive-price
output and there are no raw or facility caps, the LP objective has no upper
bound — HiGHS returns Infeasible or Unbounded. The fix is the `ub_net_X`
constraints above.

`soloMaxRate[X]` is computed by `solveItemMax`: a mini-LP identical to the
global LP but with a single-item objective and no pinned items. It builds
facility caps through the **same `_addFacilityCaps` helper** as the global LP,
so a dedicated single-formula facility's max reflects its building cap (and is
re-solved as a MIP), while a time-shared one uses the looser slot cap — i.e. the
slider max drops when a facility is dedicated and rises when it's time-shared.
If HiGHS is not yet loaded, a simpler facility-ceiling fallback is used instead.

Results are memoised in `_maxCache` (keyed by item + recipe + limits
fingerprint, **including each facility's time-share flag** so toggling it
re-caches). The persistent `_singleMaxMap` is rebuilt lazily — only when
`_singleMaxDirty` is true, which is set by `invalidateMaxCache()` whenever
limits or item list changes. During drag, the map is reused as-is (`single=0.0ms`
in the timing log).

The solver log prints a per-phase breakdown so the costly step is obvious at a
glance: `graph` (build) · `single` (max-rate map; skipped on drag) · `lp` (main
solve) · `canon` (Phase 3b; skipped on drag) · `pack` (bounded Phase-3 packer)
· `render` (DOM). During a drag the main solve is the same exact MIP as the
settled pass (only `single`, `canon` and the exact packer are skipped), so `lp`
dominates the frame; the greedy packer still runs live in well under 1 ms.

---

## Phase 6: Apply and residual snapping

After Phase 5 sanity-checks the solution:

1. `computeNetRatesFromFlow` derives net item rates from `recipeFacilityCounts`.
2. For each non-fixed production item, LP residuals below `1e-3` are snapped
   to exactly 0. This prevents `p.rate = 3.7e-7` from appearing as `0.001`
   on the slider during drag.
3. `p.rate` is written for each non-fixed item.
4. `_lastGraph`, `_lastFacilityCounts`, and `_lastPlacementCounts` are cached.
5. `computeSummary` (in `endfield_calculator.js`) reads `p.rate` directly
   (not `computeNetRatesFromFlow`) so sliders and the summary always agree.

---

## Power consumption (batteries)

Battery items are **not** LP constraints. They are a post-solve display
subtraction applied in `computeSummary`:

```javascript
powerBatteries.forEach((pb) => {
  netRates[pb.matId] = (netRates[pb.matId] || 0) - pb.rate;
});
```

A battery item that is also a production target shows a reduced net rate.
A battery item that is NOT a production target appears as a negative line
item (pure cost) in the summary table and saved-production cards.

---

## Glossary

| Term                          | Meaning                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------ |
| **Target**                    | An item with a user-requested rate. Lives in `production[]`.                                     |
| **Recipe**                    | Game recipe: `{ id, facilityId, craftingTime, inputs[], outputs[] }`.                            |
| **FD item / forced-disposal** | Item in `forcedDisposalSet` (e.g. sewage, lxp_lowpoly). Free to over-produce.                    |
| **Raw material**              | Item in `forcedRawSet` (e.g. ore, water). Unlimited supply, capped only by `rawLimits[]`.        |
| **Pinned item**               | A fixed item (`p.locked` or `p.id === tempPinnedId`) with rate > 0. Gets an `equal:` constraint. |
| **x_ri**                      | LP variable: facility count for recipe r. Directly gives `recipeFacilityCounts`.                 |
| **p_gas_ri**                  | Integer physical placement count used by gas facility caps, power, and vaporizer coverage. Catalyst drains use `x_ri`. |
| **soloMaxRate[X]**            | Maximum rate of item X if it were the only target given current caps.                            |
| **calcRate(amt, ct)**         | `amt/ct × 60` — converts "qty per craft" to "qty/min per facility".                             |
| **surp_X**                    | Surplus variable for zero-price dead-end item X.                                                 |
| **generals**                  | List of `x_ri` names emitted in the LP `General` section; triggers MIP solve.                   |
| **integerOnly**               | Per-facility flag (UI `⇄`); on = time-share (`⌈Σ load⌉` units), off = one recipe per unit (`Σ⌈load⌉`).  |

---

## Forced-disposal semantics

`forcedDisposalSet` lists items the game treats as free recyclable byproducts:
sewage, lxp_lowpoly, lxp. The pipeline treats them as:

- Not charged as raw costs (they come from other recipes for free).
- Not subject to the surplus-variable penalty (they're expected to be over-produced).
- Starting points for the augmentation pass (their consumers may be recycler recipes).

What FD does NOT mean:

- The item is never consumed. lxp is FD but Heavy Xiranite needs it.
- You can skip producing it. Within the LP, balance still holds; the LP just
  doesn't penalise over-production.

---

## Facility, resource, power, and Metastorage totals

`buildPlanAggregates` is the single display-side source of truth. It consumes
the solved recipe counts and the existing `packBins` result once per render and
returns:

- gross local generation, consumption, Metastorage import, and net flow for
  every active item;
- raw source requirements plus their Depot Unloader / Fluid Pump / Acid Pump /
  Gas Extractor pickup counts;
- per-facility theoretical count, physical count, load, bins, and segments;
- total facility count, power consumption, sustained Thermal Bank generation,
  and net power.

Theoretical mode matches the beta calculator: a shared bin contributes the
mean activity of its recipes. “Round up facilities” uses whole packed buildings
and charges full power for each physical building. Hard caps still compare
against physical placements.

Auto Metastorage uses Valley IV's 1,500-TTV hourly route into Wuling. A settled
solve ranks graph-relevant eligible items with continuous relaxations, runs the
exact integer model for the winner, and accepts it only when it beats the exact
no-transfer baseline by the objective/raw/building/power/TTV tuple. Slider
drags reuse the last selected item as one continuous variable. Imports remain
separate from local recipe generation in the aggregate. Candidate enumeration
also runs when the no-transfer baseline is infeasible, because the import may
be what makes a locked target set feasible.

The `ub_net_X` safety guards are also Meta-aware. Their solo-max pass exposes
all eligible imports behind one shared TTV budget as a continuous relaxation,
producing a finite upper bound without restricting the real solve to its
no-transfer maximum. Toggling Auto Meta invalidates this max-rate cache.

Crucible input-fluid behavior is unchanged: `packMultiFormulaFast` deliberately
does not cap `pipeIn`, so Reactor Crucible and Expanded Crucible may receive any
number of distinct liquid types that fit the shared cache. Only output ports,
solid belt inputs, and cache slots are checked.

---

## Interactive performance architecture

HiGHS is pinned to npm package version `1.15.1`. The main production solve,
Meta candidate solves, canonical solve, and solo-max bound solves use
`solver_worker.js`. The UI sends a model object; the worker serialises it to
CPLEX LP text and calls the HiGHS WASM module. `solveLP` remains on the main
thread only as a compatibility fallback when workers are unavailable.

Two structural caches remove repeated work without caching any user-adjustable
bounds:

- `getCachedBipartiteGraph` keeps a 32-entry LRU keyed by ordered target IDs
  and recipe overrides. Raw and facility limits are deliberately absent because
  they change LP bounds, not graph reachability.
- `getGraphModelIndex` stores immutable sparse non-zero coefficient lists in a
  `WeakMap` per graph. Balance, raw-input, objective, and gas-drain rows walk
  these lists instead of rescanning every recipe for every item.

While a slider is active, summary and usage renderers compare structural keys
and update existing rate, width, count, power, and tooltip nodes. They rebuild
the panel only when the active resources/facilities/segments actually change.
The pointer-up settled solve still performs a complete render and persists the
final state.

`getSolverPerformanceSnapshot()` returns the latest 60 completed samples,
including total, worker compile/solve/round-trip, packer, summary, usage, and
input-lag timings. This is the first place to inspect before changing cadence or
moving another phase across the worker boundary.

---

## Known traps when modifying

- **Adding a recipe to the graph by hand:** use `addRecipeToGraph` inside
  `buildBipartiteGraph` — it maintains all four index maps consistently.
  Skipping any map will cause the graph to be silently incomplete.

- **Changing the augmentation criterion:** anything other than
  `isDisposalOnlyRecipe(cons)` can let in alternate normal producers. They
  form unexpected multi-producer groups that the single-recipe LP didn't
  account for, leading to wrong or missing balance equations.

- **Facility cap = 0:** the `ub_net_X` guard uses `mx === undefined || mx ===
null || !isFinite(mx)` — NOT `!mx`. Zero is a valid upper bound (facility
  cap=0 means the item can't be produced). The `solveMaxForItem` fallback
  likewise uses `>= 0` not `> 0`.

- **Pinned items at rate ≈ 0:** these are excluded from `pinnedIds`. A
  `equal: 0` equality constraint is almost always unintentional (e.g. the
  user dragged a slider to the left edge). Free (`min: 0`) is the safer default.

- **Residual snap threshold 1e-3:** if you tighten it below LP arithmetic
  noise, you'll see phantom non-zero rates. If you loosen it above real
  minimum production rates, you'll accidentally zero out legitimate results.

- **The `integerOnly` flag is inverted from its name — it now means
  *time-share*.** Flag **off** (default) = dedicated → each recipe gets an
  integer building-count var `b_ri ≥ x_ri` (in `generals`) and the cap is
  `Σ b_ri ≤ cap`, so it binds on whole units while production `x_ri` stays
  continuous (don't force `x_ri` itself integer — that makes a lone fractional
  recipe like 10.978 infeasible). Flag **on** = time-share → no `b` vars, slot
  cap `Σ x_ri ≤ cap`, packer rounds `⌈Σ d⌉`. The `b`-var MIP is added only for
  *capped single-formula* facilities (multi-formula is the packer's job).

---

## Where to look for what

| If you want to …                         | Look at                                                     |
| ---------------------------------------- | ----------------------------------------------------------- |
| Change recipe-pick heuristic             | `selectRecipe` in `solver_pipeline.js`                      |
| Add a new raw resource                   | `rawLimits[]` + `raw_R` constraint loop in `runSolver`      |
| Add a new facility type                  | `facilityLimits[]` + `fac_F` constraint loop in `runSolver` |
| Toggle time-share for a facility         | `f.integerOnly` on the `facilityLimit` entry (UI `⇄` toggle / URL `:i`); applied in `packBins` |
| Debug "why isn't recipe X running?"      | Log `recipeFacilityCounts` after Phase 4                    |
| Debug "why is item X at 0?"             | Check `soloMaxRate[X]`; if 0, a cap is binding              |
| Verify caps hold                         | Phase 5 sanity check (`rawAndFacilityUsage`)                |
| Swap the LP solver                       | `compileLP` / `solveLPAsync` in `solver_pipeline.js` and `solver_worker.js` |
| Change surplus penalty                   | `assets/solver_config.js` → `weights.surplus`               |
| Change machine penalty                   | `assets/solver_config.js` → `weights.machine`               |
| Understand battery display               | `computeSummary` in `endfield_calculator.js`                |
| Change facility/power counting            | `buildPlanAggregates` in `solver_pipeline.js`                |
| Change automatic Metastorage selection    | `_metastorageCandidates` + Phase 3 in `solver_pipeline.js`    |

---

## Reading order for a newcomer

1. Skim this doc top to bottom.
2. Read `runSolver` end to end in `solver_pipeline.js` — the phase banners match this doc.
3. Read `buildBipartiteGraph` — the structural decisions here shape everything the LP sees.
4. Read `selectRecipe`, `isDismantleRecipe`, `isDisposalOnlyRecipe` — understand why certain recipes are filtered.
5. Read the augmentation pass in `buildBipartiteGraph` — this is where recyclers enter.
6. Glance at `compileLP` + `solveLP` — know what the LP rows look like when handed to HiGHS.
7. Read `solveItemMax` + `solveMaxForItem` — understand how soloMaxRate is computed and cached.
