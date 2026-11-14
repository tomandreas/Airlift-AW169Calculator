# CLAUDE.md – Airlift-AW169Calculator

Read `C:\Users\tom_o\Documents\Repos\CLAUDE.md` (general rules) first. If the two conflict, this file wins. UI language: English.

## What this repo is
AW169 tools site, deployed on Vercel at `aw169calculator.vercel.app`: `index.html`, `ferry.html` (ferry planner), `limitations.html`, `operations.html`, `performance.html`, `sun-moon.html` (LOOME Norway edition), plus PWA icons and manifest. Static pages, no build step, no backend.

## Rules
- **Never touch the ops-hours bot files** in a build: `data/ops_hours.json`, `scripts/update-ops-hours.mjs`, `.github/workflows/update-ops-hours.yml`.
- `sun-moon.html` is a LOOME copy: LOOME changes are applied to all three copies (see `STATUS.md` ripple rules).
- Archive copies go in `versions/<name>.vNN.html` and are listed in `versions.json`. Every page carries a discreet version label at the bottom (`ferry.html`: `v8 · 2026-11-14`) and `<meta name="page-version">`.
- Tom commits, pushes and deploys himself.

## Versions
- `ferry.html` **v8** (2026-11-14): coastwise routing. `versions/ferry.v7.html` is the revert point (forecast wind, no coastwise). v7 (2026-11-14): forecast wind; `versions/ferry.v6.html` is the revert point before that (518 bytes larger than the v6 originally logged). v1 to v5 archive copies are missing.
- Backup before the v8 build: `Documents\Claude\AW169-backups\2026-11-14_0955_pre-coastwise_ferry-v7\` (all working files except `.github/workflows/update-ops-hours.yml`, which the tool cannot write; git history is on GitHub at ab7189e).
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

## ferry.html: coastwise routing (v8)
- Two independent switches in Flight Settings (button `role="switch"`, both OFF by default, not persisted): **Coastwise Vestlandet** (SUMAK, UPLOR, VEMAM, ADNUM) and **Coastwise Helgeland** (SUKAM, ADRIP). Both OFF = identical to v7 (checked: pages, optimiser, 66 optimiser cases).
- Waypoints are the user-supplied coordinates, stored once in `COAST.ROUTES` (frozen, decimal degrees from DMS). Nothing from external databases. No connecting waypoints are invented.
- Both ON: the routes form one chain SUMAK to ADRIP. ADNUM to SUKAM is a direct link (not a defined route segment); it is flagged in the status line, on the leg and on the map (dotted) and is not validated.
- Insertion: each airport is projected onto the chain (spherical along-track and cross-track, nearest segment, ties to the lowest index; position < 0 before the first waypoint, > N after the last). A leg uses the chain waypoints strictly between the two airport positions, in travel order; southbound reverses them. An airport between two waypoints gets only the waypoints on its way (VEMAM, airport, ADNUM). Both airports between the same two waypoints: direct. Waypoints are never stops.
- Relevance rule (deterministic): the coastal path is used only if it is at most **35 % longer** than the direct leg (`COAST.RATIO_MAX = 1.35`). Otherwise the leg stays direct and shows a note ("Coastwise not applied"). No corridor-distance rule. Airports near the end of a route are included in the same way (e.g. Stavanger to Tromso uses the whole chain, +7 %).
- Ambiguity: an airport within 5 NM of two non-adjacent segment positions is flagged on the leg; the nearest segment (lowest index) is used.
- Every leg carries one routed path (`COAST.legPath`, memoised by switch setting and airports) used by: displayed distance, GS in manual Wind mode (each segment at its own track; every segment must be flyable), GS mode (distance / GS), forecast integration (`FWX.integrateLeg` takes a polyline; samples at most 20 NM on every segment, time continuous across the leg), ETE, fuel, arrival times, map and optimiser. Fuel constants unchanged.
- Optimize Route: reach check, remaining-distance score and total all use the routed distance (`legReach`). If the whole from-to journey is coastal, a hop whose own coastal path was refused as too long is not allowed (otherwise the optimiser could fly inland past the selected route). Greedy search, angle filter, priority bonus, range and exclusions are unchanged. Optimiser message texts are still Norwegian (legacy), with a coastwise note appended.
- Map: enabled route as thin blue line, coastal waypoints as diamonds with names (filled when used), planned path previewed (thin dashed) when a switch is ON and no result is shown, route through the waypoints after Calculate. SUMAK and UPLOR lie west of the map picture: drawn as left-edge arrows, the line runs off the edge.
- Results: leg shows `Track` per segment, a "Coastwise: A→SUMAK 28 NM 315° · …" line with segment distances, tracks and "N NM vs M NM direct (+x %)", notes, summary item "Coastwise: n of m legs routed", and a planning-aid note.
- Planning aid only. No terrain, obstacle, airspace or emergency-landing check. Segments are straight great circles.
- Known, left as is: `Flight Settings` panel div is not closed in the HTML (also in v6/v7), so the Route panel nests inside it; fixing it would change the layout.

## Decisions (do not re-propose)
- Open-Meteo free API, private non-commercial use, no key and no backend.
- Model `icon_seamless`; spacing 20 NM; slider 1,000 to 10,000 ft; default 1,000 ft.
- Forecast is fetched only on Calculate.
- The route optimiser stays as it was (still-air or route-wind range); it is not forecast-aware. Calculate flags legs the forecast makes infeasible.
- New legs stay GS unless the route-level Forecast toggle is on.
- Impossible-wind legs are refused, in Wind mode as well.
- Coastwise: user-supplied waypoints only; 35 % detour limit; both ON joins the routes with a flagged direct ADNUM to SUKAM link; no corridor-distance rule; switches not persisted; no draggable or editable route; no forecast-aware optimiser.

## To-do
None queued.
