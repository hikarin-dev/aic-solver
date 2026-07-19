/* ═══════════════════════════════════════════════
   GAME DATA  (from assets/items.js + assets/recipes.js)
═══════════════════════════════════════════════ */
const itemsDB        = window.ITEMS_DB || [];
const recipesDB      = (window.RECIPES_DB && window.RECIPES_DB.recipes)    || [];
const gameFacilities = (window.RECIPES_DB && window.RECIPES_DB.facilities) || [];
const recipeNamesDB  = (window.RECIPES_DB && window.RECIPES_DB.recipeNames)|| {};
const forcedRawSet   = new Set((window.RECIPES_DB && window.RECIPES_DB.forcedRawMaterials) || []);
const forcedDisposalSet = new Set((window.RECIPES_DB && window.RECIPES_DB.forcedDisposalItems) || []);
const rawMaterialSourcesDB = (window.RECIPES_DB && window.RECIPES_DB.rawMaterialSources) || {};
const powerFuelsDB = (window.RECIPES_DB && window.RECIPES_DB.powerFuels) || {};

const recipeById       = Object.fromEntries(recipesDB.map(r => [r.id, r]));
const facilityTypeById = Object.fromEntries(gameFacilities.map(f => [f.id, f]));
const itemById         = Object.fromEntries(itemsDB.map(i => [i.id, i]));

// Index maps for compact base36 URL encoding
const itemIdxById = new Map(itemsDB.map((it, i) => [it.id, i]));
const facIdxById  = new Map(gameFacilities.map((f, i) => [f.id, i]));

// itemId -> [recipe, ...] that produce it
const recipesByOutput = (() => {
  const m = {};
  recipesDB.forEach(r => {
    (r.outputs || []).forEach(o => {
      if (!m[o.itemId]) m[o.itemId] = [];
      m[o.itemId].push(r);
    });
  });
  return m;
})();

// itemId -> [recipe, ...] that consume it
const recipesByInput = (() => {
  const m = {};
  recipesDB.forEach(r => {
    (r.inputs || []).forEach(i => {
      if (!m[i.itemId]) m[i.itemId] = [];
      m[i.itemId].push(r);
    });
  });
  return m;
})();

// itemId -> true if it can be a production target
// (has at least one recipe, not forced-raw, asTarget !== false)
function isTargetItem(id) {
  const it = itemById[id];
  if (!it || it.asTarget === false) return false;
  if (forcedRawSet.has(id)) return false;
  return (recipesByOutput[id] || []).length > 0;
}

/* ═══════════════════════════════════════════════
   PRICES  (loaded from assets/price.json)
═══════════════════════════════════════════════ */
let prices = {};   // { itemId: number }
async function loadPrices() {
  try {
    const r = await fetch('assets/price.json');
    if (r.ok) {
      const data = await r.json();
      Object.entries(data).forEach(([k, v]) => {
        if (k !== '_comment') prices[k] = Number(v) || 0;
      });
    }
  } catch (e) {}
}
function priceOf(id) { return prices[id] ?? 0; }

// Solver cost weights loaded from assets/solver_config.js (window.SOLVER_CONFIG).
function getSolverWeight(key) {
  return window.SOLVER_CONFIG?.weights?.[key] ?? 0;
}

/* ═══════════════════════════════════════════════
   STATE
   production[]: { id, recipeId, rate, locked, optimized }
   rawLimits[]:  { matId, cap }
   facilityLimits[]: { id, gameFacilityId, name, cap, integerOnly }
     integerOnly: when true, all x_ri for this facility are declared as
     integers in the LP General section (MIP solve).
   powerBatteries[]: { matId, rate }
   prices: { itemId: number }  (persisted separately)
═══════════════════════════════════════════════ */
let production     = [];   // items the user wants to produce
let rawLimits      = [];
let facilityLimits = [];
let powerBatteries = [];
let outpostCostDefault = 59688;
let autoMetaTransfer = false;
let roundUpFacilities = false;

let _lastChangedProdId = null;  // item last touched by the user
let _infeasibleProdId  = null;  // item to highlight red on LP infeasible
let _prodSortable      = null;  // SortableJS instance for the production list

const RAW_DEFAULT_CAPS = {
  'item_originium_ore': 590,
  'item_iron_ore':      90,
  'item_quartz_sand':   240,
  'item_copper_ore':    240,
  'resource_xiranite_gas_vent': 1,
};

/* ═══════════════════════════════════════════════
   PERSISTENCE
═══════════════════════════════════════════════ */
const STORAGE_KEY = 'epc_v2';

// Debounced save — only writes to localStorage after 500ms of inactivity.
// Prevents expensive JSON serialization on every slider drag frame.
let _saveTimer = null;
function saveState() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_doSave, 500);
}
function saveStateNow() {
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  _doSave();
}
function _doSave() {
  try {
    const autoSolve = document.getElementById('auto-solve-toggle')?.checked ?? true;
    const outpostCost = parseFloat((document.getElementById('outpost-cost')?.value||'').replace(/,/g,'')) || outpostCostDefault;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      production, rawLimits, facilityLimits, powerBatteries,
      prices, autoSolve, prioritizeUnsellable: prioritizeUnsellableOn(), outpostCost,
      autoMetaTransfer, roundUpFacilities
    }));
    encodeStateToUrl();
  } catch (e) {}
}

/* ═══════════════════════════════════════════════
   URL STATE
   Side-pane config is encoded as readable hash params:
     #t=item:rate,item:rate!&rl=mat:cap&fl=fac:cap[:i]&b=mat:rate&as=0&oc=59688
   Append ! to a production entry to mark it locked.
   Append :recipe_id to a production entry to override the default recipe.
   Append :i to a facility entry to mark it integer-only (MIP solve).
   Prices live in localStorage only (separate Prices tab).
═══════════════════════════════════════════════ */
let _pendingUrlPrices = null; // localStorage prices deferred past loadPrices()

function _fmtN(n) { return parseFloat(n.toFixed(3)).toString(); }
function _fmtExportN(n) { return parseFloat(n.toFixed(6)).toString(); }

const ENDFIELD_CALC_BETA_URL = 'https://jambochen.github.io/endfield-calc/beta/';
const ENDFIELD_LAB_URL = 'https://endfield-calc.github.io/aef/list';

/* Build the public hash format consumed by endfield-calc beta.
   Its URL contract supports production targets, locked target constraints,
   recipe overrides, rounding/bin-fusion, power sustain, and gas coverage.
   Raw/facility limits and Metastorage settings live only in that app's
   origin-scoped localStorage, so they cannot be changed by a cross-origin link. */
function buildEndfieldCalcBetaUrl() {
  const params = new URLSearchParams();
  const targets = [];
  const recipeOverrides = [];

  production.forEach(p => {
    if (!itemById[p.id]) return;
    const rate = Number.isFinite(Number(p.rate)) ? Math.max(0, Number(p.rate)) : 0;
    targets.push(`${p.id}:${_fmtN(rate)}${p.locked ? 'l' : ''}`);

    const defaultRecipeId = recipesByOutput[p.id]?.[0]?.id || '';
    if (p.recipeId && p.recipeId !== defaultRecipeId && recipeById[p.recipeId]) {
      recipeOverrides.push(`${p.id}:${p.recipeId}`);
    }
  });

  if (targets.length) params.set('t', targets.join(','));
  if (recipeOverrides.length) params.set('r', recipeOverrides.join(','));
  if (roundUpFacilities) params.set('c', '1');

  // Both calculators use bin fusion and four gas-consuming facilities per
  // Gas Dispersing Unit by default. Emit only non-default values so links stay
  // compatible with beta's own serializer.
  const configuredMpv = typeof GAS_SUSTAIN_CONFIG !== 'undefined'
    ? GAS_SUSTAIN_CONFIG.machinesPerVaporizer
    : 4;
  const mpv = Number(configuredMpv) || 4;
  if (mpv !== 4) params.set('mpv', String(Math.max(1, Math.min(16, Math.round(mpv)))));

  const hash = params.toString();
  return ENDFIELD_CALC_BETA_URL + (hash ? `#${hash}` : '');
}

function openInEndfieldCalcBeta(event) {
  event?.preventDefault();
  event?.stopPropagation();
  window.open(buildEndfieldCalcBetaUrl(), '_blank', 'noopener,noreferrer');
}

/* EndfieldLab v11 accepts a readable repeated `o` query and rewrites it to its
   compressed `z` form after loading. Targets are exported as exact current
   outputs. Forge capacity and Auto Meta use its dedicated controls. Its raw
   resource control is all-or-nothing, so independently optional raw limits
   cannot be imported faithfully and are deliberately omitted. */
function buildEndfieldLabUrl() {
  const url = new URL(ENDFIELD_LAB_URL);

  production.forEach(p => {
    if (!itemById[p.id] || !p.id.startsWith('item_')) return;
    const rate = Number.isFinite(Number(p.rate)) ? Math.max(0, Number(p.rate)) : 0;
    if (rate <= 1e-9) return;
    // Keep enough precision for solutions sitting directly on a resource cap;
    // rounding a target upward to three decimals can make the import infeasible.
    url.searchParams.append('o', `${p.id.slice(5)}*${_fmtExportN(rate)}`);
  });

  facilityLimits.forEach(limit => {
    const cap = Number(limit.cap);
    if (limit.gameFacilityId !== 'xiranite_oven_1' || !Number.isFinite(cap) || cap < 0) return;
    // Type 13 is EndfieldLab's physical Forge machine limit.
    url.searchParams.append('o', `xiranite_oven_1*${_fmtN(cap)}**13`);
  });

  if (autoMetaTransfer) {
    // Type 14 enables EndfieldLab's automatic Valley IV Metastorage route.
    url.searchParams.append('o', 'domain_key_tundra*1**14');
  }

  url.searchParams.set('v', '11');
  return url.toString();
}

function openInEndfieldLab(event) {
  event?.preventDefault();
  event?.stopPropagation();
  window.open(buildEndfieldLabUrl(), '_blank', 'noopener,noreferrer');
}

function encodeStateToUrl() {
  try {
    const parts = [];

    if (production.length) {
      parts.push('t=' + production.map(p => {
        const defRecipe = recipesByOutput[p.id]?.[0]?.id || '';
        const safeRate = (p.maxRate && isFinite(p.maxRate)) ? Math.min(p.rate, p.maxRate) : p.rate;
        const key = itemIdxById.get(p.id)?.toString(36) ?? p.id;
        let s = key + ':' + _fmtN(safeRate);
        if (p.recipeId && p.recipeId !== defRecipe) s += ':' + p.recipeId;
        return p.locked ? s + '!' : s;
      }).join(','));
    }

    if (rawLimits.length)
      parts.push('rl=' + rawLimits.map(r => {
        const key = itemIdxById.get(r.matId)?.toString(36) ?? r.matId;
        return key + ':' + r.cap;
      }).join(','));

    if (facilityLimits.length)
      parts.push('fl=' + facilityLimits.map(f => {
        const key = facIdxById.get(f.gameFacilityId)?.toString(36) ?? f.gameFacilityId;
        return key + ':' + f.cap + (f.integerOnly ? ':i' : '');
      }).join(','));

    if (powerBatteries.length)
      parts.push('b=' + powerBatteries.map(b => {
        const key = itemIdxById.get(b.matId)?.toString(36) ?? b.matId;
        return key + ':' + _fmtN(b.rate);
      }).join(','));

    const autoSolve = document.getElementById('auto-solve-toggle')?.checked ?? true;
    parts.push('as=' + (autoSolve ? '1' : '0'));
    if (prioritizeUnsellableOn()) parts.push('pu=1');
    if (autoMetaTransfer) parts.push('mt=1');
    if (roundUpFacilities) parts.push('c=1');

    const outpostCost = parseFloat((document.getElementById('outpost-cost')?.value || '').replace(/,/g, '')) || outpostCostDefault;
    if (outpostCost) parts.push('oc=' + outpostCost);

    history.replaceState(null, '', parts.length ? '#' + parts.join('&') : location.pathname + location.search);
  } catch (e) {}
}

function decodeStateFromUrl() {
  try {
    const hash = location.hash;
    if (!hash || hash.length <= 1) return false;
    const map = {};
    decodeURIComponent(hash.slice(1)).split('&').forEach(part => {
      const eq = part.indexOf('=');
      if (eq >= 0) map[part.slice(0, eq)] = part.slice(eq + 1);
    });
    // Require at least one recognised side-pane key (also rejects old #s= base64 URLs)
    if (!map.t && !map.rl && !map.fl && !map.b && map.as === undefined && map.mt === undefined && map.c === undefined && !map.oc) return false;

    // Resolve a token that is either a full item/facility ID or a base36 index
    function resolveItemId(tok) {
      return tok.includes('_') ? tok : (itemsDB[parseInt(tok, 36)]?.id ?? tok);
    }
    function resolveFacId(tok) {
      return tok.includes('_') ? tok : (gameFacilities[parseInt(tok, 36)]?.id ?? tok);
    }

    if (map.t) {
      production = map.t.split(',').filter(Boolean).map(seg => {
        const locked = seg.endsWith('!');
        if (locked) seg = seg.slice(0, -1);
        const f = seg.split(':');                          // [id_or_idx, rate, recipe_id?]
        const id = resolveItemId(f[0]), rate = parseFloat(f[1]) || 0;
        const recipeId = f[2] || recipesByOutput[id]?.[0]?.id || '';
        return { id, recipeId, rate, locked, optimized: false };
      }).filter(p => itemById[p.id]);
    }

    if (map.rl) {
      rawLimits = map.rl.split(',').filter(Boolean).map(seg => {
        const [tok, cap] = seg.split(':');
        return { matId: resolveItemId(tok), cap: parseFloat(cap) || 0 };
      }).filter(r => r.matId);
    }

    if (map.fl) {
      facilityLimits = map.fl.split(',').filter(Boolean).map(seg => {
        const parts = seg.split(':');
        const gfid = resolveFacId(parts[0]), cap = parts[1], flag = parts[2];
        const ft = facilityTypeById[gfid];
        const parsedCap = parseFloat(cap);
        return { id: uid(), gameFacilityId: gfid, name: ft?.name || gfid, cap: isNaN(parsedCap) ? 1 : parsedCap, integerOnly: flag === 'i' };
      }).filter(f => f.gameFacilityId);
    }

    if (map.b) {
      powerBatteries = map.b.split(',').filter(Boolean).map(seg => {
        const [tok, rate] = seg.split(':');
        return { matId: resolveItemId(tok), rate: parseFloat(rate) || 0 };
      }).filter(b => b.matId);
    }

    if (map.as !== undefined) {
      const tog = document.getElementById('auto-solve-toggle');
      if (tog) tog.checked = map.as !== '0';
    }
    if (map.pu !== undefined) {
      const tog = document.getElementById('prioritize-unsellable-toggle');
      if (tog) tog.checked = map.pu === '1';
    }
    autoMetaTransfer = map.mt === '1';
    roundUpFacilities = map.c === '1';

    if (map.oc != null) outpostCostDefault = parseFloat(map.oc) || 0;

    return true;
  } catch (e) { return false; }
}

const VISITED_KEY = 'epc_visited';

function _applyStateSnapshot(s) {
  if (Array.isArray(s.production)) production = s.production;
  if (Array.isArray(s.rawLimits)) rawLimits = s.rawLimits;
  if (Array.isArray(s.facilityLimits)) facilityLimits = s.facilityLimits;
  if (Array.isArray(s.powerBatteries)) powerBatteries = s.powerBatteries;
  if (s.prices && typeof s.prices === 'object') _pendingUrlPrices = s.prices;
  if (s.outpostCost != null) outpostCostDefault = s.outpostCost;
  if (s.autoMetaTransfer != null) autoMetaTransfer = !!s.autoMetaTransfer;
  if (s.roundUpFacilities != null) roundUpFacilities = !!s.roundUpFacilities;
  const tog = document.getElementById('auto-solve-toggle');
  if (tog) tog.checked = s.autoSolve !== false;
  const puTog = document.getElementById('prioritize-unsellable-toggle');
  if (puTog && s.prioritizeUnsellable != null) puTog.checked = !!s.prioritizeUnsellable;
  const metaTog = document.getElementById('auto-meta-toggle');
  if (metaTog) metaTog.checked = autoMetaTransfer;
  const ceilTog = document.getElementById('round-facilities-toggle');
  if (ceilTog) ceilTog.checked = roundUpFacilities;
}

async function loadState() {
  if (decodeStateFromUrl()) return; // URL hash takes priority over localStorage

  if (!localStorage.getItem(VISITED_KEY)) {
    localStorage.setItem(VISITED_KEY, '1');
    try {
      const r = await fetch('initialization.json');
      if (r.ok) _applyStateSnapshot(await r.json());
    } catch (e) {}
    return;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) _applyStateSnapshot(JSON.parse(raw));
  } catch (e) {}
}

/* LP adapter (isHighsReady, setHighsInstance, compileLP, solveLP) → solver_pipeline.js § 1 */

/* ═══════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════ */
function uid() { return Math.random().toString(36).substr(2, 8); }
function autoSolveOn() { return document.getElementById('auto-solve-toggle')?.checked; }
function prioritizeUnsellableOn() { return document.getElementById('prioritize-unsellable-toggle')?.checked; }

// Toggle handlers yield a paint before starting HiGHS. Rapid clicks collapse
// into one solve, and an in-progress yielded Meta scan is invalidated at once.
let _controlSolveTimer = null;
function scheduleControlSolve(pinAll = !autoSolveOn()) {
  clearTimeout(_controlSolveTimer);
  _controlSolveTimer = setTimeout(() => {
    _controlSolveTimer = null;
    runSolver(false, pinAll);
  }, 60);
}
function handleAutoSolveToggle() {
  tempPinnedId = null;
  clearTimeout(_controlSolveTimer); _controlSolveTimer = null;
  clearTimeout(_settleTimer);
  if (typeof cancelScheduledSolverWork === 'function') cancelScheduledSolverWork();
  saveState();
  if (autoSolveOn()) scheduleControlSolve(false);
  else renderProducts();
}
function handleAutoMetaToggle() {
  autoMetaTransfer = !!document.getElementById('auto-meta-toggle')?.checked;
  _lastMetastorageItem = null;
  // soloMaxRate supplies ub_net_X guards to the main LP. Those maxima differ
  // when a TTV-funded input is available, so neither direction may reuse the
  // other mode's cached bounds.
  if (typeof invalidateMaxCache === 'function') invalidateMaxCache();
  clearTimeout(_controlSolveTimer); _controlSolveTimer = null;
  clearTimeout(_settleTimer);
  if (typeof cancelScheduledSolverWork === 'function') cancelScheduledSolverWork();
  saveStateNow();
  scheduleControlSolve(!autoSolveOn());
}
function handlePrioritizeUnsellableToggle() {
  tempPinnedId = null;
  clearTimeout(_controlSolveTimer); _controlSolveTimer = null;
  if (typeof cancelScheduledSolverWork === 'function') cancelScheduledSolverWork();
  saveState();
  scheduleControlSolve(!autoSolveOn());
}

function markInfeasibleItem(id) {
  _infeasibleProdId = id || null;
  document.querySelectorAll('.prod-item-row[data-prod-id]').forEach(row => {
    const on = row.dataset.prodId === id;
    row.querySelector('.prod-slider')?.classList.toggle('infeasible', on);
    row.querySelector('.icon-btn:not(.del)')?.classList.toggle('infeasible', on);
  });
}
function fmt(n) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return (n < 0 ? '-' : '') + Math.abs(n).toLocaleString('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}
function icon(id) {
  const it = itemById[id];
  if (!it) return '';
  return `<img src="assets/icons/items/${it.iconFile}" class="mat-icon" title="${it.name}">`;
}
function facIcon(typeId) {
  const file = facilityTypeById[typeId]?.iconFile || `${typeId}.webp`;
  return `<img src="assets/icons/facilities/${file}" class="mat-icon" onerror="this.style.visibility='hidden'">`;
}
function prodEntry(id) { return production.find(p => p.id === id); }
function isFixed(p) { return p.locked || p.id === tempPinnedId; }

/* ═══════════════════════════════════════════════
   RECIPE CHAIN HELPERS
   All cost/chain logic works directly from recipesDB.
   No per-item cost objects stored in state.
═══════════════════════════════════════════════ */

// Per-unit inputs for an item given a specific recipe.
function recipeCosts(recipe, outputId) {
  const out = (recipe.outputs || []).find(o => o.itemId === outputId);
  const perUnit = (out && out.amount > 0) ? out.amount : 1;
  const costs = {};
  (recipe.inputs || []).forEach(i => { costs[i.itemId] = i.amount / perUnit; });
  return costs;
}

// Get the chosen recipe for a production entry (first recipe by default).
function recipeFor(p) {
  if (p.recipeId && recipeById[p.recipeId]) return recipeById[p.recipeId];
  const recipes = recipesByOutput[p.id] || [];
  return recipes[0] || null;
}

function invalidateChainCache() { invalidateMaxCache(); }

/* ═══════════════════════════════════════════════
   PANEL COLLAPSE / TABS / SIDE PANE
═══════════════════════════════════════════════ */
function togglePanel(id) { document.getElementById(id).classList.toggle('collapsed'); }

function switchTab(t) {
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === t));
  document.querySelectorAll('.page').forEach(el => el.classList.remove('active'));
  document.getElementById('page-' + t).classList.add('active');
  if (t === 'prices') renderPricesTab();
  if (t === 'saved') renderSavedTab();
  const app = document.querySelector('.app');
  if (app && window.matchMedia('(max-width: 1100px)').matches) app.classList.remove('side-mobile-open');
}

function toggleSidePane() {
  const app = document.querySelector('.app');
  if (!app) return;
  if (window.matchMedia('(max-width: 1100px)').matches) app.classList.toggle('side-mobile-open');
  else app.classList.toggle('side-collapsed');
}

/* ═══════════════════════════════════════════════
   RAW RESOURCE LIMITS PANEL
═══════════════════════════════════════════════ */
function renderResources() {
  const el = document.getElementById('res-list');
  el.innerHTML = '';
  if (!rawLimits.length) {
    el.innerHTML = '<div class="empty-state" style="font-size:11px;">No limits set — LP treats all raw resources as unlimited</div>';
    document.getElementById('res-pill').textContent = '0';
    return;
  }
  rawLimits.forEach((rl, ri) => {
    const it = itemById[rl.matId];
    if (!it) return;
    const d = document.createElement('div');
    d.className = 'item-row';
    d.style.gridTemplateColumns = 'auto 1fr 72px auto auto';
    d.style.gap = '0.375rem';
    d.innerHTML = `${icon(rl.matId)}<span class="item-name">${it.name}</span>
      <input class="num-input" type="number" value="${rl.cap}" min="0"
        onchange="rawLimits[${ri}].cap=+this.value;invalidateChainCache();saveStateNow();recomputeMaxForRaw();renderProducts();if(autoSolveOn())runSolver();else runSolver(false,true)">
      <span class="prod-max-label">${it.rawUnit || '/min'}</span>
      <button class="icon-btn del" onclick="delRawLimit(${ri})">✕</button>`;
    el.appendChild(d);
  });
  document.getElementById('res-pill').textContent = rawLimits.length;
}

function delRawLimit(i) {
  rawLimits.splice(i, 1);
  invalidateChainCache();
  renderResources(); saveStateNow(); recomputeMaxForRaw(); renderProducts();
  if (autoSolveOn()) runSolver(); else runSolver(false, true);
}

function positionPortal(dd, anchor) {
  const rect = anchor.getBoundingClientRect();
  const ddH  = dd.offsetHeight || 280;
  const pad  = 8;
  const spaceBelow = window.innerHeight - rect.bottom - pad;
  const spaceAbove = rect.top - pad;
  dd.style.left  = rect.left + 'px';
  dd.style.width = rect.width + 'px';
  if (spaceBelow < ddH && spaceAbove > spaceBelow) {
    const h = Math.min(ddH, spaceAbove);
    dd.style.top       = (rect.top - h - 3) + 'px';
    dd.style.maxHeight = h + 'px';
  } else {
    dd.style.top       = (rect.bottom + 3) + 'px';
    dd.style.maxHeight = Math.max(60, spaceBelow) + 'px';
  }
}

function getRawPortal() {
  let el = document.getElementById('raw-portal');
  if (!el) { el = document.createElement('div'); el.id = 'raw-portal'; el.className = 'mat-search-dropdown'; el.style.cssText = 'position:fixed;z-index:9999;display:none;'; document.body.appendChild(el); }
  return el;
}
function filterRawSearch() {
  const input = document.getElementById('new-raw-input'); if (!input) return;
  const dd = getRawPortal();
  const q = input.value.trim().toLowerCase();
  const limited = new Set(rawLimits.map(rl => rl.matId));
  const available = itemsDB.filter(it => forcedRawSet.has(it.id) && !limited.has(it.id));
  const matches = q ? available.filter(it => it.name.toLowerCase().includes(q)) : available;
  dd.innerHTML = matches.length
    ? matches.slice(0, 20).map(it => `<div class="mat-search-item" onmousedown="pickRawLimit('${it.id}')"><img src="assets/icons/items/${it.iconFile}" class="mat-icon"><span>${it.name}</span></div>`).join('')
    : '<div class="mat-search-empty">No raw materials to add</div>';
  dd.style.display = 'block';
  positionPortal(dd, input);
}
function closeRawSearch() { const dd = document.getElementById('raw-portal'); if (dd) dd.style.display = 'none'; }
function pickRawLimit(matId) {
  const input = document.getElementById('new-raw-input'); if (input) input.value = '';
  closeRawSearch();
  if (rawLimits.find(rl => rl.matId === matId)) return;
  rawLimits.push({ matId, cap: RAW_DEFAULT_CAPS[matId] ?? 100 });
  invalidateChainCache();
  renderResources(); saveStateNow(); recomputeMaxForRaw(); renderProducts();
  if (autoSolveOn()) runSolver(); else runSolver(false, true);
}

/* ═══════════════════════════════════════════════
   FACILITY LIMITS PANEL
═══════════════════════════════════════════════ */
function renderFacilities() {
  const el = document.getElementById('fac-list');
  el.innerHTML = '';
  if (!facilityLimits.length) {
    el.innerHTML = '<div class="empty-state" style="font-size:11px;">No facility limits set — LP treats all facilities as unlimited</div>';
    document.getElementById('fac-pill').textContent = '0';
    return;
  }
  facilityLimits.forEach((f, fi) => {
    const d = document.createElement('div');
    d.className = 'item-row';
    d.style.gridTemplateColumns = 'auto 1fr auto auto auto auto';
    d.style.gap = '0.375rem';
    const intOn = !!f.integerOnly;
    const tsTip = 'Time-share: one unit runs several recipes by time-slicing → ⌈total load⌉ units (fewer). Off (default): one recipe per dedicated unit, counts kept whole so they fit the cap.';
    d.innerHTML = `${facIcon(f.gameFacilityId)}<span class="item-name">${f.name}</span>
      <input class="num-input" type="number" value="${f.cap}" min="0" step="1"
        title="Max units of this facility the LP may use"
        onchange="facilityLimits[${fi}].cap=Math.max(0,+this.value);saveStateNow();recomputeMaxForFacility('${f.gameFacilityId}');renderProducts();if(autoSolveOn())runSolver();else runSolver(false,true)">
      <span style="font-size:0.75rem;color:var(--text3);font-weight:600;white-space:nowrap;" title="${tsTip}">⇄</span>
      <label class="tog-wrap" onclick="event.stopPropagation()" title="${tsTip}">
        <input type="checkbox" class="tog-cb" ${intOn ? 'checked' : ''} onchange="facilityLimits[${fi}].integerOnly=this.checked;saveStateNow();recomputeMaxForFacility('${f.gameFacilityId}');renderProducts();if(autoSolveOn())runSolver();else runSolver(false,true)">
        <span class="tog-track"></span>
      </label>
      <button class="icon-btn del" onclick="delFacLimit(${fi})">✕</button>`;
    el.appendChild(d);
  });
  document.getElementById('fac-pill').textContent = facilityLimits.length;
}

function delFacLimit(i) {
  const typeId = facilityLimits[i]?.gameFacilityId;
  facilityLimits.splice(i, 1);
  if (typeId) recomputeMaxForFacility(typeId);
  renderFacilities(); renderProducts(); saveStateNow();
  if (autoSolveOn()) runSolver(); else runSolver(false, true);
}


function getFacTypePortal() {
  let el = document.getElementById('ft-portal');
  if (!el) { el = document.createElement('div'); el.id = 'ft-portal'; el.className = 'mat-search-dropdown'; el.style.cssText = 'position:fixed;z-index:9999;display:none;'; document.body.appendChild(el); }
  return el;
}
// Facility types referenced anywhere in the recipe chain of the current
// production list — not just the final-step recipe per target, but every
// intermediate too. Uses the same graph builder as runSolver so the
// dropdown lists exactly what the solver will actually consume.
function chainFacilityTypes() {
  if (!production.length) return new Set();
  const overrides = productionRecipeOverrides();
  let graph;
  try { graph = getCachedBipartiteGraph(production.map(p => p.id), overrides); }
  catch (e) { return new Set(); }
  const out = new Set();
  graph.recipeNodes.forEach(r => { if (r.facilityId) out.add(r.facilityId); });
  graph.itemNodes.forEach((info, itemId) => {
    if (!info.isRawMaterial && !forcedRawSet.has(itemId)) return;
    const source = rawMaterialSourcesDB[itemId];
    if (source?.facilityId) out.add(source.facilityId);
  });
  if (powerBatteries.some(b => (b.rate || 0) > 0)) out.add('power_station_1');
  return out;
}

function filterFacTypeSearch() {
  const input = document.getElementById('new-fac-name'); if (!input) return;
  const dd = getFacTypePortal();
  const q = input.value.trim().toLowerCase();
  const usedTypeIds = new Set(facilityLimits.map(f => f.gameFacilityId));
  const referenced = chainFacilityTypes();
  let available = gameFacilities.filter(ft => referenced.has(ft.id) && !usedTypeIds.has(ft.id));
  if (q) available = available.filter(ft => (ft.name||'').toLowerCase().includes(q));
  dd.innerHTML = available.length
    ? available.map(ft => `<div class="mat-search-item" onmousedown="pickFacType('${ft.id}')"><img src="assets/icons/facilities/${ft.id}.webp" class="mat-icon"><span>${ft.name||ft.id}</span></div>`).join('')
    : '<div class="mat-search-empty">No facility types to add</div>';
  dd.style.display = 'block';
  positionPortal(dd, input);
}
function closeFacTypeSearch() { const dd = document.getElementById('ft-portal'); if (dd) dd.style.display = 'none'; }
function pickFacType(typeId) {
  const input = document.getElementById('new-fac-name'); if (input) input.value = '';
  closeFacTypeSearch();
  const ft = facilityTypeById[typeId];
  if (!ft || facilityLimits.some(f => f.gameFacilityId === typeId)) return;
  facilityLimits.push({ id: uid(), name: ft.name || typeId, gameFacilityId: typeId, cap: 1, integerOnly: false });
  recomputeMaxForFacility(typeId);
  renderFacilities(); renderProducts(); saveStateNow();
  if (autoSolveOn()) runSolver(); else runSolver(false, true);
}

/* ═══════════════════════════════════════════════
   PRODUCTION PANEL
═══════════════════════════════════════════════ */
let tempPinnedId = null;

/* Max-rate cache (_maxCache, _singleMaxMap, solveItemMax, solveMaxForItem, recomputeMax*) → solver_pipeline.js § 2 */

function getProdPortal() {
  let el = document.getElementById('prod-portal');
  if (!el) { el = document.createElement('div'); el.id = 'prod-portal'; el.className = 'mat-search-dropdown'; el.style.cssText = 'position:fixed;z-index:9999;display:none;'; document.body.appendChild(el); }
  return el;
}
function filterProdSearch() {
  const input = document.getElementById('new-prod-input'); if (!input) return;
  const dd = getProdPortal();
  const q = input.value.trim().toLowerCase();
  const inProd = new Set(production.map(p => p.id));
  const available = itemsDB.filter(it => isTargetItem(it.id) && !inProd.has(it.id));
  const matches = (q ? available.filter(it => it.name.toLowerCase().includes(q)) : available)
    .sort((a, b) => priceOf(b.id) - priceOf(a.id));
  dd.innerHTML = matches.length
    ? matches.slice(0, 20).map(it => `<div class="mat-search-item" onmousedown="pickProdMat('${it.id}')"><img src="assets/icons/items/${it.iconFile}" class="mat-icon"><span>${it.name}</span></div>`).join('')
    : '<div class="mat-search-empty">No matching items</div>';
  dd.style.display = 'block';
  positionPortal(dd, input);
}
function closeProdSearch() { const dd = document.getElementById('prod-portal'); if (dd) dd.style.display = 'none'; }
function pickProdMat(id) {
  const input = document.getElementById('new-prod-input'); if (input) input.value = '';
  closeProdSearch();
  addProductionItem(id);
}
function addProductionItem(id) {
  if (production.find(p => p.id === id)) return;
  const recipes = recipesByOutput[id] || [];
  if (!recipes.length) return;
  const p = { id, recipeId: recipes[0].id, rate: 0, locked: false, optimized: false };
  production.push(p);   // push first so prodEntry(id) works inside solveMaxForItem
  invalidateMaxCache();
  recomputeMax(p);
  invalidateChainCache();
  _lastGraph = null; _lastFacilityCounts = null; _lastPlacementCounts = null;
  renderAll();
}
function removeFromProduction(id) {
  const idx = production.findIndex(p => p.id === id);
  if (idx < 0) return;
  production.splice(idx, 1);
  if (tempPinnedId === id) tempPinnedId = null;
  invalidateChainCache();
  _lastGraph = null; _lastFacilityCounts = null; _lastPlacementCounts = null;
  renderAll();
}
function toggleProdLock(id) {
  const p = prodEntry(id);
  if (!p) return;
  if (tempPinnedId === id) {
    // Temp-pinned → promote to permanent lock (don't unpin)
    tempPinnedId = null;
    p.locked = true;
    p.optimized = false;
  } else if (p.locked) {
    // Permanently locked → unpin
    p.locked = false;
    p.optimized = false;
  } else {
    // Free → permanently lock
    p.locked = true;
    p.optimized = false;
  }
  // Always do a full renderProducts so the button icon/class updates immediately.
  renderProducts();
  if (autoSolveOn()) runSolver(); else runSolver(false, true);
}

function setSliderFill(slider) {
  const min = +slider.min || 0, max = +slider.max || 1;
  const pct = max > min ? ((+slider.value - min) / (max - min)) * 100 : 0;
  slider.style.setProperty('--fill', pct.toFixed(2) + '%');
}

// During a slider drag the packer runs in lite mode (cached crucible bins).
// scheduleSettle debounces a final FULL solve after input stops so the crucible
// packing settles to the exact rates — robust to any input source (mouse,
// keyboard, pointer released off-window).  Resetting on each input + cancelling
// on pointerdown means the full solve fires only once, after the user is done.
//
// The settled pass also canonicalises and repacks the result. SETTLE_DELAY is
// sized so that
// "let go then immediately re-grab" lands its pointerdown (which clears the
// timer) BEFORE the settle fires.  pointerdown also flips _dragging, so the
// fire-time guard skips a settle that races a fresh grab.
const SETTLE_DELAY = 320;
let _settleTimer = null;
function settleNow() {
  clearTimeout(_settleTimer); _settleTimer = null;
  clearTimeout(_controlSolveTimer); _controlSolveTimer = null;
  if (typeof cancelScheduledSolverWork === 'function') cancelScheduledSolverWork();
  if (autoSolveOn()) runSolver(false);
  else { renderProducts(); runSolver(false, true); }
}
function scheduleSettle() {
  clearTimeout(_settleTimer);
  _settleTimer = setTimeout(() => {
    _settleTimer = null;
    if (!_dragging) settleNow();   // skip if a re-grab is already in progress
  }, SETTLE_DELAY);
}

function renderProducts() {
  if (_prodSortable) { _prodSortable.destroy(); _prodSortable = null; }
  const el = document.getElementById('prod-list');
  el.innerHTML = '';
  if (!production.length) {
    el.innerHTML = '<div class="empty-state">Search for items above to add production targets</div>';
    document.getElementById('prod-pill').textContent = '0';
    return;
  }
  production.forEach(p => {
    if (p.maxRate === undefined) recomputeMax(p);
    const it = itemById[p.id];
    if (!it) return;
    const mx = p.maxRate || 1e6;
    const isTemp = tempPinnedId === p.id;
    const btnClass = p.locked ? 'lock-on' : isTemp ? 'pin-temp' : '';
    const iconName = (p.locked || isTemp) ? 'pin' : 'pin-off';
    const title = p.locked ? 'Unpin (free for solver)' : isTemp ? 'Make permanent pin' : 'Pin (fix for solver)';
    const recipe = recipeFor(p);
    const d = document.createElement('div');
    d.className = 'prod-item-row' + (p.locked || isTemp ? ' locked' : '');
    d.dataset.prodId = p.id;
    d.innerHTML = `
      <div class="drag-handle"><i data-lucide="grip-vertical" style="width:14px;height:14px;pointer-events:none;"></i></div>
      <div class="prod-item-icon"><img src="assets/icons/items/${it.iconFile}" class="mat-icon"></div>
      <div class="prod-item-right">
        <div class="prod-item-top">
          <span class="item-name">${it.name}</span>
        </div>
        <div class="prod-item-bottom">
          <input class="prod-slider ${p.locked||isTemp?'locked':''}" type="range" min="0" max="${Math.min(mx,1e6).toFixed(3)}" step="any" value="${Math.min(p.rate,Math.min(mx,1e6)).toFixed(3)}">
          <input class="prod-rate-display" type="number" min="0" max="${Math.min(mx,1e6).toFixed(3)}" value="${p.rate.toFixed(3)}">
          <span class="prod-max-label">/ ${mx < 1e5 ? mx.toFixed(1) : '∞'}</span>
        </div>
      </div>
      <div class="prod-item-actions">
        <button class="icon-btn del" onclick="removeFromProduction('${p.id}')">✕</button>
        <button class="icon-btn ${btnClass}" onclick="toggleProdLock('${p.id}')" title="${title}"><i data-lucide="${iconName}" style="width:13px;height:13px;pointer-events:none;"></i></button>
      </div>`;
    const slider = d.querySelector('.prod-slider');
    const display = d.querySelector('.prod-rate-display');
    const pid = p.id;
    if (pid === _infeasibleProdId) {
      slider.classList.add('infeasible');
      d.querySelector('.icon-btn:not(.del)')?.classList.add('infeasible');
    }
    slider.addEventListener('pointerdown', () => {
      _dragging = true;            // suppress the debounced settle until the drag ends
      clearTimeout(_controlSolveTimer); _controlSolveTimer = null;
      clearTimeout(_settleTimer);  // cancel a pending settle so a fresh grab never blocks
      const pe = prodEntry(pid);
      if (!pe.locked) {
        tempPinnedId = pid;
        const btn = d.querySelector('.icon-btn:not(.del)');
        if (btn) { btn.className = 'icon-btn pin-temp'; btn.title = 'Make permanent pin'; const ico = btn.querySelector('i'); if (ico) { ico.dataset.lucide = 'pin'; lucide.createIcons({el: btn}); } }
        document.querySelectorAll('.prod-item-row').forEach(row => {
          const rowId = row.dataset.prodId;
          const rp = rowId && rowId !== pid ? prodEntry(rowId) : null;
          if (!rp || rp.locked) return;
          const prevBtn = row.querySelector('.icon-btn:not(.del)');
          if (prevBtn && prevBtn.classList.contains('pin-temp')) { prevBtn.className = 'icon-btn'; prevBtn.title = 'Pin (fix for solver)'; const ico = prevBtn.querySelector('i'); if (ico) { ico.dataset.lucide = 'pin-off'; lucide.createIcons({el: prevBtn}); } }
        });
      }
    });
    slider.addEventListener('input', () => {
      _lastChangedProdId = pid;
      const pe = prodEntry(pid);
      // Keyboard-driven range input has no pointerdown to establish the
      // temporary pin; give it the same ownership semantics as mouse dragging.
      if (!pe.locked) tempPinnedId = pid;
      pe.rate = +slider.value; pe.optimized = false;
      display.value = pe.rate.toFixed(3);
      setSliderFill(slider);
      if (autoSolveOn()) _lastInputT = performance.now();
      runSolverThrottled(true, !autoSolveOn());
      // Only the keyboard path debounces a settle here.  While a pointer drag is
      // in progress (_dragging) we must NOT — the heavy crucible re-pack would
      // fire on every mid-drag pause and freeze the slider.  Pointer drags settle
      // once, on pointerup/pointercancel.
      if (!_dragging) scheduleSettle();
    });
    const endDrag = () => {
      if (!_dragging) return;
      _dragging = false;
      // Keep pointerup cheap: no synchronous re-render here.  The in-place slider
      // values are already current, and the deferred settle (if not cancelled by
      // an immediate re-grab) re-renders the list when it runs.
      scheduleSettle();
    };
    slider.addEventListener('pointerup', endDrag);
    slider.addEventListener('pointercancel', endDrag);
    display.addEventListener('change', () => {
      _lastChangedProdId = pid;
      const pe = prodEntry(pid);
      const mx2 = pe.maxRate || 1e6;
      pe.rate = Math.min(Math.min(mx2, 1e6), Math.max(0, +display.value));
      pe.optimized = false;
      display.value = pe.rate.toFixed(3);
      slider.value = pe.rate.toFixed(3);
      if (autoSolveOn()) runSolver(); else runSolver(false, true);
    });
    el.appendChild(d);
  });
  document.getElementById('prod-pill').textContent = production.length;
  if (typeof lucide !== 'undefined') lucide.createIcons();
  const labels = el.querySelectorAll('.prod-max-label');
  labels.forEach(l => { l.style.width = ''; });
  let maxW = 0;
  labels.forEach(l => { maxW = Math.max(maxW, l.getBoundingClientRect().width); });
  if (maxW > 0) labels.forEach(l => { l.style.width = maxW + 'px'; });
  el.querySelectorAll('.prod-slider').forEach(setSliderFill);
  if (typeof Sortable !== 'undefined') {
    _prodSortable = Sortable.create(el, {
      animation: 150,
      handle: '.drag-handle',
      ghostClass: 'prod-ghost',
      chosenClass: 'prod-chosen',
      onEnd(evt) {
        if (evt.oldIndex === evt.newIndex) return;
        const [moved] = production.splice(evt.oldIndex, 1);
        production.splice(evt.newIndex, 0, moved);
        tempPinnedId = null;
        saveState();
        runSolver(false, !autoSolveOn());
      }
    });
  }
}

/* ═══════════════════════════════════════════════
   POWER BATTERIES PANEL
═══════════════════════════════════════════════ */
function getBatPortal() {
  let el = document.getElementById('bat-portal');
  if (!el) { el = document.createElement('div'); el.id = 'bat-portal'; el.className = 'mat-search-dropdown'; el.style.cssText = 'position:fixed;z-index:9999;display:none;'; document.body.appendChild(el); }
  return el;
}
function filterBatSearch() {
  const input = document.getElementById('power-bat-input'); if (!input) return;
  const dd = getBatPortal();
  const q = input.value.trim().toLowerCase();
  const added = new Set(powerBatteries.map(pb => pb.matId));
  const available = itemsDB.filter(it => !added.has(it.id) && (it.id.includes('battery') || it.id.includes('proc_battery')));
  const matches = q ? available.filter(it => it.name.toLowerCase().includes(q)) : available;
  dd.innerHTML = matches.length
    ? matches.slice(0, 20).map(it => `<div class="mat-search-item" onmousedown="pickBatMat('${it.id}')"><img src="assets/icons/items/${it.iconFile}" class="mat-icon"><span>${it.name}</span></div>`).join('')
    : '<div class="mat-search-empty">No matching batteries</div>';
  dd.style.display = 'block';
  positionPortal(dd, input);
}
function closeBatSearch() { const dd = document.getElementById('bat-portal'); if (dd) dd.style.display = 'none'; }
function pickBatMat(mid) {
  const input = document.getElementById('power-bat-input'); if (input) input.value = '';
  closeBatSearch();
  if (!powerBatteries.find(pb => pb.matId === mid)) { powerBatteries.push({ matId: mid, rate: 1 }); renderPowerBatteries(); computeSummary(); }
}
function removePowerBattery(i) { powerBatteries.splice(i, 1); renderPowerBatteries(); computeSummary(); }
function renderPowerBatteries() {
  const el = document.getElementById('power-bat-list'); if (!el) return;
  if (!powerBatteries.length) { el.innerHTML = ''; return; }
  el.innerHTML = powerBatteries.map((pb, i) => {
    const it = itemById[pb.matId];
    if (!it) return '';
    const p = prodEntry(pb.matId);
    const prodRate = p ? p.rate : 0;
    const netRate = Math.max(0, pb.rate - prodRate);
    const costHr = netRate * priceOf(pb.matId) * 60;
    const fuel = powerFuelsDB[pb.matId];
    const banks = fuel ? pb.rate / fuel.fuelPerMinutePerBank : 0;
    const generation = fuel ? banks * fuel.powerGeneration : 0;
    return `<div class="power-bat-row">
      <img src="assets/icons/items/${it.iconFile}" class="mat-icon">
      <span style="flex:1;min-width:0;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${generation.toFixed(1)} power from ${banks.toFixed(2)} sustained Thermal Bank(s) · external fuel cost ${fmt(costHr)}/hr">${it.name}<small style="display:block;color:var(--text3);font-size:9px;">${generation.toFixed(1)} power · ${banks.toFixed(2)} bank</small></span>
      <input type="number" value="${pb.rate}" min="0" step="0.01" class="fac-num-input"
        onchange="powerBatteries[${i}].rate=Math.max(0,+this.value);renderPowerBatteries();computeSummary()">
      <span class="prod-max-label">/min</span>
      <button class="icon-btn del" style="width:18px;height:18px;font-size:11px;" onclick="removePowerBattery(${i})">✕</button>
    </div>`;
  }).join('');
}

/* ═══════════════════════════════════════════════
   PRICES TAB  (replaces old Materials tab)
═══════════════════════════════════════════════ */
function getPricePortal() {
  let el = document.getElementById('price-portal');
  if (!el) { el = document.createElement('div'); el.id = 'price-portal'; el.className = 'mat-search-dropdown'; el.style.cssText = 'position:fixed;z-index:9999;display:none;'; document.body.appendChild(el); }
  return el;
}
function filterPriceSearch() {
  const input = document.getElementById('price-search-input');
  if (!input) return;
  const dd = getPricePortal();
  const q = input.value.trim().toLowerCase();
  if (!q) { dd.style.display = 'none'; return; }
  const matches = itemsDB.filter(it => isTargetItem(it.id) && it.name.toLowerCase().includes(q)).slice(0, 24);
  dd.innerHTML = matches.length
    ? matches.map(it => `<div class="mat-search-item" onmousedown="addPriceEntry('${it.id}')">
        <img src="assets/icons/items/${it.iconFile}" class="mat-icon"><span>${it.name}</span>
        ${prices[it.id] ? `<span style="font-size:10px;color:var(--text3);margin-left:auto;">${prices[it.id]}</span>` : ''}
      </div>`).join('')
    : '<div class="mat-search-empty">No matching items</div>';
  dd.style.display = 'block';
  positionPortal(dd, input);
}
function closePriceSearch() { const dd = document.getElementById('price-portal'); if (dd) dd.style.display = 'none'; }
function addPriceEntry(id) {
  const input = document.getElementById('price-search-input'); if (input) input.value = '';
  closePriceSearch();
  if (!prices[id]) prices[id] = 0;
  renderPricesTab();
}
function renderPricesTab() {
  const el = document.getElementById('price-config-list'); if (!el) return;
  const priced = Object.keys(prices).filter(id => itemById[id]);
  if (!priced.length) { el.innerHTML = '<div class="empty-state">Search for items above to set their sell price</div>'; return; }
  el.innerHTML = '';
  priced.forEach(id => {
    const it = itemById[id];
    const d = document.createElement('div');
    d.className = 'item-row';
    d.style.gridTemplateColumns = 'auto 1fr 80px auto';
    d.style.gap = '0.5rem';
    d.innerHTML = `<img src="assets/icons/items/${it.iconFile}" class="mat-icon">
      <span class="item-name">${it.name}</span>
      <input class="num-input" type="number" value="${prices[id]}" min="0"
        onchange="prices['${id}']=+this.value;saveState();computeSummary()">
      <button class="icon-btn del" onclick="deletePriceEntry('${id}')">✕</button>`;
    el.appendChild(d);
  });
}
function deletePriceEntry(id) { delete prices[id]; saveState(); renderPricesTab(); computeSummary(); }

/* Pipeline helpers, graph builder, flow analysis, solver state, runSolverThrottled → solver_pipeline.js §§ 3–6 */

// Returns a function (recipe → scale factor) based on the ratio of current
// production rates to the rates that were in effect during the last LP solve.
// Used to update resource/facility usage when sliders change without re-solving.
function getSolvedScale() {
  if (!_lastSolvedRates || !production.length) return () => 1;
  const itemScale = {};
  production.forEach(p => {
    const solved = _lastSolvedRates[p.id];
    if (solved != null && solved > 1e-9) itemScale[p.id] = p.rate / solved;
  });
  const vals = Object.values(itemScale);
  const avgScale = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
  return r => {
    const primaryOut = (r.outputs || [])[0];
    if (primaryOut && itemScale[primaryOut.itemId] !== undefined)
      return itemScale[primaryOut.itemId];
    return avgScale;
  };
}

let _lastSummaryRenderMs = 0;
let _lastUsageRenderMs = 0;

function computeSummary() {
  const liveUpdate = !!_solverDragging;
  const getScale = getSolvedScale();
  _lastPlanAggregates = _lastGraph && _lastFacilityCounts
    ? buildPlanAggregates(_lastFacilityCounts, _lastGraph, _lastPlacementCounts, {
        getScale,
        ceilMode: roundUpFacilities,
        lite: _solverDragging,
        metastorageImport: _lastMetastorageImport,
        batteries: powerBatteries,
      })
    : null;
  // Always derive summary rates from p.rate — Phase 6 already snaps LP residuals
  // below 1e-3 to 0, so sliders and summary always agree.
  const netRates = Object.fromEntries(production.map(p => [p.id, Math.max(0, p.rate || 0)]));
  // Subtract power consumption — may push items negative (pure cost) or reduce net.
  // Battery-only entries (not in production) start at 0 and go negative.
  powerBatteries.forEach(pb => {
    netRates[pb.matId] = (netRates[pb.matId] || 0) - pb.rate;
  });
  const outpostCost = parseFloat((document.getElementById('outpost-cost')?.value||'').replace(/,/g,'')) || outpostCostDefault;
  const totalFixedCost = outpostCost;
  const summaryStarted = performance.now();
  renderSummaryTable(netRates, totalFixedCost, liveUpdate);
  _lastSummaryRenderMs = performance.now() - summaryStarted;
  const usageStarted = performance.now();
  renderUsageBars(_lastPlanAggregates, liveUpdate);
  _lastUsageRenderMs = performance.now() - usageStarted;
  // A settled solve persists the final slider state. Intermediate pointer
  // positions do not need to churn the persistence debounce timer.
  if (!liveUpdate) saveState();
}

/* ═══════════════════════════════════════════════
   SUMMARY TABLE
═══════════════════════════════════════════════ */
const SUM_COLS = { product: 260, perMin: 220, price: 120, bill: 140 };
function sumGridCols() {
  const t = (n) => `minmax(min-content,${n}fr)`;
  return `${t(SUM_COLS.product)} ${t(SUM_COLS.perMin)} ${t(SUM_COLS.price)} ${t(SUM_COLS.bill)}`;
}
function sumGridWidth() { return SUM_COLS.product + SUM_COLS.perMin + SUM_COLS.price + SUM_COLS.bill; }

function buildSumProductRow(itemId, iconFile, name, perMinCell, sell, ihr) {
  return `<div class="sg-cell td-name"><img src="assets/icons/items/${iconFile}" class="mat-icon">${name}</div>
    <div class="sg-cell" data-summary-rate="${itemId}">${perMinCell}</div>
    <div class="sg-cell sg-right" style="color:var(--text2);">${sell}</div>
    <div class="sg-cell sg-right ${ihr > 0 ? 'td-pos' : ihr < 0 ? 'td-neg' : ''}" data-summary-bill="${itemId}">${fmt(ihr)}</div>`;
}

// totals: [{label, labelStyle?, valueCls?, valueHTML}]  — last item gets sg-last automatically
function buildSumTotalRows(totals) {
  return totals.map((t, i) => {
    const last = i === totals.length - 1 ? ' sg-last' : '';
    const vCls = t.valueCls != null ? t.valueCls : 'sg-right';
    return `<div class="sg-cell sg-total${last} sg-right" style="grid-column:1/4;font-weight:600;${t.labelStyle || ''}">${t.label}</div>
    <div class="sg-cell sg-total${last} ${vCls}" data-summary-total="${t.key || ''}" style="font-weight:600;">${t.valueHTML}</div>`;
  }).join('');
}

function renderSummaryTable(netRates, fixedCost, incremental = false) {
  const el = document.getElementById('summary-body');
  const batRateMap = Object.fromEntries(powerBatteries.map(pb => [pb.matId, pb.rate]));
  const prodIds = new Set(production.map(p => p.id));
  const batOnlyRows = powerBatteries
    .filter(pb => !prodIds.has(pb.matId))
    .map(pb => ({ it: itemById[pb.matId], net: -pb.rate, ihr: -pb.rate * priceOf(pb.matId) * 60 }))
    .filter(r => r.it && Math.abs(r.net) >= 5e-4);
  const visibleProd = production.filter(p => Math.abs(netRates[p.id] || 0) >= 5e-4);
  if (!visibleProd.length && !batOnlyRows.length) {
    el.innerHTML = '<div class="empty-state">No production items added yet</div>';
    delete el.dataset.summaryStructure;
    return;
  }
  const gridCols = sumGridCols(), totalW = sumGridWidth();
  // Production Summary and every result window beneath it share this width.
  document.documentElement.style.setProperty('--main-window-width', `${totalW}px`);
  document.querySelectorAll('#page-main .production-summary-wrap').forEach(w => {
    w.style.width = '100%'; w.style.maxWidth = totalW + 'px';
  });
  const rows = [];
  production.forEach(p => {
    const net = netRates[p.id] || 0;
    if (Math.abs(net) < 5e-4) return;
    const it = itemById[p.id]; if (!it) return;
    const ihr = priceOf(p.id) * net * 60;
    let statusIcon = p.locked
      ? `<i data-lucide="lock" class="status-icon" style="color:var(--locked);"></i>`
      : p.optimized ? `<i data-lucide="badge-check" class="status-icon" style="color:var(--positive);"></i>` : '';
    const iconOrPlaceholder = statusIcon || `<span class="status-icon status-icon-placeholder"></span>`;
    const batRate = batRateMap[p.id] || 0;
    const rateSpan = batRate > 0
      ? `<span class="summary-rate-primary">${_fmtN(p.rate || 0)}</span><span class="summary-rate-battery" style="color:var(--text3);margin-left:0.3em;">(-${_fmtN(batRate)})</span>`
      : `<span class="summary-rate-primary">${_fmtN(net)}</span>`;
    rows.push({ id: p.id, it, ihr, displayRate: batRate > 0 ? p.rate || 0 : net, batRate, perMinCell: `<span class="per-min-wrap">${iconOrPlaceholder}${rateSpan}</span>` });
  });
  batOnlyRows.forEach(({ it, net, ihr }) => {
    rows.push({ id: it.id, it, ihr, displayRate: net, batRate: 0, perMinCell: `<span class="per-min-wrap"><span class="status-icon status-icon-placeholder"></span><span class="summary-rate-primary">${_fmtN(net)}</span></span>` });
  });
  const totalIhr = rows.reduce((s, r) => s + r.ihr, 0);
  const fc = fixedCost != null ? fixedCost : (parseFloat((document.getElementById('outpost-cost')?.value || String(outpostCostDefault)).replace(/,/g,'')) || 0);
  const netHr = totalIhr - fc;
  const totals = [
    { key: 'income', label: 'Income', labelStyle: 'color:var(--text2);', valueCls: 'sg-right td-pos', valueHTML: fmt(totalIhr) },
    { key: 'outpost', label: 'Outpost bill', labelStyle: 'color:var(--text2);', valueCls: 'sg-outpost-cell td-neg',
      valueHTML: `<span>-</span><input type="text" inputmode="numeric" id="outpost-cost" value="${fc.toLocaleString('en',{minimumFractionDigits:1,maximumFractionDigits:1})}" class="fac-num-input outpost-input" onchange="outpostCostDefault=parseFloat(this.value.replace(/,/g,''))||0;this.value=outpostCostDefault.toLocaleString('en',{minimumFractionDigits:1,maximumFractionDigits:1});saveState();computeSummary()">` },
    { key: 'net', label: 'Net profit', valueCls: `sg-right ${netHr >= 0 ? 'td-pos' : 'td-neg'}`, valueHTML: `${netHr >= 0 ? '+' : ''}${fmt(netHr)}` },
  ];

  const structure = rows.map(row => `${row.id}:${row.batRate > 0 ? 1 : 0}`).join('|');
  if (incremental && el.dataset.summaryStructure === structure) {
    const rateCells = new Map([...el.querySelectorAll('[data-summary-rate]')]
      .map(cell => [cell.dataset.summaryRate, cell]));
    const billCells = new Map([...el.querySelectorAll('[data-summary-bill]')]
      .map(cell => [cell.dataset.summaryBill, cell]));
    rows.forEach(row => {
      const rate = rateCells.get(row.id)?.querySelector('.summary-rate-primary');
      if (rate) rate.textContent = _fmtN(row.displayRate);
      const battery = rateCells.get(row.id)?.querySelector('.summary-rate-battery');
      if (battery) battery.textContent = `(-${_fmtN(row.batRate)})`;
      const bill = billCells.get(row.id);
      if (bill) {
        bill.textContent = fmt(row.ihr);
        bill.className = `sg-cell sg-right ${row.ihr > 0 ? 'td-pos' : row.ihr < 0 ? 'td-neg' : ''}`;
      }
    });
    const income = el.querySelector('[data-summary-total="income"]');
    if (income) income.textContent = fmt(totalIhr);
    const net = el.querySelector('[data-summary-total="net"]');
    if (net) {
      net.textContent = `${netHr >= 0 ? '+' : ''}${fmt(netHr)}`;
      net.className = `sg-cell sg-total sg-last sg-right ${netHr >= 0 ? 'td-pos' : 'td-neg'}`;
    }
    return;
  }
  el.innerHTML = `<div class="sum-grid" style="grid-template-columns:${gridCols}">
    <div class="sg-cell sg-head">Product</div>
    <div class="sg-cell sg-head">Per minute</div>
    <div class="sg-cell sg-head sg-right">Price</div>
    <div class="sg-cell sg-head sg-right">Bill / hour</div>
    ${rows.map(({ id, it, ihr, perMinCell }) => buildSumProductRow(id, it.iconFile, it.name, perMinCell, priceOf(it.id), ihr)).join('')}
    ${buildSumTotalRows(totals)}
    <div class="sg-cell sg-save-row" style="grid-column:1/-1;"><button class="btn-save-snapshot" onclick="saveSnapshot()">Save Production</button></div>
  </div>`;
  el.dataset.summaryStructure = structure;
  if (typeof lucide !== 'undefined') lucide.createIcons({ el });
}

/* ═══════════════════════════════════════════════
   USAGE BARS
═══════════════════════════════════════════════ */
function renderUsageBars(plan, incremental = false) {
  const el = document.getElementById('usage-bars');
  const FAC_COLORS = ['#60a5fa','#f97316','#4ade80','#f87171','#a78bfa','#facc15','#34d399','#fb7185','#38bdf8','#c084fc'];
  const rawCapMap = Object.fromEntries(rawLimits.map(rl => [rl.matId, rl.cap]));
  const facLimitMap = Object.fromEntries(facilityLimits.map(f => [f.gameFacilityId, f]));
  const flows = plan?.resourceFlows || {};
  const resourceIds = new Set([...Object.keys(flows), ...rawLimits.map(r => r.matId)]);
  const allFacIds = new Set([
    ...(plan ? [...plan.facilityEffective.keys()] : []),
    ...facilityLimits.map(f => f.gameFacilityId),
  ]);
  const resourceUpdates = new Map();
  const facilityUpdates = new Map();
  const segmentUpdates = new Map();
  const binCountUpdates = new Map();
  let resourceStructure = [];
  let facilityStructure = [];
  let metaSummaryHtml = '';

  if (!resourceIds.size && !allFacIds.size) {
    el.innerHTML = '<div class="empty-state">Solve a production to see usage</div>';
    delete el.dataset.usageStructure;
    return;
  }

  const displayCount = value => roundUpFacilities
    ? String(Math.ceil(Math.max(0, value) - 1e-9))
    : (Math.max(0, value) || 0).toFixed(2);
  let html = '';

  const renderResourceRows = itemIds => itemIds.map(itemId => {
    const item = itemById[itemId];
    if (!item) return '';
    const flow = flows[itemId] || { generated: 0, localGenerated: 0, consumed: 0, imported: 0, net: 0, raw: 0 };
    const cap = rawCapMap[itemId];
    const hasCap = cap != null;
    const used = flow.raw || 0;
    const over = hasCap && used > cap + 1e-9;
    const scale = Math.max(flow.generated, flow.consumed, hasCap ? cap : 0, 1e-9);
    const localPct = Math.min(100, flow.localGenerated / scale * 100);
    const importPct = Math.min(100 - localPct, flow.imported / scale * 100);
    const usePct = Math.min(100, flow.consumed / scale * 100);
    const netText = `${flow.net >= 0 ? '+' : ''}${flow.net.toFixed(1)}`;
    const nums = hasCap
      ? `${used.toFixed(1)} / ${cap}${item.rawUnit ? ` ${item.rawUnit}` : ''}`
      : `+${flow.generated.toFixed(1)} −${flow.consumed.toFixed(1)} = ${netText}`;
    const labelBadges = `${forcedRawSet.has(itemId) ? '<em>raw</em>' : ''}${flow.imported > 1e-9 ? '<em class="meta">meta</em>' : ''}`;
    const tip = `${item.name}: generated ${flow.generated.toFixed(3)}/min (${flow.imported.toFixed(3)} imported), consumed ${flow.consumed.toFixed(3)}/min, net ${netText}/min`;
    resourceUpdates.set(itemId, { localPct, importPct, usePct, over, nums, tip });
    return `<div class="res-bar-row" data-resource-id="${itemId}">
      <span class="res-bar-label" title="${tip}"><img src="assets/icons/items/${item.iconFile}" class="mat-icon" style="margin-right:3px;">${item.name}${labelBadges}</span>
      <div class="res-flow-track" title="${tip}">
        <div class="res-flow-half generated"><span class="res-flow-local" style="width:${localPct.toFixed(2)}%"></span><span class="res-flow-import" style="width:${importPct.toFixed(2)}%"></span></div>
        <div class="res-flow-half consumed"><span class="${over ? 'bar-over' : 'res-flow-consumed'}" style="width:${usePct.toFixed(2)}%"></span></div>
      </div>
      <span class="res-bar-nums ${over ? 'td-neg' : ''}">${nums}</span>
    </div>`;
  }).join('');

  if (plan) {
    const netPower = plan.netPower;
    html += `<div class="usage-kpis">
      <div class="usage-kpi" data-usage-kpi="facilities"><span>Facilities</span><strong>${displayCount(plan.totalFacilities)}</strong></div>
      <div class="usage-kpi" data-usage-kpi="draw"><span>Power draw</span><strong>${fmt(plan.totalPowerConsumption)}</strong></div>
      <div class="usage-kpi" data-usage-kpi="generated"><span>Power generated</span><strong>${fmt(plan.totalPowerGeneration)}</strong></div>
      <div class="usage-kpi" data-usage-kpi="balance"><span>Power balance</span><strong class="${netPower >= 0 ? 'td-pos' : 'td-neg'}">${netPower >= 0 ? '+' : ''}${fmt(netPower)}</strong></div>
    </div>`;
  }

  if (resourceIds.size) {
    const orderedResources = [...resourceIds].sort((a, b) => {
      const ar = forcedRawSet.has(a) || rawCapMap[a] != null || (flows[a]?.raw || 0) > 1e-9 ? 0 : 1;
      const br = forcedRawSet.has(b) || rawCapMap[b] != null || (flows[b]?.raw || 0) > 1e-9 ? 0 : 1;
      return ar - br || (itemById[a]?.name || a).localeCompare(itemById[b]?.name || b);
    });
    const rawResources = orderedResources.filter(id =>
      forcedRawSet.has(id) || rawCapMap[id] != null || (flows[id]?.raw || 0) > 1e-9);
    const rawResourceSet = new Set(rawResources);
    const metaResources = orderedResources.filter(id =>
      !rawResourceSet.has(id) && (flows[id]?.imported || 0) > 1e-9);
    const metaResourceSet = new Set(metaResources);
    const intermediateResources = orderedResources.filter(id =>
      !rawResourceSet.has(id) && !metaResourceSet.has(id));
    resourceStructure = [
      ['raw', rawResources.map(id => [id, (flows[id]?.imported || 0) > 1e-9])],
      ['meta', metaResources],
      ['intermediate', intermediateResources],
    ];

    if (rawResources.length) {
      html += `<section class="usage-resource-group raw-resource-group">
        <div class="usage-section-title">Raw materials</div>
        <div class="res-bar-grid resource-flow-grid">${renderResourceRows(rawResources)}</div>
      </section>`;
    }

    if (autoMetaTransfer || metaResources.length) {
      const meta = plan?.metastorageImport;
      let metaSummary = '<div class="meta-transfer-row meta-transfer-empty"><span class="meta-transfer-label">Auto Metastorage</span><span>No beneficial transfer selected</span></div>';
      if (meta) {
        const item = itemById[meta.itemId];
        const perCycle = meta.ratePerMinute * (meta.cycleSeconds / 60);
        metaSummary = `<div class="meta-transfer-row">
          <span class="meta-transfer-label">Auto Metastorage</span>
          ${item ? icon(item.id) : ''}<strong>${item?.name || meta.itemId}</strong>
          <span>${meta.ratePerMinute.toFixed(3)}/min · ${perCycle.toFixed(1)}/delivery · ${meta.ttvUsedPerMinute.toFixed(2)} / ${meta.ttvBudgetPerMinute.toFixed(2)} TTV/min</span>
        </div>`;
      }
      metaSummaryHtml = metaSummary;
      html += `<section class="usage-resource-group meta-resource-group">
        <div class="usage-section-title">Meta transfer</div>${metaSummary}
        ${metaResources.length ? `<div class="res-bar-grid resource-flow-grid">${renderResourceRows(metaResources)}</div>` : ''}
      </section>`;
    }

    if (intermediateResources.length) {
      html += `<section class="usage-resource-group intermediate-resource-group">
        <div class="usage-section-title">Intermediate materials</div>
        <div class="intermediate-resource-scroll"><div class="res-bar-grid resource-flow-grid">${renderResourceRows(intermediateResources)}</div></div>
      </section>`;
    }
  }

  if (allFacIds.size) {
    const orderedFacilities = [...allFacIds].sort((a, b) =>
      (facilityTypeById[a]?.name || a).localeCompare(facilityTypeById[b]?.name || b));
    facilityStructure = orderedFacilities.map(fid => {
      const facility = facilityTypeById[fid];
      const bins = plan?.binsByFacility.get(fid) || [];
      if ((facility?.cacheSlots ?? 1) > 1 && bins.length)
        return [fid, 'bins', bins.slice().sort((a, b) =>
          b.buildingCount - a.buildingCount || b.recipeIds.length - a.recipeIds.length)
          .map(bin => bin.recipeIds)];
      return [fid, 'segments', (plan?.facilitySegments.get(fid) || [])
        .map(segment => [segment.itemId || '', segment.direction || ''])];
    });
    html += `<section class="facility-usage-section">
      <div class="usage-section-title facility-section-title">
        <span>Facilities &amp; power</span>
        <span class="usage-header-toggle">
          <span>Round up facilities</span>
          <label class="tog-wrap" title="Display physical whole-building counts and power">
            <input type="checkbox" class="tog-cb" id="round-facilities-toggle"
              ${roundUpFacilities ? 'checked' : ''}
              onchange="roundUpFacilities=this.checked;saveState();computeSummary()">
            <span class="tog-track"></span>
          </label>
        </span>
      </div>
      <div class="fac-grid">`;
    orderedFacilities.forEach(fid => {
      const effective = plan?.facilityEffective.get(fid) || 0;
      const load = plan?.facilityLoad.get(fid) || 0;
      const physical = plan?.facilityPhysical.get(fid) || 0;
      const limit = facLimitMap[fid];
      const cap = limit?.cap;
      const hasCap = cap != null;
      const facility = facilityTypeById[fid];
      const facName = limit?.name || facility?.name || fid;
      const over = hasCap && physical > cap + 1e-9;
      const power = effective * (facility?.power || 0);
      const countText = hasCap ? `${displayCount(effective)} / ${cap}u` : `${displayCount(effective)}u`;
      const bins = plan?.binsByFacility.get(fid) || [];
      const isMulti = (facility?.cacheSlots ?? 1) > 1;
      let bodyHtml;
      facilityUpdates.set(fid, {
        over,
        countText,
        powerText: `${fmt(power)} power`,
        modeText: roundUpFacilities ? 'physical' : 'theoretical',
        title: `${physical} whole placement(s); ${load.toFixed(3)} slot/pickup load`,
      });

      if (isMulti && bins.length) {
        bodyHtml = '<div class="fac-bins">' + bins.slice().sort((a, b) =>
          b.buildingCount - a.buildingCount || b.recipeIds.length - a.recipeIds.length).map((bin, binIndex) => {
          const total = bin.recipeIds.reduce((sum, rid) => sum + (bin.active.get(rid) || 0), 0) || 1;
          const mean = total / Math.max(1, bin.recipeIds.length);
          const binCount = roundUpFacilities ? bin.buildingCount : mean;
          const segs = bin.recipeIds.map((rid, si) => {
            const recipe = recipeById[rid];
            const active = bin.active.get(rid) || 0;
            const display = _recipeDisplayFlow(recipe, active);
            const item = display.itemId ? itemById[display.itemId] : null;
            const action = display.direction === 'input' ? ' consumed' : '';
            const image = item?.iconFile ? `<img src="assets/icons/items/${item.iconFile}">` : '';
            const liveKey = `${fid}:b${binIndex}:s${si}`;
            segmentUpdates.set(liveKey, {
              width: `${(active / total * 100).toFixed(2)}%`,
              tip: `${item?.name || rid}${action}: ${display.rate.toFixed(1)}/min`,
            });
            return `<div class="fac-bin-seg" data-live-segment="${liveKey}" style="width:${(active / total * 100).toFixed(2)}%;border-bottom-color:${FAC_COLORS[si % FAC_COLORS.length]};" data-tip="${item?.name || rid}${action}: ${display.rate.toFixed(1)}/min" data-icon="${item?.iconFile || ''}">${image}</div>`;
          }).join('');
          const binKey = `${fid}:b${binIndex}`;
          binCountUpdates.set(binKey, `×${displayCount(binCount)}`);
          return `<div class="fac-bin-row"><span class="fac-bin-count" data-live-bin="${binKey}">×${displayCount(binCount)}</span><div class="fac-bin-track">${segs}</div></div>`;
        }).join('') + '</div>';
      } else {
        const segments = plan?.facilitySegments.get(fid) || [];
        const denominator = Math.max(load, hasCap ? cap : 0, 1e-9);
        const segHtml = segments.map((segment, si) => {
          const item = segment.itemId ? itemById[segment.itemId] : null;
          const action = segment.direction === 'input' ? ' consumed'
            : segment.direction === 'source' ? ' supplied'
            : segment.direction === 'power' ? ' burned'
            : '';
          const width = Math.min(100, segment.contrib / denominator * 100);
          const liveKey = `${fid}:s${si}`;
          const tip = `${item?.name || '?'}${action}: ${segment.rate.toFixed(1)}/min · ${segment.contrib.toFixed(2)}u`;
          segmentUpdates.set(liveKey, { width: `${width.toFixed(2)}%`, tip });
          return `<div class="fac-seg" data-live-segment="${liveKey}" style="width:${width.toFixed(2)}%;background:${FAC_COLORS[si % FAC_COLORS.length]};" data-tip="${tip}" data-icon="${item?.iconFile || ''}"></div>`;
        }).join('');
        bodyHtml = `<div class="fac-seg-track">${segHtml}</div>`;
      }

      html += `<div class="fac-card ${over ? 'fac-card-over' : ''}" data-facility-id="${fid}" title="${physical} whole placement(s); ${load.toFixed(3)} slot/pickup load">
        <div class="fac-card-header">
          ${facIcon(fid)}
          <span class="fac-card-name">${facName}</span>
          <span class="fac-card-count ${over ? 'td-neg' : ''}">${countText}</span>
        </div>
        <div class="fac-card-meta"><span>${roundUpFacilities ? 'physical' : 'theoretical'}</span><span>${fmt(power)} power</span></div>
        ${bodyHtml}
      </div>`;
    });
    html += '</div></section>';
  }

  const usageStructure = JSON.stringify({
    hasPlan: !!plan,
    roundUpFacilities,
    showMeta: !!(autoMetaTransfer || plan?.metastorageImport),
    metaItem: plan?.metastorageImport?.itemId || '',
    resources: resourceStructure,
    facilities: facilityStructure,
  });

  if (incremental && el.dataset.usageStructure === usageStructure) {
    if (plan) {
      const kpis = {
        facilities: displayCount(plan.totalFacilities),
        draw: fmt(plan.totalPowerConsumption),
        generated: fmt(plan.totalPowerGeneration),
        balance: `${plan.netPower >= 0 ? '+' : ''}${fmt(plan.netPower)}`,
      };
      Object.entries(kpis).forEach(([key, value]) => {
        const strong = el.querySelector(`[data-usage-kpi="${key}"] strong`);
        if (!strong) return;
        strong.textContent = value;
        if (key === 'balance') strong.className = plan.netPower >= 0 ? 'td-pos' : 'td-neg';
      });
    }

    const resourceRows = new Map([...el.querySelectorAll('[data-resource-id]')]
      .map(row => [row.dataset.resourceId, row]));
    resourceUpdates.forEach((update, itemId) => {
      const row = resourceRows.get(itemId);
      if (!row) return;
      const label = row.querySelector('.res-bar-label');
      const track = row.querySelector('.res-flow-track');
      if (label) label.title = update.tip;
      if (track) track.title = update.tip;
      const local = row.querySelector('.res-flow-local');
      const imported = row.querySelector('.res-flow-import');
      const consumed = row.querySelector('.res-flow-half.consumed > span');
      const nums = row.querySelector('.res-bar-nums');
      if (local) local.style.width = `${update.localPct.toFixed(2)}%`;
      if (imported) imported.style.width = `${update.importPct.toFixed(2)}%`;
      if (consumed) {
        consumed.style.width = `${update.usePct.toFixed(2)}%`;
        consumed.className = update.over ? 'bar-over' : 'res-flow-consumed';
      }
      if (nums) {
        nums.textContent = update.nums;
        nums.className = `res-bar-nums ${update.over ? 'td-neg' : ''}`;
      }
    });

    if (metaSummaryHtml) {
      const currentMeta = el.querySelector('.meta-transfer-row');
      if (currentMeta) currentMeta.outerHTML = metaSummaryHtml;
    }

    const facilityCards = new Map([...el.querySelectorAll('[data-facility-id]')]
      .map(card => [card.dataset.facilityId, card]));
    facilityUpdates.forEach((update, facilityId) => {
      const card = facilityCards.get(facilityId);
      if (!card) return;
      card.className = `fac-card ${update.over ? 'fac-card-over' : ''}`;
      card.title = update.title;
      const count = card.querySelector('.fac-card-count');
      if (count) {
        count.textContent = update.countText;
        count.className = `fac-card-count ${update.over ? 'td-neg' : ''}`;
      }
      const meta = card.querySelectorAll('.fac-card-meta span');
      if (meta[0]) meta[0].textContent = update.modeText;
      if (meta[1]) meta[1].textContent = update.powerText;
    });

    const liveSegments = new Map([...el.querySelectorAll('[data-live-segment]')]
      .map(segment => [segment.dataset.liveSegment, segment]));
    segmentUpdates.forEach((update, key) => {
      const segment = liveSegments.get(key);
      if (!segment) return;
      segment.style.width = update.width;
      segment.dataset.tip = update.tip;
    });
    const liveBins = new Map([...el.querySelectorAll('[data-live-bin]')]
      .map(bin => [bin.dataset.liveBin, bin]));
    binCountUpdates.forEach((value, key) => {
      const count = liveBins.get(key);
      if (count) count.textContent = value;
    });
    plan?.packed.warnings.forEach(w => console.warn('[packBins]', w));
    return;
  }

  el.innerHTML = html;
  el.dataset.usageStructure = usageStructure;
  plan?.packed.warnings.forEach(w => console.warn('[packBins]', w));

  let tt = document.getElementById('fac-tooltip');
  if (!tt) {
    tt = document.createElement('div');
    tt.id = 'fac-tooltip';
    document.body.appendChild(tt);
  }
  if (!el.dataset.tooltipBound) {
    el.dataset.tooltipBound = '1';
    el.addEventListener('mouseover', e => {
      const seg = e.target.closest('[data-tip]');
      if (!seg) return;
      const iconFile = seg.dataset.icon;
      tt.innerHTML = iconFile
        ? `<img src="assets/icons/items/${iconFile}" style="width:16px;height:16px;object-fit:contain;vertical-align:middle;margin-right:4px;"> ${seg.dataset.tip}`
        : seg.dataset.tip;
      tt.style.display = 'block';
    });
    el.addEventListener('mousemove', e => {
      if (tt.style.display === 'none') return;
      tt.style.left = (e.clientX + 12) + 'px';
      tt.style.top = (e.clientY - 28) + 'px';
    });
    el.addEventListener('mouseout', e => {
      if (e.target.closest('[data-tip]')) tt.style.display = 'none';
    });
  }
}

/* Solver core (logS, updateSlidersInPlace, runSolver) → solver_pipeline.js § 7 */
/* ═══════════════════════════════════════════════
   SAVED PRODUCTIONS

   A snapshot captures:
     • A `state` blob — every sidenav input (rawLimits, facilityLimits,
       production with pinned flags + recipe overrides, powerBatteries,
       outpostCost). This is what loadSnapshot restores.
     • A pre-rendered `rows` + totals — frozen display for the saved tab,
       so it stays readable even if recipe data later changes.
═══════════════════════════════════════════════ */
const SNAPSHOTS_KEY = 'epc_snapshots_v1';
function loadSnapshots() { try { return JSON.parse(localStorage.getItem(SNAPSHOTS_KEY)) || []; } catch { return []; } }
function saveSnapshots(snaps) { localStorage.setItem(SNAPSHOTS_KEY, JSON.stringify(snaps)); }

// Build display rows + per-battery shortfall from the current solver state,
// mirroring renderSummaryTable so the saved card shows the same numbers as
// the live "Production Summary" panel. If we haven't solved yet, fall back
// to the raw per-target rates from production[].
function snapshotRowsFromCurrent() {
  const prodIds = new Set(production.map(p => p.id));
  // net rates: p.rate already snapped; subtract battery consumption
  const netRates = Object.fromEntries(production.map(p => [p.id, Math.max(0, p.rate || 0)]));
  powerBatteries.forEach(pb => { netRates[pb.matId] = (netRates[pb.matId] || 0) - pb.rate; });

  const batRateMap = Object.fromEntries(powerBatteries.map(pb => [pb.matId, pb.rate]));
  const rows = [];
  production.forEach(p => {
    const net = netRates[p.id] || 0;
    if (Math.abs(net) < 5e-4) return;
    const it = itemById[p.id]; if (!it) return;
    const batRate = batRateMap[p.id] || 0;
    rows.push({ name: it.name, iconFile: it.iconFile, rate: net, grossRate: p.rate || 0, batRate, sell: priceOf(p.id), ihr: priceOf(p.id) * net * 60, locked: !!p.locked });
  });
  // Battery-only rows
  powerBatteries.forEach(pb => {
    if (prodIds.has(pb.matId)) return; // already included above
    const it = itemById[pb.matId]; if (!it) return;
    const net = -pb.rate;
    if (Math.abs(net) < 5e-4) return;
    rows.push({ name: it.name, iconFile: it.iconFile, rate: net, grossRate: 0, batRate: 0, sell: priceOf(pb.matId), ihr: priceOf(pb.matId) * net * 60, locked: false });
  });
  return rows;
}

function saveSnapshot() {
  const name = prompt('Name this production snapshot:', 'Snapshot ' + new Date().toLocaleString());
  if (!name) return;

  const outpostCost = parseFloat((document.getElementById('outpost-cost')?.value ?? outpostCostDefault).toString().replace(/,/g,'')) || 0;

  const rows      = snapshotRowsFromCurrent();
  const totalIhr  = rows.reduce((s, r) => s + r.ihr, 0);
  const fixedCost = outpostCost;
  const netHr     = totalIhr - fixedCost;

  const snap = {
    id: uid(),
    name,
    date: new Date().toISOString(),
    rows, totalIhr, fixedCost, netHr,
    state: {
      production:     JSON.parse(JSON.stringify(production)),
      rawLimits:      JSON.parse(JSON.stringify(rawLimits)),
      facilityLimits: JSON.parse(JSON.stringify(facilityLimits)),
      powerBatteries: JSON.parse(JSON.stringify(powerBatteries)),
      autoMetaTransfer,
      roundUpFacilities,
      outpostCost,
    },
  };
  const snaps = loadSnapshots(); snaps.push(snap); saveSnapshots(snaps);
  switchTab('saved');
  renderSavedTab();
}

// Restore a snapshot's full sidenav state and re-solve.
function loadSnapshot(id) {
  const snap = loadSnapshots().find(s => s.id === id);
  if (!snap || !snap.state) return;
  if (!confirm(`Load "${snap.name}"?\nThis will replace your current setup (resources, facilities, production, batteries, outpost cost).`)) return;

  production     = JSON.parse(JSON.stringify(snap.state.production     || []));
  rawLimits      = JSON.parse(JSON.stringify(snap.state.rawLimits      || []));
  facilityLimits = JSON.parse(JSON.stringify(snap.state.facilityLimits || []));
  powerBatteries = JSON.parse(JSON.stringify(snap.state.powerBatteries || []));
  autoMetaTransfer = !!snap.state.autoMetaTransfer;
  roundUpFacilities = !!snap.state.roundUpFacilities;
  if (snap.state.outpostCost != null) outpostCostDefault = snap.state.outpostCost;

  // renderSummaryTable reads its outpost cost from the LIVE #outpost-cost
  // input first, so the input — which survives across re-renders inside
  // its container — must be updated before computeSummary runs.
  const oc = document.getElementById('outpost-cost');
  if (oc) oc.value = outpostCostDefault.toLocaleString('en', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  tempPinnedId = null;
  _lastGraph = null;
  _lastFacilityCounts = null;
  _lastPlacementCounts = null;
  invalidateChainCache();
  invalidateMaxCache();

  saveStateNow();
  switchTab('main');
  recomputeAllMax();
  renderAll();
  if (autoSolveOn()) runSolver();
}

function deleteSnapshot(id) {
  const snaps = loadSnapshots().filter(s => s.id !== id);
  saveSnapshots(snaps);
  if (!snaps.length) switchTab('main'); else renderSavedTab();
}

function renderSavedTab() {
  const el = document.getElementById('saved-list');
  const snaps = loadSnapshots();
  if (!snaps.length) { el.innerHTML = '<div class="empty-state">No saved productions yet</div>'; return; }
  const gridCols = sumGridCols();
  const cardW = sumGridWidth();
  el.innerHTML = snaps.map(snap => {
    const canLoad = !!snap.state;
    const productRowsHTML = snap.rows.map((r, rowIndex) => {
      const lockMark = r.locked
        ? `<i data-lucide="lock" class="status-icon" style="color:var(--locked);"></i>`
        : `<span class="status-icon status-icon-placeholder"></span>`;
      const rateSpan = r.batRate > 0
        ? `<span>${_fmtN(r.grossRate)}</span><span style="color:var(--text3);margin-left:0.3em;">(-${_fmtN(r.batRate)})</span>`
        : `<span>${_fmtN(r.rate)}</span>`;
      return buildSumProductRow(`snapshot_${rowIndex}`, r.iconFile, r.name, `<span class="per-min-wrap">${lockMark}${rateSpan}</span>`, r.sell, r.ihr);
    }).join('');
    const totals = [
      { label: 'Income', labelStyle: 'color:var(--text2);', valueCls: 'sg-right td-pos', valueHTML: fmt(snap.totalIhr) },
      { label: 'Outpost bill', labelStyle: 'color:var(--text2);', valueCls: 'sg-right td-neg', valueHTML: snap.fixedCost ? `-${fmt(snap.fixedCost)}` : '-' },
      { label: 'Net profit', valueCls: `sg-right ${snap.netHr >= 0 ? 'td-pos' : 'td-neg'}`, valueHTML: `${snap.netHr >= 0 ? '+' : ''}${fmt(snap.netHr)}` },
    ];
    const actionHTML = canLoad
      ? `<button class="btn-load-snapshot" onclick="loadSnapshot('${snap.id}')">Load Production</button>`
      : `<span style="font-size:11px;color:var(--text3);">Legacy snapshot (no saved inputs to load)</span>`;
    return `<div class="snap-card result-table-wrap" style="max-width:${cardW}px;">
      <div class="panel-head" style="background:var(--accent);">
        <span class="panel-title" style="color:var(--accent-fg);">${snap.name}</span>
        <button class="icon-btn del" onclick="deleteSnapshot('${snap.id}')" style="margin-left:auto;color:var(--accent-fg);" title="Delete snapshot">✕</button>
      </div>
      <div class="sum-grid-scroll"><div class="sum-grid" style="grid-template-columns:${gridCols}">
        <div class="sg-cell sg-head">Product</div>
        <div class="sg-cell sg-head">Per minute</div>
        <div class="sg-cell sg-head sg-right">Price</div>
        <div class="sg-cell sg-head sg-right">Bill / hour</div>
        ${productRowsHTML}
        ${buildSumTotalRows(totals)}
        <div class="sg-cell sg-save-row" style="grid-column:1/-1;">${actionHTML}</div>
      </div></div>
    </div>`;
  }).join('');
  if (typeof lucide !== 'undefined') lucide.createIcons({ el });
}

/* ═══════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════ */
function renderAll() {
  const metaTog = document.getElementById('auto-meta-toggle');
  if (metaTog) metaTog.checked = autoMetaTransfer;
  const ceilTog = document.getElementById('round-facilities-toggle');
  if (ceilTog) ceilTog.checked = roundUpFacilities;
  renderResources();
  renderFacilities();
  renderProducts();
  renderPowerBatteries();
  computeSummary();
}

// The sidenav is fixed beneath the sticky header and scrolls independently.
// Keep its top edge tied to the header's rendered height across zoom and wraps.
function syncTopNavHeight() {
  const nav = document.querySelector('header.top-nav');
  if (!nav) return;
  document.documentElement.style.setProperty(
    '--top-nav-height', `${nav.getBoundingClientRect().height}px`,
  );
}
syncTopNavHeight();
window.addEventListener('resize', syncTopNavHeight, { passive: true });
if (typeof ResizeObserver !== 'undefined') {
  const topNav = document.querySelector('header.top-nav');
  if (topNav) new ResizeObserver(syncTopNavHeight).observe(topNav);
}

// Global click handler — close all search portals
document.addEventListener('click', e => {
  const pricePortal = document.getElementById('price-portal');
  if (pricePortal && pricePortal.style.display !== 'none') {
    const input = document.getElementById('price-search-input');
    if (input && !input.contains(e.target) && !pricePortal.contains(e.target)) closePriceSearch();
  }
  const rawportal = document.getElementById('raw-portal');
  if (rawportal && rawportal.style.display !== 'none') {
    const input = document.getElementById('new-raw-input');
    if (input && !input.contains(e.target) && !rawportal.contains(e.target)) closeRawSearch();
  }
  const ftportal = document.getElementById('ft-portal');
  if (ftportal && ftportal.style.display !== 'none') {
    const input = document.getElementById('new-fac-name');
    if (input && !input.contains(e.target) && !ftportal.contains(e.target)) closeFacTypeSearch();
  }
  const pportal = document.getElementById('prod-portal');
  if (pportal && pportal.style.display !== 'none') {
    const input = document.getElementById('new-prod-input');
    if (input && !input.contains(e.target) && !pportal.contains(e.target)) closeProdSearch();
  }
  const bportal = document.getElementById('bat-portal');
  if (bportal && bportal.style.display !== 'none') {
    const input = document.getElementById('power-bat-input');
    if (input && !input.contains(e.target) && !bportal.contains(e.target)) closeBatSearch();
  }
});

Promise.all([loadPrices(), loadState()]).then(() => {
  // Apply saved/URL prices after loadPrices() has populated defaults from
  // price.json — ensures user overrides win over the bundled defaults.
  if (_pendingUrlPrices) { Object.assign(prices, _pendingUrlPrices); _pendingUrlPrices = null; }
  encodeStateToUrl(); // normalize URL to compact base36 format on load
  renderAll();
  // Always run once on load to populate usage bars. When auto-solve is off,
  // use pinAll=true so all rates are treated as fixed — no state is modified.
  if (isHighsReady() && production.length) runSolver(false, !autoSolveOn());
});
