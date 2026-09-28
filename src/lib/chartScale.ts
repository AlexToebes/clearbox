/**
 * "Nice" axis tick generation (issue #6 polish): rather than letting
 * Recharts pick raw ticks off the data's exact max (giving ugly steps
 * like 450/900/1,350/1,800), compute a human-friendly step — 1, 2, 2.5 or
 * 5 × a power of ten — and derive the tick list from it. Mirrors the
 * classic "nice numbers" axis algorithm (e.g. D3's `ticks`/`nice`).
 */

const NICE_FRACTIONS = [1, 2, 2.5, 5, 10] as const;

/**
 * Returns evenly-spaced ticks from `0` to a "nice" maximum at or above
 * `maxValue`, aiming for `targetTicks` values (a "nice" max can land one
 * tick short or over depending on how `maxValue` falls against the step).
 * `maxValue <= 0` (no data) returns `[0, 1]` — a minimal, still-valid axis
 * rather than a degenerate single-point one.
 */
export function niceTicks(maxValue: number, targetTicks = 5): number[] {
  if (!Number.isFinite(maxValue) || maxValue <= 0) {
    return [0, 1];
  }

  const intervals = Math.max(1, targetTicks - 1);
  const roughStep = maxValue / intervals;
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  const niceFraction =
    NICE_FRACTIONS.find((fraction) => fraction >= normalized) ?? 10;
  const step = niceFraction * magnitude;
  const niceMax = Math.ceil(maxValue / step) * step;

  const ticks: number[] = [];
  // The `+ step / 2` guard is a float-safety margin so the final tick
  // (which should land exactly on `niceMax`) isn't dropped by rounding
  // error in the loop's running total.
  for (let value = 0; value <= niceMax + step / 2; value += step) {
    ticks.push(Math.round(value * 1e6) / 1e6);
  }
  return ticks;
}
