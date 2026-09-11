/**
 * Time-decay math for the memory ranking layer.
 *
 * A memory's value decays with age, but *reinforcement* (how often it has been
 * referenced) stretches its half-life. This is the "memories fade unless used"
 * behavior that keeps the store from becoming a junk heap — a memory consulted
 * weekly stays near full weight indefinitely, while an unreferenced one sinks.
 */

/** Whole days between `isoDate` and `now` (never negative). */
export function daysSince(isoDate: string, now: Date = new Date()): number {
  const t = Date.parse(isoDate);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, (now.getTime() - t) / 86_400_000);
}

/**
 * Reinforcement stretches the base half-life logarithmically so frequent use
 * helps but never grows without bound. accessCount of 0 → multiplier 1.
 */
export function effectiveHalfLifeDays(
  baseHalfLife: number,
  accessCount: number,
  reinforcementFactor: number,
): number {
  const stretched = baseHalfLife * (1 + reinforcementFactor * Math.log1p(Math.max(0, accessCount)));
  return Math.max(1, stretched);
}

/**
 * Exponential decay weight in [0, 1]. ageDays 0 → 1; ageDays == halfLife → 0.5.
 */
export function decayWeight(ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return ageDays <= 0 ? 1 : 0;
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays);
}
