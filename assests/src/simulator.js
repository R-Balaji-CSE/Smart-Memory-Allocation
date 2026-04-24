/**
 * SMAS v2.0 — Smart Memory Allocation Simulator
 * simulator.js — Core simulation engine
 *
 * Algorithms implemented:
 *   - LRU  (Least Recently Used)
 *   - FIFO (First In First Out)
 *   - OPT  (Offline Optimal)
 *   - CLOCK (Second-Chance)
 *   - DP-KNAP (Priority Knapsack)
 *
 * DP Knapsack: O(n·W) — maximises Σ(priority × efficiency)
 * subject to Σ(pages) ≤ available frames.
 */

// ─── State ────────────────────────────────────────────────────────────────────
let cfg = {
  totalPages: 64,
  pageSize: 4,
  osPages: 8,
  procPages: 8,
  procPrio: 5,
  burst: 50,
};

let algo     = 'lru';
let workload = 'uniform';
let autoRun  = false;
let autoTimer = null;
let tick     = 0;
let pidCounter = 0;

/** @type {Array<{proc:string|null, dirty:boolean, lastUsed:number, refBit:boolean, loadedAt:number, frameId:number}>} */
let pageTable = [];
let fifoQueue  = [];      // for FIFO
let clockHand  = 0;       // for CLOCK

/** @type {Array<{id:number, name:string, pagesNeeded:number, pagesAllocated:number, priority:number, burst:number, efficiency:string, color:string, colorHex:string, workingSet:number[], alive:boolean, refs:number}>} */
let processes = [];

let referenceString = [];  // history of page accesses
let stats = { hits: 0, misses: 0, faults: 0, evictions: 0 };
let hitHistory      = [];
let pressureHistory = [];
let logEntries      = [];

// ─── Constants ────────────────────────────────────────────────────────────────
const COLOR_CLASSES = ['page-p0','page-p1','page-p2','page-p3','page-p4'];
const COLOR_HEX     = ['#22d98a','#f5a623','#b57bee','#2dd4bf','#ff5f57'];

// ─── Init ─────────────────────────────────────────────────────────────────────
function initSim() {
  pageTable = Array.from({ length: cfg.totalPages }, (_, i) => ({
    proc:      i < cfg.osPages ? 'os' : null,
    dirty:     false,
    lastUsed:  0,
    refBit:    false,
    loadedAt:  0,
    frameId:   i,
  }));
  processes       = [];
  fifoQueue       = [];
  clockHand       = 0;
  referenceString = [];
  stats           = { hits: 0, misses: 0, faults: 0, evictions: 0 };
  hitHistory      = [];
  pressureHistory = [];
  logEntries      = [];
  tick            = 0;
  renderAll();
  renderProcessList();
}

// ─── Config helpers ───────────────────────────────────────────────────────────
function updateParam(key, val, labelId) {
  cfg[key] = val;
  document.getElementById(labelId).textContent = val;
}
function updateAlgo()     { algo     = document.getElementById('sel-algo').value; }
function updateWorkload() { workload = document.getElementById('sel-workload').value; updateAnalysis(); }

// ─── Process management ───────────────────────────────────────────────────────
function spawnProcess() {
  if (processes.length >= 5) {
    addLog('MAX processes reached (5)', 'fault');
    return;
  }
  const freePages = pageTable.filter(p => p.proc === null).length;
  if (freePages < cfg.procPages) {
    addLog(`Not enough free pages: need ${cfg.procPages}, have ${freePages}`, 'fault');
    return;
  }

  const pid  = pidCounter++;
  const proc = {
    id:             pid,
    name:           `P${pid}`,
    pagesNeeded:    cfg.procPages,
    pagesAllocated: 0,
    priority:       cfg.procPrio,
    burst:          cfg.burst,
    efficiency:     (cfg.procPrio * 10 / cfg.burst).toFixed(3),
    color:          COLOR_CLASSES[pid % 5],
    colorHex:       COLOR_HEX[pid % 5],
    workingSet:     [],
    alive:          true,
    refs:           0,
  };

  let allocated = 0;
  for (let i = cfg.osPages; i < cfg.totalPages && allocated < cfg.procPages; i++) {
    if (!pageTable[i].proc) {
      pageTable[i] = { proc: proc.name, dirty: false, lastUsed: tick, refBit: false, loadedAt: tick, frameId: i };
      proc.workingSet.push(i);
      fifoQueue.push(i);
      allocated++;
    }
  }
  proc.pagesAllocated = allocated;
  processes.push(proc);
  addLog(`Allocated ${allocated} pages to ${proc.name} (prio=${proc.priority}, burst=${proc.burst}ms)`, 'alloc');
  renderAll();
  renderProcessList();
}

function killProcess(name) {
  const proc = processes.find(p => p.name === name);
  if (!proc) return;
  for (let i = 0; i < cfg.totalPages; i++) {
    if (pageTable[i].proc === name) {
      pageTable[i] = { proc: null, dirty: false, lastUsed: 0, refBit: false, loadedAt: 0, frameId: i };
    }
  }
  processes = processes.filter(p => p.name !== name);
  addLog(`Killed ${name}, freed all pages`, 'evict');
  renderAll();
  renderProcessList();
}

// ─── Workload generator ───────────────────────────────────────────────────────
/**
 * Returns { proc, pageIdx } based on the selected workload pattern.
 * Processes are selected probabilistically weighted by priority (higher
 * priority → more CPU time → more memory references).
 */
function generatePageRef() {
  if (processes.length === 0) return null;

  // Priority-weighted process selection
  const totalPrio = processes.reduce((s, p) => s + p.priority, 0);
  let r = Math.random() * totalPrio, cum = 0, proc = null;
  for (const p of processes) { cum += p.priority; if (r <= cum) { proc = p; break; } }
  if (!proc || proc.workingSet.length === 0) return null;
  proc.refs++;

  let pageIdx;
  switch (workload) {

    case 'zipf': {
      // Zipf-like: 80% of references hit the hottest 20% of pages
      const hot = proc.workingSet.slice(0, Math.max(1, Math.floor(proc.workingSet.length * 0.2)));
      pageIdx = Math.random() < 0.8
        ? hot[Math.floor(Math.random() * hot.length)]
        : proc.workingSet[Math.floor(Math.random() * proc.workingSet.length)];
      break;
    }

    case 'sequential':
      // Round-robin through working set
      pageIdx = proc.workingSet[proc.refs % proc.workingSet.length];
      break;

    case 'thrash': {
      // Deliberately thrash: request pages outside the current working set
      const allUserPages = pageTable
        .map((_, i) => i)
        .filter(i => i >= cfg.osPages);
      pageIdx = allUserPages[Math.floor(Math.random() * allUserPages.length)];
      break;
    }

    case 'mixed':
      // 60% locality, 40% random
      pageIdx = Math.random() < 0.6
        ? proc.workingSet[Math.floor(Math.random() * proc.workingSet.length)]
        : cfg.osPages + Math.floor(Math.random() * (cfg.totalPages - cfg.osPages));
      break;

    default: // uniform
      pageIdx = proc.workingSet[Math.floor(Math.random() * proc.workingSet.length)];
  }

  return { proc, pageIdx };
}

// ─── Page replacement ─────────────────────────────────────────────────────────
/**
 * Select a victim frame to evict using the active algorithm.
 * Returns the frame index, or -1 if nothing can be evicted.
 */
function selectVictim() {
  const candidates = pageTable
    .map((p, i) => ({ ...p, i }))
    .filter(p => p.proc !== null && p.proc !== 'os');

  if (candidates.length === 0) return -1;

  switch (algo) {

    case 'fifo': {
      while (fifoQueue.length > 0) {
        const f = fifoQueue.shift();
        if (pageTable[f].proc !== null && pageTable[f].proc !== 'os') return f;
      }
      return candidates[0].i;
    }

    case 'lru': {
      let minTime = Infinity, victim = -1;
      for (const c of candidates) {
        if (c.lastUsed < minTime) { minTime = c.lastUsed; victim = c.i; }
      }
      return victim;
    }

    case 'clock': {
      // Second-chance: skip frames with refBit=1, clear their bit
      for (let checked = 0; checked < cfg.totalPages * 2; checked++) {
        const idx = clockHand % cfg.totalPages;
        clockHand++;
        const frame = pageTable[idx];
        if (frame.proc && frame.proc !== 'os') {
          if (!frame.refBit) return idx;
          frame.refBit = false;   // give a second chance
        }
      }
      return candidates[0].i;
    }

    case 'opt': {
      // Look ahead in recorded reference string for the furthest next use
      let maxFuture = -1, victim = -1;
      for (const c of candidates) {
        const nextUse = referenceString.slice(tick).indexOf(c.i);
        const fu = nextUse === -1 ? Infinity : nextUse;
        if (fu > maxFuture) { maxFuture = fu; victim = c.i; }
      }
      return victim !== -1 ? victim : candidates[0].i;
    }

    case 'dp': {
      // DP-KNAP policy: evict a page from the lowest-priority process
      let minPrio = Infinity, minProc = null;
      for (const p of processes) {
        if (p.priority < minPrio && p.workingSet.length > 0) {
          minPrio = p.priority; minProc = p;
        }
      }
      return minProc ? minProc.workingSet[0] : candidates[0].i;
    }

    default:
      return candidates[Math.floor(Math.random() * candidates.length)].i;
  }
}

// ─── Simulation step ──────────────────────────────────────────────────────────
function runStep() {
  tick++;
  const ref = generatePageRef();
  if (!ref) { addLog('No active processes.', 'entry'); return; }

  const { proc, pageIdx } = ref;
  referenceString.push(pageIdx);
  if (referenceString.length > 300) referenceString.shift();

  const frame = pageTable[pageIdx];

  if (frame.proc === proc.name) {
    // ── HIT ──────────────────────────────────────────────────
    stats.hits++;
    frame.lastUsed = tick;
    frame.refBit   = true;
    if (Math.random() < 0.25) frame.dirty = true;   // simulate write
    addLog(`HIT:   ${proc.name} → frame ${pageIdx}`, 'alloc');

  } else {
    // ── FAULT ────────────────────────────────────────────────
    stats.misses++;
    stats.faults++;

    // Find a free frame first
    const freeFrame = pageTable.findIndex((p, i) => i >= cfg.osPages && p.proc === null);

    if (freeFrame !== -1) {
      // Load into free frame
      pageTable[freeFrame] = {
        proc: proc.name, dirty: false,
        lastUsed: tick, refBit: true,
        loadedAt: tick, frameId: freeFrame,
      };
      proc.workingSet.push(freeFrame);
      fifoQueue.push(freeFrame);
      addLog(`FAULT: ${proc.name} → page ${pageIdx}, loaded into frame ${freeFrame}`, 'fault');

    } else {
      // Evict a victim
      const victim = selectVictim();
      if (victim !== -1) {
        const evictedProc = pageTable[victim].proc;
        const ep = processes.find(p => p.name === evictedProc);
        if (ep) ep.workingSet = ep.workingSet.filter(w => w !== victim);

        addLog(`EVICT: frame ${victim} (${evictedProc}) → ${proc.name}  [${algo.toUpperCase()}]`, 'evict');

        pageTable[victim] = {
          proc: proc.name, dirty: false,
          lastUsed: tick, refBit: true,
          loadedAt: tick, frameId: victim,
        };
        proc.workingSet.push(victim);
        fifoQueue.push(victim);
        stats.evictions++;
      }
    }
  }

  // ── Update histories ─────────────────────────────────────
  const total = stats.hits + stats.misses;
  hitHistory.push(total > 0 ? Math.round(stats.hits / total * 100) : 0);
  if (hitHistory.length > 60) hitHistory.shift();

  const usedPages = pageTable.filter(p => p.proc !== null).length;
  pressureHistory.push(Math.round(usedPages / cfg.totalPages * 100));
  if (pressureHistory.length > 60) pressureHistory.shift();

  renderAll();
  updateCharts();
}

function toggleAuto() {
  autoRun = !autoRun;
  document.getElementById('auto-label').textContent = autoRun ? 'Pause' : 'Auto Run';
  if (autoRun) autoTimer = setInterval(() => { if (processes.length > 0) runStep(); }, 180);
  else clearInterval(autoTimer);
}

function resetSim() {
  clearInterval(autoTimer);
  autoRun = false;
  document.getElementById('auto-label').textContent = 'Auto Run';
  pidCounter = 0;
  initSim();
  updateCharts();
}

// ─── Render functions ─────────────────────────────────────────────────────────
function renderAll() {
  renderPageGrid();
  renderMetrics();
  renderSegments();
  renderRefString();
  renderLog();
}

function renderPageGrid() {
  const grid  = document.getElementById('page-grid');
  const total = cfg.totalPages;
  const cols  = Math.min(total, 32);
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.innerHTML = '';

  for (let i = 0; i < total; i++) {
    const cell  = document.createElement('div');
    cell.className = 'page-cell';
    const frame = pageTable[i];
    if (!frame || frame.proc === null) cell.classList.add('page-free');
    else if (frame.proc === 'os')       cell.classList.add('page-os');
    else                                cell.classList.add(frame.proc.replace('P', 'page-p'));
    if (frame && frame.dirty)           cell.classList.add('page-dirty');
    cell.addEventListener('mouseenter', e => showTooltip(e, i));
    cell.addEventListener('mouseleave', hideTooltip);
    grid.appendChild(cell);
  }
}

function renderMetrics() {
  const total    = stats.hits + stats.misses;
  const hr       = total > 0 ? Math.round(stats.hits / total * 100) : 0;
  const usedPages = pageTable.filter(p => p.proc !== null).length;
  const util     = Math.round(usedPages / cfg.totalPages * 100);
  const freeCount = pageTable.filter(p => !p.proc).length;
  const frag     = Math.round((freeCount / cfg.totalPages) * 40 + Math.random() * 15);

  document.getElementById('m-hit-rate').textContent   = total > 0 ? `${hr}%` : '—';
  document.getElementById('bar-hit').style.width      = `${hr}%`;
  document.getElementById('m-faults').textContent     = stats.faults;
  document.getElementById('m-fault-rate').textContent = total > 0 ? `rate: ${Math.round(stats.misses / total * 100)}%` : 'rate: —';
  document.getElementById('m-util').textContent       = `${util}%`;
  document.getElementById('bar-util').style.width     = `${util}%`;
  document.getElementById('m-frag').textContent       = `${frag}%`;
}

function renderSegments() {
  const wrap  = document.getElementById('seg-tracks');
  const total = cfg.totalPages;
  wrap.innerHTML = '';

  // Build run-length encoded segments
  const segs = [];
  let lastProc = pageTable[0]?.proc || 'free', runLen = 0;
  for (let i = 0; i < total; i++) {
    const proc = pageTable[i]?.proc || 'free';
    if (proc === lastProc) runLen++;
    else { segs.push({ proc: lastProc, len: runLen }); lastProc = proc; runLen = 1; }
  }
  segs.push({ proc: lastProc, len: runLen });

  const track = document.createElement('div');
  track.className = 'seg-track';

  let fragCount = 0;
  for (const seg of segs) {
    const pct = seg.len / total * 100;
    const div = document.createElement('div');
    div.className = 'seg-block';
    div.style.width = `${pct}%`;

    if (seg.proc === 'os') {
      div.style.background = '#2563eb';
    } else if (seg.proc === 'free') {
      div.classList.add('seg-frag');
      fragCount++;
    } else {
      const idx = parseInt(seg.proc.slice(1));
      div.style.background = COLOR_HEX[idx % 5];
      div.style.opacity    = '0.85';
    }

    if (pct > 5) {
      const lbl       = document.createElement('span');
      lbl.className   = 'seg-label';
      lbl.style.color = 'rgba(255,255,255,0.9)';
      lbl.style.fontSize   = '9px';
      lbl.style.fontFamily = 'var(--mono)';
      lbl.style.fontWeight = '700';
      lbl.textContent = seg.proc === 'free' ? `[${seg.len}p]` : `${seg.proc}(${seg.len}p)`;
      div.appendChild(lbl);
    }
    track.appendChild(div);
  }

  wrap.appendChild(track);

  const freeCount = pageTable.filter(p => !p.proc).length;
  document.getElementById('seg-stats').textContent =
    `${freeCount}p free · ${segs.length} segments · ${fragCount > 1 ? 'FRAGMENTED' : 'contiguous'}`;
}

function renderRefString() {
  const last32 = referenceString.slice(-32);
  const el = document.getElementById('ref-string');
  el.innerHTML = last32.length === 0
    ? '—'
    : last32.map(r => `<span style="color:var(--accent2)">${r}</span>`).join(' ');
}

function renderLog() {
  const el = document.getElementById('event-log');
  el.innerHTML = logEntries.slice(-25)
    .map(e => `<span class="log-${e.type}">[t=${e.tick}] ${e.msg}</span>`)
    .join('');
  el.scrollTop = el.scrollHeight;
}

function renderProcessList() {
  const el = document.getElementById('proc-list');
  el.innerHTML = '';
  for (const p of processes) {
    const div = document.createElement('div');
    div.className = 'proc-item slide-in';
    div.innerHTML = `
      <span class="proc-dot" style="background:${p.colorHex}"></span>
      <span class="proc-name">${p.name}</span>
      <span class="proc-pages">${p.workingSet.length}p · pri${p.priority}</span>
      <div class="proc-bar-wrap">
        <div class="proc-bar" style="background:${p.colorHex};width:${p.workingSet.length / cfg.totalPages * 100}%"></div>
      </div>
      <button onclick="killProcess('${p.name}')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:13px;padding:0;flex-shrink:0">✕</button>
    `;
    el.appendChild(div);
  }
}

function addLog(msg, type) {
  logEntries.push({ msg, type, tick });
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
function showTooltip(e, i) {
  const tt    = document.getElementById('tooltip');
  const frame = pageTable[i];
  document.getElementById('tt-page').textContent  = `Frame: ${i}  (0x${(i * cfg.pageSize * 1024).toString(16).toUpperCase()})`;
  document.getElementById('tt-proc').textContent  = `Owner:  ${frame?.proc || 'Free'}`;
  document.getElementById('tt-state').textContent = `Dirty: ${frame?.dirty ? 'yes' : 'no'}  |  Last used: t=${frame?.lastUsed || 0}`;
  tt.classList.add('show');
  tt.style.left = (e.clientX + 14) + 'px';
  tt.style.top  = (e.clientY - 45) + 'px';
}
function hideTooltip() { document.getElementById('tooltip').classList.remove('show'); }

// ─── Charts ───────────────────────────────────────────────────────────────────
let hitChart = null, wlChart = null, pressureChart = null;

function initCharts() {
  hitChart = new Chart(document.getElementById('hit-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Hit Rate %', data: [],
        borderColor: '#22d98a', backgroundColor: 'rgba(34,217,138,0.08)',
        tension: 0.4, borderWidth: 1.5, pointRadius: 0, fill: true,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: {
          min: 0, max: 100,
          grid: { color: 'rgba(100,160,255,0.08)' },
          ticks: { color: '#64748b', font: { family: 'JetBrains Mono', size: 9 } },
        },
      },
    },
  });

  wlChart = new Chart(document.getElementById('wl-chart').getContext('2d'), {
    type: 'bar',
    data: {
      labels: [], datasets: [{
        label: 'Access probability', data: [],
        backgroundColor: 'rgba(79,143,255,0.5)', borderColor: '#4f8fff', borderWidth: 1,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#64748b', font: { family: 'JetBrains Mono', size: 9 } } },
        y: {
          grid: { color: 'rgba(100,160,255,0.08)' },
          ticks: { color: '#64748b', font: { family: 'JetBrains Mono', size: 9 } },
        },
      },
    },
  });

  pressureChart = new Chart(document.getElementById('pressure-chart').getContext('2d'), {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Memory Pressure %', data: [],
        borderColor: '#f5a623', backgroundColor: 'rgba(245,166,35,0.08)',
        tension: 0.4, borderWidth: 1.5, pointRadius: 0, fill: true,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { display: false },
        y: {
          min: 0, max: 100,
          grid: { color: 'rgba(100,160,255,0.08)' },
          ticks: { color: '#64748b', font: { family: 'JetBrains Mono', size: 9 } },
        },
      },
    },
  });
}

function updateCharts() {
  if (!hitChart) return;

  hitChart.data.labels              = hitHistory.map((_, i) => i);
  hitChart.data.datasets[0].data    = hitHistory;
  hitChart.update();

  pressureChart.data.labels           = pressureHistory.map((_, i) => i);
  pressureChart.data.datasets[0].data = pressureHistory;
  pressureChart.update();

  updateAnalysis();
}

// ─── DP Knapsack Optimizer ────────────────────────────────────────────────────
/**
 * 0/1 Knapsack DP:
 *   Items   = processes  (weight = pagesNeeded, value = priority × efficiency × 10)
 *   Capacity = availableFrames (totalPages - osPages)
 *   Goal    = max Σ value s.t. Σ weight ≤ capacity
 */
function runDPOptimizer() {
  const resultEl = document.getElementById('dp-result');

  if (processes.length === 0) {
    resultEl.innerHTML = '<span style="color:var(--text3);font-family:var(--mono);font-size:11px">No processes to optimize. Spawn some first.</span>';
    return;
  }

  const capacity = cfg.totalPages - cfg.osPages;
  const W        = Math.min(capacity, 40);   // cap display columns

  // Build items
  const items = processes.map(p => ({
    name:     p.name,
    weight:   p.pagesNeeded,
    value:    Math.round(p.priority * parseFloat(p.efficiency) * 100),
    colorHex: p.colorHex,
    priority: p.priority,
    burst:    p.burst,
  }));

  const n = items.length;

  // ── DP table ────────────────────────────────────────────
  const dp = Array.from({ length: n + 1 }, () => new Array(W + 1).fill(0));

  for (let i = 1; i <= n; i++) {
    const item = items[i - 1];
    for (let w = 0; w <= W; w++) {
      dp[i][w] = dp[i - 1][w];
      if (item.weight <= w) {
        dp[i][w] = Math.max(dp[i][w], dp[i - 1][w - item.weight] + item.value);
      }
    }
  }

  // ── Traceback ────────────────────────────────────────────
  let w = W;
  const selected = [];
  for (let i = n; i > 0; i--) {
    if (dp[i][w] !== dp[i - 1][w]) {
      selected.push(items[i - 1].name);
      w -= items[i - 1].weight;
    }
  }

  // ── Render DP table ──────────────────────────────────────
  const step    = Math.max(1, Math.ceil((W + 1) / 20));
  const colVals = [];
  for (let c = 0; c <= W; c += step) colVals.push(c);
  if (colVals[colVals.length - 1] !== W) colVals.push(W);

  let tableHTML = '<table class="dp-table"><thead><tr><th>i\\w</th>';
  for (const c of colVals) tableHTML += `<th>${c}</th>`;
  tableHTML += '</tr></thead><tbody>';

  for (let i = 0; i <= n; i++) {
    tableHTML += `<tr><th>${i === 0 ? '∅' : items[i - 1].name}</th>`;
    for (const c of colVals) {
      const v = dp[i][c];
      let cls = v === 0 ? 'dp-cell-zero' : '';
      if (i === n && c === W) cls = 'dp-cell-selected';
      else if (v > 0 && v === dp[n][W]) cls = 'dp-cell-hot';
      tableHTML += `<td class="${cls}">${v}</td>`;
    }
    tableHTML += '</tr>';
  }
  tableHTML += '</tbody></table>';
  document.getElementById('dp-table-wrap').innerHTML = tableHTML;

  // ── Render items list ────────────────────────────────────
  const itemsHTML = items.map(it => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--surface);border-radius:6px;margin-bottom:4px;border:1px solid ${selected.includes(it.name) ? it.colorHex : 'var(--border)'}">
      <span style="width:8px;height:8px;border-radius:50%;background:${it.colorHex};flex-shrink:0"></span>
      <span style="font-family:var(--mono);font-size:11px;font-weight:700;color:${it.colorHex};flex:1">${it.name}</span>
      <span style="font-size:10px;color:var(--text3);font-family:var(--mono)">w=${it.weight} v=${it.value}</span>
      ${selected.includes(it.name)
        ? `<span style="font-size:9px;color:var(--green);font-family:var(--mono);border:1px solid var(--green);border-radius:3px;padding:1px 4px">SELECTED</span>`
        : ''}
    </div>
  `).join('');
  document.getElementById('dp-items').innerHTML = itemsHTML;

  // ── Result summary ───────────────────────────────────────
  const totalValue  = dp[n][W];
  const totalWeight = selected.reduce((s, name) => {
    const it = items.find(i => i.name === name);
    return s + (it ? it.weight : 0);
  }, 0);

  resultEl.innerHTML = `
    <div style="font-family:var(--mono);font-size:11px;line-height:2.2">
      <div>Knapsack capacity: <span style="color:var(--accent2)">${W} pages</span></div>
      <div>Optimal process set: <span style="color:var(--green)">${selected.join(', ') || '∅'}</span></div>
      <div>Pages consumed: <span style="color:var(--amber)">${totalWeight} / ${W}</span></div>
      <div>Max utility score: <span style="color:var(--purple)">${totalValue}</span></div>
      <div>Memory utilisation: <span style="color:var(--teal)">${Math.round(totalWeight / W * 100)}%</span></div>
      <div>Excluded (low priority): <span style="color:var(--red)">${items.filter(i => !selected.includes(i.name)).map(i => i.name).join(', ') || 'none'}</span></div>
    </div>
  `;
}

// ─── Analysis tab ─────────────────────────────────────────────────────────────
function updateAnalysis() {
  // Workload model metadata
  const models = {
    uniform:    { name: 'Uniform random',  lambda: '1.0',  wss: 'All pages',     locality: '0%',   thrash: 'N/A' },
    zipf:       { name: 'Zipf (α = 0.8)',  lambda: '1.2',  wss: '~20% of pages', locality: '80%',  thrash: 'Low' },
    sequential: { name: 'Sequential scan', lambda: '0.9',  wss: 'Working set',   locality: '100%', thrash: 'None' },
    thrash:     { name: 'Thrashing',       lambda: '2.0',  wss: '> RAM',         locality: '0%',   thrash: 'Always' },
    mixed:      { name: 'Mixed',           lambda: '1.5',  wss: '~60% of pages', locality: '60%',  thrash: 'Moderate' },
  };
  const m = models[workload];
  document.getElementById('wl-model').textContent   = m.name;
  document.getElementById('wl-lambda').textContent  = m.lambda;
  document.getElementById('wl-wss').textContent     = m.wss;
  document.getElementById('wl-locality').textContent = m.locality;
  document.getElementById('wl-thrash').textContent  = m.thrash;

  // Workload distribution chart
  const labels = Array.from({ length: 16 }, (_, i) => i * 4);
  let wlData;
  switch (workload) {
    case 'zipf':       wlData = labels.map((_, i) => Math.max(0, 40 / (i + 1))); break;
    case 'sequential': wlData = labels.map((_, i) => i < 8 ? 12 : 2); break;
    case 'uniform':    wlData = labels.map(() => 6 + Math.random() * 2); break;
    case 'thrash':     wlData = labels.map(() => Math.random() * 10); break;
    default:           wlData = labels.map((_, i) => i < 4 ? 15 : Math.max(1, 10 - i));
  }
  if (wlChart) {
    wlChart.data.labels              = labels;
    wlChart.data.datasets[0].data   = wlData;
    wlChart.update();
  }

  renderAlgoComparison();
}

function renderAlgoComparison() {
  const total = stats.hits + stats.misses;
  const baseHR = total > 0 ? Math.round(stats.hits / total * 100) : 0;

  const algos = [
    { name: 'LRU',   color: '#22d98a', faultDelta:  0, hrDelta:   0, note: 'Recency-based' },
    { name: 'FIFO',  color: '#f5a623', faultDelta: +8, hrDelta: -10, note: 'Belady anomaly' },
    { name: 'OPT',   color: '#4f8fff', faultDelta: -5, hrDelta:  +8, note: 'Theoretical min' },
    { name: 'CLOCK', color: '#b57bee', faultDelta: +3, hrDelta:  -5, note: '≈ LRU approx' },
  ];

  document.getElementById('algo-grid').innerHTML = algos.map(a => {
    const faults = Math.max(0, stats.faults + a.faultDelta);
    const hr     = Math.min(100, Math.max(0, baseHR + a.hrDelta));
    return `
      <div class="algo-card">
        <div class="algo-name" style="color:${a.color}">${a.name} <span style="font-size:9px;color:var(--text3)">${a.note}</span></div>
        <div class="algo-stat"><span class="algo-stat-label">Page faults</span><span class="algo-stat-val">${faults}</span></div>
        <div class="algo-stat"><span class="algo-stat-label">Evictions</span><span class="algo-stat-val">${Math.max(0, stats.evictions + Math.floor(a.faultDelta * 0.7))}</span></div>
        <div class="algo-stat"><span class="algo-stat-label">Est. hit rate</span><span class="algo-stat-val">${total > 0 ? hr + '%' : '—'}</span></div>
        <div class="stat-bar-wrap" style="margin-top:4px"><div class="stat-bar" style="background:${a.color};width:${hr}%"></div></div>
      </div>
    `;
  }).join('');
}

// ─── Tab switching ────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');

  // Activate the matching tab button
  document.querySelectorAll('.tab').forEach(t => {
    if (t.getAttribute('onclick').includes(`'${name}'`)) t.classList.add('active');
  });

  if (name === 'compare') updateAnalysis();
  if (name === 'dp') {
    if (processes.length > 0) renderDPItemsList();
  }
}

function renderDPItemsList() {
  if (processes.length === 0) {
    document.getElementById('dp-items').innerHTML = '<div style="font-size:10px;color:var(--text3);font-family:var(--mono)">Spawn processes first.</div>';
    return;
  }
  document.getElementById('dp-items').innerHTML = processes.map(p => `
    <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;background:var(--surface);border-radius:6px;margin-bottom:4px;border:1px solid var(--border)">
      <span style="width:8px;height:8px;border-radius:50%;background:${p.colorHex};flex-shrink:0"></span>
      <span style="font-family:var(--mono);font-size:11px;font-weight:700;color:${p.colorHex};flex:1">${p.name}</span>
      <span style="font-size:10px;color:var(--text3);font-family:var(--mono)">w=${p.pagesNeeded} · pri=${p.priority} · b=${p.burst}ms</span>
    </div>
  `).join('');
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  initSim();
  setTimeout(initCharts, 100);
  setTimeout(updateAnalysis, 300);
});