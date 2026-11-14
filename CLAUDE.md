# CLAUDE.md – Airlift-AW169Calculator

Read `C:\Users\tom_o\Documents\Repos\CLAUDE.md` (general rules) first. If the two conflict, this file wins. UI language: English.

## What this repo is
AW169 tools site, deployed on Vercel at `aw169calculator.vercel.app`: `index.html`, `ferry.html` (ferry planner), `limitations.html`, `operations.html`, `performance.html`, `sun-moon.html` (LOOME Norway edition), plus PWA icons and manifest. Static pages, no build step, no backend.

## Rules
- **Never touch the ops-hours bot files** in a build: `data/ops_hours.json`, `scripts/update-ops-hours.mjs`, `.github/workflows/update-ops-hours.yml`.
- `sun-moon.html` is a LOOME copy: LOOME changes are applied to all three copies (see `STATUS.md` ripple rules).
- Archive copies go in `versions/<name>.vNN.html` and are listed in `versions.json`. Every page carries a discreet version label at the bottom (`ferry.html`: `v7 · 2026-11-14`) and `<meta name="page-version">`.
- Tom commits, pushes and deploys himself.

## Versions
- `ferry.html` **v7** (2026-11-14): forecast wind. `versions/ferry.v6.html` is the revert point (page as it was before v7; 518 bytes larger than the v6 originally logged). v1 to v5 archive copies are missing.
- `sun-moon.html` v7 (LOOME 1.9).
- `versions.json` is stale for payload, limitations, operations and performance: re-log when those pages next change.

## ferry.html: forecast wind (v7)
- Legs have three modes: GS | Wind | Forecast (`wp.mode` = `gs`, `wind`, `fc`). Route-level toggle "All legs: Manual / Forecast". Manual route wind and Clear never overwrite Forecast legs.
- Cruise altitude slider 1,000 to 10,000 ft in 1,000 ft steps, default 1,000 ft. Single (route) or Per leg. First switch to Per leg copies the route altitude into every leg; values are kept afterwards; new legs inherit the route altitude.
- Source: Open-Meteo Forecast API, `models=icon_seamless` (DWD ICON), pressure levels 1000 to 600 hPa (wind speed, wind direction, geopotential height), `wind_speed_unit=kn`, `timeformat=unixtime`. No API key, no backend, called straight from the browser. If the API rejects `models=`, the page retries once without it ("best match") and says so.
- Engine = `FWX` block in `ferry.html` (no DOM access): great-circle samples at most 20 NM apart; wind at each sample's own arrival time and altitude (vertical interpolation by geopotential height, then time interpolation, wind as u/v vectors); wind triangle with crosswind correction; segment time = trapezoid on 1/GS with a predicted end time; legs marched in order, each starting at the previous arrival plus the ground stop. Average GS = distance / integrated time.
- Fetch only when Calculate is pressed. One batched request per 50 points. In-memory cache by 0.05 degree point, UTC days and pressure levels; data younger than 3 h is reused (TAS, ground stop and small time changes cost no request). A failed refresh may reuse older cached data but it is labelled STALE.
- Never assumes zero wind: a missing forecast, a departure in the past, a departure more than 7 days ahead, or null data stops the calculation with an explanation and the pilot switches those legs to GS or Wind.
- Impossible wind (crosswind at or above TAS, or GS below 30 kt) refuses the leg and the route, in Forecast and in manual Wind mode (no silent clamp, no time or fuel).
- Cruise altitude below terrain at a sample point (`elevation` from the API): the leg gets a warning and the wind is taken at terrain level there. It is never silent.
- Forecast winds are model estimates, not a weather briefing. Attribution to Open-Meteo.com (CC BY 4.0) is shown on the page.
- Manual GS and Wind results are unchanged from v6 (checked by regression test, identical output).

## Decisions (do not re-propose)
- Open-Meteo free API, private non-commercial use, no key and no backend.
- Model `icon_seamless`; spacing 20 NM; slider 1,000 to 10,000 ft; default 1,000 ft.
- Forecast is fetched only on Calculate.
- The route optimiser stays as it was (still-air or route-wind range); it is not forecast-aware. Calculate flags legs the forecast makes infeasible.
- New legs stay GS unless the route-level Forecast toggle is on.
- Impossible-wind legs are refused, in Wind mode as well.

## To-do
None queued.
