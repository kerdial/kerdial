/**
 * GATE-1's shared peak-overlap measurement: extracted out of
 * `holdings-history-status-request-volume.spec.ts`, which originally defined
 * its own private copy, so every network-level spec that needs to prove a
 * peak-concurrency bound over a set of intercepted requests (that spec, plus
 * UR-16's dashboard case 7 and UR-27's Instruments-screen case 8) shares one
 * implementation rather than three independently-maintained ones.
 */
export interface RequestInterval {
  readonly start: number;
  readonly end: number;
}

/** Sweep-line max-overlap over a set of `[start, end)` request intervals. */
export function peakConcurrency(intervals: readonly RequestInterval[]): number {
  const events: Array<[number, 1 | -1]> = [];
  for (const { start, end } of intervals) {
    events.push([start, 1], [end, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  for (const [, delta] of events) {
    current += delta;
    if (current > peak) peak = current;
  }
  return peak;
}
