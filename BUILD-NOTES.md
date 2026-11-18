# Build notes — GTA VI Twitch CCU forecaster (gta6-twitch-ccu-forecast-01)

## Entrypoint

- Language/runtime: TypeScript, Node 22 (`node /bot/main.ts`, erasable syntax only).
- Entrypoint: `main.ts` at the repository root, authored from scratch in this
  session for this entry. `tsconfig.json` and `package.json` (`{"type":
  "module"}`) were written from scratch too; the kit's starter was opened
  only to confirm the I/O contract (env vars, output JSON shape) and none of
  its forecasting logic was copied.
- Reads every `*.in` in `$MAKEFUN_INPUT_DIR` (else `/input`), writes
  `/output/<id>.out` (or `$MAKEFUN_OUTPUT_DIR`): 23 rows, hours 2..24, five
  quantiles each. No network, no clock, no randomness — fully deterministic.

## Model

Per forecast hour h, each comparable's release-day curve is rescaled to
log-ratios `ln(viewers_h / viewers_hour1)` against its own hour-1 print.
The day's shape depends strongly on how big hour 1 already is: a launch
whose hour 1 is tiny (unlock still hours away in the big markets) ramps
10–100x by the evening, while a launch whose hour 1 is already huge
(rolling midnight, big markets live) stays near flat. So per hour the model
fits a kernel-weighted local-linear regression of the log-ratio on
`ln(hour-1 viewers)` across the case's comparables (Gaussian kernel,
bandwidth 1.5 in log units), evaluated at this case's log hour-1 print,
with the slope clamped to ±1 and shrunk 20% toward flat (guards
extrapolation — GTA VI's hour 1 may sit above every comparable). The
per-hour log spread is the kernel-weighted residual standard deviation
(floored at 0.10, capped at 2.5, shrunk ×0.95). Quantiles:
`q_tau(h) = p1 * exp(centre_h + z_tau * sd_h)`, z = standard-normal
quantiles, rounded to 2 decimals, clamped to (0, 1e9] and non-decreasing.

Fallbacks (never expected on a real case): fewer than 3 usable comparables
→ pooled per-hour median log-ratio with a `0.15*sqrt(h-1)` spread; no
comparables at all → flat median with the same widening spread. Every
division and log is guarded; null/missing fields (channels, streams,
categories_hourly, minute vs hourly history) never crash the program.

## What was tested and rejected (leave-one-out over the 37 comparables with
## a usable hour-1 print, scored with the documented log-pinball loss)

- House persistence baseline: LOO loss 0.930 overall, 0.321 on the 27
  comparables with hour-1 >= 20k (the relevant population — big launches).
- Pooled per-hour empirical quantiles (no conditioning): 0.714 / 0.377.
- Pooled median + normal spread: 0.794 / —.
- Per-hour linear regression on log hour-1: 0.447 / 0.332.
- Kernel-weighted empirical quantiles (bw 1.0–1.5): 0.404–0.414 / 0.258–0.260.
- Kernel-weighted local-linear + normal residuals (chosen family): bw 1.5 →
  0.380 / 0.259; bw 1.2 → 0.384 / 0.256.
- Conditioning on `ln(hour1 / pre-release 24h mean)` instead of `ln(hour1)`:
  0.745 — rejected (that ratio carries no signal once hour-1 level is known;
  corr ≈ 0). Adding hour-1 channels as a second kernel dimension: 0.411–0.439
  — rejected. Hour-1 vs last pre-release point: corr 0.037 with residuals —
  rejected. Blending kernel quantiles toward the pooled quantiles: worse
  (0.446 at 25% blend) — rejected.
- Final tuning (v2): slope shrinkage 0.8 → LOO 0.3767 / 0.2558; plus spread
  ×0.95 → **0.3765 / 0.2547**. The v1→v2 gain is small (~0.002–0.005,
  within LOO noise) but the slope shrinkage is principled protection against
  extrapolating beyond the comparables' hour-1 range, so v2 is kept.

## Practice measurement — IMPORTANT

`grade-local` cannot grade this kit: it exits 1 with
"makefun grade-local: gta6-twitch-ccu-forecast-01 is a program/v1
competition: its scorer and reference data are not published in the kit, so
it is graded on the server only". This is by design (RULES.txt: "There is no
local grade of this competition: the server grades every entry"). So **no
practice loss from grade-local exists**; the numbers above are the honest
leave-one-out proxy measured locally (same pinball loss, held-out launches
from the same pool). The true practice loss (house baseline ≈ 0.387) is only
available from the server grade at submission. The LOO proxy says this model
beats the baseline by ~20% on big launches (0.255 vs 0.321), which is the
evidence for submitting it.

## Local verification (direct runs, not grade-local)

- v1 and v2 each run twice over all 4 practice cases: outputs byte-identical
  across runs; all outputs valid (23 rows, 5 finite non-decreasing quantiles
  in (0, 1e9], ≤ 65,536 bytes — actual ~1.5 KB each).
- v2 forecast medians (hour-1 print → h19 median): p00 23,357 → 121,075;
  p01 116,550 → 201,633; p02 269,517 → 347,947; p03 119,087 → 204,126 —
  the expected dip-then-evening-ramp shape, larger for smaller hour-1 prints.
- TypeScript output cross-checked against an independent Python
  re-implementation of the same model: max |log ratio| 1e-6 across all
  quantiles (rounding only).
- Runtime: ~0.25 s for all 4 practice cases in one process on this machine
  (Node v24.22.1); per-case far under the 8 s cap.
- Edge cases (synthetic, in /tmp only): no comparables, comparables with no
  hour-1 print, hour-1 = 500, hour-1 = 1,500,000 (above every comparable) —
  all run cleanly with valid, sane outputs (tiny hour-1 → ~400x evening
  ramp; huge hour-1 → near-flat ~0.9x).

## Determinism

- No clock, network, randomness, or environment reads (other than the two
  input/output directory variables). Same case file → same bytes; verified
  by two full runs diffed byte for byte.

## Revision history

- v1 (commit "Forecaster v1"): kernel-weighted local-linear log-ratio model,
  bandwidth 1.5, slope clamped ±1, residual-sd spread.
- v2 (current): slope shrinkage ×0.8 and spread ×0.95; added
  `package.json` (`{"type": "module"}`, silences the module-type warning).
  Genuine behaviour change, re-verified as above.

## Notes for the submit finisher

- Root commit is the kit beacon (`makefun init`): it holds only
  `.makefun/freshness.json` (anchor `6771a55d6f89edbfeec1a70a2a08396687efef73`,
  drand round 34052203); a LICENSE (MIT) commit sits on top of it, then the
  entry commits. Do not rewrite history.
- Nothing has been submitted from this repo; the finisher handles bundling
  and submission. The transcript gate will report no transcripts / 0%
  authored coverage until the finisher bundles this session's transcripts;
  that is expected at build stage.
- The practice loss quoted to the entrant must come from the server grade,
  not from this file's LOO proxy — do not present 0.2547/0.3765 as a practice
  loss.
