// gta6-twitch-ccu-forecast-01 — hour-by-hour Twitch CCU forecaster.
//
// Idea: every past big launch in the case's `comparables` has a release-day
// curve. Rescale each curve to log(viewers_h / viewers_hour1) — the shape of
// the day relative to its own first hour. The shape depends strongly on how
// big hour 1 already is: a launch whose hour 1 is tiny (unlock still hours
// away in the big markets) ramps 10-100x by the evening, while a launch
// whose hour 1 is already huge (rolling midnight, big markets live) stays
// near flat. So, per forecast hour h, fit a kernel-weighted local-linear
// regression of the log-ratio on log(hour-1 viewers) across the
// comparables (Gaussian kernel, bandwidth 1.5 in log units), evaluate it at
// this case's log hour-1 print, and take the kernel-weighted residual
// standard deviation as the log spread. Quantiles are then
//   q_tau(h) = p1 * exp(centre_h + z_tau * sd_h)
// with z the standard-normal quantiles. No clock, no network, no randomness:
// the same case file always yields the same bytes.
//
// Fallbacks (never expected on a real case): if fewer than 3 comparables
// carry a usable hour-1 print, fall back to the pooled per-hour median
// log-ratio with a fixed spread; if there are no comparables at all, fall
// back to a flat median with a spread widening like sqrt(h - 1).

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Scored quantile levels, in row order. */
const LEVELS: number[] = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard-normal quantiles at LEVELS. */
const Z: number[] = [-1.645, -0.674, 0, 0.674, 1.645];
/** Gaussian kernel bandwidth, in natural-log units of hour-1 viewers. */
const BANDWIDTH = 1.5;
/** Floor / cap on the per-hour log spread, so bands never collapse or explode. */
const SD_FLOOR = 0.1;
const SD_CAP = 2.5;
/** Local-linear slope is clamped to this magnitude (guards extrapolation). */
const SLOPE_CAP = 1;
/**
 * Shrinkage on the fitted slope (0.8): the log-ratio/log-h1 slope is noisy
 * and GTA VI's hour 1 may sit above every comparable, so the slope is pulled
 * 20% toward flat. Leave-one-out over the comparables: 0.3765 vs 0.3785
 * unshrunk (all launches), 0.2547 vs 0.2593 (hour-1 >= 20k only).
 */
const SLOPE_SHRINK = 0.8;
/** Small spread shrinkage, same leave-one-out comparison. */
const SD_MULT = 0.95;

type HourlyPoint = { from: string; viewers: number | null; channels?: number | null };
type Comparable = { day_start: string; hourly: HourlyPoint[] };
type CaseFile = {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables: Comparable[];
};

/** Parse an ISO-8601 timestamp to epoch milliseconds (NaN on garbage). */
function parseTime(s: unknown): number {
  if (typeof s !== 'string') return NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * One comparable's release-day curve as log-ratios to its own hour-1 print,
 * or null when it has no usable hour-1 print. Returns { x, ratios } where
 * x = ln(hour-1 viewers) and ratios[h] = ln(viewers_h / viewers_1).
 */
function comparableCurve(comp: Comparable): { x: number; ratios: Map<number, number> } | null {
  const start = parseTime(comp.day_start);
  if (!Number.isFinite(start) || !Array.isArray(comp.hourly)) return null;
  const byHour = new Map<number, number>();
  for (const pt of comp.hourly) {
    if (!pt || typeof pt.viewers !== 'number' || !Number.isFinite(pt.viewers) || pt.viewers <= 0) continue;
    const t = parseTime(pt.from);
    if (!Number.isFinite(t)) continue;
    const d = (t - start) / 3600000;
    if (d >= 0 && d < 24) {
      const h = Math.floor(d) + 1;
      if (!byHour.has(h)) byHour.set(h, pt.viewers);
    }
  }
  const v1 = byHour.get(1);
  if (v1 === undefined || v1 <= 0) return null;
  const ratios = new Map<number, number>();
  for (const [h, v] of byHour) ratios.set(h, Math.log(v / v1));
  return { x: Math.log(v1), ratios };
}

/** Linear-interpolation quantile of a sorted array. */
function quantileSorted(sorted: number[], p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = p * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, n - 1);
  const f = pos - lo;
  return sorted[lo] * (1 - f) + sorted[hi] * f;
}

/** Clamp a number into [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Round to 2 decimals (half up), keeping the value finite and positive. */
function round2(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 1;
  return Math.min(1e9, Math.round(x * 100) / 100);
}

/** Forecast quantiles for one case. */
function forecastCase(c: CaseFile): Array<{ hour: number; q: number[] }> {
  const first = c.known.find((k) => k.hour === 1);
  const p1 = first !== undefined && Number.isFinite(first.viewers) && first.viewers > 0 ? first.viewers : 1;
  const xg = Math.log(p1);

  const curves: Array<{ x: number; ratios: Map<number, number> }> = [];
  if (Array.isArray(c.comparables)) {
    for (const comp of c.comparables) {
      const curve = comparableCurve(comp);
      if (curve !== null) curves.push(curve);
    }
  }

  const hours = c.forecast.map((f) => f.hour).filter((h) => Number.isInteger(h) && h >= 2 && h <= 24);
  const out: Array<{ hour: number; q: number[] }> = [];

  for (const h of hours) {
    let centre = 0;
    let sd = 0.15 * Math.sqrt(h - 1);
    if (curves.length >= 3) {
      // Kernel-weighted local-linear fit of log-ratio on log hour-1 viewers.
      let sw = 0;
      let swx = 0;
      let swy = 0;
      const pts: Array<{ x: number; y: number; w: number }> = [];
      for (const curve of curves) {
        const y = curve.ratios.get(h);
        if (y === undefined) continue;
        const w = Math.exp(-0.5 * Math.pow((curve.x - xg) / BANDWIDTH, 2));
        pts.push({ x: curve.x, y, w });
        sw += w;
        swx += w * curve.x;
        swy += w * y;
      }
      if (pts.length >= 3 && sw > 0) {
        const mx = swx / sw;
        const my = swy / sw;
        let den = 0;
        let num = 0;
        for (const pt of pts) {
          den += pt.w * (pt.x - mx) * (pt.x - mx);
          num += pt.w * (pt.x - mx) * (pt.y - my);
        }
        const slope = clamp(den > 1e-12 ? num / den : 0, -SLOPE_CAP, SLOPE_CAP) * SLOPE_SHRINK;
        const intercept = my - slope * mx;
        centre = intercept + slope * xg;
        let varSum = 0;
        for (const pt of pts) {
          const r = pt.y - (intercept + slope * pt.x);
          varSum += pt.w * r * r;
        }
        sd = clamp(Math.sqrt(varSum / sw), SD_FLOOR, SD_CAP) * SD_MULT;
      } else {
        // Too few comparables report this hour: pooled median + fixed spread.
        const rs = curves
          .map((curve) => curve.ratios.get(h))
          .filter((y): y is number => y !== undefined)
          .sort((a, b) => a - b);
        if (rs.length > 0) centre = quantileSorted(rs, 0.5);
      }
    } else if (curves.length > 0) {
      const rs = curves
        .map((curve) => curve.ratios.get(h))
        .filter((y): y is number => y !== undefined)
        .sort((a, b) => a - b);
      if (rs.length > 0) centre = quantileSorted(rs, 0.5);
    }

    const qs = Z.map((z) => round2(p1 * Math.exp(centre + z * sd)));
    // Enforce non-decreasing (already true by construction; belt and braces).
    for (let i = 1; i < qs.length; i += 1) {
      if (qs[i] < qs[i - 1]) qs[i] = qs[i - 1];
    }
    out.push({ hour: h, q: qs });
  }
  return out;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (!Array.isArray(c.levels) || c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
