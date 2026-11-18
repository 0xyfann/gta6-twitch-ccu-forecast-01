# GTA VI Twitch CCU forecaster

Forecasts Grand Theft Auto VI's launch-day Twitch viewers hour by hour
(hours 2–24 of 2026-11-19 UTC) as five quantiles per hour, from the first
hour's print and the release-day curves of 38–42 past big launches.

Entry for the make.fun competition `gta6-twitch-ccu-forecast-01`.

## How it works

Each past launch's release day is rescaled to log-ratios against its own
hour-1 print. Per forecast hour, a kernel-weighted local-linear regression
of that log-ratio on log hour-1 viewers (Gaussian kernel, bandwidth 1.5)
is evaluated at this case's hour-1 print; the spread is the
kernel-weighted residual standard deviation. The day's shape depends
strongly on hour-1 size — a tiny hour 1 means the unlock is still hours
away and the evening ramps 10–100x; a huge hour 1 means the launch is
already live and the day stays near flat.

See [BUILD-NOTES.md](BUILD-NOTES.md) for the full design, the alternatives
tested and rejected, and the measurement caveat (this kit has no local
grade — the practice loss comes from the server grade at submission).

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Node 22+, standard library only. No network, no clock, no randomness.
