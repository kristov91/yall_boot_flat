# Patrol Loop Plan: sink, return to port, beat the high score

Replaces the stopgap "sink every cargo ship = VICTORY" round (added 2026-11-22).

## The loop

1. Leave port with the crew.
2. Hunt convoys. New convoys keep spawning as ships are sunk, so the sea never empties.
3. Decide when to head home. Every ship sunk adds to the patrol score, but the boat is running down (fuel, damage, torpedoes).
4. Reach port alive: the patrol score is banked and shown against the leaderboard.
5. Get sunk on the way: the patrol is lost (see open question B).

## Step 1: Convoy respawn within MIN/MAX (built in this slice)

- New `Simulation` exports in the Convoys group: `ship_population_min`, `ship_population_max`, `convoy_respawn_min_distance`.
- "Population" = ships still afloat (alive and not already sinking).
- Every tick, if population < MIN, spawn whole convoys until it reaches MIN. Each convoy is rolled with the existing destroyer/cargo ranges, then trimmed so it never pushes population over MAX (cargo is kept first, so a trimmed convoy is still worth hunting).
- Respawned convoys appear around the sub's **current** position, between `convoy_respawn_min_distance` and `convoy_spawn_max_distance`, so they never pop in right on top of the boat.
- Fully sunk ships are removed from the world, and running totals `cargo_sunk` / `destroyers_sunk` are kept instead.
- Setting `ship_population_min = 0` turns respawn off and brings back the old sink-all-cargo VICTORY, for testing until port return exists.

## Step 2: Port location and return trigger (built 2026-11-22, assumes question D = one port at start)

- One fixed home port at world origin (0,0), where the sub already starts. Exports in the Port group: `port_position`, `port_radius` (60), `port_leave_distance` (150), `port_dock_seconds` (3), `port_dock_max_speed` (0.05).
- Shown on both Navigation maps as a dashed blue ring at the docking radius. Status table shows distance to port and docking %. (Periscope landmark: not yet.)
- On docking, the sim freezes and clients show PATROL COMPLETE with the sunk counts and Play Again. No score yet (step 3).
- Return trigger: inside `port_radius`, surfaced (depth <= `surfaced_max_depth`), and nearly stopped, held for a few seconds (`port_dock_seconds`). That stops a drive-by "touch and go" and makes docking a crew task.
- The trigger is armed only after the sub has first left port (been outside, say, 2x the radius), so the round can't end at tick 1.
- Optional later: a client "Return to port" bearing/range readout on the nav table.

## Step 3: Score formula (built 2026-11-22, Chris's pick)

- 100 points per cargo ship, 50 per destroyer (`score_per_cargo`, `score_per_destroyer`, Scoring group).
- Mild damage penalty on return: damage = flooding (0..1) + `damage_per_leak` (0.1) per unwelded leak, capped at 1. Score x (1 - damage x `damage_penalty_max`), default 0.25, so a wreck that limps home keeps 75%.
- Banked only by docking. Sunk = lose everything, start over.
- Live "Patrol Score" row in the status table shows what docking right now would bank, with the best score to beat.

## Step 4: Leaderboard (built 2026-11-22)

- `server/leaderboard.gd`: top `leaderboard_size` (10) in `user://leaderboard.json`, which on Windows is `%APPDATA%\Godot\app_userdata\YallBootFlat\leaderboard.json`. Not in git.
- Entry: name (default "Crew"), score, cargo sunk, destroyers sunk, damage penalty, duration, date. Ties go to the older entry.
- The board is sent in state only once the patrol is over (docked or sunk). `best_score` is sent always.

## Step 5: End screen (built 2026-11-22)

- Docked: PATROL COMPLETE banner with the score breakdown, NEW HIGH SCORE when beaten, a crew-name field (any player, `SET_CREW_NAME`, max `crew_name_max_length`), the leaderboard with this patrol highlighted, and Play Again.
- Sunk: SUBMARINE LOST banner saying nothing was banked, with the leaderboard.
- Ports are a list (`port_positions`), with one entry for now. Docking at any of them ends the patrol.

## Still open / next ideas

- The old sink-all-cargo VICTORY still exists only when `ship_population_min = 0`. It can be removed once nobody needs it.
- Periscope landmark for the port, plus a bearing/range-to-port readout on the nav table.
- BALL/PRESS/COMP AIR gauges are still unbound.
