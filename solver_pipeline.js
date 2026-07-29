/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENDFIELD PRODUCTION SOLVER — PIPELINE  (solver_pipeline.js)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  This file owns everything that turns user inputs into a solved production
 *  schedule:
 *
 *    1. HiGHS LP adapter   — compileLP / solveLP / setHighsInstance
 *    2. Max-rate cache      — per-item ceiling via mini-LP; invalidated on limit changes
 *    3. Pipeline helpers    — calcRate, recipe selectors
 *    4. Graph builder       — DFS + byproduct-recycler augment + cycle repair
 *    5. Flow analysis       — net item rates and raw/facility usage from a schedule
 *    6. Solver state        — cached last result, throttle handle, timing
 *    7. Solver core         — runSolver (single global LP), updateSlidersInPlace, logS
 *
 *  End-to-end flow inside runSolver
 *  ─────────────────────────────────
 *
 *    production[], rawLimits, facilityLimits
 *                    │
 *     Phase 1 ───────┤  buildBipartiteGraph
 *                    │  DFS from each target → add ALL viable recipes per item
 *                    │  Augment: add FD-byproduct recyclers (e.g. xiranite purifier)
 *                    │  Repair:  inject all viable recipes for cycle-stranded items
 *                    │
 *     Phase 2 ───────┤  Build LP
 *                    │  Variables : x_ri  — facility count for recipe r (≥ 0)
 *                    │              surp_X — surplus absorber for zero-price dead ends
 *                    │  Constraints:
 *                    │    bal_X   net production ≥ 0  (= pinnedRate for fixed items)
 *                    │    raw_R   Σ consumption ≤ rawCap
 *                    │    fac_F   Σ facility counts ≤ facCap
 *                    │    ub_net_X  net production ≤ singleMaxRate[X]  (unbounded guard)
 *                    │  Objective: single-pass weighted
 *                    │    max  value − (MACHINE_PENALTY + POWER_WEIGHT·kW) · Σ x_ri
 *                    │    where value = Σ price(X)×net_rate(X) − SURPLUS_PENALTY·Σ surp_X.
 *                    │    The tiny penalties regularise degenerate optima so rates come
 *                    │    out clean.  (pinAll → just min Σ x_ri.)  Building-count
 *                    │    optimisation lives in the Phase-3 packer, not here.
 *                    │  Building-count MIP: dedicated (NOT time-shared) capped
 *                    │    single-formula facilities get an integer building var
 *                    │    b_ri ≥ x_ri per recipe with Σ b_ri ≤ cap — so the cap binds
 *                    │    on whole units (10+2=12, not ⌈9.84⌉+⌈2.16⌉=13) while
 *                    │    production x_ri stays continuous (a lone 10.978 → b=11 fits).
 *                    │    Time-shared facilities (the integerOnly flag) keep the slot
 *                    │    cap; the packer rounds their shared total (⌈Σx⌉).
 *                    │
 *     Phase 3 ───────┤  Solve via HiGHS (CPLEX LP text → WebAssembly)
 *                    │
 *     Phase 3b ──────┤  Canonicalise: pin solved target outputs, re-solve for
 *                    │  the minimal-facility mix.  Makes the recipe mix (and thus
 *                    │  the Phase-3 bin packing) a deterministic function of the
 *                    │  outputs, so pinning a target at its own value is a no-op.
 *                    │
 *     Phase 4 ───────┤  Extract recipeFacilityCounts from x_ri solution values
 *                    │
 *     Phase 5 ───────┤  Sanity check — abort if LP solution violates any cap by > 0.5
 *                    │
 *     Phase 6 ───────┤  Apply results
 *                    │  Snap LP residuals < 1e-3 → 0  (keeps slider/summary in sync)
 *                    │  Write p.rate, mark p.optimized, cache _lastGraph / _lastFacilityCounts
 *                    │  Render summary + usage bars
 *                    │
 *     Phase 3*───────┤  Building packer (packBins, at render time) — turns the LP's
 *                    │  per-recipe slot demands into integer PHYSICAL buildings;
 *                    │  twin-aware MILP for the multi-formula crucibles.  See
 *                    │  PACKER_PIPELINE.md.
 *
 *  Power (battery) consumption is NOT part of the LP.  Battery cost is a
 *  post-solve display subtraction: computeSummary subtracts pb.rate from
 *  netRates[pb.matId].  This keeps the LP constraints clean and lets the
 *  user see the gross vs net split explicitly.
 *
 *  singleMaxRate and the unbounded guard
 *  ────────────────────────────────────
 *  Without raw/facility caps, a self-sustaining production cycle (e.g. the
 *  moss/seed loop) makes the profit objective unbounded — HiGHS returns
 *  "Infeasible or Unbounded".  The fix is to cap every priced item's net
 *  production at the most it could ever be if that item were the only target
 *  (singleMaxRate, computed by a mini-LP).  These ub_net_X constraints bound
 *  the objective without affecting the LP's optimal solution when caps are
 *  present — a cap-constrained optimum is always ≤ the unconstrained
 *  singleMax.  singleMaxRate is computed lazily and cached; _singleMaxDirty causes
 *  a full rebuild only when limits or item list changes.
 *
 *  Globals consumed from endfield_calculator.js (present at call time):
 *    production, rawLimits, facilityLimits, prices, powerBatteries
 *    outpostCostDefault, tempPinnedId
 *    priceOf, prodEntry, isFixed, recipeFor, getSolverWeight
 *    computeSummary, renderProducts, fmt, setSliderFill
 *
 *  Globals consumed from assets/recipes.js:
 *    recipesByOutput, recipesByInput, recipeById, forcedRawSet, forcedDisposalSet
 *
 *  Globals consumed from assets/items.js:
 *    itemById
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/* ═══════════════════════════════════════════════
   § 1  HIGHS LP SOLVER ADAPTER

   The solver pipeline emits LP models as plain JS objects:
     {
       optimize:    string,           // objective variable name
       opType:      'max' | 'min',
       constraints: { name: { max|min|equal: number } },
       variables:   { name: { [constraintOrObj]: coef } },
       generals?:   string[]          // optional: variable names declared as integers
     }

   compileLP serialises this into CPLEX LP format text;  solveLP runs it
   through HiGHS and returns:
     { feasible: bool, result: number, [varName]: value }

   When generals is non-empty, compileLP appends a "General" section before
   "End", turning the solve into a MIP.  HiGHS handles both LP and MIP via
   the same solve() call — no adapter changes needed.

   HiGHS is loaded as a WebAssembly module. index.html awaits the WASM
   promise and calls setHighsInstance(solver) to install it. While _highs
   is null, isHighsReady() returns false and runSolver aborts with a user-
   visible message rather than a JS exception.
═══════════════════════════════════════════════ */

// Resolved HiGHS WebAssembly instance; null until setHighsInstance is called.
let _highs = null;
const _bipartiteGraphCache = new Map();
const _graphModelIndexCache = new WeakMap();

function isHighsReady() { return !!_highs; }

// Queued solve from before HiGHS was ready — drained by setHighsInstance.
let _pendingSolve = null;

// Called by the index.html bootstrap once the HiGHS WASM promise resolves.
// If the app already has production items (e.g. state was restored from
// localStorage before the WASM was ready), invalidate max bounds and let the
// worker-backed global solve refresh them without blocking startup.
function setHighsInstance(h) {
  _highs = h;
  if (typeof production !== 'undefined' && production.length) {
    invalidateMaxCache();
    const pending = _pendingSolve || { inPlace: false, pinAll: !autoSolveOn() };
    _pendingSolve = null;
    runSolver(pending.inPlace, pending.pinAll);
  }
}
// If the HiGHS WASM resolved before this script loaded, the head bootstrap
// stashed the instance in window._highsPending — consume it now.
if (window._highsPending) {
  const pendingHighs = window._highsPending;
  window._highsPending = null;
  // Finish initialising this script's caches/state before the pending solver
  // can trigger a restored-state solve.
  setTimeout(() => setHighsInstance(pendingHighs), 0);
}

// compileLP: serialise an LP model object into CPLEX LP format text.
//
// CPLEX LP format is a whitespace-sensitive text format that HiGHS accepts.
// Layout:
//   Maximize / Minimize
//     obj: <expr>
//   Subject To
//     <name>: <expr> <= / >= / = <bound>
//   End
//
// All variables default to [0, ∞) in CPLEX LP — no Bounds section needed
// because every variable here is either a facility count (x_ri ≥ 0) or a
// surplus absorber (surp_X ≥ 0).
// When model.generals is non-empty, a "General" section is appended so HiGHS
// treats those variables as integers, turning the problem into a MIP.
function compileLP(model) {
  const objName    = model.optimize;
  const opType     = (model.opType || 'max').toLowerCase();
  const objKeyword = opType === 'min' ? 'Minimize' : 'Maximize';

  // Walk all variables once, bucketing each non-zero coefficient into the
  // objective term list or the appropriate constraint term list.
  const constraintTerms = new Map();
  for (const cname of Object.keys(model.constraints)) constraintTerms.set(cname, []);
  const objTerms = [];

  for (const vname of Object.keys(model.variables)) {
    const coefs = model.variables[vname];
    for (const key of Object.keys(coefs)) {
      const c = coefs[key];
      if (!isFinite(c) || c === 0) continue;
      const term = (c < 0 ? '- ' : '+ ') + Math.abs(c) + ' ' + vname;
      if (key === objName) objTerms.push(term);
      else if (constraintTerms.has(key)) constraintTerms.get(key).push(term);
    }
  }

  const stripLeadingPlus = s => s.replace(/^\+\s+/, '');
  const objExpr = objTerms.length ? stripLeadingPlus(objTerms.join(' ')) : '0';

  const cLines = [];
  for (const [cname, bound] of Object.entries(model.constraints)) {
    const terms = constraintTerms.get(cname);
    if (!terms || !terms.length) continue;  // HiGHS rejects empty constraint rows
    const expr = stripLeadingPlus(terms.join(' '));
    if ('max' in bound)        cLines.push('  ' + cname + ': ' + expr + ' <= ' + bound.max);
    else if ('min' in bound)   cLines.push('  ' + cname + ': ' + expr + ' >= ' + bound.min);
    else if ('equal' in bound) cLines.push('  ' + cname + ': ' + expr + ' = '  + bound.equal);
  }

  const generalSection = (model.generals && model.generals.length)
    ? '\nGeneral\n  ' + model.generals.join('\n  ') + '\n'
    : '';
  return objKeyword + '\n  obj: ' + objExpr + '\nSubject To\n' + cLines.join('\n') + generalSection + '\nEnd\n';
}

// solveLP: run a model through HiGHS and return a flat result map.
// HiGHS' solve() returns a HighsSolution object; this adapter reshapes it
// into { feasible, result, [varName]: value } so call sites are insulated
// from HiGHS' internal return shape.
function solveLP(model) {
  if (!_highs) throw new Error('HiGHS not initialised');
  // model.options (e.g. { time_limit: 0.15 }) is forwarded to HiGHS verbatim.
  // A MILP time limit lets the packer return its best-found integer solution
  // promptly rather than spending seconds proving optimality on every frame.
  const text = model.options ? _highs.solve(compileLP(model), model.options) : _highs.solve(compileLP(model));
  return _flattenHighsSolution(text);
}

function _flattenHighsSolution(text) {
  // 'Optimal' is the clean case.  Under a MILP time limit HiGHS reports a
  // different status ('Time limit reached') while still returning the best
  // integer incumbent in Columns — accept that too, as long as a primal
  // solution is present and the model wasn't proven Infeasible/Unbounded.
  const feasible = text.Status === 'Optimal'
    || (!!text.Columns && text.ObjectiveValue != null && isFinite(text.ObjectiveValue)
        && text.Status !== 'Infeasible' && text.Status !== 'Unbounded' && text.Status !== 'Empty');
  const out = { feasible, result: text.ObjectiveValue, status: text.Status };
  if (feasible && text.Columns) {
    for (const [name, col] of Object.entries(text.Columns)) out[name] = col.Primal;
  }
  return out;
}

// LPs run in a dedicated worker so dragging, model serialisation, max-bound
// helpers and Meta candidate scans do not monopolise the UI thread.
// Synchronous solveLP remains a compatibility fallback for blocked workers.
let _lpWorker = null;
let _lpWorkerDisabled = false;
let _lpWorkerRequestId = 0;
const _lpWorkerPending = new Map();
let _lastLPWorkerStats = { compileMs: 0, solveMs: 0, roundTripMs: 0, lpBytes: 0 };

function _getLPWorker() {
  if (_lpWorker || _lpWorkerDisabled || typeof Worker === 'undefined') return _lpWorker;
  try {
    _lpWorker = new Worker('solver_worker.js');
    _lpWorker.onmessage = event => {
      const { id, solution, error, compileMs, solveMs, lpBytes } = event.data || {};
      const pending = _lpWorkerPending.get(id);
      if (!pending) return;
      _lpWorkerPending.delete(id);
      if (error) pending.reject(new Error(error));
      else {
        _lastLPWorkerStats = {
          compileMs: Number(compileMs) || 0,
          solveMs: Number(solveMs) || 0,
          roundTripMs: performance.now() - pending.started,
          lpBytes: Number(lpBytes) || 0,
        };
        pending.resolve(_flattenHighsSolution(solution));
      }
    };
    _lpWorker.onerror = event => {
      const error = new Error(event.message || 'LP worker failed');
      _lpWorkerPending.forEach(pending => pending.reject(error));
      _lpWorkerPending.clear();
      _lpWorker?.terminate();
      _lpWorker = null;
      _lpWorkerDisabled = true;
    };
  } catch (error) {
    _lpWorkerDisabled = true;
    _lpWorker = null;
  }
  return _lpWorker;
}

async function solveLPAsync(model) {
  const worker = _getLPWorker();
  if (!worker) return solveLP(model);
  const id = ++_lpWorkerRequestId;
  try {
    return await new Promise((resolve, reject) => {
      _lpWorkerPending.set(id, { resolve, reject, started: performance.now() });
      // Structured cloning is substantially cheaper than constructing the LP
      // text here, and lets the worker own both serialisation and HiGHS.
      worker.postMessage({ id, model });
    });
  } catch (error) {
    // Preserve functionality in browsers that block workers/CDN imports.
    return solveLP(model);
  }
}

// solveLexicographic: solve a sequence of objectives in strict priority order.
// (Currently unused — the main LP and the packer both use single weighted
// objectives — but kept as a tested utility for multi-objective solves.)
// Each pass optimises one objective, then pins its achieved optimum (± a tiny
// tolerance) as a constraint so later passes can only break ties — never
// sacrifice a higher-priority objective.  This replaces blended weighted
// penalties (which conflate objectives of different magnitudes) with a clean
// lexicographic order, matching how the reference planner ranks
// rawCost/buildings/power.
//
// objectives: ordered array of
//   { key, op:'max'|'min', capKey?, capDir?:'min'|'max', tol? }
//   key    — the objective variable-coefficient key (e.g. 'value', 'facc').
//   capKey — constraint name used to pin this pass's optimum for later passes.
//            Every variable must already carry a `capKey` coef equal to its
//            `key` coef (the caller mirrors them at model-build time).  Omit on
//            the last objective (nothing left to pin).
//   capDir — 'min' to add `>= optimum - slack` (for a maximised objective),
//            'max' to add `<= optimum + slack` (for a minimised objective).
//   tol    — absolute slack added to the pin.  relTol — slack proportional to
//            |optimum| (so value preservation stays safe across magnitudes).
//
// Returns the final pass's result, or the last feasible result if a later pass
// turns infeasible (defensive — shouldn't happen, the prior optimum is always
// feasible for the next pass; if a slack is mis-tuned we degrade to the
// higher-priority optimum rather than failing).
function solveLexicographic(baseConstraints, variables, generals, objectives, solveFn = solveLP) {
  let constraints = { ...baseConstraints };
  let result = null;
  for (let i = 0; i < objectives.length; i++) {
    const o = objectives[i];
    const r = solveFn({ optimize: o.key, opType: o.op, constraints, variables, generals });
    if (!r || !r.feasible) return result || r;
    result = r;
    if (i < objectives.length - 1 && o.capKey) {
      const star = r.result || 0;
      const slack = (o.tol || 0) + (o.relTol || 0) * Math.abs(star);
      constraints = {
        ...constraints,
        [o.capKey]: o.capDir === 'min' ? { min: star - slack } : { max: star + slack },
      };
    }
  }
  return result;
}


/* ================================================================
   ENDFIELD 1.4 GAS SUSTAIN DATA

   The new gas recipes have two costs that are not ordinary recipe
   inputs in the game data:

     - every PLACED transmuter drains 6 catalyst items/min, even idle;
     - gas-environment recipes require an always-on Gas Dispersing Unit.

   extract_recipes.py now persists the vaporizer facility/consumer recipes and
   gasEnv tags in the generated assets. installGasSustainData() remains a
   compatibility backstop for older assets, adding only missing records before
   endfield_calculator.js builds its indexes. The LP helpers below use integer
   placement variables so catalyst and environment costs follow whole buildings,
   not fractional recipe load.
================================================================ */

const GAS_SUSTAIN_CONFIG = Object.freeze({
  machinesPerVaporizer: 4,
  facilityDrains: new Map([
    ['transmuter_1', { itemId: 'item_liquid_xiranite', ratePerMinute: 6 }],
    ['transmuter_2', { itemId: 'item_gas_xiranite', ratePerMinute: 6 }],
  ]),
  recipeEnvironments: new Map([
    ['gas_reactor_gas_copper_enr2_1', 3],
    ['liquid_purifier_gas_copper_enr_2', 1],
    ['liquid_purifier_gas_xiranite_enr_2', 1],
    ['xiranite_oven_xiranite_powder_2', 1],
  ]),
  vaporizerEnvironments: new Map([
    [1, { itemId: 'item_gas_inert', recipeId: 'vaporize_item_gas_inert' }],
    [2, { itemId: 'item_gas_water', recipeId: 'vaporize_item_gas_water' }],
    [3, { itemId: 'item_gas_acid', recipeId: 'vaporize_item_gas_acid' }],
    [4, { itemId: 'item_gas_xiranite', recipeId: 'vaporize_item_gas_xiranite' }],
  ]),
});

// Source facilities and Metastorage are data-driven in newly generated assets.
// These defaults keep older checked-out assets compatible until
// extract_recipes.py is run again. The source rates match the beta calculator:
// solids use one 30/min Depot Unloader, liquids one 60/min pump, and Inergen
// one 20/min Gas Extractor.
const DEFAULT_RAW_MATERIAL_SOURCES = Object.freeze({
  item_originium_ore: { facilityId: 'unloader_1', ratePerMinute: 30 },
  item_quartz_sand: { facilityId: 'unloader_1', ratePerMinute: 30 },
  item_iron_ore: { facilityId: 'unloader_1', ratePerMinute: 30 },
  item_copper_ore: { facilityId: 'unloader_1', ratePerMinute: 30 },
  item_muck_feces_1: { facilityId: 'unloader_1', ratePerMinute: 30 },
  item_liquid_water: { facilityId: 'pump_1', ratePerMinute: 60 },
  item_liquid_acid: { facilityId: 'pump_2', ratePerMinute: 60 },
  item_gas_inert: { facilityId: 'gas_pump_1', ratePerMinute: 20 },
});

const DEFAULT_METASTORAGE = Object.freeze({
  sourceDomain: 'domain_1',
  destinationDomain: 'domain_2',
  ttvCapPerCycle: 1500,
  cycleSeconds: 3600,
  itemCosts: Object.freeze({
    item_bottled_food_1: 10, item_bottled_food_2: 20, item_bottled_food_3: 50,
    item_bottled_rec_hp_1: 10, item_bottled_rec_hp_2: 20, item_bottled_rec_hp_3: 50,
    item_carbon_enr: 1, item_carbon_enr_powder: 1, item_carbon_mtl: 1,
    item_carbon_powder: 1, item_crystal_enr: 2, item_crystal_enr_powder: 2,
    item_crystal_powder: 1, item_crystal_shell: 1, item_equip_script_1: 10,
    item_equip_script_2: 20, item_equip_script_3: 50, item_glass_bottle: 2,
    item_glass_cmpt: 1, item_glass_enr_bottle: 5, item_glass_enr_cmpt: 2,
    item_iron_bottle: 2, item_iron_cmpt: 1, item_iron_enr: 2,
    item_iron_enr_bottle: 5, item_iron_enr_cmpt: 2, item_iron_enr_powder: 2,
    item_iron_nugget: 1, item_iron_ore: 1, item_iron_powder: 1,
    item_originium_enr_powder: 1, item_originium_ore: 1, item_originium_powder: 1,
    item_plant_bbflower_1: 1, item_plant_bbflower_powder_1: 1,
    item_plant_bbflower_seed_1: 1, item_plant_grass_1: 1, item_plant_grass_2: 1,
    item_plant_grass_powder_1: 1, item_plant_grass_powder_2: 1,
    item_plant_grass_seed_1: 1, item_plant_grass_seed_2: 1, item_plant_moss_1: 1,
    item_plant_moss_2: 1, item_plant_moss_3: 1, item_plant_moss_enr_powder_1: 1,
    item_plant_moss_enr_powder_2: 1, item_plant_moss_powder_1: 1,
    item_plant_moss_powder_2: 1, item_plant_moss_powder_3: 1,
    item_plant_moss_seed_1: 1, item_plant_moss_seed_2: 1, item_plant_moss_seed_3: 1,
    item_proc_battery_1: 20, item_proc_battery_2: 20, item_proc_battery_3: 50,
    item_proc_bomb_1: 5, item_quartz_enr: 2, item_quartz_enr_powder: 2,
    item_quartz_glass: 1, item_quartz_powder: 1, item_quartz_sand: 1,
  }),
});

const DEFAULT_POWER_FUELS = Object.freeze({
  item_proc_battery_1: { powerGeneration: 220, fuelPerMinutePerBank: 1.5 },
  item_proc_battery_2: { powerGeneration: 420, fuelPerMinutePerBank: 1.5 },
  item_proc_battery_3: { powerGeneration: 1100, fuelPerMinutePerBank: 1.5 },
  item_proc_battery_4: { powerGeneration: 1600, fuelPerMinutePerBank: 1.5 },
  item_proc_battery_5: { powerGeneration: 3200, fuelPerMinutePerBank: 1.5 },
});

function gasEnvironmentForRecipe(recipe) {
  const env = recipe?.gasEnv ?? GAS_SUSTAIN_CONFIG.recipeEnvironments.get(recipe?.id);
  return Number.isFinite(Number(env)) && Number(env) > 0 ? Number(env) : 0;
}

function sustainDrainForRecipe(recipe) {
  return GAS_SUSTAIN_CONFIG.facilityDrains.get(recipe?.facilityId) || null;
}

// Called from index.html after recipes.json is loaded and before the runtime
// recipe/facility lookup tables are constructed.
function installGasSustainData(db) {
  if (!db || typeof db !== 'object') return db;

  const facilities = [...(db.facilities || [])];
  if (!facilities.some(f => f.id === 'vaporizer_1')) {
    facilities.push({
      id: 'vaporizer_1', power: 0, tier: 4, name: 'Gas Dispersing Unit',
      iconFile: 'vaporizer_1.webp', bandwidth: 2,
      beltInPorts: 0, pipeInPorts: 1, beltOutPorts: 0, pipeOutPorts: 0,
      cacheSlots: 1,
    });
  }
  if (!facilities.some(f => f.id === 'unloader_1')) {
    facilities.push({
      id: 'unloader_1', power: 0, tier: 3, name: 'Depot Unloader',
      iconFile: 'unloader_1.webp', bandwidth: 2,
      beltInPorts: 0, pipeInPorts: 0, beltOutPorts: 1, pipeOutPorts: 0,
      cacheSlots: 1,
    });
  }
  if (!facilities.some(f => f.id === 'power_station_1')) {
    facilities.push({
      id: 'power_station_1', power: 0, tier: 2, name: 'Thermal Bank',
      iconFile: 'power_station_1.webp', bandwidth: 2,
      beltInPorts: 2, pipeInPorts: 0, beltOutPorts: 0, pipeOutPorts: 0,
      cacheSlots: 1,
    });
  }

  const recipes = (db.recipes || []).map(recipe => {
    const gasEnv = gasEnvironmentForRecipe(recipe);
    return gasEnv && recipe.gasEnv == null ? { ...recipe, gasEnv } : recipe;
  });
  const recipeIds = new Set(recipes.map(r => r.id));
  GAS_SUSTAIN_CONFIG.vaporizerEnvironments.forEach((entry, env) => {
    if (recipeIds.has(entry.recipeId)) return;
    recipes.push({
      id: entry.recipeId,
      inputs: [{ itemId: entry.itemId, amount: 6 }],
      outputs: [],
      facilityId: 'vaporizer_1',
      craftingTime: 60,
      beltIn: 0, pipeIn: 1, beltOut: 0, pipeOut: 0,
      buffers: [entry.itemId],
      gasEnvSupport: env,
      synthetic: true,
    });
  });

  return {
    ...db,
    facilities,
    recipes,
    rawMaterialSources: db.rawMaterialSources || DEFAULT_RAW_MATERIAL_SOURCES,
    metastorage: db.metastorage || DEFAULT_METASTORAGE,
    powerFuels: db.powerFuels || DEFAULT_POWER_FUELS,
  };
}


/* ═══════════════════════════════════════════════
   § 2  MAX-RATE CACHE

   For each priced item in the graph, we need an upper bound on how fast
   it can be produced (singleMaxRate).  This is computed by a mini-LP that
   maximises net production of just that item against the current
   raw/facility limits.

   Two-level caching strategy
   ──────────────────────────
   _maxCache   (Map)  — memoises solveItemMax results keyed by
                        itemId + recipeId + facLimits fingerprint + rawLimits fingerprint.
                        Cleared by invalidateMaxCache().

   _singleMaxMap (obj)  — a flat { itemId → maxRate } map rebuilt from
                        _maxCache or solveItemMax calls whenever
                        _singleMaxDirty is true. The dirty flag is set by
                        invalidateMaxCache() (called when limits or item
                        list changes). During drag, _singleMaxDirty stays
                        false, so runSolver skips the rebuild entirely
                        and singleMax lookups are O(1) object reads.
═══════════════════════════════════════════════ */

// Primary memoisation map: cache key → max rate (number).
const _maxCache = new Map();

// Flat itemId → maxRate snapshot; rebuilt lazily from _maxCache/_solveItemMax.
let _singleMaxMap = {};
let _singleMaxDirty = true;

// Production entries always carry a recipeId so the UI can show a selected
// recipe.  The first recipe is merely that UI default; treating it as a hard
// graph override silently removes every alternate route (notably the
// Solid-Gas Heavy Xiranite route).  Only a non-default selection represents an
// explicit user override, which also matches the URL encoder's behaviour.
function isExplicitRecipeOverride(entry) {
  if (!entry?.recipeId) return false;
  const defaultId = recipesByOutput?.[entry.id]?.[0]?.id || '';
  return !!defaultId && entry.recipeId !== defaultId;
}

function productionRecipeOverrides(entries = production) {
  return new Map(entries
    .filter(isExplicitRecipeOverride)
    .map(entry => [entry.id, entry.recipeId]));
}

// Cache key: encodes everything that can affect the max rate for an item —
// the item's chosen recipe, every facility limit, and every raw limit.
// Any change to limits triggers invalidateMaxCache(), which clears the map
// and sets _singleMaxDirty so the next runSolver call rebuilds _singleMaxMap.
function _maxCacheKey(id) {
  const p = prodEntry(id);
  const recipeId = isExplicitRecipeOverride(p) ? p.recipeId : '';
  // Include the time-share flag — it changes the effective facility cap model
  // (building-count vs slots), so the max rate differs and must re-cache.
  const facKey = facilityLimits.map(f => f.gameFacilityId + ':' + f.cap + ':' + (f.integerOnly ? 1 : 0)).join(',');
  const rawKey = rawLimits.map(r => r.matId + ':' + r.cap).join(',');
  const metaKey = _metastorageEnabled() ? 'meta:1' : 'meta:0';
  return id + '|' + recipeId + '|' + facKey + '|' + rawKey + '|' + metaKey;
}

// Invalidate both caches — called whenever the limit fingerprint changes.
function invalidateMaxCache() { _maxCache.clear(); _singleMaxDirty = true; }

// _addFacilityCaps: build the per-facility cap constraints, shared by the main
// LP and the per-item max-rate mini-LP so both honour the same model.
// Dedicated single-formula capped facilities (time-share off) get an integer
// building-count var b_ri ≥ x_ri per recipe with Σ b_ri ≤ cap; everything else
// caps Σ x_ri ≤ cap (slots).  Pushes any b_ri names into `generals` (→ MIP).
function _addFacilityCaps(constraints, variables, generals, recipeList, placementVarByIndex = new Map()) {
  // Recipe index -> variable that actually consumes one unit of the hard cap.
  // For dedicated facilities this is the whole-building b_ri variable, not
  // fractional recipe activity x_ri.  Returning the map lets the objective use
  // the exact same physical quantity as the ceiling.
  const capUsageVarByIndex = new Map();
  facilityLimits.forEach(f => {
    const fid = f.gameFacilityId;
    const cName = `fac_${fid}`;
    constraints[cName] = { max: f.cap };
    const dedicatedSingle = (facilityTypeById[fid]?.cacheSlots ?? 1) <= 1 && !f.integerOnly;
    recipeList.forEach((r, ri) => {
      if (r.facilityId !== fid) return;
      const placementName = placementVarByIndex.get(ri);
      if (placementName) {
        // Gas-sustain placement variables represent real whole buildings and
        // are authoritative for caps, even when the UI's time-share flag is on.
        variables[placementName][cName] = (variables[placementName][cName] || 0) + 1;
        capUsageVarByIndex.set(ri, placementName);
      } else if (dedicatedSingle) {
        const bName = `b_${ri}`, bcName = `bc_${ri}`;
        if (!variables[bName]) { variables[bName] = {}; generals.push(bName); }
        constraints[bcName] = { max: 0 };                                   // x_ri − b_ri ≤ 0
        variables[`x_${ri}`][bcName] = (variables[`x_${ri}`][bcName] || 0) + 1;
        variables[bName][bcName] = -1;
        variables[bName][cName] = (variables[bName][cName] || 0) + 1;        // Σ b_ri ≤ cap
        capUsageVarByIndex.set(ri, bName);
      } else {
        variables[`x_${ri}`][cName] = (variables[`x_${ri}`][cName] || 0) + 1; // Σ x_ri ≤ cap
        capUsageVarByIndex.set(ri, `x_${ri}`);
      }
    });
  });
  return capUsageVarByIndex;
}

// Fold raw pickup facilities into the same facility-cap rows. This makes a
// pump/unloader limit constrain its supplied throughput instead of appearing as
// an empty recipe-facility row. Whole-placement overflow is still checked after
// packing because several raw item types can fragment across pickups.
function _addSourceFacilityCaps(constraints, variables, recipeList, placementVarByIndex = new Map()) {
  const sources = window.RECIPES_DB?.rawMaterialSources || DEFAULT_RAW_MATERIAL_SOURCES;
  facilityLimits.forEach(limit => {
    const sourceItems = Object.entries(sources).filter(([, cfg]) =>
      cfg.facilityId === limit.gameFacilityId && cfg.ratePerMinute > 0);
    if (!sourceItems.length) return;
    const cName = `fac_${limit.gameFacilityId}`;
    constraints[cName] = { max: limit.cap };
    sourceItems.forEach(([itemId, cfg]) => {
      recipeList.forEach((recipe, ri) => {
        (recipe.inputs || []).forEach(input => {
          if (input.itemId !== itemId) return;
          const pickupCount = calcRate(input.amount, recipe.craftingTime) / cfg.ratePerMinute;
          variables[`x_${ri}`][cName] = (variables[`x_${ri}`][cName] || 0) + pickupCount;
        });
        const drain = sustainDrainForRecipe(recipe);
        if (drain?.itemId !== itemId) return;
        variables[`x_${ri}`][cName] = (variables[`x_${ri}`][cName] || 0)
          + drain.ratePerMinute / cfg.ratePerMinute;
      });
    });
  });
}

// Add the 1.4 gas mechanics to an already-created recipe LP.
//
// For every transmuter or gas-environment recipe, p_ri is an integer placed-
// building variable with x_ri <= p_ri. It is what facility caps, power and the
// vaporizer coverage row count, because those follow whole buildings.
//
// Catalyst balance is charged to x_ri, not p_ri. A placed transmuter does drain
// its catalyst continuously, but in-game the drain can be pulse-width modulated
// or batched down to exactly the amount a partially-loaded unit needs, so the
// sustained cost tracks fractional recipe load rather than ceil(load). Charging
// p_ri instead billed a 4.87-load bank of transmuters for 5 whole units of
// catalyst and understated every downstream rate.
//
// Environment rows still use placements and a whole-number vaporizer variable:
//
//   machinesPerVaporizer * x_vaporize - sum(p_env_recipe) >= 0
//
// Returns recipe-index -> placement-variable so facility caps, objectives and
// post-solve building counts all use the identical physical count.
function _addGasSustainConstraints(constraints, variables, generals, recipeList) {
  const placementVarByIndex = new Map();
  const ensurePlacement = ri => {
    if (placementVarByIndex.has(ri)) return placementVarByIndex.get(ri);
    const pName = `p_gas_${ri}`;
    const linkName = `gas_place_${ri}`;
    variables[pName] = variables[pName] || {};
    if (!generals.includes(pName)) generals.push(pName);
    constraints[linkName] = { max: 0 }; // x_ri - p_ri <= 0
    variables[`x_${ri}`][linkName] = (variables[`x_${ri}`][linkName] || 0) + 1;
    variables[pName][linkName] = (variables[pName][linkName] || 0) - 1;
    placementVarByIndex.set(ri, pName);
    return pName;
  };

  recipeList.forEach((recipe, ri) => {
    const drain = sustainDrainForRecipe(recipe);
    const gasEnv = gasEnvironmentForRecipe(recipe);
    if (!drain && !gasEnv) return;
    ensurePlacement(ri);
    if (!drain) return;

    const xName = `x_${ri}`;
    const balanceName = `bal_${drain.itemId}`;
    if (constraints[balanceName])
      variables[xName][balanceName] = (variables[xName][balanceName] || 0) - drain.ratePerMinute;

    const rawName = `raw_${drain.itemId}`;
    if (constraints[rawName])
      variables[xName][rawName] = (variables[xName][rawName] || 0) + drain.ratePerMinute;
  });

  const envRecipeIndices = new Map();
  const vaporizerIndexByEnv = new Map();
  recipeList.forEach((recipe, ri) => {
    const env = gasEnvironmentForRecipe(recipe);
    if (env) {
      if (!envRecipeIndices.has(env)) envRecipeIndices.set(env, []);
      envRecipeIndices.get(env).push(ri);
    }
    if (Number(recipe.gasEnvSupport) > 0)
      vaporizerIndexByEnv.set(Number(recipe.gasEnvSupport), ri);
  });

  envRecipeIndices.forEach((indices, env) => {
    const vaporizerIndex = vaporizerIndexByEnv.get(env);
    if (vaporizerIndex == null) return;
    const vaporizerVar = `x_${vaporizerIndex}`;
    if (!generals.includes(vaporizerVar)) generals.push(vaporizerVar);
    const rowName = `gas_env_${env}`;
    constraints[rowName] = { min: 0 };
    variables[vaporizerVar][rowName] = GAS_SUSTAIN_CONFIG.machinesPerVaporizer;
    indices.forEach(ri => {
      const pName = ensurePlacement(ri);
      variables[pName][rowName] = (variables[pName][rowName] || 0) - 1;
    });
  });

  return placementVarByIndex;
}

// solveItemMax: mini-LP that maximises net production of a single item.
// Builds the same balance/raw/facility constraint structure as the global LP
// but with a single-item objective and no pinned items or batteries.
// Returns the max rate (number ≥ 0) or null on solver failure.
function buildItemMaxModel(targetId, graph) {
  const {
    recipeList,
    netTermsByItem,
    inputTermsByItem,
    drainTermsByItem,
  } = getGraphModelIndex(graph);
  if (!recipeList.length) return null;
  const constraints = {};
  const variables = {};
  const generals = [];
  recipeList.forEach((_, ri) => { variables[`x_${ri}`] = {}; });

  // Balance: net production ≥ 0 for every non-raw item.
  // (Same structure as the global LP's bal_X constraints.)
  graph.itemNodes.forEach((info, iid) => {
    if (info.isRawMaterial) return;
    const cName = `bal_${iid}`;
    const terms = netTermsByItem.get(iid) || [];
    terms.forEach(([ri, coefficient]) => { variables[`x_${ri}`][cName] = coefficient; });
    if (terms.length) constraints[cName] = { min: 0 };
  });

  // Raw material caps (replicate global LP's raw_R constraints).
  rawLimits.forEach(rl => {
    const cName = `raw_${rl.matId}`;
    constraints[cName] = { max: rl.cap };
    (inputTermsByItem.get(rl.matId) || []).forEach(([ri, coefficient]) => {
      variables[`x_${ri}`][cName] = (variables[`x_${ri}`][cName] || 0) + coefficient;
    });
  });

  // Facility caps — same model as the global LP (building-count for dedicated
  // single-formula, slots for time-shared / multi-formula) so the max rate
  // reflects whether the facility is time-shared.
  const gasPlacementVars = _addGasSustainConstraints(constraints, variables, generals, recipeList);
  _addFacilityCaps(constraints, variables, generals, recipeList, gasPlacementVars);
  _addSourceFacilityCaps(constraints, variables, recipeList, gasPlacementVars);

  // Single-item profit objective: maximise net production of targetId.
  (netTermsByItem.get(targetId) || []).forEach(([ri, coefficient]) => {
    variables[`x_${ri}`].obj = coefficient;
  });
  (drainTermsByItem.get(targetId) || []).forEach(([ri, rate]) => {
    variables[`x_${ri}`].obj = (variables[`x_${ri}`].obj || 0) - rate;
  });

  // The global LP's ub_net_X rows must remain valid when Auto Meta adds an
  // import. A no-transfer solo maximum is too small: for example, 540 ore plus
  // 25 Dense Originium Powder can reproduce a 590-ore plan, but the old guard
  // still capped Battery V at its 540-ore maximum. For bound construction only,
  // expose all graph-relevant Meta items behind one shared TTV budget. Allowing
  // several item types is a deliberate relaxation: it yields a safe finite
  // upper bound while the real solve still selects at most one transfer item.
  if (_metastorageEnabled()) {
    const cfg = _metastorageConfig();
    const budget = Number(cfg?.ttvCapPerCycle) / (Number(cfg?.cycleSeconds) / 60);
    if (budget > 0) {
      const ttvRow = 'max_meta_ttv';
      constraints[ttvRow] = { max: budget };
      Object.entries(cfg?.itemCosts || {}).sort(([a], [b]) => a.localeCompare(b))
        .forEach(([itemId, rawCost], index) => {
          const cost = Number(rawCost);
          const balance = `bal_${itemId}`;
          if (!(cost > 0) || !constraints[balance]) return;
          const name = `max_meta_${index}`;
          variables[name] = { [balance]: 1, [ttvRow]: cost };
          if (itemId === targetId) variables[name].obj = 1;
        });
    }
  }

  // A continuous relaxation is sufficient here because this solve only builds
  // a safety upper bound. It is also important for toggle responsiveness: the
  // bound may contain every eligible Meta source, but never runs a MIP scan.
  const maxGenerals = _metastorageEnabled() ? [] : generals;
  return { optimize: 'obj', opType: 'max', constraints, variables, generals: maxGenerals };
}

function _itemMaxFromResult(result) {
  if (!result?.feasible || result.result == null) return null;
  // Treat near-zero results as exactly 0 (LP arithmetic noise).
  return result.result > 1e-9 ? result.result : 0;
}

function solveItemMax(targetId, graph) {
  const model = buildItemMaxModel(targetId, graph);
  return model ? _itemMaxFromResult(solveLP(model)) : null;
}

async function solveItemMaxAsync(targetId, graph) {
  const model = buildItemMaxModel(targetId, graph);
  return model ? _itemMaxFromResult(await solveLPAsync(model)) : null;
}

// solveMaxForItem: public entry point for per-item max rate.
// Checks _maxCache first; falls back to solveItemMax (or a simple facility-
// count bound when HiGHS isn't loaded yet).
function solveMaxForItem(id) {
  const cacheKey = _maxCacheKey(id);
  if (_maxCache.has(cacheKey)) return _maxCache.get(cacheKey);

  const p = prodEntry(id);
  const r = p ? recipeFor(p) : null;
  if (!r) { _maxCache.set(cacheKey, 1e6); return 1e6; }

  const out = (r.outputs || []).find(o => o.itemId === id);
  const outputRatePerFac = out ? calcRate(out.amount, r.craftingTime) : 0;
  if (outputRatePerFac <= 0) { _maxCache.set(cacheKey, 1e6); return 1e6; }

  let final = 1e6;
  if (isHighsReady()) {
    try {
      // Build a graph rooted at this item only (honours any user recipe override).
      const overrides = isExplicitRecipeOverride(p)
        ? new Map([[id, p.recipeId]])
        : new Map();
      const graph = getCachedBipartiteGraph([id], overrides);
      if (graph.recipeNodes.size) {
        const v = solveItemMax(id, graph);
        // v >= 0 check: cap=0 on the item's facility means v=0 is a valid answer.
        if (typeof v === 'number' && isFinite(v) && v >= 0) final = v;
      }
    } catch (e) {
      // HiGHS error: fall back to simple facility-count ceiling.
      let mx = Infinity;
      facilityLimits.forEach(f => {
        if (f.gameFacilityId === r.facilityId) mx = Math.min(mx, f.cap * outputRatePerFac);
      });
      if (isFinite(mx) && mx >= 0) final = mx;
    }
  } else {
    // HiGHS not yet loaded: approximate with facility count × output rate.
    let mx = Infinity;
    facilityLimits.forEach(f => {
      if (f.gameFacilityId === r.facilityId) mx = Math.min(mx, f.cap * outputRatePerFac);
    });
    if (isFinite(mx) && mx >= 0) final = mx;
  }

  _maxCache.set(cacheKey, final);
  return final;
}

// Fast UI estimate used while the worker-backed exact max bound is pending.
function _approximateItemMax(p) {
  const recipe = p ? recipeFor(p) : null;
  const output = recipe?.outputs?.find(entry => entry.itemId === p.id);
  const perFacility = output ? calcRate(output.amount, recipe.craftingTime) : 0;
  if (!(perFacility > 0)) return 1e6;
  let max = Infinity;
  facilityLimits.forEach(limit => {
    if (limit.gameFacilityId === recipe.facilityId)
      max = Math.min(max, Math.max(0, limit.cap) * perFacility);
  });
  return isFinite(max) ? max : 1e6;
}

function recomputeMax(p) { p.maxRate = _approximateItemMax(p); }

// Invalidate exact bounds and publish cheap estimates for the controls. The
// next runSolver pass replaces them with solveItemMaxAsync results.
function recomputeAllMax() {
  invalidateMaxCache();
  production.forEach(p => { p.maxRate = _approximateItemMax(p); });
}

// recomputeMaxForFacility: called when a facility limit changes.
// Clamps any slider that was above the new ceiling.
function recomputeMaxForFacility(typeId) {
  invalidateMaxCache();
  production.forEach(p => {
    // Give controls an immediate safe estimate. The exact helper LP runs in
    // the worker at the start of runSolver and replaces this value.
    p.maxRate = _approximateItemMax(p);
    if (p.rate > p.maxRate) p.rate = p.maxRate;
  });
}

// recomputeMaxForRaw: called when a raw resource limit changes.
// Same clamp logic as recomputeMaxForFacility.
function recomputeMaxForRaw() {
  invalidateMaxCache();
  production.forEach(p => {
    if (p.maxRate === undefined) p.maxRate = _approximateItemMax(p);
    if (p.rate > p.maxRate) p.rate = p.maxRate;
  });
}


/* ═══════════════════════════════════════════════
   § 3  PIPELINE HELPERS

   Small pure functions used by the graph builder and LP constructor.
═══════════════════════════════════════════════ */

// calcRate: convert a recipe's "amount per crafting cycle" into items/minute.
// Every rate value in the LP (coefficient and output bound) goes through this.
function calcRate(amount, craftingTime) { return amount / craftingTime * 60; }

// isDismantleRecipe: true when the recipe consumes a filled liquid bottle or
// filled gas canister. These are container-return sinks, not production paths.
// Letting the newly-added gas-canister dismantlers participate as producers
// creates large artificial cycles through every gas recipe and makes the LP
// much more expensive than the stable calculator.
function isDismantleRecipe(r) {
  return (r.inputs || []).some(i =>
    i.itemId.startsWith('item_fbottle_') || i.itemId.startsWith('item_gasjar_')
  );
}

// isDisposalOnlyRecipe: true when EVERY input is a forced-disposal item.
// These recipes are pure byproduct sinks (e.g. liquid_purifier_xiranite_poly
// which converts waste lxp_lowpoly back to useful lxp).  The DFS avoids
// picking them as the primary producer for an item; the augmentation pass
// adds them back as recyclers once the main graph is built.
function isDisposalOnlyRecipe(r) {
  const inps = r.inputs || [];
  if (inps.length === 0) return false;
  return inps.every(i => forcedDisposalSet.has(i.itemId));
}

// Ordinary recipe inputs plus the out-of-band catalyst a transmuter drains.
// The synthetic dependency has amount 0 here — it exists only so the graph
// builder traverses the catalyst's supply chain. Its real 6/min coefficient is
// attached to the recipe-load variable x_ri when the LP rows are built.
function recipeDependencyInputs(recipe) {
  const inputs = recipe.inputs || [];
  const drain = sustainDrainForRecipe(recipe);
  if (!drain || inputs.some(input => input.itemId === drain.itemId)) return inputs;
  return [...inputs, { itemId: drain.itemId, amount: 0, sustain: true }];
}

// selectRecipe: recipe selection heuristic.
//
// Filter cascade applied in order:
//   1. Drop dismantle recipes (filled-bottle inputs)
//   2. Drop disposal-only recipes (all-FD inputs; added later as recyclers)
//   3. Prefer single-output recipes (avoids picking multi-output alternates
//      that generate unwanted byproducts as the primary path)
//   4. Within each tier, prefer a recipe whose EVERY input is a forced-raw
//      material — it terminates the DFS immediately and avoids synthetic
//      cycles like "iron_powder → iron_nugget" that have no external entry.
//   5. If visitedPath is provided, prefer non-circular (no input already on
//      the DFS stack) to break tie-loops in multi-input items.
function selectRecipe(recipes, visitedPath) {
  const nonDismantle = recipes.filter(r => !isDismantleRecipe(r));
  const stage1 = nonDismantle.length > 0 ? nonDismantle : recipes;
  const nonDisposal = stage1.filter(r => !isDisposalOnlyRecipe(r));
  const pool = nonDisposal.length > 0 ? nonDisposal : stage1;
  const singleOutput = pool.filter(r => (r.outputs || []).length === 1);

  function pickBest(candidates) {
    const allRaw = candidates.filter(r =>
      (r.inputs || []).length > 0 &&
      (r.inputs || []).every(i => forcedRawSet.has(i.itemId)));
    return allRaw.length > 0 ? allRaw[0] : candidates[0];
  }

  if (singleOutput.length > 0) {
    if (visitedPath && visitedPath.size > 0) {
      const nonCircular = singleOutput.filter(r =>
        !(r.inputs || []).some(i => visitedPath.has(i.itemId)));
      if (nonCircular.length > 0) return pickBest(nonCircular);
    }
    return pickBest(singleOutput);
  }
  if (visitedPath && visitedPath.size > 0) {
    const nonCircular = pool.filter(r =>
      !(r.inputs || []).some(i => visitedPath.has(i.itemId)));
    if (nonCircular.length > 0) return pickBest(nonCircular);
  }
  return pickBest(pool);
}


/* ═══════════════════════════════════════════════
   § 4  GRAPH BUILDER

   buildBipartiteGraph constructs the recipe/item subgraph for the given
   target items. Only recipes that could plausibly contribute to satisfying
   demand for a target are included — the global recipe database (~hundreds)
   is far too large to hand wholesale to the LP.

   Three-step construction:

     Step 1 — DFS from each target.  At each item, add ALL viable recipes
              (non-dismantle, non-disposal-only) and recurse into every
              recipe's inputs.  User recipe overrides limit an item to one
              recipe.  Stop at forcedRawSet items and dead-end items.
              Multiple recipes per item enter the LP as separate variables;
              the power-weighted objective (MACHINE_PENALTY + POWER_WEIGHT ×
              facility_kw) steers the solver toward lower-power paths when
              profit is otherwise equal.

     Step 2 — Augmentation: byproduct recyclers.  Scan every recipe already
              in the graph.  For each forced-disposal output, look up all
              consuming recipes.  Any recipe that (a) has all-FD inputs and
              (b) produces at least one item already in the graph gets added.
              This is how liquid_purifier_xiranite_poly_1 enters: it eats
              lowpoly (FD output of pool_liquid) and produces lxp (already
              in graph).  The all-FD-input restriction is critical — it
              blocks alternate normal producers from sneaking in.
              Repeat until fixpoint (typically 1–2 iterations).

     Step 3 — Post-DFS cycle repair.  Compute which items are reachable from
              raw materials through the current graph.  For any item not yet
              reachable (stuck in a cycle with no raw entry), find a recipe
              NOT already in the graph whose every input is reachable-or-raw
              and inject it.  Repeat until stable.

   Graph shape:
     {
       itemNodes:      Map<itemId, { isRawMaterial: bool }>,
       recipeNodes:    Map<recipeId, recipe>,
       itemConsumedBy: Map<itemId, Set<recipeId>>,
       itemProducedBy: Map<itemId, Set<recipeId>>,
       recipeInputs:   Map<recipeId, Set<itemId>>,
       recipeOutputs:  Map<recipeId, Set<itemId>>,
       targets:        Set<itemId>,
       rawMaterials:   Set<itemId>,
     }
═══════════════════════════════════════════════ */
function buildBipartiteGraph(targetIds, recipeOverrides) {
  const graph = {
    itemNodes: new Map(),
    recipeNodes: new Map(),
    itemConsumedBy: new Map(),
    itemProducedBy: new Map(),
    recipeInputs: new Map(),
    recipeOutputs: new Map(),
    targets: new Set(targetIds),
    rawMaterials: new Set(),
  };
  const visitedItems = new Set();

  // Reactor and Expanded Reactor recipes are facility twins with identical
  // I/O. Phase 1 only needs one variable for each logical recipe; Phase 3's
  // twin pool still has the complete recipe database and chooses the physical
  // Reactor/Expanded placement. Keeping both twins in the LP doubles this
  // entire branch without changing any material balance.
  function collapseMultiFormulaTwins(recipes) {
    const bySignature = new Map();
    recipes.forEach(recipe => {
      const facility = facilityTypeById[recipe.facilityId];
      if (!facility || (facility.cacheSlots ?? 1) <= 1) {
        bySignature.set(`recipe:${recipe.id}`, recipe);
        return;
      }
      const signature = `multi:${_recipeSignature(recipe)}`;
      const current = bySignature.get(signature);
      if (!current) {
        bySignature.set(signature, recipe);
        return;
      }
      const currentFacility = facilityTypeById[current.facilityId];
      const currentPower = currentFacility?.power ?? Number.POSITIVE_INFINITY;
      const recipePower = facility.power ?? Number.POSITIVE_INFINITY;
      if (recipePower < currentPower ||
          (recipePower === currentPower && recipe.id.localeCompare(current.id) < 0))
        bySignature.set(signature, recipe);
    });
    return [...bySignature.values()];
  }

  // addRecipeToGraph: register a recipe and wire up all four index maps.
  // Must be used instead of directly setting graph.recipeNodes — skipping
  // any map corrupts the graph structure silently.
  function addRecipeToGraph(recipe) {
    if (graph.recipeNodes.has(recipe.id)) return;
    graph.recipeNodes.set(recipe.id, recipe);
    graph.recipeInputs.set(recipe.id, new Set());
    graph.recipeOutputs.set(recipe.id, new Set());
    (recipe.outputs || []).forEach(out => {
      graph.recipeOutputs.get(recipe.id).add(out.itemId);
      if (!graph.itemNodes.has(out.itemId))
        graph.itemNodes.set(out.itemId, { isRawMaterial: false });
      if (!graph.itemProducedBy.has(out.itemId))
        graph.itemProducedBy.set(out.itemId, new Set());
      graph.itemProducedBy.get(out.itemId).add(recipe.id);
    });
    recipeDependencyInputs(recipe).forEach(inp => {
      graph.recipeInputs.get(recipe.id).add(inp.itemId);
      if (!graph.itemConsumedBy.has(inp.itemId))
        graph.itemConsumedBy.set(inp.itemId, new Set());
      graph.itemConsumedBy.get(inp.itemId).add(recipe.id);
    });
  }

  // Step 1 — DFS: add ALL viable recipes per item, recurse into their inputs.
  // visitedItems prevents re-entering an item already processed, which also
  // terminates natural production cycles (A→B→A) without needing a path set.
  // User recipe overrides restrict an item to the pinned recipe only.
  function traverse(itemId) {
    if (visitedItems.has(itemId)) return;
    visitedItems.add(itemId);
    const isRaw = forcedRawSet.has(itemId);
    graph.itemNodes.set(itemId, { isRawMaterial: isRaw });
    if (isRaw) { graph.rawMaterials.add(itemId); return; }

    const available = recipesByOutput[itemId] || [];
    if (available.length === 0) {
      graph.itemNodes.get(itemId).isRawMaterial = true;
      graph.rawMaterials.add(itemId);
      return;
    }

    const nonDismantle = available.filter(r => !isDismantleRecipe(r));
    const stage1 = nonDismantle.length > 0 ? nonDismantle : available;
    const nonDisposal = stage1.filter(r => !isDisposalOnlyRecipe(r));
    const pool = nonDisposal.length > 0 ? nonDisposal : stage1;

    // User override: restrict to the pinned recipe only (fall back to pool if invalid).
    const recipesToAdd = (recipeOverrides && recipeOverrides.has(itemId))
      ? [recipeById[recipeOverrides.get(itemId)] || pool[0]]
      : collapseMultiFormulaTwins(pool);

    for (const r of recipesToAdd) {
      if (!r) continue;
      addRecipeToGraph(r);
      recipeDependencyInputs(r).forEach(inp => traverse(inp.itemId));
    }
  }

  targetIds.forEach(id => traverse(id));

  // Step 1b - Gas environment support. Vaporizer recipes consume gas but
  // produce nothing, so target-rooted traversal can never discover them.
  // Inject one synthetic consumer for every environment used by a recipe in
  // the graph, then traverse its gas supply chain. Repeat to a fixpoint in case
  // a future gas chain introduces another environment-gated recipe.
  {
    const injectedEnvs = new Set();
    let progressed = true;
    while (progressed) {
      progressed = false;
      const wanted = new Set();
      graph.recipeNodes.forEach(recipe => {
        const env = gasEnvironmentForRecipe(recipe);
        if (env && !injectedEnvs.has(env)) wanted.add(env);
      });
      wanted.forEach(env => {
        const cfg = GAS_SUSTAIN_CONFIG.vaporizerEnvironments.get(env);
        const vaporizer = cfg && recipeById[cfg.recipeId];
        const gasInput = vaporizer?.inputs?.[0];
        if (!vaporizer || !gasInput) return;

        // Do not let traverse() promote an unavailable environment gas into a
        // free raw material. Current 1.4 gases all pass this guard.
        const suppliable = forcedRawSet.has(gasInput.itemId)
          || (recipesByOutput[gasInput.itemId] || []).length > 0;
        if (!suppliable) return;

        injectedEnvs.add(env);
        addRecipeToGraph(vaporizer);
        traverse(gasInput.itemId);
        progressed = true;
      });
    }
  }

  // Step 2 — Augmentation: add FD-byproduct recycler recipes.
  // A recycler recipe satisfies both conditions:
  //   (a) isDisposalOnlyRecipe — ALL its inputs are forced-disposal items.
  //   (b) it produces at least one item already present in the graph.
  // Condition (a) is the critical guard: without it, alternate normal
  // producers (e.g. pool_xiranite_poly_2) would be added and break the
  // LP's balance equations by creating unexpected multi-producer blends.
  let added = true;
  while (added) {
    added = false;
    const snapshot = [...graph.recipeNodes.values()];
    for (const r of snapshot) {
      for (const out of (r.outputs || [])) {
        if (!forcedDisposalSet.has(out.itemId)) continue;
        const consumers = recipesByInput[out.itemId] || [];
        for (const cons of consumers) {
          if (graph.recipeNodes.has(cons.id)) continue;
          if (isDismantleRecipe(cons)) continue;
          if (!isDisposalOnlyRecipe(cons)) continue;
          const useful = (cons.outputs || []).some(o => graph.itemNodes.has(o.itemId));
          if (!useful) continue;
          addRecipeToGraph(cons);
          recipeDependencyInputs(cons).forEach(inp => traverse(inp.itemId));
          added = true;
        }
      }
    }
  }

  // Step 3 — Cycle repair (post-DFS).
  // Compute items reachable from raw materials through current recipes.
  // Any item not yet reachable is trapped in a cycle whose inputs have no
  // raw-material entry point.  Inject a viable alternate recipe (one whose
  // every input is reachable or raw) to break the cycle.  Repeat until
  // the reachable set stabilises.
  {
    const computeReachable = () => {
      const reach = new Set(graph.rawMaterials);
      let changed = true;
      while (changed) {
        changed = false;
        graph.recipeNodes.forEach(r => {
          if (recipeDependencyInputs(r).every(i => reach.has(i.itemId))) {
            (r.outputs || []).forEach(o => {
              if (!reach.has(o.itemId)) { reach.add(o.itemId); changed = true; }
            });
          }
        });
      }
      return reach;
    };

    let reachable = computeReachable();
    let anyAdded = true;
    while (anyAdded) {
      anyAdded = false;
      graph.itemNodes.forEach((info, iid) => {
        if (info.isRawMaterial || reachable.has(iid)) return;
        const viable = (recipesByOutput[iid] || []).filter(r =>
          !isDismantleRecipe(r) &&
          !isDisposalOnlyRecipe(r) &&
          !graph.recipeNodes.has(r.id) &&
          recipeDependencyInputs(r).every(i => reachable.has(i.itemId) || forcedRawSet.has(i.itemId))
        );
        if (!viable.length) return;
        for (const r of viable) {
          addRecipeToGraph(r);
          recipeDependencyInputs(r).forEach(i => traverse(i.itemId));
        }
        anyAdded = true;
      });
      if (anyAdded) reachable = computeReachable();
    }
  }

  return graph;
}

// Graph topology depends only on target IDs and recipe overrides. Resource and
// facility limits alter bounds, never recipe reachability, so slider/toggle
// solves can safely reuse this structure. Keep a small LRU because item-search
// previews may ask for several one-target graphs over a session.
function _bipartiteGraphCacheKey(targetIds, recipeOverrides) {
  // Preserve target order: Prioritize Unsellable and deterministic recipe
  // insertion intentionally follow the production pane's ordering.
  const targets = [...new Set(targetIds || [])];
  const overrides = recipeOverrides
    ? [...recipeOverrides.entries()].sort(([a], [b]) => a.localeCompare(b))
    : [];
  return JSON.stringify([targets, overrides]);
}

function getCachedBipartiteGraph(targetIds, recipeOverrides) {
  const key = _bipartiteGraphCacheKey(targetIds, recipeOverrides);
  if (_bipartiteGraphCache.has(key)) {
    const graph = _bipartiteGraphCache.get(key);
    _bipartiteGraphCache.delete(key);
    _bipartiteGraphCache.set(key, graph);
    return graph;
  }
  const graph = buildBipartiteGraph(targetIds, recipeOverrides);
  _bipartiteGraphCache.set(key, graph);
  while (_bipartiteGraphCache.size > 32)
    _bipartiteGraphCache.delete(_bipartiteGraphCache.keys().next().value);
  return graph;
}

// Sparse coefficient indexes are immutable companions to a cached graph.
// Building them once turns the former item × recipe scans into direct walks of
// the non-zero coefficients used by balance, raw-cap and objective rows.
function getGraphModelIndex(graph) {
  const cached = _graphModelIndexCache.get(graph);
  if (cached) return cached;

  const recipeList = [...graph.recipeNodes.values()];
  const netTermsByItem = new Map();
  const inputTermsByItem = new Map();
  const drainTermsByItem = new Map();
  const itemsConsumed = new Set();
  const pushTerm = (map, itemId, ri, coefficient) => {
    if (Math.abs(coefficient) <= 1e-12) return;
    if (!map.has(itemId)) map.set(itemId, []);
    map.get(itemId).push([ri, coefficient]);
  };

  recipeList.forEach((recipe, ri) => {
    const net = new Map();
    (recipe.outputs || []).forEach(output => {
      const rate = calcRate(output.amount, recipe.craftingTime);
      net.set(output.itemId, (net.get(output.itemId) || 0) + rate);
    });
    (recipe.inputs || []).forEach(input => {
      const rate = calcRate(input.amount, recipe.craftingTime);
      net.set(input.itemId, (net.get(input.itemId) || 0) - rate);
      pushTerm(inputTermsByItem, input.itemId, ri, rate);
      itemsConsumed.add(input.itemId);
    });
    net.forEach((coefficient, itemId) => pushTerm(netTermsByItem, itemId, ri, coefficient));

    const drain = sustainDrainForRecipe(recipe);
    if (drain) {
      pushTerm(drainTermsByItem, drain.itemId, ri, drain.ratePerMinute);
      itemsConsumed.add(drain.itemId);
    }
  });

  const index = {
    recipeList,
    netTermsByItem,
    inputTermsByItem,
    drainTermsByItem,
    itemsConsumed,
  };
  _graphModelIndexCache.set(graph, index);
  return index;
}


/* ═══════════════════════════════════════════════
   § 5  FLOW ANALYSIS

   Two utility functions that derive useful summaries from a solved
   recipeFacilityCounts map (recipeId → facility count).
═══════════════════════════════════════════════ */

// computeNetRatesFromFlow: from a facility-count map, compute the net
// production rate of every item (outputs minus inputs, items/min).
// Positive net = net producer; negative net = net consumer.
// Used in Phase 6 to read LP results before writing p.rate.
function computeNetRatesFromFlow(recipeFacilityCounts, graph, recipePlacementCounts = null) {
  const net = {};
  recipeFacilityCounts.forEach((fc, rid) => {
    if (fc < 1e-9) return;
    const r = graph.recipeNodes.get(rid);
    if (!r) return;
    (r.outputs || []).forEach(o => { net[o.itemId] = (net[o.itemId] || 0) + calcRate(o.amount, r.craftingTime) * fc; });
    (r.inputs  || []).forEach(i => { net[i.itemId] = (net[i.itemId] || 0) - calcRate(i.amount, r.craftingTime) * fc; });
    const drain = sustainDrainForRecipe(r);
    if (drain)
      net[drain.itemId] = (net[drain.itemId] || 0) - drain.ratePerMinute * fc;
  });
  return net;
}

// rawAndFacilityUsage: aggregate raw material consumption (per raw item) and
// facility usage (per facility type) from a facility-count map.
// Used for the Phase 5 sanity check and the usage-bars UI.
function rawAndFacilityUsage(recipeFacilityCounts, graph, recipePlacementCounts = null) {
  const rawUse = {};
  const facUse = {};
  recipeFacilityCounts.forEach((fc, rid) => {
    if (fc < 1e-9) return;
    const r = graph.recipeNodes.get(rid);
    if (!r) return;
    (r.inputs || []).forEach(i => {
      if (forcedRawSet.has(i.itemId) || (graph.itemNodes.get(i.itemId) || {}).isRawMaterial)
        rawUse[i.itemId] = (rawUse[i.itemId] || 0) + calcRate(i.amount, r.craftingTime) * fc;
    });
    // Catalyst is PWM-able down to the fractional load; buildings are not.
    const drain = sustainDrainForRecipe(r);
    if (drain && (forcedRawSet.has(drain.itemId) || (graph.itemNodes.get(drain.itemId) || {}).isRawMaterial))
      rawUse[drain.itemId] = (rawUse[drain.itemId] || 0) + drain.ratePerMinute * fc;
    facUse[r.facilityId] = (facUse[r.facilityId] || 0)
      + (recipePlacementCounts?.get(rid) ?? (drain ? Math.ceil(fc - 1e-9) : fc));
  });
  const sources = window.RECIPES_DB?.rawMaterialSources || DEFAULT_RAW_MATERIAL_SOURCES;
  Object.entries(rawUse).forEach(([itemId, rate]) => {
    const cfg = sources[itemId];
    if (!cfg || !(cfg.ratePerMinute > 0) || !(rate > 1e-9)) return;
    facUse[cfg.facilityId] = (facUse[cfg.facilityId] || 0)
      + Math.ceil(rate / cfg.ratePerMinute - 1e-9);
  });
  return { rawUse, facUse };
}


/* ═══════════════════════════════════════════════
   § 5b  PHASE 3 — MULTI-FORMULA BUILDING PACKER

   The LP (Phase 2) optimises one variable per recipe: x_ri, the recipe's
   facility count in *slot-equivalents* (how many dedicated buildings it
   would need if it ran alone).  For single-formula facilities (cacheSlots
   = 1) that is also the physical building count.  For *multi-formula*
   facilities (cacheSlots > 1 — the mix_pool crucibles) it is NOT: one
   building can host several recipes at once, each running at one
   building-equivalent in parallel.

   packBins turns slot demands into an integer count of physical buildings
   by solving a small lex MILP over "variants" (a co-located recipe subset on
   a facility, with the rate direction that balances its internal hand-offs):

     variables : x_v ∈ ℤ≥0  (buildings of variant v)
                 u_v ∈ ℝ≥0  (active scale; logical l runs at rateDir_v[l]·u_v)
     capacity  : u_v ≤ x_v
     demand    : Σ_v rateDir_v[l]·u_v = d_l    (strict equality, per logical)
     objective : min Σ_v x_v  →  min Σ_v power(F_v)·x_v   (lex, MIP)

   Twin-aware: each crucible recipe is a "logical" hostable on either the
   5-slot Reactor or 8-slot Expanded twin.  Internal-netting: items produced
   and consumed within a variant are netted (no port) when the rate direction
   balances them, so a whole producer→consumer chain fits one Expanded building.
   Singletons are always feasible → a safe singleton-bin fallback.

   See PACKER_PIPELINE.md for the full model, worked examples, and the two
   remaining scope cuts vs. the upstream reference (3^k regime depth,
   building-unit facility caps).
═══════════════════════════════════════════════ */

// itemIsLiquid: pipe-routed (liquid) vs belt-routed (solid) classification.
function _itemIsLiquid(itemId) { return !!(itemById[itemId] && itemById[itemId].isLiquid); }

// recipeBuffers: the distinct items a recipe occupies in inner slots.
// Prefer the precomputed `buffers` list; fall back to distinct in+out items.
function _recipeBuffers(r) {
  if (Array.isArray(r.buffers) && r.buffers.length) return r.buffers;
  const s = new Set();
  (r.inputs || []).forEach(i => s.add(i.itemId));
  (r.outputs || []).forEach(o => s.add(o.itemId));
  return [...s];
}

// _ceilDemand: round a slot demand up to whole buildings, snapping values
// already integral (within LP noise) so 2.0000001 → 2, not 3.
function _ceilDemand(d) {
  const r = Math.round(d);
  return Math.abs(d - r) < 1e-6 ? r : Math.ceil(d);
}

// _itemNetCoef: per-building net production rate of an item in a recipe
// (output rate − input rate, items/min).  Sign carries the direction.
function _itemNetCoef(r, itemId) {
  let c = 0;
  (r.outputs || []).forEach(o => { if (o.itemId === itemId) c += calcRate(o.amount, r.craftingTime); });
  (r.inputs  || []).forEach(i => { if (i.itemId === itemId) c -= calcRate(i.amount, r.craftingTime); });
  return c;
}

// _classifyInternal: items produced by ≥1 recipe AND consumed by ≥1 recipe
// within the subset are "internal" — the hand-off happens inside the building,
// so it uses no external port (provided the recipes run at balancing rates,
// see _computeRateDirection).  All other items are external.
function _classifyInternal(recipes) {
  const produced = new Set(), consumed = new Set();
  recipes.forEach(r => {
    (r.outputs || []).forEach(o => produced.add(o.itemId));
    (r.inputs  || []).forEach(i => consumed.add(i.itemId));
  });
  const internal = new Set();
  produced.forEach(it => { if (consumed.has(it)) internal.add(it); });
  return internal;
}

// _computeRateDirection: the per-recipe rate ratios that zero every internal
// item's net flow — the strictly-positive null-space ray of the internal-item
// balance matrix (rows = internal items, cols = recipes; entry = net rate).
// Normalised so max component = 1 (capacity stays `u_v ≤ x_v`).  Returns the
// direction vector, or null if no strictly-positive ray exists (the subset
// cannot self-balance its internal hand-offs → not a valid co-location).
// Ported from the reference packer's null-space computation.
function _computeRateDirection(recipes, internal) {
  const n = recipes.length;
  if (n === 0) return null;
  const EPS = 1e-9;

  // One equality row per internal item: Σ_r coef[item][r]·d_r = 0.
  const rows = [];
  internal.forEach(itemId => {
    const row = new Array(n).fill(0);
    let nz = false;
    recipes.forEach((r, i) => { const c = _itemNetCoef(r, itemId); row[i] = c; if (Math.abs(c) > EPS) nz = true; });
    if (nz) rows.push(row);
  });
  if (rows.length === 0) return new Array(n).fill(1); // no internal coupling → independent

  // Reduced row-echelon form, tracking pivot columns.
  const k = rows.length;
  const m = rows.map(r => r.slice());
  const pivotCols = [];
  let row = 0, col = 0;
  while (row < k && col < n) {
    let piv = row, pivAbs = Math.abs(m[piv][col]);
    for (let r = row + 1; r < k; r++) { const v = Math.abs(m[r][col]); if (v > pivAbs) { piv = r; pivAbs = v; } }
    if (pivAbs <= EPS) { col++; continue; }
    if (piv !== row) { const t = m[row]; m[row] = m[piv]; m[piv] = t; }
    for (let r = 0; r < k; r++) {
      if (r === row) continue;
      const f = m[r][col] / m[row][col];
      if (Math.abs(f) <= EPS) continue;
      for (let c = col; c < n; c++) m[r][c] -= f * m[row][c];
    }
    pivotCols.push(col); row++; col++;
  }
  const rank = pivotCols.length;
  if (rank >= n) return null; // only the zero solution

  // Build one null-space vector: first free column = 1, back-substitute pivots.
  const isPivot = new Set(pivotCols);
  const freeCols = [];
  for (let c = 0; c < n; c++) if (!isPivot.has(c)) freeCols.push(c);
  const dir = new Array(n).fill(0);
  dir[freeCols[0]] = 1;
  for (let r = 0; r < rank; r++) {
    const pc = pivotCols[r];
    let sum = 0;
    freeCols.forEach(fc => { sum += m[r][fc] * dir[fc]; });
    dir[pc] = -sum / m[r][pc];
  }

  // Strictly-positive ray required.  Flip an all-negative ray; reject mixed.
  let hasPos = false, hasNeg = false;
  dir.forEach(v => { if (v > EPS) hasPos = true; else if (v < -EPS) hasNeg = true; });
  if (hasPos && hasNeg) return null;
  if (hasNeg) for (let i = 0; i < n; i++) dir[i] = -dir[i];
  const mx = Math.max(...dir.map(v => Math.abs(v)));
  if (mx <= EPS) return null;
  return dir.map(v => Math.abs(v) <= EPS ? 0 : v / mx);
}

// _variantPortsAndSlots: external port demand of a co-located subset running at
// `rateDirection`.  An item's net flow (Σ rateDirection·(out−in)) decides its
// port: net ≈ 0 → fully internal, no port; net > 0 → one out-port; net < 0 →
// one in-port; by medium (liquid → pipe).  No `internal` set needed — items
// balanced by the rate direction simply net to zero.
function _variantPortsAndSlots(recipes, rateDirection) {
  const slots = new Set();
  const net = new Map(); // itemId → net rate under rateDirection
  recipes.forEach((r, i) => {
    const d = rateDirection[i];
    _recipeBuffers(r).forEach(b => slots.add(b));
    (r.outputs || []).forEach(o => net.set(o.itemId, (net.get(o.itemId) || 0) + calcRate(o.amount, r.craftingTime) * d));
    (r.inputs  || []).forEach(inp => net.set(inp.itemId, (net.get(inp.itemId) || 0) - calcRate(inp.amount, r.craftingTime) * d));
  });
  let beltIn = 0, pipeIn = 0, beltOut = 0, pipeOut = 0;
  net.forEach((v, itemId) => {
    if (v > 1e-9) { if (_itemIsLiquid(itemId)) pipeOut++; else beltOut++; }
    else if (v < -1e-9) { if (_itemIsLiquid(itemId)) pipeIn++; else beltIn++; }
  });
  return { slots: slots.size, beltIn, pipeIn, beltOut, pipeOut };
}

// enumerateVariants: every cap-feasible co-located subset of `recipes` on
// `facility`, each paired with one or more rate directions.
//
// Two kinds of direction per subset:
//   • Demand-aligned: the direction proportional to each recipe's slot demand
//     (`demandOf`).  This is the direction the LP actually wants, so a single
//     building of this variant can cover the subset's exact demand — it's what
//     lets the recycler-fed crucible chain (demand 0.8,0.8,0.5 → dir 1,1,0.625)
//     sit in ONE Expanded instead of spilling onto a second crucible.
//   • Balancing regimes: enumerate which "borderline" items (produced AND
//     consumed inside the subset) to net to zero; the rest stay external,
//     handled by net-flow ports.  These give the densest co-locations.
//
// Crucibles do not cap how many distinct fluids are piped IN (multiple input
// pipes feed the shared cache), so `portsFit` checks only the OUTPUT ports
// (pipe-out/belt-out) and solid belt-in — NOT pipe-in.
//
// Slot usage is monotone in subset size → prune on it; port feasibility is NOT
// monotone, so check it per-subset but keep extending regardless.
function enumerateVariants(recipes, facility, demandOf) {
  const variants = [];
  const n = recipes.length;
  const slotCap = facility.cacheSlots ?? 1;
  const portsFit = ps =>
    ps.beltIn  <= (facility.beltInPorts  ?? Infinity) &&
    ps.beltOut <= (facility.beltOutPorts ?? Infinity) &&
    ps.pipeOut <= (facility.pipeOutPorts ?? Infinity);
  (function rec(start, current) {
    for (let i = start; i < n; i++) {
      const next = current.concat([recipes[i]]);
      const slotSet = new Set();
      next.forEach(r => _recipeBuffers(r).forEach(b => slotSet.add(b)));
      if (slotSet.size > slotCap) continue; // slots monotone → safe to prune branch

      const seen = new Set();
      // addDir: dedup + port-check + keep.  A zero-rate entry means that recipe
      // doesn't run in this variant (a degenerate ray); drop it as it's
      // redundant with the smaller subset and renders as a phantom 0/min bin.
      const addDir = dir => {
        if (!dir || dir.some(d => Math.abs(d) < 1e-9)) return;
        const key = dir.map(d => d.toFixed(6)).join(',');
        if (seen.has(key)) return;
        seen.add(key);
        if (portsFit(_variantPortsAndSlots(next, dir)))
          variants.push({ recipes: next.slice(), rateDirection: dir });
      };

      // Two directions per subset (keeping the MILP small enough to re-solve
      // every slider frame — the full 2^b regime sweep blew up to thousands of
      // integer vars and multi-second solves):
      //   1. Demand-aligned — runs the subset at the LP's demand ratio; the
      //      single building that covers the subset's exact demand.
      //   2. Fully-balanced — net every internal hand-off (densest ports), a
      //      fallback when the demand-aligned direction overruns an output port.
      if (demandOf) {
        const dem = next.map(r => demandOf(r));
        const maxD = Math.max(...dem);
        if (maxD > 1e-12) addDir(dem.map(d => d / maxD));
      }
      addDir(_computeRateDirection(next, _classifyInternal(next)));
      rec(i + 1, next);
    }
  })(0, []);
  return variants;
}

// _recipeSignature: facility-independent I/O fingerprint.  Two recipes with
// the same signature are interchangeable "twins" — identical inputs, outputs
// and crafting time, differing only in which facility hosts them (e.g.
// pool_liquid_copper_1 on mix_pool_1 vs _2 on mix_pool_2).  Excludes id and
// facilityId so twins collapse to one logical recipe for packing.
function _recipeSignature(r) {
  const ins  = (r.inputs  || []).map(i => `${i.itemId}:${i.amount}`).sort().join(',');
  const outs = (r.outputs || []).map(o => `${o.itemId}:${o.amount}`).sort().join(',');
  return `IN[${ins}]OUT[${outs}]ct=${r.craftingTime}`;
}

// Pick the item/rate represented by a facility-bar segment. Producers display
// their first output; pure consumers (vaporizer/disposal recipes) display their
// first input instead. Keeping this in the solver pipeline lets both the packer
// and the DOM renderer use identical semantics for zero-output recipes.
function _recipeDisplayFlow(recipe, active = 1) {
  if (!recipe) return { itemId: null, rate: 0, direction: 'output' };
  const output = (recipe.outputs || [])[0];
  const flow = output || (recipe.inputs || [])[0];
  return {
    itemId: flow?.itemId || null,
    rate: flow ? calcRate(flow.amount, recipe.craftingTime) * active : 0,
    direction: output ? 'output' : 'input',
  };
}

// _buildTwinPools: signature → Map<facilityId, recipeId> over every
// multi-formula recipe in the database.  Lets the packer host a logical recipe
// on whichever twin facility (Reactor 5-slot vs Expanded 8-slot crucible)
// minimises total buildings, independent of which twin the LP happened to pick.
// Built once — recipe data is static at runtime.
let _twinPoolCache = null;
function _buildTwinPools() {
  if (_twinPoolCache) return _twinPoolCache;
  const map = new Map();
  Object.values(recipeById).forEach(r => {
    const fac = facilityTypeById[r.facilityId];
    if (!fac || (fac.cacheSlots ?? 1) <= 1) return;  // multi-formula only
    const sig = _recipeSignature(r);
    if (!map.has(sig)) map.set(sig, new Map());
    map.get(sig).set(r.facilityId, r.id);
  });
  _twinPoolCache = map;
  return map;
}

// packMultiFormula: twin-aware MILP over ALL multi-formula active recipes.
//
// Recipes are first collapsed into "logical recipes" by I/O signature, summing
// demand across active twins.  Each logical may be hosted on any twin facility.
// A "variant" is (facility F, co-located recipe subset, rateDirection) —
// enumerated with F's own cacheSlots/ports.  Internal hand-offs are netted
// (no port) provided the recipes run at the balancing `rateDirection`, so an
// 8-slot Expanded crucible can host a whole producer→consumer chain a 5-slot
// Reactor can't.  The MILP picks integer building counts per variant:
//
//   x_v ∈ ℤ≥0  buildings of variant v        u_v ∈ ℝ≥0  active scale
//   capacity : u_v ≤ x_v
//   demand   : Σ_v rateDirection_v[l]·u_v = demand_logical   (strict equality)
//   lex      : min Σ x_v (buildings) → min Σ power(F_v)·x_v (power)
//
// The building pass enables the densest packing (favours roomy Expanded); the
// power pass then shifts work onto cheaper Reactor crucibles wherever it does
// not cost an extra building — reproducing the reference's Reactor/Expanded
// split.  Emits results through `sink` (addBin/addBuildings/addLoad/addSeg).
function packMultiFormula(items, solveFn, sink) {
  // 1. Collapse active recipes into logical recipes by signature.
  const twinPools = _buildTwinPools();
  const bySig = new Map();
  items.forEach(({ recipe, demand }) => {
    const sig = _recipeSignature(recipe);
    const hosts = twinPools.get(sig) || new Map([[recipe.facilityId, recipe.id]]);
    if (!bySig.has(sig)) bySig.set(sig, { demand: 0, hosts, rep: recipe });
    bySig.get(sig).demand += demand;
  });
  const logicals = [...bySig.values()];
  const logIndex = new Map(logicals.map((l, i) => [l, i]));
  const repToLogical = new Map(logicals.map(l => [l.rep, l]));

  // 2. Enumerate variants per host facility (subset + balancing rateDirection),
  //    aligning rateDirection to the variant's logicals.  Guarantee singletons.
  const facilities = new Set();
  logicals.forEach(l => l.hosts.forEach((_, fid) => facilities.add(fid)));
  const variants = [];
  facilities.forEach(fid => {
    const fac = facilityTypeById[fid];
    const reps = logicals.filter(l => l.hosts.has(fid)).map(l => l.rep);
    const demandOf = r => { const l = repToLogical.get(r); return l ? l.demand : 0; };
    enumerateVariants(reps, fac, demandOf).forEach(variant =>
      variants.push({
        facilityId: fid, power: fac.power ?? 0,
        logicals: variant.recipes.map(r => repToLogical.get(r)),
        rateDirection: variant.rateDirection,
      }));
  });
  logicals.forEach(l => {
    const hasSingleton = variants.some(v => v.logicals.length === 1 && v.logicals[0] === l);
    if (!hasSingleton) variants.push({ facilityId: l.rep.facilityId, power: facilityTypeById[l.rep.facilityId]?.power ?? 0, logicals: [l], rateDirection: [1] });
  });

  // 3. Build the MILP.  Objective is a single weighted "obj" = buildings +
  //    ε·power per building: integer building counts dominate (ε·max_power ≪ 1),
  //    power only breaks ties — same result as a lex buildings→power pass but in
  //    ONE solve instead of two (matters on every slider frame).
  const POW_TIEBREAK = 1e-4;
  const constraints = {};
  const variables = {};
  const generals = [];
  logicals.forEach((l, li) => { constraints[`dem_${li}`] = { equal: l.demand }; });
  variants.forEach((v, vi) => {
    const x = `x_${vi}`, u = `u_${vi}`, cap = `cap_${vi}`;
    generals.push(x);
    constraints[cap] = { max: 0 };                       // u_v − x_v ≤ 0
    variables[x] = { [cap]: -1, obj: 1 + POW_TIEBREAK * v.power };
    variables[u] = { [cap]: 1 };
    v.logicals.forEach((l, k) => { const li = logIndex.get(l); variables[u][`dem_${li}`] = (variables[u][`dem_${li}`] || 0) + v.rateDirection[k]; });
  });

  // 4. Solve: minimise buildings (power as tiebreak).  Under a time limit HiGHS
  //    returns its best integer incumbent, which for a packing model is found
  //    quickly — the remaining time would only prove optimality.
  let res = null;
  try {
    const options = {};
    if (_packMipGap > 0) options.mip_rel_gap = _packMipGap;
    if (_packTimeLimit > 0) options.time_limit = _packTimeLimit;
    res = solveFn({ optimize: 'obj', opType: 'min', constraints, variables, generals, options: Object.keys(options).length ? options : undefined });
  } catch (e) { sink.warnings.push(`packMultiFormula: solver error: ${e}`); }

  // 5. Fallback: one singleton building-stack per logical on its rep facility.
  if (!res || !res.feasible) {
    logicals.forEach(l => {
      const fid = l.rep.facilityId, b = _ceilDemand(l.demand);
      sink.emit(fid, [{ logical: l, active: l.demand }], b);
    });
    sink.warnings.push('packMultiFormula: MILP infeasible — used singleton fallback');
    return;
  }

  // Debug: set window._DEBUG_PACK=true in the console, then re-solve, to dump
  // the per-recipe slot demands the packer received and the variants it chose.
  if (typeof window !== 'undefined' && window._DEBUG_PACK) {
    console.group('[pack debug] multi-formula');
    console.log('logical demands:', logicals.map(l => ({ recipe: l.rep.id, demand: +l.demand.toFixed(4), hosts: [...l.hosts.keys()] })));
    const chosen = [];
    variants.forEach((v, vi) => {
      const x = Math.round(res[`x_${vi}`] || 0), u = res[`u_${vi}`] || 0;
      if (x > 0 && u > 1e-9) chosen.push({ fac: v.facilityId, buildings: x, u: +u.toFixed(4), dir: v.rateDirection.map(d => +d.toFixed(3)), recipes: v.logicals.map(l => l.rep.id) });
    });
    console.log('chosen variants:', chosen);
    const perFac = {};
    chosen.forEach(c => { perFac[c.fac] = (perFac[c.fac] || 0) + c.buildings; });
    console.log('buildings per facility:', perFac);
    console.groupEnd();
  }

  // 6. Emit a bin per active variant.  Recipe l's active rate in variant v is
  //    rateDirection_v[l] · u_v (building-equivalents).
  variants.forEach((v, vi) => {
    const raw = res[`x_${vi}`];
    const bc = (typeof raw === 'number' && raw > 1e-6) ? Math.round(raw) : 0;
    if (bc <= 0) return;
    const u = res[`u_${vi}`] || 0;
    if (u < 1e-9) return;
    sink.emit(v.facilityId, v.logicals.map((l, k) => ({ logical: l, active: v.rateDirection[k] * u })), bc);
  });
}

// Fast deterministic multi-formula packer.
//
// The exact variant MIP above is useful as a reference, but its subset search
// is exponential and its integer solve can consume seconds on reactor-heavy
// plans. This path keeps the useful behaviours (shared bins, twin facilities,
// building-count first and power second) with bounded work:
//   - compare demand-aligned, equal-layer and internally-balanced allocations;
//   - keep only a small beam of the best groups at each group size;
//   - allocate the best saving, subtract it, and repeat.
//
// As requested for this calculator, liquid input count is NOT constrained.
// `_fastPackingOption` checks cache slots, belt input and output ports only.
function _fastPackingOption(logicals, actives) {
  if (!logicals.length || logicals.length !== actives.length) return null;
  const maxActive = Math.max(...actives);
  if (!(maxActive > 1e-9)) return null;

  let commonHosts = null;
  logicals.forEach(logical => {
    const ids = new Set(logical.hosts.keys());
    commonHosts = commonHosts == null
      ? ids
      : new Set([...commonHosts].filter(fid => ids.has(fid)));
  });
  if (!commonHosts?.size) return null;

  const rateDirection = actives.map(value => value / maxActive);
  let best = null;
  [...commonHosts].sort().forEach(facilityId => {
    const facility = facilityTypeById[facilityId];
    if (!facility) return;
    const recipes = logicals.map(logical =>
      recipeById[logical.hosts.get(facilityId)] || logical.rep);
    const ports = _variantPortsAndSlots(recipes, rateDirection);
    const fits = ports.slots <= (facility.cacheSlots ?? 1)
      && ports.beltIn <= (facility.beltInPorts ?? Infinity)
      && ports.beltOut <= (facility.beltOutPorts ?? Infinity)
      && ports.pipeOut <= (facility.pipeOutPorts ?? Infinity);
    if (!fits) return;
    const buildingCount = _ceilDemand(maxActive);
    const option = {
      facilityId,
      buildingCount,
      powerCost: buildingCount * (facility.power || 0),
    };
    if (!best
      || option.buildingCount < best.buildingCount
      || (option.buildingCount === best.buildingCount && option.powerCost < best.powerCost)
      || (option.buildingCount === best.buildingCount && option.powerCost === best.powerCost
        && option.facilityId < best.facilityId)) best = option;
  });
  return best;
}

function _fastSingletonOption(logical, active) {
  const option = _fastPackingOption([logical], [active]);
  if (option) return option;
  // Defensive fallback for malformed recipe metadata: match the former exact
  // packer's singleton fallback rather than dropping facility usage.
  const facilityId = logical.rep.facilityId;
  const buildingCount = _ceilDemand(active);
  return {
    facilityId,
    buildingCount,
    powerCost: buildingCount * (facilityTypeById[facilityId]?.power || 0),
  };
}

function _compareFastCandidates(a, b) {
  if (a.buildingSaving !== b.buildingSaving)
    return b.buildingSaving - a.buildingSaving;
  if (Math.abs(a.powerSaving - b.powerSaving) > 1e-9)
    return b.powerSaving - a.powerSaving;
  if (Math.abs(a.allocatedTotal - b.allocatedTotal) > 1e-9)
    return b.allocatedTotal - a.allocatedTotal;
  if (a.logicals.length !== b.logicals.length)
    return b.logicals.length - a.logicals.length;
  const ak = a.logicals.map(l => l.rep.id).sort().join('|');
  const bk = b.logicals.map(l => l.rep.id).sort().join('|');
  return ak.localeCompare(bk);
}

function _fastCandidateForGroup(logicals, remaining) {
  if (logicals.length < 2) return null;
  const demands = logicals.map(logical => remaining.get(logical) || 0);
  if (demands.some(value => !(value > 1e-9))) return null;
  const patterns = [];
  const seen = new Set();
  const addPattern = values => {
    if (!values || values.some(value => !(value > 1e-9))) return;
    const key = values.map(value => value.toFixed(7)).join(',');
    if (seen.has(key)) return;
    seen.add(key);
    patterns.push(values);
  };

  // Cover each remaining demand in one shared stack when the ports fit.
  addPattern(demands.slice());

  // Equal layers are important for power: e.g. demands [3, 3.1] can run three
  // shared Expanded buildings and leave the 0.1 tail for a cheaper Reactor.
  const common = Math.min(...demands);
  addPattern(new Array(logicals.length).fill(common));
  const wholeCommon = Math.floor(common + 1e-9);
  if (wholeCommon >= 1 && wholeCommon < common - 1e-7)
    addPattern(new Array(logicals.length).fill(wholeCommon));

  // Balanced internal hand-offs reproduce the useful dense-chain cases from
  // the reference packer without enumerating all internal/external regimes.
  const reps = logicals.map(logical => logical.rep);
  const direction = _computeRateDirection(reps, _classifyInternal(reps));
  if (direction?.every(value => value > 1e-9)) {
    const scale = Math.min(...direction.map((value, i) => demands[i] / value));
    addPattern(direction.map(value => value * scale));
    const wholeScale = Math.floor(scale + 1e-9);
    if (wholeScale >= 1 && wholeScale < scale - 1e-7)
      addPattern(direction.map(value => value * wholeScale));
  }

  let best = null;
  patterns.forEach(actives => {
    const option = _fastPackingOption(logicals, actives);
    if (!option) return;
    let singletonBuildings = 0;
    let singletonPower = 0;
    logicals.forEach((logical, i) => {
      const singleton = _fastSingletonOption(logical, actives[i]);
      singletonBuildings += singleton.buildingCount;
      singletonPower += singleton.powerCost;
    });
    const candidate = {
      logicals,
      actives,
      option,
      buildingSaving: singletonBuildings - option.buildingCount,
      powerSaving: singletonPower - option.powerCost,
      allocatedTotal: actives.reduce((sum, value) => sum + value, 0),
    };
    if (candidate.buildingSaving < 0) return;
    if (candidate.buildingSaving === 0 && candidate.powerSaving <= 1e-9) return;
    if (!best || _compareFastCandidates(candidate, best) < 0) best = candidate;
  });
  return best;
}

function _enumerateFastPackingCandidates(activeLogicals, remaining) {
  const candidates = [];
  const BEAM_WIDTH = 96;
  const MAX_GROUP_SIZE = Math.min(8, activeLogicals.length);
  let frontier = activeLogicals.map((_, index) => ({ indices: [index], candidate: null }));

  for (let size = 2; size <= MAX_GROUP_SIZE && frontier.length; size++) {
    const nextByKey = new Map();
    frontier.forEach(entry => {
      const last = entry.indices[entry.indices.length - 1];
      for (let next = last + 1; next < activeLogicals.length; next++) {
        const indices = entry.indices.concat(next);
        const logicals = indices.map(index => activeLogicals[index]);
        const candidate = _fastCandidateForGroup(logicals, remaining);
        if (!candidate) continue;
        const key = indices.join(',');
        nextByKey.set(key, { indices, candidate });
        candidates.push(candidate);
      }
    });
    frontier = [...nextByKey.values()]
      .sort((a, b) => _compareFastCandidates(a.candidate, b.candidate))
      .slice(0, BEAM_WIDTH);
  }
  return candidates;
}

function packMultiFormulaFast(items, sink) {
  const twinPools = _buildTwinPools();
  const bySignature = new Map();
  items.forEach(({ recipe, demand }) => {
    const signature = _recipeSignature(recipe);
    const hosts = twinPools.get(signature) || new Map([[recipe.facilityId, recipe.id]]);
    if (!bySignature.has(signature))
      bySignature.set(signature, { demand: 0, hosts, rep: recipe });
    bySignature.get(signature).demand += demand;
  });

  const logicals = [...bySignature.values()]
    .filter(logical => logical.demand > 1e-9)
    .sort((a, b) => a.rep.id.localeCompare(b.rep.id));
  const remaining = new Map(logicals.map(logical => [logical, logical.demand]));
  const safetyLimit = logicals.length * 3 + 8;
  let iterations = 0;

  while (iterations++ < safetyLimit) {
    const active = logicals.filter(logical => (remaining.get(logical) || 0) > 1e-9);
    if (active.length < 2) break;
    const candidates = _enumerateFastPackingCandidates(active, remaining);
    if (!candidates.length) break;
    candidates.sort(_compareFastCandidates);
    const chosen = candidates[0];
    sink.emit(
      chosen.option.facilityId,
      chosen.logicals.map((logical, i) => ({ logical, active: chosen.actives[i] })),
      chosen.option.buildingCount,
    );
    chosen.logicals.forEach((logical, i) => {
      const next = Math.max(0, (remaining.get(logical) || 0) - chosen.actives[i]);
      remaining.set(logical, next < 1e-8 ? 0 : next);
    });
  }

  // Anything not profitably shareable is emitted as a singleton stack on its
  // lowest-power compatible twin.
  logicals.forEach(logical => {
    const active = remaining.get(logical) || 0;
    if (!(active > 1e-9)) return;
    const option = _fastSingletonOption(logical, active);
    sink.emit(option.facilityId, [{ logical, active }], option.buildingCount);
  });
  if (iterations >= safetyLimit)
    sink.warnings.push('packMultiFormulaFast: safety limit reached; remaining demand used singleton bins');
}

// packBins: Phase 3 entry point.  Resolves the LP's per-recipe slot demands
// into integer PHYSICAL buildings for every facility:
//   • single-formula (cacheSlots ≤ 1) — one recipe per building, ⌈demand⌉ each.
//   • multi-formula (the crucibles)   — bounded deterministic greedy packing,
//     co-locating recipes and choosing the Reactor/Expanded split.
//
// solveFn is injectable (defaults to the HiGHS adapter) so the combinatorial
// core is unit-testable without the WASM solver.
//
// `lite` remains in the signature for callers, but the bounded packer is cheap
// enough to run live so reactor counts no longer freeze or lag behind a drag.
//
// Returns:
//   facilityBuildings : Map<facilityId, number>          integer buildings
//   facilityLoad      : Map<facilityId, number>          slot-units (for cap bar)
//   facilitySegments  : Map<facilityId, [{itemId,contrib,rate,direction}]>
//                       bar segments (zero-output recipes show their input)
//   bins              : [{ facilityId, recipeIds[], buildingCount, active: Map }]
//   recipeAlloc       : Map<recipeId, binIndex[]>
//   warnings          : string[]
function packBins(recipeFacilityCounts, graph, solveFn = solveLP, lite = false) {
  const facilityBuildings = new Map();
  const facilityLoad = new Map();
  const facilitySegments = new Map();
  const bins = [];
  const recipeAlloc = new Map();
  const warnings = [];

  const addBin = (facilityId, recipeIds, buildingCount, active) => {
    const bi = bins.length;
    bins.push({ facilityId, recipeIds: recipeIds.slice().sort(), buildingCount, active });
    recipeIds.forEach(id => {
      if (!recipeAlloc.has(id)) recipeAlloc.set(id, []);
      recipeAlloc.get(id).push(bi);
    });
    return bi;
  };
  const addBuildings = (fid, n) => facilityBuildings.set(fid, (facilityBuildings.get(fid) || 0) + n);
  const addLoad = (fid, amt) => facilityLoad.set(fid, (facilityLoad.get(fid) || 0) + amt);
  const addSeg = (fid, itemId, contrib, rate, direction = 'output') => {
    if (!facilitySegments.has(fid)) facilitySegments.set(fid, []);
    facilitySegments.get(fid).push({ itemId, contrib, rate, direction });
  };

  // sink.emit: record one variant/bin's contribution across all bookkeeping.
  // `logicalActives` is [{logical, active}] — each logical (a {rep,hosts} group)
  // mapped to this facility's own recipe id, with its active rate in
  // building-equivalents (rateDirection·u).
  const sink = {
    warnings,
    emit(fid, logicalActives, buildingCount) {
      addBuildings(fid, buildingCount);
      const recipeIds = [];
      const active = new Map();
      logicalActives.forEach(({ logical, active: a }) => {
        const rid = logical.hosts.get(fid) || logical.rep.id;
        recipeIds.push(rid);
        active.set(rid, a);
        addLoad(fid, a);
        const display = _recipeDisplayFlow(logical.rep, a);
        addSeg(fid, display.itemId, a, display.rate, display.direction);
      });
      addBin(fid, recipeIds, buildingCount, active);
    },
  };

  // Group active recipes (count > 0) by facility.
  const byFacility = new Map();
  recipeFacilityCounts.forEach((count, rid) => {
    if (!(count > 1e-9)) return;
    const r = (graph && graph.recipeNodes.get(rid)) || recipeById[rid];
    if (!r) return;
    if (!byFacility.has(r.facilityId)) byFacility.set(r.facilityId, []);
    byFacility.get(r.facilityId).push({ recipe: r, demand: count });
  });

  // Single-formula building count depends on the facility's time-share flag
  // (the repurposed `integerOnly` flag on its facilityLimit):
  //   • off (default) — one recipe per unit: Σ_r ⌈demand_r⌉ (dedicated buildings).
  //   • on            — time-sharing: ⌈Σ_r demand_r⌉ (one unit runs several
  //                     recipes by time-slicing, so a 9.84 + 2.16 split is 12
  //                     units, not 13).
  // Multi-formula facilities (crucibles) co-locate via the twin-aware packer
  // and ignore the flag.
  const timeShare = fid => {
    if (typeof facilityLimits === 'undefined') return false;
    const f = facilityLimits.find(x => x.gameFacilityId === fid);
    return !!(f && f.integerOnly);
  };
  const addSingleBin = (fid, recipe, demand) => {
    addLoad(fid, demand);
    const display = _recipeDisplayFlow(recipe, demand);
    addSeg(fid, display.itemId, demand, display.rate, display.direction);
  };
  const multiFormula = [];
  byFacility.forEach((list, fid) => {
    const cacheSlots = facilityTypeById[fid]?.cacheSlots ?? 1;
    if (cacheSlots > 1) { list.forEach(x => multiFormula.push(x)); return; }
    if (timeShare(fid)) {
      const total = list.reduce((s, x) => s + x.demand, 0);
      const b = _ceilDemand(total);
      addBuildings(fid, b);
      const active = new Map();
      list.forEach(({ recipe, demand }) => { addSingleBin(fid, recipe, demand); active.set(recipe.id, demand); });
      addBin(fid, list.map(x => x.recipe.id), b, active);
    } else {
      list.forEach(({ recipe, demand }) => {
        const b = _ceilDemand(demand);
        addBuildings(fid, b);
        addSingleBin(fid, recipe, demand);
        addBin(fid, [recipe.id], b, new Map([[recipe.id, demand]]));
      });
    }
  });
  if (multiFormula.length) {
    packMultiFormulaFast(multiFormula, sink);
  }

  return { facilityBuildings, facilityLoad, facilitySegments, bins, recipeAlloc, warnings };
}


/* ================================================================
   § 5c  CANONICAL PLAN AGGREGATES

   One pass produces every figure shown by the Resource & Facility Usage
   panel. Keeping flows, source pickups, packed buildings, and power in one
   object prevents the graphs from drifting apart. A drag frame calls the
   bounded packer exactly once, so Crucible placement remains live.

   `ceilMode=false` follows the beta calculator's theoretical view: a bin is
   the mean activity of the recipes sharing it. `ceilMode=true` uses the whole
   physical building count. Source pickups follow the same fractional/ceiled
   rule. Reactor/Expanded port-type limits are deliberately absent — this
   function consumes this project's unrestricted packBins output as-is.
================================================================ */

function buildPlanAggregates(
  recipeFacilityCounts,
  graph,
  recipePlacementCounts = null,
  options = {},
) {
  const {
    getScale = () => 1,
    ceilMode = false,
    lite = false,
    metastorageImport = null,
    batteries = [],
  } = options;
  const generated = {};
  const consumed = {};
  const imported = {};
  const rawUse = {};
  const scaledCounts = new Map();
  const add = (obj, key, value) => {
    if (!key || !(value > 1e-12)) return;
    obj[key] = (obj[key] || 0) + value;
  };

  recipeFacilityCounts?.forEach((fc, rid) => {
    if (!(fc > 1e-9)) return;
    const recipe = graph?.recipeNodes.get(rid) || recipeById?.[rid];
    if (!recipe) return;
    const scale = Number(getScale(recipe)) || 0;
    const active = fc * Math.max(0, scale);
    if (!(active > 1e-9)) return;
    scaledCounts.set(rid, active);
    (recipe.outputs || []).forEach(output => {
      add(generated, output.itemId, calcRate(output.amount, recipe.craftingTime) * active);
    });
    (recipe.inputs || []).forEach(input => {
      const rate = calcRate(input.amount, recipe.craftingTime) * active;
      add(consumed, input.itemId, rate);
      const node = graph?.itemNodes.get(input.itemId);
      if (forcedRawSet.has(input.itemId) || node?.isRawMaterial) add(rawUse, input.itemId, rate);
    });

    // Transmuter catalyst drain follows fractional activity, not placements:
    // a partially-loaded bank can be pulse-width modulated or batched down to
    // exactly the catalyst its load needs.
    const drain = sustainDrainForRecipe(recipe);
    if (drain) {
      const rate = drain.ratePerMinute * active;
      add(consumed, drain.itemId, rate);
      const node = graph?.itemNodes.get(drain.itemId);
      if (forcedRawSet.has(drain.itemId) || node?.isRawMaterial) add(rawUse, drain.itemId, rate);
    }
  });

  if (metastorageImport?.itemId && metastorageImport.ratePerMinute > 1e-9) {
    add(imported, metastorageImport.itemId, metastorageImport.ratePerMinute);
    add(generated, metastorageImport.itemId, metastorageImport.ratePerMinute);
  }

  let packed = {
    facilityBuildings: new Map(), facilityLoad: new Map(),
    facilitySegments: new Map(), bins: [], recipeAlloc: new Map(), warnings: [],
  };
  if (scaledCounts.size) {
    const started = performance.now();
    try {
      packed = packBins(scaledCounts, graph, solveLP, lite);
    } finally {
      _lastPackMs = performance.now() - started;
    }
  } else {
    _lastPackMs = 0;
  }

  const facilityLoad = new Map(packed.facilityLoad);
  const facilityPhysical = new Map(packed.facilityBuildings);
  const facilityEffective = new Map();
  const facilitySegments = new Map(packed.facilitySegments);
  const binsByFacility = new Map();
  const addMap = (map, key, value) => map.set(key, (map.get(key) || 0) + value);

  for (const bin of packed.bins) {
    if (!binsByFacility.has(bin.facilityId)) binsByFacility.set(bin.facilityId, []);
    binsByFacility.get(bin.facilityId).push(bin);
    const activities = bin.active instanceof Map ? [...bin.active.values()] : [];
    const recipeCount = Math.max(1, activities.length || bin.recipeIds?.length || 1);
    const activitySum = activities.length
      ? activities.reduce((sum, value) => sum + value, 0)
      : bin.buildingCount;
    const effective = ceilMode ? bin.buildingCount : activitySum / recipeCount;
    addMap(facilityEffective, bin.facilityId, effective);
  }

  const rawSources = window.RECIPES_DB?.rawMaterialSources || DEFAULT_RAW_MATERIAL_SOURCES;
  Object.entries(rawUse).forEach(([itemId, demand]) => {
    const source = rawSources[itemId];
    if (!source || !(source.ratePerMinute > 0) || !(demand > 1e-9)) return;
    const fid = source.facilityId;
    const fractional = demand / source.ratePerMinute;
    const physical = Math.ceil(fractional - 1e-9);
    const effective = ceilMode ? physical : fractional;
    addMap(facilityLoad, fid, fractional);
    addMap(facilityPhysical, fid, physical);
    addMap(facilityEffective, fid, effective);
    if (!facilitySegments.has(fid)) facilitySegments.set(fid, []);
    facilitySegments.get(fid).push({
      itemId, contrib: fractional, rate: demand, direction: 'source',
    });
  });

  // Existing battery rows are actual Thermal Bank fuel rates. Count their
  // banks and sustained generation using the same constants as the beta.
  const powerFuels = window.RECIPES_DB?.powerFuels || DEFAULT_POWER_FUELS;
  let totalPowerGeneration = 0;
  batteries.forEach(entry => {
    const fuel = powerFuels[entry.matId];
    const rate = Math.max(0, Number(entry.rate) || 0);
    if (!fuel || !(rate > 1e-9) || !(fuel.fuelPerMinutePerBank > 0)) return;
    const banks = rate / fuel.fuelPerMinutePerBank;
    const physical = Math.ceil(banks - 1e-9);
    addMap(facilityLoad, 'power_station_1', banks);
    addMap(facilityPhysical, 'power_station_1', physical);
    addMap(facilityEffective, 'power_station_1', ceilMode ? physical : banks);
    if (!facilitySegments.has('power_station_1')) facilitySegments.set('power_station_1', []);
    facilitySegments.get('power_station_1').push({
      itemId: entry.matId, contrib: banks, rate, direction: 'power',
    });
    totalPowerGeneration += banks * fuel.powerGeneration;
  });

  let totalFacilities = 0;
  let totalPowerConsumption = 0;
  facilityEffective.forEach((count, fid) => {
    totalFacilities += count;
    totalPowerConsumption += count * (facilityTypeById?.[fid]?.power || 0);
  });

  const resourceFlows = {};
  const resourceIds = new Set([
    ...Object.keys(generated), ...Object.keys(consumed), ...Object.keys(imported),
  ]);
  resourceIds.forEach(itemId => {
    const production = generated[itemId] || 0;
    const consumption = consumed[itemId] || 0;
    const importRate = imported[itemId] || 0;
    resourceFlows[itemId] = {
      generated: production,
      localGenerated: Math.max(0, production - importRate),
      consumed: consumption,
      imported: importRate,
      net: production - consumption,
      raw: rawUse[itemId] || 0,
    };
  });

  return {
    scaledCounts,
    rawUse,
    resourceFlows,
    facilityLoad,
    facilityPhysical,
    facilityEffective,
    facilitySegments,
    binsByFacility,
    packed,
    totalFacilities,
    totalPowerConsumption,
    totalPowerGeneration,
    netPower: totalPowerGeneration - totalPowerConsumption,
    metastorageImport,
  };
}


/* ═══════════════════════════════════════════════
   § 6  SOLVER STATE

   Variables shared between runSolver, computeSummary (in
   endfield_calculator.js), and the usage-bar renderer.
═══════════════════════════════════════════════ */

// Last solved graph and facility counts — stored so computeSummary can
// render usage bars without re-solving (used on every slider drag).
let _lastGraph = null;
let _lastFacilityCounts = null;
let _lastPlacementCounts = null; // whole placements for gas sustain recipes
let _lastSolvedRates = null; // production rates at the time of the last LP solve
let _lastPackMs = 0;         // wall time of the most recent packBins call (for the log)
let _lastPlanAggregates = null; // shared resource/facility/power render model
let _lastMetastorageImport = null; // winning settled/drag import and actual rate
let _lastMetastorageItem = null;   // candidate reused on the drag fast path
let _lastMetastorageMs = 0;
// Legacy exact-packer tuning. The runtime path uses packMultiFormulaFast and
// does not read these; retained only for manual comparison with packMultiFormula.
let _packTimeLimit = 0;
let _packMipGap = 0;
// True while a solve is an in-place slider drag; passed through aggregate
// options for compatibility and diagnostics.
let _solverDragging = false;

// Latest-only adaptive drag scheduler state. RAF aligns visible updates with a
// paint; the timer keeps synchronous fallback work from consuming every frame.
let _solverRafId = null;
let _solverThrottleTimer = null;
let _pendingInteractiveSolve = null;
let _lastInteractiveSolveStart = 0;
let _lastInteractiveSolveMs = 60;
let _solverRunGeneration = 0;
let _interactiveSolveActive = false;
const _solverPerformanceSamples = [];

function getSolverPerformanceSnapshot() {
  const samples = _solverPerformanceSamples.map(sample => ({ ...sample }));
  const average = key => samples.length
    ? samples.reduce((sum, sample) => sum + (Number(sample[key]) || 0), 0) / samples.length
    : 0;
  return {
    count: samples.length,
    latest: samples.at(-1) || null,
    averages: {
      totalMs: average('totalMs'),
      workerRoundTripMs: average('workerRoundTripMs'),
      packMs: average('packMs'),
      summaryMs: average('summaryMs'),
      usageMs: average('usageMs'),
    },
    samples,
  };
}
window.getSolverPerformanceSnapshot = getSolverPerformanceSnapshot;

// performance.now() of the most recent slider input that triggered a solve.
// Used to compute end-to-end input→render lag in the timing log.
let _lastInputT = 0;

function _metastorageConfig() {
  return window.RECIPES_DB?.metastorage || DEFAULT_METASTORAGE;
}

function _metastorageEnabled() {
  return typeof autoMetaTransfer !== 'undefined' && !!autoMetaTransfer;
}

// Same relevance screen as beta: only balanced graph items that are consumed
// or targeted can improve the plan. Raw/manual source items are excluded.
function _metastorageCandidates(graph, productionSet) {
  const costs = _metastorageConfig()?.itemCosts || {};
  return Object.keys(costs).filter(itemId => {
    const node = graph.itemNodes.get(itemId);
    if (!node || node.isRawMaterial || forcedRawSet.has(itemId)) return false;
    return productionSet.has(itemId) || (graph.itemConsumedBy.get(itemId)?.size || 0) > 0;
  }).sort();
}

function _installMetastorageVariable(
  itemId,
  variables,
  constraints,
  effectivePriceByItem,
) {
  delete variables.meta_import;
  if (!itemId) return null;
  const cfg = _metastorageConfig();
  const cost = Number(cfg?.itemCosts?.[itemId]);
  const budget = Number(cfg?.ttvCapPerCycle) / (Number(cfg?.cycleSeconds) / 60);
  const balance = `bal_${itemId}`;
  if (!(cost > 0) || !(budget > 0) || !constraints[balance]) return null;
  constraints.meta_ttv = { max: budget };
  const effectivePrice = effectivePriceByItem.get(itemId) || 0;
  variables.meta_import = {
    [balance]: 1,
    meta_ttv: cost,
    value: effectivePrice,
    facc: 0,
    power: 0,
    profit: effectivePrice,
  };
  const upper = `ub_net_${itemId}`;
  if (constraints[upper]) variables.meta_import[upper] = 1;
  return { itemId, cost, budget, cycleSeconds: Number(cfg.cycleSeconds) || 3600 };
}

function _metastorageSolveMetrics(result, variables, recipeList, meta) {
  let rawCost = 0;
  let buildings = 0;
  let power = 0;
  const rawDemand = {};
  const addRaw = (itemId, rate) => { rawDemand[itemId] = (rawDemand[itemId] || 0) + rate; };
  Object.entries(variables).forEach(([name, coefs]) => {
    const amount = Number(result?.[name]) || 0;
    buildings += (coefs.facc || 0) * amount;
    power += (coefs.power || 0) * amount;
  });
  recipeList.forEach((recipe, ri) => {
    const active = Number(result?.[`x_${ri}`]) || 0;
    (recipe.inputs || []).forEach(input => {
      if (!forcedRawSet.has(input.itemId)) return;
      const rate = calcRate(input.amount, recipe.craftingTime) * active;
      addRaw(input.itemId, rate);
      // Match beta raw-cost ordering: effectively unlimited pump liquids do
      // not make an otherwise better recipe lose the tie-break.
      if (input.itemId === 'item_liquid_water' || input.itemId === 'item_liquid_acid') return;
      rawCost += rate;
    });
    const drain = sustainDrainForRecipe(recipe);
    if (drain && forcedRawSet.has(drain.itemId)) {
      const rate = drain.ratePerMinute * active;
      addRaw(drain.itemId, rate);
      if (drain.itemId !== 'item_liquid_water' && drain.itemId !== 'item_liquid_acid')
        rawCost += rate;
    }
  });
  const sources = window.RECIPES_DB?.rawMaterialSources || DEFAULT_RAW_MATERIAL_SOURCES;
  Object.entries(rawDemand).forEach(([itemId, rate]) => {
    const cfg = sources[itemId];
    const facility = cfg ? facilityTypeById?.[cfg.facilityId] : null;
    if (cfg?.ratePerMinute > 0 && facility)
      power += rate / cfg.ratePerMinute * (facility.power || 0);
  });
  return {
    objective: Number(result?.result) || 0,
    rawCost,
    buildings,
    power,
    ttv: meta ? (Number(result?.meta_import) || 0) * meta.cost : 0,
  };
}

function _isBetterMetastorageSolve(candidate, incumbent, opType) {
  const primaryDiff = candidate.objective - incumbent.objective;
  const primaryTol = 1e-7 * Math.max(1, Math.abs(candidate.objective), Math.abs(incumbent.objective));
  if (Math.abs(primaryDiff) > primaryTol)
    return opType === 'max' ? primaryDiff > 0 : primaryDiff < 0;
  for (const key of ['rawCost', 'buildings', 'power', 'ttv']) {
    const diff = candidate[key] - incumbent[key];
    if (Math.abs(diff) > 1e-7 * Math.max(1, Math.abs(candidate[key]), Math.abs(incumbent[key])))
      return diff < 0;
  }
  return false;
}

// runSolverThrottled: coalesce slider input and adapt solve cadence to the last
// solve duration. Called with inPlace=true to avoid a full production rebuild.
// Cancel queued/stale work immediately when a control changes. A Meta scan
// checks the generation after every yielded candidate and exits without
// applying stale results.
function cancelScheduledSolverWork() {
  _solverRunGeneration++;
  _pendingInteractiveSolve = null;
  if (_solverRafId) cancelAnimationFrame(_solverRafId);
  if (_solverThrottleTimer) clearTimeout(_solverThrottleTimer);
  _solverRafId = null;
  _solverThrottleTimer = null;
}

function _scheduleInteractiveSolve() {
  if (_interactiveSolveActive || _solverRafId || _solverThrottleTimer || !_pendingInteractiveSolve) return;
  // The worker keeps HiGHS off the UI thread, so update near animation speed
  // without ever queueing stale solves. The latest pending pointer position is
  // picked up as soon as the preceding solve finishes.
  const startGap = Math.min(180, Math.max(65, _lastInteractiveSolveMs * 1.35));
  const wait = Math.max(0, _lastInteractiveSolveStart + startGap - performance.now());
  if (wait > 1) {
    _solverThrottleTimer = setTimeout(() => {
      _solverThrottleTimer = null;
      _scheduleInteractiveSolve();
    }, wait);
    return;
  }
  _solverRafId = requestAnimationFrame(async () => {
    _solverRafId = null;
    const request = _pendingInteractiveSolve;
    _pendingInteractiveSolve = null;
    if (!request) return;
    const started = performance.now();
    _lastInteractiveSolveStart = started;
    _interactiveSolveActive = true;
    try {
      await runSolver(request.inPlace, request.pinAll);
      _lastInteractiveSolveMs = Math.max(1, performance.now() - started);
    } finally {
      _interactiveSolveActive = false;
      _scheduleInteractiveSolve();
    }
  });
}

// Repeated input replaces the pending request; it never queues a row of
// obsolete LP solves behind the pointer.
function runSolverThrottled(inPlace, pinAll = false) {
  _pendingInteractiveSolve = { inPlace, pinAll };
  _scheduleInteractiveSolve();
}

// _dragging: set during active slider drag.  Reserved for future use;
// currently no-op but keeps the flag available for optimisations.
let _dragging = false;


/* ═══════════════════════════════════════════════
   § 7  SOLVER CORE

   logS           — append a timestamped message to the solver log box.
   updateSlidersInPlace — refresh slider values from p.rate without
                    rebuilding the production list DOM.
   runSolver      — the single global LP.

   runSolver phases (matching the SOLVER_PIPELINE.md diagram):
     Phase 1 — Build bipartite graph (DFS + augment + cycle repair)
     Phase 2 — Construct LP model (balance, raw caps, facility caps,
                ub_net bounds, profit objective, surplus penalty)
     Phase 3 — Solve via HiGHS
     Phase 4 — Extract recipeFacilityCounts from x_ri values
     Phase 5 — Sanity check cap violations
     Phase 6 — Apply: snap residuals, write p.rate, render
═══════════════════════════════════════════════ */

// logS: append a line to the solver-log box with a HH:MM:SS timestamp.
// type is an optional CSS class suffix ('ok', 'err', '').
function logS(msg, type = '') {
  const box = document.getElementById('solver-log');
  if (!box) return;
  const d = document.createElement('div');
  d.className = type ? 'log-' + type : '';
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  box.appendChild(d); box.scrollTop = box.scrollHeight;
}

// updateSlidersInPlace: rewrite slider + display values from p.rate without
// rebuilding the full production-list DOM.  Called by runSolver(inPlace=true)
// during continuous slider drag so that non-fixed items reflect the LP result
// while the dragged item's slider stays under pointer control.
// Reads p.rate directly (not computeNetRatesFromFlow) so values always match
// the Phase 6 snapped result.
function updateSlidersInPlace() {
  const productionById = new Map(production.map(entry => [entry.id, entry]));
  document.querySelectorAll('.prod-item-row').forEach(row => {
    const p = productionById.get(row.dataset.prodId); if (!p) return;
    if (isFixed(p)) return; // fixed items own their own slider; leave it alone
    const net = Math.max(0, p.rate || 0);
    const slider = row.querySelector('.prod-slider');
    const display = row.querySelector('.prod-rate-display');
    if (slider) { slider.value = net.toFixed(6); setSliderFill(slider); }
    if (display) display.value = net.toFixed(3);
  });
}

// runSolver: single global LP — one variable per recipe, one balance
// constraint per non-raw item.  No SCC detection; the LP handles cycles
// implicitly.  No free-disposal special cases; every item gets the same
// net_production >= 0 constraint.
//
// inPlace=true:  update sliders in-place (called during slider drag via
//                runSolverThrottled); avoids full DOM rebuild.
// inPlace=false: full renderProducts() rebuild (called after state changes).
async function runSolver(inPlace = false, pinAll = false) {
  const solveGeneration = ++_solverRunGeneration;
  const _t0 = performance.now();
  const box = document.getElementById('solver-log');
  if (box) box.innerHTML = '';
  if (!production.length) { logS('No production items.', 'err'); return; }
  if (!isHighsReady()) { _pendingSolve = { inPlace, pinAll }; return; }

  // ─── Phase 1: Build graph ────────────────────────────────────────────
  // Collect all production item IDs (deduped) and any user recipe overrides,
  // then build the bipartite graph via DFS + augmentation + cycle repair.
  const allIds = [...new Set(production.map(p => p.id))];
  const recipeOverrides = productionRecipeOverrides();
  const graph = getCachedBipartiteGraph(allIds, recipeOverrides);
  if (!graph.recipeNodes.size) { logS('No recipes found.', 'err'); return; }
  const graphIndex = getGraphModelIndex(graph);
  const _t1 = performance.now();
  logS(`Graph: ${graph.recipeNodes.size} recipes, ${graph.itemNodes.size} items`);

  // ─── Phase 1b: Pinned items ──────────────────────────────────────────
  // Fixed items (locked or tempPinnedId) produce at a user-set rate.
  // They get an equal: constraint instead of min: 0.
  // Exception: a fixed item at rate ≈ 0 is excluded from pinnedIds so the
  // LP treats it as free — locking/dragging to exactly 0 is almost always
  // unintentional and a equal: 0 equality just wastes a LP slot.
  // If the rate exceeds the computed maxRate (e.g. due to step rounding),
  // cap the equality target at maxRate so the LP stays feasible.
  // trulyFixedIds: user-locked items → get equal: constraints (unchanged).
  // pinnedIds: also includes all >0 items when pinAll=true → get equal: constraints.
  // trulyFixedIds always carries into pinAll so locked-at-0 items keep equal:0
  // and don't get produced as free co-products during the read-only solve.
  const trulyFixedIds = new Set(production.filter(isFixed).map(p => p.id));
  const pinnedIds = pinAll
    ? new Set([...production.filter(p => (p.rate || 0) > 1e-9).map(p => p.id), ...trulyFixedIds])
    : trulyFixedIds;
  const pinnedRates = new Map(production.filter(p => pinnedIds.has(p.id)).map(p => {
    const rawRate = Math.max(0, p.rate || 0);
    const mx = p.maxRate;
    return [p.id, (mx && isFinite(mx) && rawRate > mx) ? mx : rawRate];
  }));

  const productionSet = new Set(production.map(p => p.id));

  // ─── Phase 1c: singleMaxRate ───────────────────────────────────────────
  // Pre-compute per-item maximum rates via mini-LPs for every priced graph
  // item.  These become ub_net_X constraints in Phase 2 that prevent the LP
  // becoming Unbounded when self-sustaining cycles (e.g. the moss/seed loop)
  // exist without any raw or facility caps.
  //
  // _singleMaxDirty is set by invalidateMaxCache() and cleared here after a
  // full rebuild.  During drag, the flag stays false, so this block is skipped
  // entirely — single=0.0ms in the timing log confirms the fast path.
  if (_singleMaxDirty) {
    _singleMaxMap = {};
    for (const [iid, info] of graph.itemNodes) {
      if (info.isRawMaterial) continue;
      if (!productionSet.has(iid)) continue;
      const ck = _maxCacheKey(iid);
      if (_maxCache.has(ck)) {
        _singleMaxMap[iid] = _maxCache.get(ck);
        continue;
      }
      const v = await solveItemMaxAsync(iid, graph);
      if (solveGeneration !== _solverRunGeneration) return;
      const final = (typeof v === 'number' && isFinite(v) && v >= 0) ? v : 1e6;
      _singleMaxMap[iid] = final;
      _maxCache.set(ck, final);
    }
    production.forEach(p => {
      const max = _singleMaxMap[p.id];
      if (!(typeof max === 'number' && isFinite(max) && max >= 0)) return;
      p.maxRate = max;
      if (p.rate > max) p.rate = max;
      if (pinnedRates.has(p.id)) pinnedRates.set(p.id, Math.min(pinnedRates.get(p.id), max));
    });
    _singleMaxDirty = false;
  }
  const singleMaxRate = _singleMaxMap;
  const _t2 = performance.now();

  // ─── Phase 2: Build LP ───────────────────────────────────────────────
  // One variable x_ri per recipe (facility count, ≥ 0 by default in CPLEX LP).
  const {
    recipeList,
    netTermsByItem,
    inputTermsByItem,
    drainTermsByItem,
    itemsConsumed,
  } = graphIndex;
  const constraints = {};
  const variables = {};
  const generals = []; // x_ri names to declare as integers (MIP); populated by integerOnly facilities
  recipeList.forEach((_, ri) => { variables[`x_${ri}`] = {}; });

  // Balance constraints: net_production(item) >= 0 for every non-raw item.
  // Pinned items use equality at their locked rate so the LP honours them.
  // The net production of item X for recipe r is:
  //   output_rate(r, X) − input_rate(r, X)    [per facility per minute]
  graph.itemNodes.forEach((info, iid) => {
    if (info.isRawMaterial) return;
    const cName = `bal_${iid}`;
    const terms = netTermsByItem.get(iid) || [];
    terms.forEach(([ri, coefficient]) => {
      variables[`x_${ri}`][cName] = coefficient;
    });
    if (terms.length) constraints[cName] = pinnedIds.has(iid) ? { equal: pinnedRates.get(iid) || 0 } : { min: 0 };
  });

  // Raw material caps and facility caps are skipped for pinAll solves —
  // we only want facility counts for the given rates; limits would cause
  // infeasibility when resources are fully saturated.
  if (!pinAll) {
    // Raw material caps: Σ consumption across all recipes <= user-set cap.
    rawLimits.forEach(rl => {
      const cName = `raw_${rl.matId}`;
      constraints[cName] = { max: rl.cap };
      (inputTermsByItem.get(rl.matId) || []).forEach(([ri, coefficient]) => {
        variables[`x_${ri}`][cName] = (variables[`x_${ri}`][cName] || 0) + coefficient;
      });
    });

    // Facility caps.  For most facilities the cap limits Σ slot-equivalents
    // (Σ x_ri ≤ cap).  For DEDICATED single-formula facilities (not time-shared)
    // the cap instead limits whole BUILDINGS via integer b_ri ≥ x_ri with
    // Σ b_ri ≤ cap (production x_ri stays continuous).  Shared with the per-item
    // max-rate mini-LP so the slider max reflects the same model.  See
    // _addFacilityCaps.
  }

  // Gas sustain is part of every solve, including pinAll: those solves still
  // need the catalyst chain and environment facilities required by the pinned
  // rates. Raw coefficients attach when raw-cap rows exist; facility caps reuse
  // the returned whole-building placement variables.
  const gasPlacementVars = _addGasSustainConstraints(constraints, variables, generals, recipeList);
  let cappedFacilityUsageVars = new Map();
  if (!pinAll) {
    cappedFacilityUsageVars = _addFacilityCaps(
      constraints, variables, generals, recipeList, gasPlacementVars,
    );
    _addSourceFacilityCaps(constraints, variables, recipeList, gasPlacementVars);
  }

  // Upper bounds on net production for every priced graph item.
  // Without these, a self-sustaining cycle (no raw/facility cap) makes the
  // profit objective unbounded.  singleMaxRate[X] is the tightest bound from
  // mini-LP or facility ceiling; mx === undefined/null/Infinity means no
  // meaningful bound so we skip the constraint entirely.
  // Note: mx=0 IS a valid bound (facility cap=0) and must NOT be skipped.
  // Skipped entirely for pinAll: all non-zero items already have equal: constraints.
  graph.itemNodes.forEach((info, iid) => {
    if (pinAll) return;
    if (info.isRawMaterial) return;
    if (pinnedIds.has(iid)) return; // pinned items are already equality-constrained
    const mx = singleMaxRate[iid];
    if (mx === undefined || mx === null || !isFinite(mx)) return;
    const cName = `ub_net_${iid}`;
    const terms = netTermsByItem.get(iid) || [];
    let hasCoef = terms.length > 0;
    terms.forEach(([ri, coefficient]) => {
      variables[`x_${ri}`][cName] = coefficient;
    });
    (drainTermsByItem.get(iid) || []).forEach(([ri, rate]) => {
      variables[`x_${ri}`][cName] = (variables[`x_${ri}`][cName] || 0) - rate;
      hasCoef = true;
    });
    if (hasCoef) constraints[cName] = { max: mx };
  });

  // Value objective: Σ price(item) × net_production(item) over production targets only.
  // Intermediate items are not sold even if a price is set for them.
  // Pinned items contribute a constant (price × pinnedRate) — omitting them
  // from the objective coefficients is safe because argmax is unaffected by
  // constants.  This "value" form is lex-pass 1 (maximise); buildings and power
  // are minimised in later passes rather than blended in as penalties here.
  const TARGET_WEIGHT = getSolverWeight('target');
  // When "Prioritize Unsellable" is on, assign exponentially decreasing weights to
  // zero-price production targets in pane order so each dominates all lower-ranked
  // targets and profit (1e9 >> max_profit; ratio 1000 >> max_rate per item).
  // These big-M weights are incompatible with the lex value-preservation slack,
  // so priority mode keeps the original single-pass weighted objective below.
  const usePriority = !pinAll && typeof prioritizeUnsellableOn === 'function' && prioritizeUnsellableOn();
  const priorityWeightMap = new Map();
  if (usePriority) {
    let rank = 0;
    production.forEach(p => {
      if (priceOf(p.id) <= 0 && productionSet.has(p.id) && !pinnedIds.has(p.id)) {
        priorityWeightMap.set(p.id, 1e9 / Math.pow(1000, rank++));
      }
    });
  }
  const effectivePriceByItem = new Map();
  graph.itemNodes.forEach((info, iid) => {
    if (info.isRawMaterial) return;
    if (pinnedIds.has(iid)) return;
    const pr = priceOf(iid);
    const effectivePrice = (pr > 0 && productionSet.has(iid)) ? pr
      : priorityWeightMap.has(iid) ? priorityWeightMap.get(iid)
      : (productionSet.has(iid) && TARGET_WEIGHT > 0 ? TARGET_WEIGHT : 0);
    effectivePriceByItem.set(iid, effectivePrice);
    if (effectivePrice <= 0) return;
    (netTermsByItem.get(iid) || []).forEach(([ri, coefficient]) => {
      variables[`x_${ri}`].value = (variables[`x_${ri}`].value || 0) + effectivePrice * coefficient;
    });
    (drainTermsByItem.get(iid) || []).forEach(([ri, rate]) => {
      variables[`x_${ri}`].value = (variables[`x_${ri}`].value || 0) - effectivePrice * rate;
    });
  });

  // Surplus penalty for zero-price dead-end items.
  //
  // Items produced by the LP with no downstream consumer AND no price are
  // pure waste (e.g. copper_nugget when only sewage is needed from copper
  // smelting).  Without penalty, the LP may waste raw materials generating
  // them.  A surplus variable absorbs net production; its coefficient in the
  // objective is -SURPLUS_PENALTY, nudging the LP to avoid overproducing.
  //
  // Dead-end criteria: not a production target, not priced, not consumed by
  // any recipe in the graph.  The balance constraint is promoted from >= 0
  // to = 0 so the surplus variable is the only escape valve.
  const SURPLUS_PENALTY = getSolverWeight('surplus');
  const MACHINE_PENALTY = getSolverWeight('machine');
  const POWER_WEIGHT    = getSolverWeight('power');

  // facc and power must charge the same physical variable that consumes a hard
  // facility ceiling.  In particular, a capped dedicated facility uses the
  // integer b_ri building variable rather than fractional x_ri activity.  This
  // makes scarce whole Forge slots visible to both the main tie-break and the
  // canonical route solve, so work can move to an uncapped alternative.
  recipeList.forEach((r, ri) => {
    const physicalName = cappedFacilityUsageVars.get(ri)
      || gasPlacementVars.get(ri)
      || `x_${ri}`;
    const v = variables[physicalName];
    v.facc = 1;
    v.power = facilityTypeById[r.facilityId]?.power ?? 0;
  });

  graph.itemNodes.forEach((info, iid) => {
    if (info.isRawMaterial) return;
    if (pinnedIds.has(iid)) return;
    if (productionSet.has(iid)) return;   // production targets are never treated as waste
    if (priceOf(iid) > 0) return;         // priced items: value objective already governs them
    if (itemsConsumed.has(iid)) return;   // consumed downstream: not a pure dead end
    const cName = `bal_${iid}`;
    if (!constraints[cName]) return;
    constraints[cName] = { equal: 0 };   // promote >= 0 to = 0
    const sv = `surp_${iid}`;
    variables[sv] = { [cName]: -1, value: -SURPLUS_PENALTY };
  });

  if (window._DEBUG_LP) {
    console.group('[LP debug]');
    console.log('variables:', Object.keys(variables).length, 'constraints:', Object.keys(constraints).length);
    console.log('model:', JSON.stringify({ constraints, variables }, null, 2));
    console.groupEnd();
  }

  // ─── Phase 3: Solve ──────────────────────────────────────────────────
  // pinAll — read-only solve: just minimise total facility count (Σ facc).
  // otherwise — single-pass weighted objective:
  //     max  value − (MACHINE_PENALTY + POWER_WEIGHT·kW) · Σ x_r
  // The tiny machine/power penalties regularise the LP: they break degenerate
  // value-optima toward fewer/cheaper facilities CONSISTENTLY, so production
  // rates come out clean (e.g. exactly 3, not 2.993).  A strict lexicographic
  // value→buildings→power solve leaves those ties to HiGHS and produced
  // cosmetic rate remainders.  The crucible BUILDING-count optimisation that
  // motivated lexicographic lives in the Phase-3 packer instead, independent
  // of this objective.  (The packer now uses a single weighted buildings+power
  // solve too, so `solveLexicographic` is currently unused — kept as a utility.)
  let result;
  let selectedMeta = null;
  let metaCandidatesEvaluated = 0;
  const mainObjective = pinAll ? 'facc' : 'profit';
  const mainOpType = pinAll ? 'min' : 'max';
  // Whole gas-placement variables make this a MIP and are the dominant cost
  // on the expanded 1.4 graph. During an active drag use the LP relaxation;
  // pointer-up always schedules a settled exact-MIP pass 320 ms later. This is
  // only a live preview optimisation: persisted counts, power and sustain
  // usage still come from the exact model.
  const solveGenerals = inPlace ? [] : generals;
  const solveMain = (relaxed = false) => solveLPAsync({
    optimize: mainObjective,
    opType: mainOpType,
    constraints,
    variables,
    generals: relaxed ? [] : solveGenerals,
  });
  try {
    if (!pinAll) {
      Object.keys(variables).forEach(name => {
        const v = variables[name];
        v.profit = (v.value || 0)
          - MACHINE_PENALTY * (v.facc || 0)
          - POWER_WEIGHT * (v.power || 0);
      });
    }

    const allMetaCandidates = _metastorageEnabled()
      ? _metastorageCandidates(graph, productionSet)
      : [];
    const dragCandidate = inPlace && _lastMetastorageItem && allMetaCandidates.includes(_lastMetastorageItem)
      ? _lastMetastorageItem
      : null;
    const metaStart = performance.now();

    if (dragCandidate) {
      // Fast path: keep the last settled route and let its continuous import
      // variable fall to zero if it no longer helps. One LP solve, no scan.
      selectedMeta = _installMetastorageVariable(
        dragCandidate, variables, constraints, effectivePriceByItem,
      );
      result = await solveMain();
      if (solveGeneration !== _solverRunGeneration) return;
      metaCandidatesEvaluated = 1;
    } else {
      delete variables.meta_import;
      result = await solveMain();
      if (solveGeneration !== _solverRunGeneration) return;
      const exactBaselineResult = result;
      const exactBaselineMetrics = result?.feasible
        ? _metastorageSolveMetrics(result, variables, recipeList, null)
        : null;

      // Settled solve: beta-style deterministic candidate enumeration. Rank
      // routes with the continuous relaxation (roughly an order of magnitude
      // faster on gas-heavy graphs), then run the exact MIP once for the winner
      // and compare it against the already-exact no-transfer baseline.
      // A transfer can be what makes a locked target set feasible at all, so a
      // failed no-transfer baseline must not suppress candidate enumeration.
      // (The old gate made Auto Meta silently useless in exactly that case.)
      if (!inPlace && (result?.feasible || allMetaCandidates.length)) {
        const solveStamp = document.getElementById('solve-stamp');
        if (solveStamp && allMetaCandidates.length)
          solveStamp.textContent = `Optimising Meta transfer (0/${allMetaCandidates.length})...`;
        let relaxedBestMetrics = null;
        let relaxedBestMeta = null;
        if (allMetaCandidates.length) {
          const relaxedBaseline = await solveMain(true);
          if (solveGeneration !== _solverRunGeneration) return;
          if (relaxedBaseline?.feasible)
            relaxedBestMetrics = _metastorageSolveMetrics(
              relaxedBaseline, variables, recipeList, null,
            );
        }
        for (const itemId of allMetaCandidates) {
          // HiGHS itself is synchronous. Yielding between candidates lets the
          // browser paint controls and process a new drag; a newer solve then
          // cancels this scan at the generation check.
          await new Promise(resolve => setTimeout(resolve, 0));
          if (solveGeneration !== _solverRunGeneration) return;
          const meta = _installMetastorageVariable(
            itemId, variables, constraints, effectivePriceByItem,
          );
          if (!meta) continue;
          metaCandidatesEvaluated++;
          const candidateResult = await solveMain(true);
          if (solveGeneration !== _solverRunGeneration) return;
          if (solveStamp)
            solveStamp.textContent = `Optimising Meta transfer (${metaCandidatesEvaluated}/${allMetaCandidates.length})...`;
          if (!candidateResult?.feasible) continue;
          const metrics = _metastorageSolveMetrics(
            candidateResult, variables, recipeList, meta,
          );
          if (!relaxedBestMetrics || _isBetterMetastorageSolve(metrics, relaxedBestMetrics, mainOpType)) {
            relaxedBestMetrics = metrics;
            relaxedBestMeta = meta;
          }
        }
        // Let input queued during the last synchronous candidate invalidate the
        // scan before stale results are applied to the visible plan.
        if (allMetaCandidates.length) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (solveGeneration !== _solverRunGeneration) return;
        }
        if (relaxedBestMeta) {
          selectedMeta = _installMetastorageVariable(
            relaxedBestMeta.itemId, variables, constraints, effectivePriceByItem,
          );
          const exactCandidate = await solveMain();
          if (solveGeneration !== _solverRunGeneration) return;
          const exactCandidateMetrics = exactCandidate?.feasible
            ? _metastorageSolveMetrics(
              exactCandidate, variables, recipeList, selectedMeta,
            )
            : null;
          if (exactCandidateMetrics && (!exactBaselineMetrics || _isBetterMetastorageSolve(
            exactCandidateMetrics, exactBaselineMetrics, mainOpType,
          ))) {
            result = exactCandidate;
          } else {
            result = exactBaselineResult;
            selectedMeta = null;
            delete variables.meta_import;
          }
        } else {
          result = exactBaselineResult;
          selectedMeta = null;
          delete variables.meta_import;
        }
        if (selectedMeta) {
          _installMetastorageVariable(
            selectedMeta.itemId, variables, constraints, effectivePriceByItem,
          );
        } else {
          delete variables.meta_import;
        }
      }
    }
    _lastMetastorageMs = performance.now() - metaStart;
  } catch (e) { logS('LP solver error: ' + e, 'err'); return; }
  if (!result?.feasible) {
    logS('LP infeasible — check constraints.', 'err');
    if (typeof markInfeasibleItem === 'function') markInfeasibleItem(_lastChangedProdId);
    return;
  }
  if (typeof markInfeasibleItem === 'function') markInfeasibleItem(null);
  const _tSolve = performance.now();

  // ─── Phase 3b: Canonicalise the recipe mix (determinism) ─────────────
  // The weighted solve's optimal vertex isn't unique — alternate recipe mixes
  // can hit the same target outputs, and adding a (even non-binding) pin
  // constraint makes HiGHS land on a different one, reshuffling the Phase-3
  // bins.  Pin the solved target OUTPUTS exactly and re-solve for the minimal-
  // facility mix: this makes the recipe combination — and therefore the bin
  // packing — a deterministic function of the outputs, so pinning a target at
  // its own value no longer changes anything.  Outputs are pinned, so displayed
  // rates are unchanged (no drift).
  // Skipped for pinAll, and during in-place slider drag (inPlace) — the extra
  // MIP isn't worth it mid-drag; determinism only needs to hold once settled.
  if (!pinAll && !inPlace) {
    const canon = { ...constraints };
    // Drop the unboundedness guards: they're only needed while MAXIMISING
    // value, and they differ between inputs (a pinned target skips its
    // ub_net_X).  Removing them makes the canon model identical regardless of
    // which target carried the pin → identical mix → identical bins.
    Object.keys(canon).forEach(k => { if (k.startsWith('ub_net_')) delete canon[k]; });
    // Pin every production target's net output at its solved value.
    graph.itemNodes.forEach((info, iid) => {
      if (info.isRawMaterial || !productionSet.has(iid)) return;
      const cName = `bal_${iid}`;
      if (!canon[cName]) return;
      let net = 0;
      Object.entries(variables).forEach(([name, coefs]) => {
        const c = coefs[cName];
        if (c) net += c * (result[name] || 0);
      });
      canon[cName] = { equal: net > 1e-9 ? net : 0 };
    });
    // Canonical objective: minimise the SAME facility + surplus penalties the
    // weighted solve uses (machine + power·kW per facility, surplus penalty per
    // dead-end).  With outputs pinned the value term is constant, so this is
    // exactly the weighted solve's mix-selection — but now a pin-INDEPENDENT
    // function of the outputs (no value coefs, which differ by pin).  The 1e-6
    // floor keeps facilities minimised even if both penalties are configured 0.
    Object.keys(variables).forEach(name => {
      const v = variables[name];
      v.canonobj = (1e-6 + MACHINE_PENALTY) * (v.facc || 0)
        + POWER_WEIGHT * (v.power || 0);
      if (name.startsWith('surp_')) v.canonobj = SURPLUS_PENALTY;
      if (name === 'meta_import') v.canonobj += 1e-8 * (selectedMeta?.cost || 1);
    });
    try {
      const r2 = await solveLPAsync({ optimize: 'canonobj', opType: 'min', constraints: canon, variables, generals: solveGenerals });
      if (solveGeneration !== _solverRunGeneration) return;
      if (r2 && r2.feasible) result = r2;
    } catch (e) { /* keep the weighted result */ }
  }
  const _t3 = performance.now();

  // ─── Phase 4: Extract results ────────────────────────────────────────
  // Map each recipe's x_ri solution value to a facility count.
  // Values below 1e-9 are LP noise — treat as zero.
  const recipeFacilityCounts = new Map();
  const recipePlacementCounts = new Map();
  recipeList.forEach((r, ri) => {
    const v = result[`x_${ri}`];
    recipeFacilityCounts.set(r.id, typeof v === 'number' && v > 1e-9 ? v : 0);
    const placementName = gasPlacementVars.get(ri);
    const placed = placementName ? result[placementName]
      : Number(r.gasEnvSupport) > 0 ? v
      : null;
    if (typeof placed === 'number' && placed > 1e-9)
      recipePlacementCounts.set(r.id, Math.round(placed));
  });
  const metaRate = selectedMeta ? Math.max(0, Number(result.meta_import) || 0) : 0;
  _lastMetastorageImport = selectedMeta && metaRate > 1e-9 ? {
    itemId: selectedMeta.itemId,
    ratePerMinute: metaRate,
    ttvCostPerItem: selectedMeta.cost,
    ttvUsedPerMinute: metaRate * selectedMeta.cost,
    ttvBudgetPerMinute: selectedMeta.budget,
    cycleSeconds: selectedMeta.cycleSeconds,
    sourceDomain: _metastorageConfig().sourceDomain,
  } : null;
  _lastMetastorageItem = _lastMetastorageImport?.itemId || null;

  // ─── Phase 5: Sanity check ───────────────────────────────────────────
  // Skipped for pinAll: limits were removed from the LP intentionally.
  if (!pinAll) {
    const { rawUse, facUse } = rawAndFacilityUsage(recipeFacilityCounts, graph, recipePlacementCounts);
    let violation = null;
    rawLimits.forEach(rl => {
      if ((rawUse[rl.matId] || 0) > rl.cap + 0.5 && !violation)
        violation = `Raw ${rl.matId}: used ${(rawUse[rl.matId]||0).toFixed(2)}, cap ${rl.cap}`;
    });
    facilityLimits.forEach(f => {
      if ((facUse[f.gameFacilityId] || 0) > f.cap + 0.5 && !violation)
        violation = `Facility ${f.gameFacilityId}: ${(facUse[f.gameFacilityId]||0).toFixed(2)} / ${f.cap}`;
    });
    if (violation) { logS(`Constraint violation: ${violation}`, 'err'); return; }
  }

  // ─── Phase 6: Apply ──────────────────────────────────────────────────
  // Cache the solved graph and counts for computeSummary / usage bars.
  _lastGraph = graph;
  _lastFacilityCounts = recipeFacilityCounts;
  _lastPlacementCounts = recipePlacementCounts;
  _lastSolvedRates = null; // cleared now; set after p.rate is written below

  _lastSolvedRates = Object.fromEntries(production.map(p => [p.id, p.rate]));

  if (pinAll) {
    // Read-only solve: just update summaries, don't touch production state.
    _solverDragging = inPlace;
    computeSummary();
    _solverDragging = false;
    return;
  }

  // Compute net rates from the LP solution, then write p.rate.
  // Snap LP residuals below 1e-3 to exactly 0: LP arithmetic can leave tiny
  // positive values (e.g. 3.7e-7) for items the solver chose not to produce.
  // Snapping ensures sliders and the summary table always agree — without this,
  // an item "at 0" might show 0.001 on the slider during drag.
  const netRates = computeNetRatesFromFlow(recipeFacilityCounts, graph, recipePlacementCounts);
  if (_lastMetastorageImport)
    netRates[_lastMetastorageImport.itemId] = (netRates[_lastMetastorageImport.itemId] || 0)
      + _lastMetastorageImport.ratePerMinute;
  production.forEach(p => {
    if (isFixed(p)) return;
    const raw = Math.max(0, netRates[p.id] || 0);
    p.rate = raw < 1e-3 ? 0 : raw;
    p.optimized = true;
  });
  _lastSolvedRates = Object.fromEntries(production.map(p => [p.id, p.rate]));

  // Log income, net (after battery cost and outpost fixed cost), and timing.
  const outpostCost = parseFloat((document.getElementById('outpost-cost')?.value||'').replace(/,/g,'')) || 0;
  const incomeHr = production.reduce((s, p) => s + priceOf(p.id) * Math.max(0, p.rate) * 60, 0);
  const batCostHr = powerBatteries.reduce((s, pb) => s + pb.rate * priceOf(pb.matId) * 60, 0);
  const netHr = incomeHr - outpostCost - batCostHr;
  logS(`Income/hr: ${fmt(incomeHr)} | Net: ${fmt(netHr)}`, 'ok');
  if (_metastorageEnabled()) {
    const metaText = _lastMetastorageImport
      ? `${itemById[_lastMetastorageImport.itemId]?.name || _lastMetastorageImport.itemId} ${_lastMetastorageImport.ratePerMinute.toFixed(3)}/min`
      : 'unused';
    logS(`Metastorage: ${metaText} · ${metaCandidatesEvaluated} candidate solve(s)`, 'ok');
  }
  const _stamp = document.getElementById('solve-stamp');
  if (_stamp) _stamp.textContent = `Solved ${new Date().toLocaleTimeString()} · Net ${netHr >= 0 ? '+' : ''}${fmt(netHr)}/hr`;

  // During an in-place drag, update the same aggregate/facility views without
  // rebuilding the production-list DOM.
  _solverDragging = inPlace;
  computeSummary();
  _solverDragging = false;
  if (inPlace) updateSlidersInPlace(); else renderProducts();
  const _t4 = performance.now();
  const _lag = _lastInputT ? (_t4 - _lastInputT).toFixed(1) : '—';
  const perfSample = {
    live: !!inPlace,
    recipes: graph.recipeNodes.size,
    items: graph.itemNodes.size,
    totalMs: _t4 - _t0,
    graphMs: _t1 - _t0,
    maxBoundsMs: _t2 - _t1,
    solvePhaseMs: _tSolve - _t2,
    canonicalMs: _t3 - _tSolve,
    workerCompileMs: _lastLPWorkerStats.compileMs,
    workerSolveMs: _lastLPWorkerStats.solveMs,
    workerRoundTripMs: _lastLPWorkerStats.roundTripMs,
    lpBytes: _lastLPWorkerStats.lpBytes,
    packMs: _lastPackMs,
    summaryMs: typeof _lastSummaryRenderMs === 'number' ? _lastSummaryRenderMs : 0,
    usageMs: typeof _lastUsageRenderMs === 'number' ? _lastUsageRenderMs : 0,
    inputLagMs: _lastInputT ? _t4 - _lastInputT : null,
  };
  _solverPerformanceSamples.push(perfSample);
  if (_solverPerformanceSamples.length > 60) _solverPerformanceSamples.shift();
  // Phase breakdown: graph build, singleMax (skipped on drag), main LP solve,
  // canonicalise (skipped on drag), Phase-3 packer (inside render), DOM render.
  logS(`Done. graph=${(_t1-_t0).toFixed(1)} single=${(_t2-_t1).toFixed(1)} lp=${(_tSolve-_t2).toFixed(1)} meta=${_lastMetastorageMs.toFixed(1)} canon=${(_t3-_tSolve).toFixed(1)} pack=${_lastPackMs.toFixed(1)} summary=${perfSample.summaryMs.toFixed(1)} usage=${perfSample.usageMs.toFixed(1)} render=${(_t4-_t3-_lastPackMs).toFixed(1)} (ms) · lag=${_lag}ms`, 'ok');
}
