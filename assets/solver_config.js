// Solver cost weights — edit this file to tune LP behaviour.
//
// surplus  — penalty per unit/min of unpriced items with no downstream consumer
//            (e.g. copper_nugget when only sewage is needed from copper smelting).
//            Raise if the solver wastes raw materials generating unwanted byproducts.
//
// machine  — base penalty per facility (x_ri) in the objective.
//            Discourages running unnecessary intermediate steps when profit is equal.
//            Keep small so it never overrides real profit differences.
//
// power    — additional penalty per kW of facility power draw, per facility.
//            Total per-facility penalty = machine + power * facility.power_kw.
//            Set to 0 to disable (power-blind, original behaviour).
//            Example: 0.00005 adds 0.001 for a 20 kW Fitting Unit — same order
//            as the base machine penalty, so high-power facilities are gently
//            preferred against when profit is otherwise equal.
window.SOLVER_CONFIG = {
  weights: {
    surplus: 0.05,
    machine: 0.001,
    power:   0.00005,
    // Virtual price applied to zero-price production targets so the LP
    // maximises their output instead of conserving resources.
    // Must exceed machine + power penalties; keep well below real item prices.
    target:  0.1
  },
  // Items in this list are stripped from ITEMS_DB and RECIPES_DB at load time.
  // Use for raw materials that exist in the data but are unobtainable in-game
  // (e.g. Wood, which has no facility that produces it).
  blacklist: [
    'item_plant_tundra_wood',
    'item_activity_xiranite_bottle',
    'item_activity_xiranite_cmpt',
    'item_activity_xiranite_enr_bottle',
    'item_activity_xiranite_enr_cmpt',
    'item_activity_xiranite_enr_hulu',
    'item_activity_xiranite_enr_tool',
    'item_activity_xiranite_hulu',

    // Chubby Lung event chain (game 1.5) — LIVE, deliberately left enabled.
    // Uncomment the block below once the event ends to retire it the same way
    // the Gourd chain above was retired.
    //
    // Uncommenting removes items from ITEMS_DB, which shifts every base36 item
    // index used by shared links. Regenerate initialization.json and bump
    // APP_VERSION in endfield_calculator.js at the same time.
    // 'item_activity_copper_poly',
    // 'item_activity_copper_poly_cmpt',
    // 'item_activity_copper_poly_gas',
    // 'item_activity_copper_poly_tool',
    // 'item_activity_copper_xiranite_tool',
    // 'item_activity_xiranite_box',
    // 'item_activity_xiranite_enr_box',
    // 'item_activity_xiranite_enr_lung',
    // 'item_activity_xiranite_enr_nugget',
    // 'item_activity_xiranite_lung',
    // 'item_activity_xiranite_nugget',
  ]
};
