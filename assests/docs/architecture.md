# SMAS Architecture & Algorithm Documentation

## System Overview

SMAS simulates a single-level paged memory system with segmentation visualization,
driven by a configurable probabilistic workload generator.

```
┌─────────────────────────────────────────────────────────────┐
│                    Simulation Engine                         │
│                                                              │
│  WorkloadGenerator ──→ PageReference ──→ PageTable          │
│                                    ↓              ↓          │
│                             [HIT]        [FAULT]             │
│                               ↓              ↓               │
│                         updateStats   selectVictim()         │
│                                            ↓                 │
│                                      [Algorithm]             │
│                               LRU | FIFO | OPT | CLOCK | DP │
└─────────────────────────────────────────────────────────────┘
```

## State Model

### pageTable[i]
```js
{
  proc:     string | null,   // owning process name, 'os', or null (free)
  dirty:    boolean,         // modified since load (write simulation)
  lastUsed: number,          // tick of last access (LRU key)
  refBit:   boolean,         // second-chance bit (CLOCK)
  loadedAt: number,          // tick when loaded (for aging analysis)
  frameId:  number,          // physical frame index
}
```

### Process
```js
{
  name:        string,   // 'P0', 'P1', ...
  pagesNeeded: number,   // requested working set size
  priority:    number,   // 1–10 (scheduler weight)
  burst:       number,   // CPU burst estimate (ms)
  efficiency:  string,   // priority / burst (utility rate)
  workingSet:  number[], // current resident frame indices
  refs:        number,   // total memory references made
}
```

## DP Knapsack Algorithm

### Formulation
- **Decision variables**: x_i ∈ {0,1} for each process i
- **Objective**: maximise Σ v_i · x_i
- **Constraint**: Σ w_i · x_i ≤ W (available frames)
- **Value**: v_i = priority_i × (priority_i / burst_i) × 100
- **Weight**: w_i = pagesNeeded_i

### Recurrence
```
dp[0][w] = 0  for all w
dp[i][w] = dp[i-1][w]                                      if w_i > w
         = max(dp[i-1][w], dp[i-1][w - w_i] + v_i)        otherwise
```

### Complexity
- Time:  O(n × W)   where n = process count, W = available frames
- Space: O(n × W)   (full table retained for visualisation + traceback)

### Traceback
```
w = W
for i in n..1:
  if dp[i][w] ≠ dp[i-1][w]:
    selected ← process_i
    w -= w_i
```

## Replacement Policies

### LRU
Evicts the frame with the smallest `lastUsed` timestamp.
Optimal for recency-based locality but requires O(n) scan per eviction.

### FIFO
Maintains a queue of frame load order. Evicts the oldest-loaded frame.
Simple, O(1), but susceptible to Belady's anomaly (more frames → more faults).

### OPT (Offline Optimal)
Scans the recorded reference string forward from the current tick.
Evicts the frame whose next use is furthest in the future (or never used again).
Provides a lower bound on fault count — used for algorithm comparison.

### CLOCK (Second Chance)
Circular scan with a `clockHand` pointer. Each frame has a `refBit`.
- refBit = 1 → clear it, advance hand (second chance)
- refBit = 0 → evict this frame
Approximates LRU with O(1) amortised cost.

### DP-KNAP (Novel)
At eviction time, evicts a frame from the lowest-priority process
(as determined by the knapsack optimiser). Ensures high-priority, high-efficiency
processes retain their working sets under memory pressure.

## Workload Generator

### Priority-Weighted Process Selection
```
totalPrio = Σ p.priority
rand ∈ [0, totalPrio)
select process where cumulative priority first exceeds rand
```
Higher priority → proportionally more CPU time → more memory references.

### Zipf Distribution
```
P(rank r) ∝ 1/r^α,  α = 0.8
Hot set  = top 20% of working set pages
P(hot)   = 0.80,  P(cold) = 0.20
```

### Thrashing
References random frames across the entire physical memory,
deliberately exceeding any process's working set size.
Forces the simulator into a fault-dominated regime.

## Metrics

| Metric | Formula |
|---|---|
| Hit rate | hits / (hits + misses) × 100 |
| Fault rate | misses / total × 100 |
| Utilisation | usedFrames / totalFrames × 100 |
| Fragmentation | f(freeSegments, freePages) |

## Segmentation Visualisation

The segment track is a run-length encoding of the pageTable:
```
[os][os][P0][P0][P0][free][P1][P1][free][free]
 ──────────   ────────────   ───────   ─────────
  OS seg         P0 seg      P1 seg   ext. frag
```
External fragmentation = number of disjoint free runs > 1.
Internal fragmentation = partially-filled last page (approximated).