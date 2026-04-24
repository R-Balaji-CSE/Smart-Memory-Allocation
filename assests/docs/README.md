# SMAS v2.0 — Smart Memory Allocation Simulator

> **Hackathon Project** 

A browser-based simulation framework for evaluating memory management techniques — **paging** and **segmentation** — under probabilistic workloads, with a novel **Dynamic Programming Knapsack Optimizer** for optimal frame allocation.

---

## Quick Start

No build tools required. Just open in VS Code and run with Live Server:

1. Install the **Live Server** extension in VS Code
2. Right-click `index.html` → **Open with Live Server**
3. Or simply open `index.html` directly in any browser

---

## Project Structure

```
smas/
├── index.html          ← Main UI (tabs, controls, memory views)
├── assets/
│   └── style.css       ← Dark terminal-inspired theme
├── src/
│   └── simulator.js    ← Core engine (all algorithms + DP)
├── docs/
│   └── architecture.md ← Technical writeup
└── README.md
```

---

## Features

### Memory Management
| Feature | Detail |
|---|---|
| Physical memory map | Real-time grid — 32–128 frames, colour-coded by process |
| Segmentation view | Run-length encoded segment track, fragmentation detection |
| Page table | Per-frame state: owner, dirty bit, last-used tick, load time |
| Address space | Configurable page size (1–16 KB), OS reserved region |

### Replacement Algorithms
| Algorithm | Complexity | Notes |
|---|---|---|
| **LRU** | O(n) | Tracks `lastUsed` timestamp per frame |
| **FIFO** | O(1) | Queue-based; demonstrates Belady's anomaly |
| **OPT** | O(n·k) | Offline lookahead into reference string |
| **CLOCK** | O(n) | Second-chance via reference bit; ≈ LRU in practice |
| **DP-KNAP** | O(n·W) | Novel: evicts from lowest-priority process |

### DP Knapsack Optimizer (Novel Contribution)
```
Capacity  = totalPages - osPages  (available frames)
Items     = processes
  weight  = pagesNeeded
  value   = priority × (priority / burst) × 100

Goal: maximise Σ value  subject to  Σ weight ≤ capacity
Algorithm: 0/1 Knapsack DP, O(n × W)
Traceback: identifies optimal subset of processes to admit
```
The DP table is rendered live in the UI with hot-cell highlighting and traceback path.

### Workload Models
| Model | Distribution | Locality |
|---|---|---|
| **Uniform random** | U[0, N) | 0% |
| **Zipf (α=0.8)** | Power-law | 80% |
| **Sequential scan** | Round-robin | 100% |
| **Thrashing** | Random ∀ frames | 0% (forces eviction) |
| **Mixed** | 60% local / 40% random | 60% |

### Analysis Dashboard
- Real-time hit rate timeline (Chart.js line chart)
- Memory pressure over time
- Side-by-side algorithm comparison (fault count, eviction count, estimated hit rate)
- Workload probability distribution chart

---

## Demo Script (for judges)

1. **Spawn 3 processes** with different priorities (e.g., P0 pri=8, P1 pri=3, P2 pri=6)
2. **Select Thrashing workload** → hit **Auto Run** → watch fault rate spike and memory fragment
3. **Switch to DP Optimizer tab** → click **Run DP Optimizer**
   - Show the DP table populating
   - Point out the optimal process subset and excluded low-priority process
4. **Switch to Analysis tab** → compare LRU vs FIFO vs OPT side-by-side
5. **Switch to Zipf workload + LRU** → show how spatial locality collapses fault rate

---

## Pitch Angle

> "Existing memory simulators treat allocation as a greedy, first-fit problem.
> SMAS models it as a **bounded combinatorial optimisation problem** and solves it
> exactly using 0/1 Knapsack dynamic programming — the same algorithmic class
> used in compiler register allocation and real-time OS scheduling research.
> The DP-KNAP replacement policy directly applies this result at eviction time,
> preferentially protecting high-priority, high-efficiency processes."

---

## Technical Notes

- Zero dependencies except **Chart.js** (CDN, v4.4.1)
- All algorithms run in the browser — no server required
- Simulation state is pure JS objects — easy to extend or export
- Reference string is recorded per-tick, enabling OPT's offline lookahead
- CLOCK's second-chance ring is simulated with a global `clockHand` pointer

---

## Extending the Project

| Idea | Where to add |
|---|---|
| Export stats to CSV | `simulator.js` → add `exportCSV()` function |
| Add NRU algorithm | `selectVictim()` → new `case 'nru'` branch |
| Animated page walk | `index.html` → add canvas overlay on the page grid |
| Multi-level page tables | New `pageDirectory[]` structure in state |
| TLB simulation | Add `tlbCache = new Map()` hit before `pageTable` lookup |

---

## Authors

