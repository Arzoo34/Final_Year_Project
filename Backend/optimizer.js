// ============================================================
//  MineGuard Pro — optimizer.js
//  Multi-Objective Safety Optimization Engine
//  Algorithms: Weighted Risk Scoring, Dijkstra Evacuation Routing,
//  Ventilation Control, Worker Distribution, Predictive Fatigue
// ============================================================
'use strict';

// ═══════════════════════════════════════════════════════════
//  1. WEIGHTED MULTI-CRITERIA RISK SCORING (Enhanced)
//     More accurate than simple risk sum — uses exponential
//     penalty for compound hazards (sensor fusion aware)
// ═══════════════════════════════════════════════════════════
function calcOptimizedRisk(w) {
  let score = 0;

  const ch4 = w.ch4 || 0;
  const co  = w.co  || 0;
  const fg = (w.flammableGas != null && w.flammableGas !== undefined)
    ? Number(w.flammableGas)
    : ((w.flammable_gas != null && w.flammable_gas !== undefined)
      ? Number(w.flammable_gas)
      : ch4 + co);
  const o2  = w.o2  || 20.9;
  const tmp = w.temp || 22;
  const hr  = w.heart_rate || 72;

  // Combined flammable index (CH₄ + CO); backward compatible when column missing
  if (fg > 0) score += Math.min(4.0, Math.log1p(fg) * 0.72);
  if (o2 < 20.9) score += Math.min(3.0, Math.exp((20.9 - o2) * 1.2) * 0.3);
  // Temp: linear above 32°C
  if (tmp > 32)  score += Math.min(1.5, (tmp - 32) * 0.15);
  // Heart rate: stress indicator
  if (hr > 100)  score += Math.min(1.5, (hr - 100) * 0.03);
  if (hr < 50)   score += 1.5; // bradycardia risk

  // Emergency multipliers
  if (w.panic) score += 4.0;
  if (w.fall)  score += 3.5;
  if (!w.motion || w.motion === 0) score += 1.2;

  // Compound hazard bonus (sensor fusion — multiple dangers simultaneously)
  let compoundCount = 0;
  if (fg > 50) compoundCount++;
  if (o2  < 19.8) compoundCount++;
  if (tmp > 35)  compoundCount++;
  if (compoundCount >= 2) score += compoundCount * 0.8; // compound penalty

  // Battery penalty — low battery = potential data loss
  const bat = w.battery || 100;
  if (bat < 15) score += 1.0;
  else if (bat < 30) score += 0.4;

  // Signal quality penalty — poor RSSI means unreliable data
  const rssi = w.rssi || -80;
  if (rssi < -90) score += 0.5;

  return Math.min(10, parseFloat(score.toFixed(2)));
}

// ═══════════════════════════════════════════════════════════
//  2. DIJKSTRA SHORTEST-PATH EVACUATION ROUTING
//     Graph nodes = tunnel junctions + exits
//     Edge weights = distance + hazard penalty + congestion
// ═══════════════════════════════════════════════════════════
const TUNNEL_GRAPH = {
  // node: { x, y, connections: [{to, baseDist}] }
  'SURFACE':  { x: 170, y: 20,  label: '▲ Surface Exit',    type: 'exit' },
  'J-SHAFT':  { x: 170, y: 80,  label: 'Main Shaft Junction', type: 'junction' },
  'J-T2':     { x: 280, y: 160, label: 'T2 Junction',        type: 'junction' },
  'J-T3':     { x: 400, y: 210, label: 'T3 Junction',        type: 'junction' },
  'J-T4':     { x: 400, y: 310, label: 'T4 Junction',        type: 'junction' },
  'J-T5':     { x: 650, y: 290, label: 'T5 Junction',        type: 'junction' },
  'J-T6':     { x: 750, y: 380, label: 'T6 Junction',        type: 'junction' },
  'REFUGE-1': { x: 280, y: 160, label: 'Muster T2',          type: 'refuge' },
  'REFUGE-2': { x: 170, y: 310, label: 'Refuge Chamber B',   type: 'refuge' },
};

const TUNNEL_EDGES = [
  { from: 'SURFACE',  to: 'J-SHAFT', dist: 60  },
  { from: 'J-SHAFT',  to: 'J-T2',   dist: 100 },
  { from: 'J-SHAFT',  to: 'J-T4',   dist: 230 },
  { from: 'J-T2',     to: 'J-T3',   dist: 130 },
  { from: 'J-T2',     to: 'REFUGE-1', dist: 0  },
  { from: 'J-T3',     to: 'J-T5',   dist: 260 },
  { from: 'J-T4',     to: 'J-T6',   dist: 350 },
  { from: 'J-T4',     to: 'REFUGE-2', dist: 80 },
  { from: 'J-T5',     to: 'J-T6',   dist: 140 },
];

function dijkstraEvacRoute(workerX, workerY, workers, geofences) {
  // Build adjacency list with real-time hazard weights
  const adj = {};
  Object.keys(TUNNEL_GRAPH).forEach(n => { adj[n] = []; });

  // Add worker start node
  adj['WORKER'] = [];
  // Find nearest tunnel node to worker
  let nearestNode = 'J-SHAFT', nearestDist = Infinity;
  Object.entries(TUNNEL_GRAPH).forEach(([id, node]) => {
    const d = Math.sqrt(Math.pow(workerX - node.x, 2) + Math.pow(workerY - node.y, 2));
    if (d < nearestDist) { nearestDist = d; nearestNode = id; }
  });
  adj['WORKER'].push({ to: nearestNode, weight: nearestDist });

  TUNNEL_EDGES.forEach(e => {
    // Hazard weight: check if a danger geofence overlaps this edge
    let hazardPenalty = 0;
    if (geofences && geofences.length) {
      geofences.forEach(gf => {
        if (gf.type === 'hazard' || gf.type === 'machinery') {
          const from = TUNNEL_GRAPH[e.from];
          const to   = TUNNEL_GRAPH[e.to];
          if (from && to) {
            // Check if midpoint of edge is inside geofence
            const mx = (from.x + to.x) / 2, my = (from.y + to.y) / 2;
            const gd = Math.sqrt(Math.pow(mx - (gf.cx||0), 2) + Math.pow(my - (gf.cy||0), 2));
            if (gd < (gf.radius || 50)) hazardPenalty += 500; // huge penalty for hazard paths
          }
        }
      });
    }
    // Congestion penalty: many workers on this path segment
    let congestion = 0;
    if (workers && workers.length) {
      const from = TUNNEL_GRAPH[e.from], to = TUNNEL_GRAPH[e.to];
      if (from && to) {
        workers.forEach(w => {
          const dx = to.x - from.x, dy = to.y - from.y;
          const len = Math.sqrt(dx*dx + dy*dy) || 1;
          const t = Math.max(0, Math.min(1, ((w.x - from.x)*dx + (w.y - from.y)*dy) / (len*len)));
          const closestX = from.x + t*dx, closestY = from.y + t*dy;
          const dist = Math.sqrt(Math.pow(w.x - closestX, 2) + Math.pow(w.y - closestY, 2));
          if (dist < 30) congestion += 15; // each worker adds 15 to path weight
        });
      }
    }
    const weight = e.dist + hazardPenalty + congestion;
    adj[e.from].push({ to: e.to,   weight });
    adj[e.to].push({   to: e.from, weight });
  });

  // Dijkstra from WORKER node
  const dist = { WORKER: 0 };
  const prev = {};
  const visited = new Set();
  const queue = [{ node: 'WORKER', d: 0 }];

  Object.keys(adj).forEach(n => { if (n !== 'WORKER') dist[n] = Infinity; });

  while (queue.length) {
    queue.sort((a, b) => a.d - b.d);
    const { node } = queue.shift();
    if (visited.has(node)) continue;
    visited.add(node);
    (adj[node] || []).forEach(({ to, weight }) => {
      const alt = dist[node] + weight;
      if (alt < (dist[to] ?? Infinity)) {
        dist[to] = alt;
        prev[to] = node;
        queue.push({ node: to, d: alt });
      }
    });
  }

  // Find best exit/refuge
  const targets = Object.entries(TUNNEL_GRAPH)
    .filter(([, v]) => v.type === 'exit' || v.type === 'refuge')
    .map(([id]) => ({ id, dist: dist[id] || Infinity }))
    .sort((a, b) => a.dist - b.dist);

  const best = targets[0];
  if (!best || best.dist === Infinity) return { path: [], target: 'SURFACE', dist: 9999, safe: false };

  // Reconstruct path
  const path = [];
  let cur = best.id;
  while (cur && cur !== 'WORKER') {
    const node = TUNNEL_GRAPH[cur];
    if (node) path.unshift({ id: cur, label: node.label, x: node.x, y: node.y, type: node.type });
    cur = prev[cur];
  }

  return {
    path,
    target: best.id,
    targetLabel: TUNNEL_GRAPH[best.id]?.label || best.id,
    dist: Math.round(best.dist),
    estimatedTime: Math.round(best.dist / 50 * 60), // ~50 units/min walking speed
    safe: best.dist < 2000,
  };
}

// ═══════════════════════════════════════════════════════════
//  3. VENTILATION OPTIMIZATION
//     Calculates which zones need fan boost based on gas levels
//     Uses a greedy zone-priority algorithm
// ═══════════════════════════════════════════════════════════
function optimizeVentilation(workers, threshold) {
  const VENT_THRESHOLD = threshold || parseFloat(process.env.VENT_BOOST_THRESHOLD) || 0.4;
  const zoneGas = {};

  workers.forEach(w => {
    if (!zoneGas[w.zone]) zoneGas[w.zone] = { ch4: 0, co: 0, fg: 0, o2: 21, workers: 0, zone: w.zone };
    zoneGas[w.zone].ch4 = Math.max(zoneGas[w.zone].ch4, w.ch4 || 0);
    zoneGas[w.zone].co  = Math.max(zoneGas[w.zone].co,  w.co  || 0);
    const ef = (w.flammableGas != null && w.flammableGas !== undefined)
      ? Number(w.flammableGas)
      : ((w.flammable_gas != null && w.flammable_gas !== undefined)
        ? Number(w.flammable_gas)
        : (w.ch4 || 0) + (w.co || 0));
    zoneGas[w.zone].fg = Math.max(zoneGas[w.zone].fg, ef);
    zoneGas[w.zone].o2  = Math.min(zoneGas[w.zone].o2,  w.o2  || 21);
    zoneGas[w.zone].workers++;
  });

  // Priority score for ventilation need
  const zones = Object.values(zoneGas).map(z => {
    const priority = (z.fg / 200) * 55
                   + (z.ch4 / 1.0) * 15
                   + (z.co  / 50)  * 15
                   + (Math.max(0, 19.5 - z.o2) / 2.5) * 15;
    return {
      zone: z.zone,
      priority: parseFloat(priority.toFixed(1)),
      ch4: z.ch4, co: z.co, fg: z.fg, o2: z.o2, workers: z.workers,
      action: priority > 60 ? 'EMERGENCY_BOOST'
            : priority > 30 ? 'INCREASE_FLOW'
            : priority > 10 ? 'MONITOR'
            : 'NORMAL',
      fanSpeedPct: Math.min(100, Math.round(20 + priority * 0.8)),
    };
  });

  zones.sort((a, b) => b.priority - a.priority);
  return zones;
}

// ═══════════════════════════════════════════════════════════
//  4. WORKER DISTRIBUTION OPTIMIZATION
//     Greedy algorithm — redistributes overcrowded zones,
//     suggests redeployment to balance risk load
// ═══════════════════════════════════════════════════════════
function optimizeWorkerDistribution(workers) {
  const MAX_PER_ZONE = parseInt(process.env.MAX_WORKERS_PER_ZONE) || 5;
  const zoneCount = {};
  const zoneRisk  = {};

  workers.forEach(w => {
    zoneCount[w.zone] = (zoneCount[w.zone] || 0) + 1;
    if (!zoneRisk[w.zone] || w.risk > zoneRisk[w.zone]) zoneRisk[w.zone] = w.risk;
  });

  const recommendations = [];

  // Find over-crowded + high-risk zones
  const hotspots = Object.entries(zoneCount)
    .filter(([zone, count]) => count > MAX_PER_ZONE || (zoneRisk[zone] || 0) > 6)
    .map(([zone, count]) => ({ zone, count, risk: zoneRisk[zone] || 0 }))
    .sort((a, b) => b.risk - a.risk);

  // Find under-utilized + safe zones
  const safeZones = Object.entries(zoneCount)
    .filter(([zone, count]) => count < MAX_PER_ZONE && (zoneRisk[zone] || 0) < 3)
    .map(([zone, count]) => ({ zone, count }));

  hotspots.forEach(h => {
    const excess = Math.max(0, h.count - MAX_PER_ZONE);
    const action = h.risk > 7 ? 'EVACUATE_ALL'
                 : h.risk > 5 ? 'REDUCE_HEADCOUNT'
                 : excess > 0 ? 'REDISTRIBUTE'
                 : 'INCREASE_MONITORING';
    const target = safeZones.length ? safeZones[0].zone : 'Surface';
    recommendations.push({
      fromZone: h.zone,
      issue: h.risk > 7 ? 'Critical risk level' : excess > 0 ? `${excess} over capacity` : 'High risk',
      action,
      moveCount: h.risk > 7 ? h.count : excess || 1,
      suggestedZone: target,
      urgency: h.risk > 7 ? 'IMMEDIATE' : h.risk > 5 ? 'HIGH' : 'MEDIUM',
    });
  });

  return {
    recommendations,
    summary: {
      totalWorkers: workers.length,
      zonesAboveCapacity: hotspots.filter(h => h.count > MAX_PER_ZONE).length,
      zonesHighRisk: hotspots.filter(h => h.risk > 5).length,
      maxWorkersPerZone: MAX_PER_ZONE,
      zoneBreakdown: zoneCount,
    }
  };
}

// ═══════════════════════════════════════════════════════════
//  5. PREDICTIVE FATIGUE ALGORITHM
//     Uses heart rate trend + time underground + motion data
//     to predict fatigue onset before it becomes dangerous
// ═══════════════════════════════════════════════════════════
function predictFatigue(workers, telemetryFn) {
  return workers.map(w => {
    const hr = w.heart_rate || 72;
    const bat = w.battery || 100;
    // Estimate time underground from battery drain (100% = ~8hr shift)
    const hoursUnderground = parseFloat(((100 - bat) / 100 * 8).toFixed(1));

    // Fatigue score 0–10:
    // High HR + low battery (long time) + stationary = high fatigue risk
    let fatigue = 0;
    fatigue += Math.max(0, (hr - 72) / 60 * 4);           // elevated HR contribution
    fatigue += Math.min(3, hoursUnderground / 8 * 3);      // time contribution
    fatigue += (w.motion === 0 && hoursUnderground > 2) ? 2 : 0; // stationary late shift
    fatigue += w.risk * 0.3;                               // risk environment adds stress

    const score = Math.min(10, parseFloat(fatigue.toFixed(1)));
    return {
      id: w.id,
      name: w.name,
      zone: w.zone,
      fatigueScore: score,
      hoursUnderground,
      heartRate: hr,
      motion: w.motion,
      recommendation: score >= 8 ? 'IMMEDIATE_RELIEF'
                    : score >= 6 ? 'SCHEDULE_BREAK_NOW'
                    : score >= 4 ? 'MONITOR_CLOSELY'
                    : 'NOMINAL',
      color: score >= 8 ? '#ff2d55' : score >= 6 ? '#ff6b35' : score >= 4 ? '#ffcc00' : '#00ff9d',
    };
  }).sort((a, b) => b.fatigueScore - a.fatigueScore);
}

// ═══════════════════════════════════════════════════════════
//  6. MASTER OPTIMIZATION RUN
//     Called periodically; returns full optimization report
// ═══════════════════════════════════════════════════════════
function runFullOptimization(workers, geofences) {
  const ventilation    = optimizeVentilation(workers);
  const distribution   = optimizeWorkerDistribution(workers);
  const fatigue        = predictFatigue(workers);

  // Per-worker evacuation routes for high-risk workers
  const evacuationRoutes = workers
    .filter(w => w.risk >= 5 || w.status === 'emergency' || w.status === 'critical')
    .map(w => ({
      workerId: w.id,
      workerName: w.name,
      zone: w.zone,
      risk: w.risk,
      route: dijkstraEvacRoute(w.x || 0, w.y || 0, workers, geofences),
    }));

  // Global risk index (mine-wide)
  const globalRisk = workers.length
    ? parseFloat((workers.reduce((a, w) => a + w.risk, 0) / workers.length).toFixed(2))
    : 0;

  // Safety score (inverse of risk, 0–100%)
  const safetyScore = Math.max(0, Math.round((1 - globalRisk / 10) * 100));

  // Top action items (sorted by urgency)
  const actionItems = [
    ...distribution.recommendations.map(r => ({
      type: 'DISTRIBUTION', urgency: r.urgency,
      message: `${r.action} in ${r.fromZone}: ${r.issue}`,
      detail: `Move ${r.moveCount} worker(s) to ${r.suggestedZone}`,
    })),
    ...ventilation.filter(v => v.action !== 'NORMAL').map(v => ({
      type: 'VENTILATION', urgency: v.priority > 60 ? 'IMMEDIATE' : v.priority > 30 ? 'HIGH' : 'MEDIUM',
      message: `${v.action} in ${v.zone}`,
      detail: `Set fan to ${v.fanSpeedPct}% — FG:${(v.fg ?? 0).toFixed(1)} CH₄:${v.ch4.toFixed(2)}% CO:${v.co}ppm O₂:${v.o2.toFixed(1)}%`,
    })),
    ...fatigue.filter(f => f.recommendation !== 'NOMINAL').map(f => ({
      type: 'FATIGUE', urgency: f.fatigueScore >= 8 ? 'IMMEDIATE' : 'HIGH',
      message: `${f.recommendation}: ${f.name} (fatigue ${f.fatigueScore}/10)`,
      detail: `${f.hoursUnderground}h underground, HR:${f.heartRate}bpm`,
    })),
  ].sort((a, b) => {
    const u = { IMMEDIATE: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
    return (u[b.urgency] || 0) - (u[a.urgency] || 0);
  });

  return {
    timestamp: new Date().toISOString(),
    globalRisk,
    safetyScore,
    ventilation,
    distribution,
    fatigue,
    evacuationRoutes,
    actionItems: actionItems.slice(0, 15),
    workersOptimizedRisk: workers.map(w => ({
      id: w.id, name: w.name, zone: w.zone,
      originalRisk: w.risk,
      optimizedRisk: calcOptimizedRisk(w),
    })),
  };
}

module.exports = {
  calcOptimizedRisk,
  dijkstraEvacRoute,
  optimizeVentilation,
  optimizeWorkerDistribution,
  predictFatigue,
  runFullOptimization,
  TUNNEL_GRAPH,
};
