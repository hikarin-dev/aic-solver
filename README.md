# Endfield Production Solver

A browser-based linear programming solver for production planning in **Arknights: Endfield**.

Set your production targets, raw resource limits, and facility caps — the solver finds the optimal allocation that maximises profit per hour.

## Features

- **LP solver** — powered by [HiGHS](https://highs.dev/) (WebAssembly), runs entirely in the browser with no backend
- **Production targets** — add items you want to produce; pin rates or let the solver optimize freely
- **Raw resource limits** — cap inputs like ores and water to reflect your outpost's actual yield
- **Facility limits** — constrain how many of each facility type can run simultaneously
- **Power consumption** — track battery cost against production income
- **Item prices** — set sell prices per item; the LP objective maximises net profit/hr. Switch between the Wuling and Valley IV outpost price profiles; edits are kept per profile and travel in shared links
- **Saved productions** — snapshot any result and compare across configurations
- **Auto-solve** — re-runs the LP on every change; toggle off for manual control

## Usage

Host the folder with any static file server and open the localhost URL in your browser.

No build step required.

## Project Structure

```
index.html              — app shell and tab layout
endfield_calculator.js  — UI, state management, rendering
endfield_calculator.css — styles
solver_pipeline.js      — LP graph construction and HiGHS adapter
assets/
  items.json            — item catalogue
  recipes.json          — recipes and facility definitions
  solver_config.js      — cost weights and item blacklist
  icons/                — item and facility icons
```

## Configuration

Edit [`assets/solver_config.js`](assets/solver_config.js) to tune solver behaviour:

| Key | Description |
|---|---|
| `weights.surplus` | Penalty per unit/min of unpriced waste byproducts |
| `weights.machine` | Base penalty per facility run |
| `weights.power` | Additional penalty per kW of facility power draw |
| `blacklist` | Item IDs stripped from the dataset at load time |

## Disclaimer

Arknights: Endfield is a trademark of Hypergryph. This tool is not affiliated with or endorsed by Hypergryph.

## License

[MIT](LICENSE.md) © 2025 Hikarin
