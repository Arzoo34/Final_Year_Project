'use strict';

// ============================================================
//  SafeMine — Dynamic Oxygen Level Calculation Module
//  File: o2Calculation.js
//
//  PURPOSE:
//    Replaces static/dummy O2 values with a physics-inspired
//    model that accounts for:
//      1. Worker count  → oxygen consumption by respiration
//      2. Gas level     → displacement of O2 by harmful gases
//         (MQ2 reading, representing CH4/flammable gas %)
//
//  ORIGINAL LOGIC (for comparison):
//    Old code in dummy-engine.js / simulator.js used:
//      s.o2 = clamp(s.o2 + jitter(0, 0.02) * s._o2Dir, 19.2, 21.0)
//    This was a simple random walk with no environmental basis.
//
//  NEW LOGIC (this file):
//    calculateOxygenLevel(workerCount, gasLevel) returns a
//    realistic O2 % based on real environmental factors.
//
//  INTEGRATION POINT:
//    • dummy-engine.js → evolveGas() uses this instead of the
//      random walk for o2.
//    • server.js       → handleHelmetUpdate() overrides o2Raw
//      with this calculation when in DUMMY_MODE or when the
//      sensor sends a default 20.9 fallback.
// ============================================================

// ── Constants ─────────────────────────────────────────────────

// Atmospheric baseline O2 level (%)
const O2_BASELINE = 20.9;

// Realistic safe operating bounds for mine tunnels (%)
const O2_MIN_BOUND = 15.0;
const O2_MAX_BOUND = 21.0;

// Oxygen consumed per worker per update cycle (% per person).
// In a sealed tunnel, each worker displaces ~0.3–0.5% of the
// total O₂ over an extraction cycle. We choose 0.12 per tick
// so at ~12 workers the total drop is ~1.44% from baseline.
const O2_DROP_PER_WORKER = 0.12;

// Maximum O2 drop caused by workers alone (% cap)
const O2_MAX_WORKER_DROP = 2.5;

// O2 drop coefficient due to flammable gas displacement.
// At 1% CH4, surrounding O2 is displaced by roughly 1–1.5%
// in a static, poorly-ventilated tunnel. We use 1.2 as the
// coefficient (gasLevel × 1.2 = O2 drop from gas).
const O2_GAS_COEFFICIENT = 1.2;

// Maximum O2 drop caused by gas alone (% cap)
const O2_MAX_GAS_DROP = 4.0;

// Small random noise to simulate sensor jitter (±%)
const O2_NOISE_SPREAD = 0.06;

// ── O2 Safety Label thresholds ────────────────────────────────
// Used by getO2Label() to classify the current O2 level.
const O2_DANGER_THRESHOLD  = 18.0;  // Below this → DANGER
const O2_WARNING_THRESHOLD = 19.5;  // Below this → WARNING, else SAFE

// ── Helper: small random jitter ──────────────────────────────
function jitter(spread) {
  return (Math.random() - 0.5) * 2 * spread;
}

// ── Helper: numeric clamp ─────────────────────────────────────
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

// =============================================================
//  calculateOxygenLevel(workerCount, gasLevel)
//
//  INPUTS:
//    workerCount  {number} — number of active workers in tunnel
//                           (use Object.keys(workers).length from backend)
//    gasLevel     {number} — MQ2 / flammable gas reading in %
//                           (e.g., ch4 value from sensor data, 0–5%)
//
//  OUTPUT:
//    {number} — O2 percentage, clamped to [O2_MIN_BOUND, O2_MAX_BOUND]
//               Rounded to 2 decimal places.
//
//  MODEL:
//    O2 = baseline
//       − workerDrop   (respiration consumption)
//       − gasDrop      (gas displacement)
//       + noise        (sensor micro-variation)
//
//  EXAMPLES:
//    calculateOxygenLevel(0,  0.0) → ~20.9  (empty tunnel, clean air)
//    calculateOxygenLevel(6,  0.2) → ~19.9  (moderate load)
//    calculateOxygenLevel(12, 0.5) → ~18.9  (busy tunnel, some gas)
//    calculateOxygenLevel(12, 1.2) → ~17.9  (high gas, many workers)
// =============================================================
function calculateOxygenLevel(workerCount, gasLevel) {
  // Sanitize inputs
  const workers = Math.max(0, Number(workerCount) || 0);
  const gas     = Math.max(0, Number(gasLevel)     || 0);

  // Drop 1: Respiration — more workers consume more O2
  // Capped to avoid unrealistic drops in very large counts
  const workerDrop = clamp(workers * O2_DROP_PER_WORKER, 0, O2_MAX_WORKER_DROP);

  // Drop 2: Gas displacement — higher MQ2/CH4 reading displaces O2
  const gasDrop = clamp(gas * O2_GAS_COEFFICIENT, 0, O2_MAX_GAS_DROP);

  // Apply noise for realistic sensor jitter
  const noise = jitter(O2_NOISE_SPREAD);

  // Combine all factors
  const o2 = O2_BASELINE - workerDrop - gasDrop + noise;

  // Clamp to realistic mine O2 bounds and round to 2dp
  return +clamp(o2, O2_MIN_BOUND, O2_MAX_BOUND).toFixed(2);
}

// =============================================================
//  getO2Label(o2Level)
//
//  Returns a safety status label for the given O2 value.
//
//  THRESHOLDS (OSHA / mining industry standards):
//    < 18.0%  →  "DANGER"   (oxygen-deficient, immediate hazard)
//    18–19.5% →  "WARNING"  (reduced, monitor closely)
//    ≥ 19.5%  →  "SAFE"     (within acceptable range)
//
//  INPUT:  o2Level {number}
//  OUTPUT: "SAFE" | "WARNING" | "DANGER"
// =============================================================
function getO2Label(o2Level) {
  const o2 = Number(o2Level);
  if (!Number.isFinite(o2)) return 'UNKNOWN';
  if (o2 < O2_DANGER_THRESHOLD)  return 'DANGER';
  if (o2 < O2_WARNING_THRESHOLD) return 'WARNING';
  return 'SAFE';
}

// =============================================================
//  getO2Status(o2Level)
//
//  Returns a structured status object for API responses.
//
//  OUTPUT: { value, label, color }
//    value  — the numeric O2 level
//    label  — "SAFE" | "WARNING" | "DANGER"
//    color  — CSS/web-safe color string for UI use
// =============================================================
function getO2Status(o2Level) {
  const label = getO2Label(o2Level);
  const colorMap = {
    SAFE:    '#22c55e',  // green
    WARNING: '#f59e0b',  // amber
    DANGER:  '#ef4444',  // red
    UNKNOWN: '#6b7280',  // gray
  };
  return {
    value: +Number(o2Level).toFixed(2),
    label,
    color: colorMap[label] || colorMap.UNKNOWN,
  };
}

// ── Exports ──────────────────────────────────────────────────
module.exports = {
  calculateOxygenLevel,
  getO2Label,
  getO2Status,
  // Expose constants so callers can reference thresholds
  O2_BASELINE,
  O2_MIN_BOUND,
  O2_MAX_BOUND,
  O2_DANGER_THRESHOLD,
  O2_WARNING_THRESHOLD,
};
