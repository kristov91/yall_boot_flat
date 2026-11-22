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

## Step 3: Score formula (needs the person's pick)

Proposed default:

- Cargo ship sunk: 100 points. Destroyer sunk: 150 points (riskier).
- Return bonus multiplier based on hull state when docking, e.g. x1.0 plus up to +0.25 for low flooding/high O2.
- Score is only banked on a safe return.

## Step 4: Leaderboard storage (needs the person's pick)

Proposed default:

- Server-side JSON file at `user://leaderboard.json` (Godot's per-user data folder, survives restarts, not in git).
- Each entry: crew name (typed by any player at the end screen, default "Crew"), score, cargo sunk, destroyers sunk, patrol duration, date.
- Keep the top 10. Clients get it in the `welcome` message and again on the end screen, which highlights "new high score" when beaten.

## Step 5: End screen and reset

- Docked: "PATROL COMPLETE" banner with score breakdown, leaderboard, crew-name field, Play Again.
- Sunk: "LOST AT SEA" banner (existing game-over), leaderboard shown, nothing banked.
- Play Again uses the existing `reset()`.

## Open questions for the person

A. Score formula: per-ship points as above, or something else (tonnage, time bonus, count only)?
B. Sunk on the way home: lose everything (current assumption), or bank a fraction?
C. Leaderboard: local JSON on the server laptop (assumed), or something shared online?
D. One port at the start point (assumed), or several ports / a different port than the start?
