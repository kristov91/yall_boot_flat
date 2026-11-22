extends Node
class_name Simulation

## Slice 3+: submarine movement, Helm/Dive stations, a real Engineering
## engine room (start/stop, throttle, gear, coolant, RPM/temp/oil/fuel), an
## electrical system (battery, charging, bilge pump, electric motor), a
## sonar with a tuning dial, randomly-spawned convoys (cargo ships + escorting
## destroyers, see the Convoys/Detection export groups and _step_ships()),
## torpedoes, and an O2/flooding/sunk state (a destroyer hit springs leaks
## that flood the sub and cap O2 - see
## _step_flooding()), on top of the Slice 1-2 station/occupancy/compartment
## model.
##
## The Control room's "Engine Order" lever is deliberately kept separate
## from Engineering's actual throttle: it is a requested order, not a direct
## propulsion control. Actual propulsion comes only from Engineering
## physically running the engine to match that order - the two rooms have to
## communicate, matching the game's cooperative-communication design goal.
##
## Balance constants below are @export so they can be tuned live from the
## Inspector on the Simulation node while playtesting.

const HELM_STATION := "station_helm" # covers both rudder and engine order
const DIVE_STATION := "station_dive"
const SONAR_STATION := "station_sonar"
const ENGINE_CONTROLS_STATION := "station_engine_controls"
const UNOCCUPIED := -1
const DEFAULT_COMPARTMENT := "control"
const TORPEDO_COMPARTMENT := "forward_torpedo" # physical tube-loading controls only now - see CONNING_TOWER_COMPARTMENT for the TDC/targeting side
const CONNING_TOWER_COMPARTMENT := "conning_tower"
const ENGINEERING_COMPARTMENT := "engineering"

const COMPARTMENTS := {
	"forward_torpedo": {"connections": ["information"]},
	"information": {"connections": ["forward_torpedo", "control"]},
	"control": {"connections": ["information", "engineering", "conning_tower"]},
	"engineering": {"connections": ["control"]},
	# Reached by swiping DOWN from Control rather than the normal left/right
	# flow - deliberately left out of COMPARTMENT_LAYOUT below, which is only
	# the horizontal ordering. Houses the TDC and attack periscope stations.
	"conning_tower": {"connections": ["control"]},
}

# Presentation-layer hint only: the order compartments lay out left-to-right
# on the client for swipe navigation. The server's real notion of adjacency
# is the connections[] graph above. conning_tower is intentionally absent -
# it's a vertical link off of "control", not part of this left-right chain.
const COMPARTMENT_LAYOUT := ["forward_torpedo", "information", "control", "engineering"]

## The fixed design resolution every Sub Editor room is authored at (see
## client/index.html's own #room-canvas width/height attributes) - a leak's
## x/y (see _spawn_leak()) is normalized 0..1 against this same resolution,
## so weld_hit_radius (a pixel distance) means the same thing regardless of
## whatever size a player's own screen actually renders the canvas at.
const ROOM_WIDTH := 960.0
const ROOM_HEIGHT := 540.0
## Which compartments leaks are allowed to spring in - everywhere inside the
## main pressure hull, but not the Conning Tower (a sail structure, not part
## of the hull that actually floods).
const LEAK_COMPARTMENTS := ["forward_torpedo", "information", "control", "engineering"]

const GEAR_FORWARD := "forward"
const GEAR_NEUTRAL := "neutral"
const GEAR_REVERSE := "reverse"

const TOOL_START_LOCATIONS := {
	"tool_wrench_01": "engineering",
	"tool_flashlight_01": "control",
}

const DT := 1.0 / 60.0

@export_group("Movement")
@export var speed_response := 0.02
@export var max_speed := 40.0 # was 8.0, then 24.0 (tripled) - bumped again, still too slow to chase convoys down
@export var max_turn_rate := 15.0 # degrees/sec at full rudder
@export var max_dive_rate := 5.0 # depth-units/sec at full dive planes
@export var max_depth := 200.0

@export_group("Ballast")
## Ballast tanks, worked from the dive station's BLOW and FLOOD valves.
## ballast is 0..100 (% of the tanks full of water); at ballast_neutral the
## boat is neutrally buoyant and only the dive planes move it. Heavier than
## neutral sinks, lighter rises, up to ballast_max_rate depth-units/sec at
## completely full / empty tanks. Starts at neutral so a crew that never
## touches the valves gets exactly the old planes-only handling.
@export var ballast_neutral := 50.0
@export var ballast_max_rate := 3.0 # depth-units/sec at 0% or 100% ballast
@export var ballast_flood_rate := 5.0 # %/sec ballast gained with FLOOD fully open
@export var ballast_blow_rate := 8.0 # %/sec ballast pushed out with BLOW fully open (needs comp_air)
@export var comp_air_use_rate := 4.0 # %/sec compressed air spent with BLOW fully open
@export var comp_air_recharge_rate := 0.5 # %/sec compressed air refilled while the diesel runs

@export_group("Dev")
## Off for a real round: every debug safety toggle below (invulnerable,
## ignore overheat, unlimited supplies, ignore game over) starts OFF, so the
## sub can actually be damaged and lost. On restores the old playtest
## defaults with all four ON. Also switched on by launching the server with
## the user arg `--dev` (e.g. `godot --path . -- --dev`). Only read once, at
## startup - the debug panel buttons still flip each toggle live either way.
@export var dev_mode := false

@export_group("Convoys")
## How many convoys spawn on reset() - each one gets its own random spawn
## point/course and its own random mix of escorts/cargo within the ranges
## below, so no two runs look alike.
@export var convoy_count := 3
@export var convoy_destroyers_min := 1
@export var convoy_destroyers_max := 1
@export var convoy_cargo_min := 1
@export var convoy_cargo_max := 2
## Distance from the sub's own start position ((0,0), see reset()) that a
## convoy is allowed to spawn at, and the fixed formation spacing between
## ships within one convoy.
@export var convoy_spawn_min_distance := 300.0
@export var convoy_spawn_max_distance := 3000.0
## The very first convoy spawned each run always uses this fixed distance
## (still at a random bearing) instead of the random min/max range above -
## guarantees a close encounter is always available early on, rather than
## every convoy occasionally rolling far away and leaving nothing nearby to
## find. Every other convoy still spawns fully randomly.
@export var convoy_guaranteed_close_distance := 200.0
@export var convoy_formation_spacing := 40.0
## Cargo ships never fight back - they run in a straight line on their own
## course, ignoring the sub entirely, right up until their convoy's escort
## detects it (see the Detection group below), at which point they turn
## directly away from the sub's last known position and flee at their own
## (faster) panic speed for the rest of the run. They never go back to
## ignoring the sub once alerted.
@export var cargo_transit_speed := 3.0
@export var cargo_flee_speed := 5.0
@export var cargo_turn_rate := 6.0
## Destroyers are the only ships that actively scan for the sub (see
## Detection group) - until one does, they travel their course exactly like
## a cargo ship. Once alerted, EVERY ship in that convoy (destroyers and
## cargo alike) stays alerted for the rest of the run - there's no going back
## to "ignoring" once spotted.
@export var destroyer_transit_speed := 4.0
@export var destroyer_attack_speed := 6.0
@export var destroyer_turn_rate := 8.0
@export var destroyer_attack_range := 15.0
@export var destroyer_attack_cooldown_ticks := 180 # 3 sec at 60Hz
@export var destroyer_min_leaks_per_hit := 1
@export var destroyer_max_leaks_per_hit := 3
## Seconds from a torpedo hit to fully sinking/disappearing - a hit ship
## doesn't just vanish, it stops dead in the water and spends this long
## tilting and settling (see _step_sinking_ships() and periscope.contacts'
## own sinking/sink_progress fields, which the periscope view animates).
@export var ship_sink_duration := 8.0

@export_group("Detection")
## The sub's own three-tier detectability model - both what lets a
## destroyer notice it (_ship_detects_player() below) and what the Sonar
## station's own "Noise" gauge reports back (see get_state()'s noise field),
## since they're the same underlying rule read from two different sides.
## Surfaced is the loudest/most visible state; below periscope depth while
## moving slowly is the only way to be fully undetectable.
@export var surfaced_max_depth := 1.0 # at or above this depth, the sub counts as surfaced
# periscope_max_depth (see the Periscope group) is reused as the boundary
# between "at periscope depth" and "below periscope depth" here too - one
# definition of that depth band, read by both systems.
@export var detection_range_surfaced := 500.0
@export var detection_range_periscope_depth := 200.0
@export var detection_range_deep_fast := 100.0
## Threshold on the sub's own "speed" broadcast field (its 0..~1 fraction of
## full speed, the same number the player's own speed gauge reads - NOT
## divided by max_speed, a separate world-units/sec scalar) at or above which
## a deep sub is loud enough to be caught at detection_range_deep_fast - below
## this threshold, deep is silent running: no destroyer can detect it at any
## range.
@export var detection_deep_speed_threshold := 0.5
@export var noise_deep_quiet := 0.0
@export var noise_deep_fast := 35.0
@export var noise_periscope_depth := 65.0
@export var noise_surfaced := 100.0

@export_group("Passive Contacts")
## Ambient background traffic, not threats: no attack, no leaks, never
## targetable by torpedo, never a real sonar "contact" (no blip, no bearing/
## pulse readout) - they only ever add a faint hum to the sonar dB gauge, so
## a player sweeping the dial can tell something distant is out there.
@export var passive_contact_radii: Array[float] = [500.0, 800.0] # world units from map center (0,0) - one contact circling at each radius
@export var passive_circle_speed := 3.0 # world units/sec along their circular path
@export var passive_sonar_max_range := 2000.0
@export var passive_sonar_max_db := 25.0 # faint - well under the hostile's own sonar_max_db at any distance

@export_group("Life Support")
@export var o2_natural_decline_rate := 0.02 # %/sec lost just from crew breathing - a snail's pace next to electric_motor_drain_rate
@export var o2_replenish_min_depth := 3.0 # at or below this depth (periscope/snorkel), fresh air replaces natural decline
@export var o2_replenish_rate := 100.0 / 60.0 # %/sec regained at/below o2_replenish_min_depth - fully replenishes in 60 sec
# leak_flood_rate moved to the Damage Control group below, alongside its own
# leak/weld tunables rather than sitting apart from them here.
@export var bilge_pump_flood_removal_rate := 1.0 # %/sec flooding pumped out while the bilge pump runs
@export var flooding_sink_rate := 3.0 # depth-units/sec sunk at 100% flooding, fighting the dive planes' own control

## Each leak has a real position now (a normalized 0..1 x/y within its own
## compartment's ROOM_WIDTH x ROOM_HEIGHT canvas, the same design resolution
## every Sub Editor room is authored at) instead of just being an abstract
## count - the old "hold a button to repair the leak count" mechanic
## (SET_REPAIRING) is gone, replaced by actually welding over a leak's own
## spot for weld_repair_seconds (see WELD_AT/_step_welding()).
@export_group("Damage Control")
@export var leak_flood_rate := 0.375 # %/sec flooding gained per active, unrepaired leak
@export var weld_repair_seconds := 2.0
@export var weld_hit_radius := 40.0 # room-canvas pixels (at the 960x540 design resolution) a weld has to land within to count as "on" a leak
## Keeps a leak's random spawn spot at least this fraction of the room's own
## width/height away from every edge - a leak jammed right against a wall or
## corner reads as visually wrong (nothing there to actually leak from) and
## is awkward to weld with the torch's own hit radius partly off-canvas.
@export var leak_edge_margin := 0.15

@export_group("Torpedo")
@export var torpedo_speed := 20.0
@export var torpedo_hit_radius := 10.0
@export var torpedo_max_lifetime_ticks := 3000 # 50 sec - together with torpedo_speed, this sets max range (world units traveled before it expires): 20 * 3000/60 = ~1000
@export var torpedo_reload_ticks := 300 # 5 sec
## Degrees/sec a torpedo turns continuously once its gyro activates (see
## torpedo_gyro_activation_distance), at FULL gyro deflection (+/-
## tdc_gyro_limit) - it never stops turning on its own, so this is also the
## tightest possible sustained turn. Deliberately low: at 8 deg/sec, a full
## 360 degree circle takes 45 sec, plus the ~2.5 sec activation delay is
## right at the edge of torpedo_max_lifetime_ticks (50 sec) - so a complete
## circular run is technically possible, but only by holding the gyro at its
## most extreme setting, with the torpedo expiring almost the instant it
## closes the loop. Anything less than full gyro takes proportionally
## longer and won't complete a circle before the torpedo dies first.
@export var torpedo_turn_rate := 8.0
## World units a fired torpedo runs straight, along the sub's heading at the
## moment of firing, before its gyro activates and it starts turning onto
## the aimed course. Real torpedoes need this to clear the firing sub - here
## it doubles as the TDC's core guessing game: the turn happens farther
## downrange than the tube itself, so a misjudged gyro angle has less room
## left to converge back onto the target before the torpedo runs past it.
@export var torpedo_gyro_activation_distance := 50.0
## Max TDC gyro angle in either direction, degrees off the bow.
@export var tdc_gyro_limit := 90.0
## Max TDC spread angle - the angular separation between two ADJACENT tubes'
## tracks when firing more than one at once (see _fire_torpedo()).
@export var tdc_spread_limit := 45.0

const TORPEDO_TUBE_COUNT := 4

@export_group("Periscope")
## Independent of Life Support's own o2_replenish_min_depth above even though
## both represent "shallow enough to reach the surface" in real life - kept
## as two separate tunables so periscope range/usability and O2 replenishment
## can be balanced separately without one accidentally dragging the other.
@export var periscope_max_depth := 30.0
## Optical range in clear conditions - generous compared to sonar_max_range
## since sight isn't attenuated by a signal-vs-noise model, just distance.
@export var periscope_max_range := 4000.0
## Degrees/sec the scope turns at FULL SET_PERISCOPE_TURN deflection (+/-1) -
## same steering-wheel relationship as the sub's own max_turn_rate/rudder:
## the handle commands a turn RATE, not an absolute bearing, so periscope_
## bearing keeps turning every tick for as long as the handle is held over,
## and stops the instant it's released back to zero (see step()).
@export var periscope_turn_rate := 60.0

@export_group("Sonar")
@export var sonar_detection_tolerance := 20.0 # half-width in degrees of the feathered detection cone around a contact's true bearing - dB ramps from 0 at this edge to full dead-center, not a hard on/off window
@export var sonar_max_range := 200.0 # world units - contacts beyond this never register, no matter how well aligned
@export var sonar_min_db := 20.0 # loudness at the very edge of sonar_max_range
@export var sonar_max_db := 100.0 # loudness at point-blank range
@export var sonar_min_pulse_hz := 0.5 # propeller pulse rate for a dead-slow contact
@export var sonar_max_pulse_hz := 3.0 # propeller pulse rate at sonar_pulse_reference_speed
@export var sonar_pulse_reference_speed := 6.0 # world units/sec that maps to sonar_max_pulse_hz - a future faster enemy would pulse quicker without any other change needed here
## Receiver gain, player-controlled via SET_SONAR_SENSITIVITY (see the
## Sensitivity dial). Multiplies the FINAL db reading (contact + ambient
## combined) and the contact's pulse_hz - turning it up makes a faint,
## distant contact easier to hear, but amplifies ambient hum right along
## with it, so it's a real tradeoff rather than a free "hear everything"
## dial. Purely a receive-side gain - it has no effect on the sub's own
## noise/detectability (see the Detection group).
@export var sonar_sensitivity_min := 0.5
@export var sonar_sensitivity_max := 2.0

@export_group("Engine Wear")
@export var engine_drift_rate := 0.5 # efficiency %/sec lost passively
@export var engine_tune_rate := 8.0 # efficiency %/sec regained while actively tuning
@export var fuse_blow_chance_per_tick := 0.0000193 # ~50% chance of a blown fuse within any given 10-minute window (was 0.00005, ~5-6 min average)
## Off until there's a real fusebox station to replace a blown fuse through -
## until then a blown fuse just gets in the way of testing everything else,
## with the only fix being the debug panel's own Replace Fuse button. Flip
## this back on once that station exists; fuse_blow_chance_per_tick above is
## left untouched so the tuned rate is still there waiting.
@export var fuse_blowing_enabled := false

@export_group("Engine Room")
@export var rpm_max := 2000.0
@export var rpm_response := 0.03
@export var ambient_temperature := 20.0
@export var temp_rise_rate := 60.0 # degrees/sec at full RPM, before cooling
@export var coolant_cooling_rate := 70.0 # degrees/sec removed at full coolant flow
@export var oil_pressure_max := 80.0
@export var fuel_max := 100.0
@export var fuel_burn_rate := 0.12 # fuel/sec at full RPM

@export_group("Electrical")
@export var battery_max := 100.0
@export var battery_drain_rate := 0.15 # %/sec baseline drain from lights/instruments
@export var battery_charge_rate := 3.0 # %/sec gained at full RPM while charging AND the engine is running - scales down with rpm_fraction below that
@export var bilge_pump_drain_rate := 0.5 # %/sec extra drain while the bilge pump runs
@export var electric_motor_drain_rate := 1.2 # %/sec extra drain while the electric motor runs
@export var electric_motor_propulsion := 0.3 # fixed propulsion fraction while running on the motor instead of the diesel engine

@export_group("Overheat")
## No penalty below nominal. Between nominal and max, power and fuel
## efficiency degrade smoothly. Only sustained time AT max temp forces a full
## shutdown - a brief spike past nominal is just a warning, not a failure.
@export var engine_nominal_temp := 90.0
@export var engine_max_temp := 150.0
@export var overheat_max_speed_penalty := 0.7 # fraction of max speed lost at full overheat
@export var overheat_fuel_penalty := 1.0 # extra fuel burn fraction at full overheat
@export var overheat_shutdown_seconds := 15.0 # sustained seconds at max temp before forced stop
@export var overheat_recovery_rate := 2.0 # timer drains this many seconds per second once below max temp

var tick: int = 0

# Control room: the requested order only. Does NOT drive propulsion directly
# - Engineering has to actually match it on the real engine controls.
var engine_order: float = 0.0

var speed: float = 0.0
var position := Vector2.ZERO
var heading: float = 0.0 # degrees
var rudder: float = 0.0 # -1..1
var dive_planes: float = 0.0 # -1..1
var blow_valve: float = 0.0 # 0..1 opening, dive station BLOW valve
var flood_valve: float = 0.0 # 0..1 opening, dive station FLOOD valve
var ballast: float = 50.0 # 0..100, see the Ballast export group
var comp_air: float = 100.0 # 0..100, spent by blowing ballast
var depth: float = 0.0
var sunk: bool = false
## The round's win condition: set once every cargo ship in every convoy has
## been torpedoed and finished sinking (destroyers are optional - fight them
## or slip past them). Freezes the sim exactly like sunk does. See
## _check_victory().
var won: bool = false

# Life support: O2 is the real "health" now - it hits a ceiling of
# (100 - flooding), so a fully flooded sub (100%) caps O2 at 0 outright, on
# top of its own slow natural decline that happens regardless of flooding.
# It never regenerates on its own - see _step_flooding().
var o2: float = 100.0
var flooding: float = 0.0 # 0..100
## Each leak: {id, compartment, x, y (normalized 0..1, see ROOM_WIDTH/
## ROOM_HEIGHT), weld_progress (seconds accumulated, see weld_repair_seconds)}
## - sprung by enemy hits (see _spawn_leak()), each one floods the sub until
## actually welded shut. active_leaks (get_state()) is just leaks.size().
var leaks: Array = []
var next_leak_id: int = 0
## player_id -> {compartment, x, y} - the LATEST position a player's welder
## has reported via WELD_AT, read every tick by _step_welding() rather than
## only when a new message arrives, so holding the torch still over a leak
## keeps accumulating weld_progress between messages exactly like a rudder
## held over stays applied between SET_RUDDER calls. Cleared by
## STOP_WELDING, or when the player disconnects (see remove_player()).
var welding_active: Dictionary = {}

var sonar_dial: float = 0.0 # degrees, true bearing the dial is swept to
var sonar_sensitivity: float = 1.0 # receiver gain, set via SET_SONAR_SENSITIVITY - see the Sonar group's sonar_sensitivity_min/max
var periscope_relative_offset: float = 0.0 # degrees off the sub's OWN bow - integrated continuously from periscope_turn_input each tick, see step(). The scope is mounted to the hull, so its ABSOLUTE bearing (heading + this, see get_state()) turns right along with the sub for free; this offset only changes when the player actually works the training handle.
var periscope_turn_input: float = 0.0 # -1..1, steering-wheel deflection set via SET_PERISCOPE_TURN - held at whatever it was last set to, same as rudder

# Engineering: the real engine.
var engine_running: bool = false
var throttle: float = 0.0 # 0..1, Engineering's own control
var gear: String = GEAR_NEUTRAL
var rpm: float = 0.0
var rpm_fraction: float = 0.0
var temperature: float = 20.0
var coolant_flow: float = 0.5
var oil_pressure: float = 0.0
var fuel: float = 100.0
var propulsion_fraction: float = 0.0 # signed - direction comes from gear
var overheat_fraction: float = 0.0 # 0..1 between nominal and max temp
var overheat_timer: float = 0.0 # seconds sustained at max temp

var engine_efficiency: float = 100.0 # 0..100, mechanical wear, scales max speed
var engine_tuning_active: bool = false
var fuse_blown: bool = false

# The charging switch's requested state, same idea as engine_order: setting
# it doesn't guarantee an effect, since charging also needs the engine
# actually running to drive the generator - see _step_battery(). Left as
# just a request (never auto-flipped back off on its own) so the switch
# always shows exactly what a player last set, matching how every other
# control here behaves - the one exception is electric_motor_active, which
# DOES get forced off on a dead battery, the same way engine_running already
# gets forced off on empty fuel: that's a real equipment failure, not a
# switch silently disagreeing with what was requested.
var battery_charge: float = 100.0
var battery_charging: bool = false
var bilge_pump_active: bool = false
var electric_motor_active: bool = false
var power_draw: float = 0.0 # net battery amperage this tick - positive drains, negative charges

# Testing convenience only - deliberately NOT reset by reset(), so it stays
# set across repeated playtests instead of needing to be re-toggled. The
# starting value of this and the three toggles below comes from dev_mode
# (see _apply_dev_mode()); the `true` here is just the dev-mode value.
var invulnerable: bool = true
var debug_show_enemy: bool = false
# When true (the default, for the same reason as invulnerable above), the
# engine room keeps simulating and broadcasting temperature/overheat_fraction/
# efficiency/rpm exactly as normal - only their gameplay CONSEQUENCES
# (overheat shutting the engine down, both of them dragging down top speed)
# are skipped, so testing everything else isn't derailed by having to
# babysit coolant flow and tuning the whole time.
var debug_ignore_overheat_effects: bool = true
# Same idea as debug_ignore_overheat_effects above, for fuel/battery instead
# of temperature: fuel and battery_charge still drain and broadcast exactly
# as normal (the gauges/numbers still visibly go to 0), but running out stops
# having any gameplay CONSEQUENCE - the engine keeps running on empty fuel,
# the electric motor keeps drawing on a dead battery - so testing everything
# else isn't derailed by babysitting refueling/charging the whole time.
var debug_unlimited_supplies: bool = true
# Same "keeps simulating, just not the terminal consequence" idea as the two
# above, but for the game-over condition itself: flooding/O2 still drain and
# broadcast normally, and can still hit 0, but sunk never gets set - so
# leaks/flooding can be tested repeatedly (welding them shut, watching O2
# recover, taking another hit) without the round actually ending and forcing
# a Reset Game every time. invulnerable already implies this (a sub that
# can't be damaged can't sink either), but it also stops leaks from being
# created in the first place - this flag is for testing leaks/flooding
# THEMSELVES without invulnerable suppressing the very thing being tested.
var debug_ignore_game_over: bool = true

## Each ship: {id, convoy_id, type ("cargo"/"destroyer"), alive, position,
## heading, course_heading, speed (current, world units/sec - read by
## sonar's pulse_hz), attack_cooldown}. convoys holds only per-convoy alert
## state ({id, alert}) - a convoy's ships share one alert flag, flipped once
## by _ship_detects_player() and never cleared again this run (see the
## Convoys export group). Both are built fresh, at random, by reset().
var ships: Array = []
var convoys: Array = []
## TDC (Torpedo Data Computer) settings - shared across all tubes. gyro_angle
## is the aimed course offset from the sub's bow, in degrees (negative =
## port, positive = starboard). spread_angle, when nonzero, fans a multi-tube
## salvo symmetrically around that aim instead of sending every torpedo down
## the same track - see _fire_torpedo() for the per-tube offset math.
var tdc := {"gyro_angle": 0.0, "spread_angle": 0.0}
var torpedo_tubes: Array = [] # each {loaded, armed, reload_ticks_remaining} - see reset()
var torpedoes: Array = [] # in-flight torpedoes, each {position, heading, target_heading, life_ticks} - see _fire_torpedo()/_step_torpedoes()
var passive_contacts: Array = [] # each {radius, angle, position} - see _step_passive_contacts()

var stations: Dictionary = {
	HELM_STATION: {"occupant": UNOCCUPIED, "compartment": "control"},
	DIVE_STATION: {"occupant": UNOCCUPIED, "compartment": "control"},
	SONAR_STATION: {"occupant": UNOCCUPIED, "compartment": "information"},
	ENGINE_CONTROLS_STATION: {"occupant": UNOCCUPIED, "compartment": "engineering"},
}

var players: Dictionary = {} # player_id: int -> {compartment, equipped_tool}
var tools: Dictionary = {}

func _ready() -> void:
	_apply_dev_mode()
	reset()

func _apply_dev_mode() -> void:
	if "--dev" in OS.get_cmdline_user_args():
		dev_mode = true
	invulnerable = dev_mode
	debug_ignore_overheat_effects = dev_mode
	debug_unlimited_supplies = dev_mode
	debug_ignore_game_over = dev_mode
	print("Dev Mode: %s" % ("ON (debug safety toggles start on)" if dev_mode else "OFF"))

## Restores the simulation to its starting conditions without disconnecting
## anyone - lets a session be replayed from the client without restarting
## the server process. Does not touch the @export balance constants above.
func reset() -> void:
	tick = 0
	engine_order = 0.0
	speed = 0.0
	position = Vector2.ZERO
	heading = 0.0
	rudder = 0.0
	dive_planes = 0.0
	blow_valve = 0.0
	flood_valve = 0.0
	ballast = ballast_neutral
	comp_air = 100.0
	depth = 0.0
	sunk = false
	won = false

	o2 = 100.0
	flooding = 0.0
	leaks = []
	next_leak_id = 0
	welding_active = {}

	sonar_dial = 0.0
	sonar_sensitivity = 1.0
	periscope_relative_offset = 0.0
	periscope_turn_input = 0.0

	engine_running = false
	throttle = 0.0
	gear = GEAR_NEUTRAL
	rpm = 0.0
	rpm_fraction = 0.0
	temperature = ambient_temperature
	coolant_flow = 0.5
	oil_pressure = 0.0
	fuel = fuel_max
	propulsion_fraction = 0.0
	overheat_fraction = 0.0
	overheat_timer = 0.0

	engine_efficiency = 100.0
	engine_tuning_active = false
	fuse_blown = false

	battery_charge = battery_max
	battery_charging = false
	bilge_pump_active = false
	electric_motor_active = false
	power_draw = 0.0

	_spawn_convoys()

	passive_contacts = []
	for i in passive_contact_radii.size():
		var radius: float = passive_contact_radii[i]
		# Staggered starting angles (spread evenly around the circle) so
		# multiple contacts don't all start lined up on the same bearing.
		var start_angle := TAU * float(i) / float(passive_contact_radii.size())
		passive_contacts.append({
			"radius": radius,
			"angle": start_angle,
			"position": Vector2(radius, 0.0).rotated(start_angle),
		})

	tdc = {"gyro_angle": 0.0, "spread_angle": 0.0}
	torpedo_tubes = []
	for i in TORPEDO_TUBE_COUNT:
		torpedo_tubes.append({"loaded": true, "armed": false, "reload_ticks_remaining": 0})
	torpedoes = []

	for station: Dictionary in stations.values():
		station.occupant = UNOCCUPIED

	tools = {}
	for tool_id in TOOL_START_LOCATIONS:
		tools[tool_id] = {"holder": UNOCCUPIED, "compartment": TOOL_START_LOCATIONS[tool_id]}

	for player_id in players:
		players[player_id].compartment = DEFAULT_COMPARTMENT
		players[player_id].equipped_tool = ""

func add_player(player_id: int) -> void:
	players[player_id] = {"compartment": DEFAULT_COMPARTMENT, "equipped_tool": ""}

func remove_player(player_id: int) -> void:
	if players.has(player_id):
		var equipped: String = players[player_id].equipped_tool
		if equipped != "" and tools.has(equipped):
			tools[equipped].holder = UNOCCUPIED
			tools[equipped].compartment = players[player_id].compartment
	players.erase(player_id)
	welding_active.erase(player_id)
	for station_id in stations:
		if stations[station_id].occupant == player_id:
			_clear_station_occupant(station_id)

func apply_input(player_id: int, action: String, data: Dictionary) -> void:
	match action:
		"REQUEST_STATION":
			_request_station(player_id, data.get("station_id", ""))
		"RELEASE_STATION":
			_release_station(player_id, data.get("station_id", ""))
		"SET_ENGINE_ORDER":
			if not sunk and _station_occupant(HELM_STATION) == player_id:
				# -1..1, not 0..1: a real telegraph orders astern as well as
				# ahead. Engineering still has to physically match it - this
				# is only ever the requested order, never propulsion itself.
				engine_order = clampf(float(data.get("value", 0.0)), -1.0, 1.0)
		"SET_RUDDER":
			if not sunk and _station_occupant(HELM_STATION) == player_id:
				rudder = clampf(float(data.get("value", 0.0)), -1.0, 1.0)
		"SET_DIVE_PLANES":
			if not sunk and _station_occupant(DIVE_STATION) == player_id:
				dive_planes = clampf(float(data.get("value", 0.0)), -1.0, 1.0)
		"SET_BLOW_VALVE":
			if not sunk and _station_occupant(DIVE_STATION) == player_id:
				blow_valve = clampf(float(data.get("value", 0.0)), 0.0, 1.0)
		"SET_FLOOD_VALVE":
			if not sunk and _station_occupant(DIVE_STATION) == player_id:
				flood_valve = clampf(float(data.get("value", 0.0)), 0.0, 1.0)
		"SET_SONAR_DIAL":
			if not sunk and _station_occupant(SONAR_STATION) == player_id:
				sonar_dial = fposmod(float(data.get("value", 0.0)), 360.0)
		"SET_SONAR_SENSITIVITY":
			if not sunk and _station_occupant(SONAR_STATION) == player_id:
				sonar_sensitivity = clampf(float(data.get("value", 1.0)), sonar_sensitivity_min, sonar_sensitivity_max)
		"START_ENGINE":
			if not sunk and _player_in_compartment(player_id, ENGINEERING_COMPARTMENT) and (debug_unlimited_supplies or fuel > 0.0):
				engine_running = true
		"STOP_ENGINE":
			if not sunk and _player_in_compartment(player_id, ENGINEERING_COMPARTMENT):
				engine_running = false
		"SET_THROTTLE":
			if not sunk and _station_occupant(ENGINE_CONTROLS_STATION) == player_id:
				throttle = clampf(float(data.get("value", 0.0)), 0.0, 1.0)
		"SET_GEAR":
			if not sunk and _player_in_compartment(player_id, ENGINEERING_COMPARTMENT):
				_set_gear(str(data.get("gear", "")))
		"SET_COOLANT_FLOW":
			if not sunk and _station_occupant(ENGINE_CONTROLS_STATION) == player_id:
				coolant_flow = clampf(float(data.get("value", 0.0)), 0.0, 1.0)
		"SET_TUNING":
			if not sunk and _station_occupant(ENGINE_CONTROLS_STATION) == player_id:
				engine_tuning_active = bool(data.get("active", false))
		"SET_CHARGING":
			if not sunk and _player_in_compartment(player_id, ENGINEERING_COMPARTMENT):
				battery_charging = bool(data.get("active", false))
		"SET_BILGE_PUMP":
			if not sunk and _player_in_compartment(player_id, ENGINEERING_COMPARTMENT):
				bilge_pump_active = bool(data.get("active", false))
		"SET_ELECTRIC_MOTOR":
			if not sunk and _player_in_compartment(player_id, ENGINEERING_COMPARTMENT):
				electric_motor_active = bool(data.get("active", false))
		"WELD_AT":
			# Not station/compartment-gated the way most controls are - a leak
			# (and so the welder) can be used anywhere in the sub, from
			# whichever compartment the player is actually standing in right
			# now. x/y are normalized 0..1 against ROOM_WIDTH/ROOM_HEIGHT, the
			# same design resolution the client's own room canvas uses, so
			# they mean the same physical spot regardless of screen size.
			if not sunk and players.has(player_id):
				welding_active[player_id] = {
					"compartment": players[player_id].compartment,
					"x": clampf(float(data.get("x", 0.0)), 0.0, 1.0),
					"y": clampf(float(data.get("y", 0.0)), 0.0, 1.0),
				}
		"STOP_WELDING":
			welding_active.erase(player_id)
		"REPLACE_FUSE":
			if not sunk:
				_replace_fuse(player_id)
		"FIRE_TORPEDO":
			if not sunk:
				_fire_torpedo(player_id)
		"SET_TDC_GYRO":
			if not sunk and _player_in_compartment(player_id, CONNING_TOWER_COMPARTMENT):
				tdc.gyro_angle = clampf(float(data.get("value", 0.0)), -tdc_gyro_limit, tdc_gyro_limit)
		"SET_TDC_SPREAD":
			if not sunk and _player_in_compartment(player_id, CONNING_TOWER_COMPARTMENT):
				tdc.spread_angle = clampf(float(data.get("value", 0.0)), 0.0, tdc_spread_limit)
		"SET_PERISCOPE_TURN":
			if not sunk and _player_in_compartment(player_id, CONNING_TOWER_COMPARTMENT):
				periscope_turn_input = clampf(float(data.get("value", 0.0)), -1.0, 1.0)
		"SET_TUBE_ARMED":
			if not sunk:
				_set_tube_armed(player_id, int(data.get("tube", -1)), bool(data.get("armed", false)))
		"MOVE_TO_COMPARTMENT":
			_move_player(player_id, data.get("compartment", ""))
		"PICKUP_TOOL":
			_pickup_tool(player_id, data.get("tool_id", ""))
		"DROP_TOOL":
			_drop_tool(player_id, data.get("tool_id", ""))
		"RESET_GAME":
			reset()
		"SET_INVULNERABLE":
			invulnerable = bool(data.get("value", false))
		"SET_SHOW_ENEMY":
			debug_show_enemy = bool(data.get("value", false))
		"SET_IGNORE_OVERHEAT_EFFECTS":
			debug_ignore_overheat_effects = bool(data.get("value", false))
		"SET_UNLIMITED_SUPPLIES":
			debug_unlimited_supplies = bool(data.get("value", false))
		"SET_IGNORE_GAME_OVER":
			debug_ignore_game_over = bool(data.get("value", false))
		_:
			pass

func step() -> void:
	tick += 1
	if sunk or won:
		return

	_step_engine_room()
	_step_battery()

	speed += (propulsion_fraction - speed) * speed_response
	heading = fposmod(heading + rudder * max_turn_rate * DT, 360.0)
	# Same steering-wheel relationship as rudder -> heading just above, but
	# for the OFFSET off the bow, not an absolute bearing - the scope is
	# mounted to the hull, so it rotates right along with the sub for free
	# (see get_state()'s periscope.bearing = heading + this) any time the
	# boat turns, exactly like a real periscope would, whether or not the
	# handle is being worked. periscope_turn_input is a held deflection, not
	# a one-shot command, so this keeps turning every tick for as long as
	# it's nonzero and only stops once the handle (spring-loaded, see the
	# Sub Editor's Spring to Center control option) is released back to zero.
	periscope_relative_offset = fposmod(periscope_relative_offset + periscope_turn_input * periscope_turn_rate * DT, 360.0)
	var heading_rad := deg_to_rad(heading)
	var speed_penalty := 1.0 if debug_ignore_overheat_effects else 1.0 - overheat_fraction * overheat_max_speed_penalty
	var effective_efficiency := 100.0 if debug_ignore_overheat_effects else engine_efficiency
	var effective_max_speed := max_speed * (effective_efficiency / 100.0) * speed_penalty
	position += Vector2(cos(heading_rad), sin(heading_rad)) * speed * effective_max_speed * 0.1 * DT
	# Flooding fights the dive planes with its own downward pull - the
	# weight of taken-on water that plain buoyancy no longer offsets - so
	# heavy flooding drags the sub down even at full rise on the planes,
	# and it can't just sit at the surface breathing while leaks this bad
	# are still open.
	var flooding_sink := flooding_sink_rate * (flooding / 100.0)
	_step_ballast()
	var ballast_span := maxf(ballast_neutral, 100.0 - ballast_neutral)
	var ballast_sink := ballast_max_rate * (ballast - ballast_neutral) / ballast_span
	depth = clampf(depth + (dive_planes * max_dive_rate + flooding_sink + ballast_sink) * DT, 0.0, max_depth)

	_step_ships()
	_step_sinking_ships()
	_step_passive_contacts()
	_step_torpedoes()
	_step_welding()
	_step_flooding()
	_check_victory()

## FLOOD lets sea water into the ballast tanks; BLOW forces it out with
## compressed air, which only the running diesel's compressor refills. Both
## valves can be open at once (they just fight each other).
func _step_ballast() -> void:
	ballast += flood_valve * ballast_flood_rate * DT
	if blow_valve > 0.0 and (debug_unlimited_supplies or comp_air > 0.0):
		ballast -= blow_valve * ballast_blow_rate * DT
		if not debug_unlimited_supplies:
			comp_air = maxf(0.0, comp_air - blow_valve * comp_air_use_rate * DT)
	ballast = clampf(ballast, 0.0, 100.0)
	if engine_running:
		comp_air = minf(100.0, comp_air + comp_air_recharge_rate * DT)

func _cargo_ships() -> Array:
	return ships.filter(func(s): return s.type == "cargo")

## Win once every cargo ship is fully sunk (alive goes false only after its
## sink animation finishes - see _step_sinking_ships()), so the crew gets to
## watch the last one go down through the periscope before the round ends.
## Losing on the same tick (sunk) takes priority.
func _check_victory() -> void:
	if sunk:
		return
	var cargo := _cargo_ships()
	if cargo.size() > 0 and cargo.all(func(s): return not s.alive):
		won = true

func _step_engine_room() -> void:
	var wear_rate := engine_tune_rate if engine_tuning_active else -engine_drift_rate
	engine_efficiency = clampf(engine_efficiency + wear_rate * DT, 0.0, 100.0)

	if fuse_blowing_enabled and not fuse_blown and randf() < fuse_blow_chance_per_tick:
		fuse_blown = true

	var can_drive := engine_running and not fuse_blown and (debug_unlimited_supplies or fuel > 0.0)
	var target_rpm := throttle * rpm_max if can_drive else 0.0
	rpm = maxf(0.0, rpm + (target_rpm - rpm) * rpm_response)
	rpm_fraction = rpm / rpm_max

	var heat_gain := rpm_fraction * temp_rise_rate
	var cooling := coolant_flow * coolant_cooling_rate
	temperature = maxf(ambient_temperature, temperature + (heat_gain - cooling) * DT)

	oil_pressure = rpm_fraction * oil_pressure_max

	overheat_fraction = clampf((temperature - engine_nominal_temp) / (engine_max_temp - engine_nominal_temp), 0.0, 1.0)

	if temperature >= engine_max_temp:
		overheat_timer += DT
		if overheat_timer >= overheat_shutdown_seconds:
			if not debug_ignore_overheat_effects:
				engine_running = false
			overheat_timer = 0.0
	else:
		overheat_timer = maxf(0.0, overheat_timer - DT * overheat_recovery_rate)

	if engine_running and rpm_fraction > 0.0:
		var effective_fuel_burn := fuel_burn_rate * (1.0 + overheat_fraction * overheat_fuel_penalty)
		fuel = maxf(0.0, fuel - rpm_fraction * effective_fuel_burn * DT)
		if fuel <= 0.0 and not debug_unlimited_supplies:
			engine_running = false

	# Running on the electric motor is a separate propulsion source from the
	# diesel engine above (real diesel-electric subs run the motor
	# submerged, off the battery, since the engine needs air) - it replaces
	# rather than adds to the diesel's own propulsion_fraction.
	if electric_motor_active and (debug_unlimited_supplies or battery_charge > 0.0):
		propulsion_fraction = electric_motor_propulsion * _gear_multiplier(gear)
	else:
		propulsion_fraction = rpm_fraction * _gear_multiplier(gear)

func _step_battery() -> void:
	var draw := battery_drain_rate
	if bilge_pump_active:
		draw += bilge_pump_drain_rate
	if electric_motor_active:
		draw += electric_motor_drain_rate
	var charge_gain := 0.0
	if battery_charging and engine_running and not fuse_blown:
		# Scales with RPM, not gear - the generator is driven by the engine
		# spinning, not by whether it's actually propelling the sub, so
		# revving the throttle in neutral still charges faster.
		charge_gain = battery_charge_rate * rpm_fraction
	power_draw = draw - charge_gain
	battery_charge = clampf(battery_charge - power_draw * DT, 0.0, battery_max)
	if battery_charge <= 0.0 and not debug_unlimited_supplies:
		electric_motor_active = false

func get_state() -> Dictionary:
	var station_state := {}
	for station_id in stations:
		station_state[station_id] = {"occupant": stations[station_id].occupant}

	var player_state := {}
	for player_id in players:
		player_state[str(player_id)] = {
			"compartment": players[player_id].compartment,
			"equipped_tool": players[player_id].equipped_tool,
		}

	var tool_state := {}
	for tool_id in tools:
		tool_state[tool_id] = {
			"holder": tools[tool_id].holder,
			"compartment": tools[tool_id].compartment,
		}

	# db/pulse_hz are always present, explicitly 0 rather than simply absent
	# when there's no signal - a gauge/scope reading resolvePath(state,
	# "sonar.db") needs an actual 0 to animate down to smoothly. A path that
	# resolves to undefined (a missing key) is treated as "nothing bound
	# here" and falls back to the object's own authored resting pose
	# instead, which is what silently produced a stuck mid-scale reading
	# whenever a contact was out of the cone.
	var sonar := {"contact": false, "db": 0.0, "pulse_hz": 0.0}
	var sonar_manned := _station_occupant(SONAR_STATION) != UNOCCUPIED
	if sonar_manned:
		# Distant passive contacts never become a real "contact" (no blip,
		# no bearing/pulse readout) - they only ever add a faint background
		# hum to db, the same feathered-cone/distance falloff as the
		# hostile's own reading but much fainter and much farther-reaching,
		# so a sharp-eared player can tell "something else is out there"
		# without it being an actual threat or nav-map reveal.
		var ambient_db := 0.0
		for contact in passive_contacts:
			var to_contact: Vector2 = contact.position - position
			var contact_distance := to_contact.length()
			if contact_distance > passive_sonar_max_range:
				continue
			var contact_bearing := fposmod(rad_to_deg(to_contact.angle()), 360.0)
			var contact_angle_off := absf(wrapf(contact_bearing - sonar_dial, -180.0, 180.0))
			var contact_cone_t := clampf(contact_angle_off / sonar_detection_tolerance, 0.0, 1.0)
			var contact_cone_fraction := 1.0 - (contact_cone_t * contact_cone_t * (3.0 - 2.0 * contact_cone_t))
			if contact_cone_fraction <= 0.0:
				continue
			var contact_distance_fraction := clampf(contact_distance / passive_sonar_max_range, 0.0, 1.0)
			ambient_db += lerpf(passive_sonar_max_db, 0.0, contact_distance_fraction) * contact_cone_fraction

		# Only the SINGLE strongest hostile contact within the cone ever
		# becomes "the" contact - a real sonar operator tracks one signal
		# at a time via the dial sweep anyway, and every consumer of this
		# field (the dial readout, the sonar Scope channel) only has room
		# for one bearing/db/pulse reading. A convoy's other ships just
		# don't show up until the dial is swept onto a louder one.
		for ship in ships:
			if not ship.alive:
				continue
			var to_ship: Vector2 = ship.position - position
			var distance := to_ship.length()
			if distance > sonar_max_range:
				continue
			var true_bearing := fposmod(rad_to_deg(to_ship.angle()), 360.0)
			# A feathered cone, not a hard aligned/not-aligned window:
			# sonar_detection_tolerance is now the cone's half-width, and
			# strength ramps smoothly from 0 at its edge to full dead-center
			# on the contact's true bearing - sweeping past one reads as a
			# rising-then-falling signal, the actual cue a player sweeps
			# for, instead of a sudden on/off. Reads as no contact at all
			# (db 0, contact false) the instant the sweep leaves the cone.
			var angle_off := absf(wrapf(true_bearing - sonar_dial, -180.0, 180.0))
			var cone_t := clampf(angle_off / sonar_detection_tolerance, 0.0, 1.0)
			# Smoothstep, not linear - a straight ramp changes at a constant
			# rate right up to a sudden stop at both the center and the
			# edge, which still reads as an abrupt fade. Smoothstep's
			# derivative is zero at both ends, so it eases in from silence
			# and eases out to silence instead of just changing at a
			# constant rate the whole way.
			var cone_fraction := 1.0 - (cone_t * cone_t * (3.0 - 2.0 * cone_t))
			if cone_fraction <= 0.0:
				continue
			# Amplitude also reads distance (louder = closer) on top of
			# the cone falloff above; pulse rate reads the contact's
			# actual speed (faster = quicker pulses) - meant to be
			# judged by feel via a dB gauge/pulse animation rather than
			# read as exact numbers, same as the design doc's real
			# passive-sonar intent. Also the two values a future audio
			# render of this contact would drive its volume/tempo from.
			var distance_fraction := clampf(distance / sonar_max_range, 0.0, 1.0)
			var speed_fraction := clampf(ship.speed / sonar_pulse_reference_speed, 0.0, 1.0)
			var contact_db := lerpf(sonar_max_db, sonar_min_db, distance_fraction) * cone_fraction
			if contact_db > sonar.db:
				sonar = {
					"contact": true,
					"bearing_true": true_bearing,
					"bearing_relative": fposmod(true_bearing - heading, 360.0),
					"distance": distance,
					"db": contact_db,
					"pulse_hz": lerpf(sonar_min_pulse_hz, sonar_max_pulse_hz, speed_fraction),
				}

		if sonar.contact:
			sonar.pulse_hz *= sonar_sensitivity
		sonar.db = clampf((sonar.db + ambient_db) * sonar_sensitivity, 0.0, 100.0)

	# Optical contact for the periscope. Unlike sonar, there's no cone-vs-
	# strength model here - the server only reports raw physical facts (is
	# anything optically visible at all right now, and if so, exactly where)
	# and leaves field-of-view narrowing (is the scope CURRENTLY pointed at
	# it) entirely to the client, computed from each contact's bearing_true
	# vs the broadcast periscope.bearing. That split is deliberate: a future
	# 3D periscope view would place a camera at periscope.bearing and a
	# contact model at bearing_true/distance using this exact same data, so
	# only the client's rendering needs to change later, never this protocol.
	# bearing itself is heading + periscope_relative_offset, computed fresh
	# every tick rather than stored directly - the scope is mounted to the
	# hull, so it has to turn right along with the sub for free, not just
	# when the player works the training handle (periscope_relative_offset).
	# contacts is every optically-visible ship, not just one - a convoy can
	# have several ships in view at once, and unlike sonar's own single-
	# strongest-signal simplification, a periscope view actually needs the
	# full list to draw each one (see room_renderer.js's drawPeriscopeScope).
	# sinking/sink_progress ride along per contact so a hit ship keeps
	# showing up (tilting and settling) instead of vanishing the instant it's
	# hit - see _step_sinking_ships().
	var periscope := {
		"available": depth <= periscope_max_depth,
		"bearing": fposmod(heading + periscope_relative_offset, 360.0),
		"contacts": [],
	}
	if periscope.available:
		for ship in ships:
			if not ship.alive:
				continue
			var to_ship_optical: Vector2 = ship.position - position
			var optical_distance := to_ship_optical.length()
			if optical_distance > periscope_max_range:
				continue
			var optical_true_bearing := fposmod(rad_to_deg(to_ship_optical.angle()), 360.0)
			periscope.contacts.append({
				"id": ship.id,
				"type": ship.type,
				"bearing_true": optical_true_bearing,
				"bearing_relative": fposmod(optical_true_bearing - heading, 360.0),
				"distance": optical_distance,
				"sinking": ship.sinking,
				"sink_progress": ship.sink_progress,
			})

	var map_data := {
		"position": {"x": position.x, "y": position.y},
		"heading": heading,
		"debug_show_enemy": debug_show_enemy,
		# The sub's own fired torpedoes, always visible (unlike ships below) -
		# there's no debug gate on watching a torpedo you launched yourself
		# travel across the map.
		"torpedoes": torpedoes.map(func(t): return {"x": t.position.x, "y": t.position.y, "heading": t.heading}),
	}
	if debug_show_enemy:
		map_data["ships"] = ships.filter(func(s): return s.alive).map(func(s): return {
			"x": s.position.x, "y": s.position.y, "heading": s.heading, "type": s.type,
		})

	return {
		"engine_order": engine_order,
		"speed": speed,
		"depth": depth,
		"heading": heading,
		"rudder": rudder,
		"dive_planes": dive_planes,
		"blow_valve": blow_valve,
		"flood_valve": flood_valve,
		"ballast": ballast,
		"comp_air": comp_air,
		"sonar_dial": sonar_dial,
		"periscope": periscope,
		"o2": o2,
		"flooding": flooding,
		"active_leaks": leaks.size(),
		"leaks": leaks.map(func(l): return {
			"id": l.id, "compartment": l.compartment, "x": l.x, "y": l.y,
			"weld_progress": l.weld_progress,
		}),
		"sunk": sunk,
		"won": won,
		"cargo_total": _cargo_ships().size(),
		"cargo_sunk": _cargo_ships().filter(func(s): return not s.alive).size(),
		"dev_mode": dev_mode,
		"invulnerable": invulnerable,
		"ignore_overheat_effects": debug_ignore_overheat_effects,
		"unlimited_supplies": debug_unlimited_supplies,
		"ignore_game_over": debug_ignore_game_over,
		"map": map_data,
		"stations": station_state,
		"players": player_state,
		"tools": tool_state,
		"sonar": sonar,
		"tdc": {"gyro_angle": tdc.gyro_angle, "spread_angle": tdc.spread_angle},
		"torpedo_tubes": torpedo_tubes.map(func(t): return {
			"loaded": t.loaded,
			"armed": t.armed,
			# A single categorical value (rather than making the Sub Editor
			# combine the two booleans above itself) so each tube can drive
			# its own Indicator Light object via a plain State Binding like
			# "torpedo_tubes.0.state" - one light per tube, each independent.
			"state": "armed" if t.armed else ("loaded" if t.loaded else "empty"),
			"reload_fraction": 0.0 if t.loaded else 1.0 - float(t.reload_ticks_remaining) / float(torpedo_reload_ticks),
		}),
		"torpedoes": torpedoes.map(func(t): return {
			"bearing_relative": fposmod(rad_to_deg((t.position - position).angle()) - heading, 360.0),
			"distance": t.position.distance_to(position),
		}),
		"enemy_alive": ships.any(func(s): return s.alive),
		"noise": _current_noise(),
		"sonar_sensitivity": sonar_sensitivity,
		"engine": {
			"ordered": engine_order,
			"running": engine_running,
			"throttle": throttle,
			"gear": gear,
			"rpm": rpm,
			"rpm_fraction": rpm_fraction,
			"temperature": temperature,
			"coolant_flow": coolant_flow,
			"oil_pressure": oil_pressure,
			"fuel": fuel,
			"efficiency": engine_efficiency,
			"tuning_active": engine_tuning_active,
			"fuse_blown": fuse_blown,
			"overheat_fraction": overheat_fraction,
		},
		"electrical": {
			"battery_charge": battery_charge,
			"charging": battery_charging,
			"bilge_pump_active": bilge_pump_active,
			"electric_motor_active": electric_motor_active,
			"power_draw": power_draw,
		},
	}

func get_world_info() -> Dictionary:
	return {
		"compartments": COMPARTMENTS,
		"layout": COMPARTMENT_LAYOUT,
		"start_compartment": DEFAULT_COMPARTMENT,
		# Balance constants the TDC scope needs to plot an accurate predicted
		# path client-side - sent once here rather than every tick in
		# get_state(), since they only change if the Inspector value itself
		# is retuned (which would need a reconnect to pick up anyway).
		"tdc_gyro_limit": tdc_gyro_limit,
		"tdc_spread_limit": tdc_spread_limit,
		"torpedo_tube_count": TORPEDO_TUBE_COUNT,
		"torpedo_speed": torpedo_speed,
		"torpedo_turn_rate": torpedo_turn_rate,
		"torpedo_max_lifetime_ticks": torpedo_max_lifetime_ticks,
		"torpedo_gyro_activation_distance": torpedo_gyro_activation_distance,
		# The client needs this to normalize a leak's weld_progress into a
		# 0..1 fraction for its own visual (e.g. how "cooked" a weld spot
		# looks) - a fixed balance constant, so it's sent once here like the
		# torpedo ones above rather than repeated on every single leak.
		"weld_repair_seconds": weld_repair_seconds,
		"room_width": ROOM_WIDTH,
		"room_height": ROOM_HEIGHT,
	}

func _request_station(player_id: int, station_id: String) -> void:
	if not stations.has(station_id) or not players.has(player_id):
		return
	var station: Dictionary = stations[station_id]
	if players[player_id].compartment != station.compartment:
		return
	if station.occupant == UNOCCUPIED or station.occupant == player_id:
		station.occupant = player_id

func _release_station(player_id: int, station_id: String) -> void:
	if not stations.has(station_id):
		return
	if stations[station_id].occupant == player_id:
		_clear_station_occupant(station_id)

func _station_occupant(station_id: String) -> int:
	if not stations.has(station_id):
		return UNOCCUPIED
	return stations[station_id].occupant

func _clear_station_occupant(station_id: String) -> void:
	if stations.has(station_id):
		stations[station_id].occupant = UNOCCUPIED
	if station_id == ENGINE_CONTROLS_STATION:
		engine_tuning_active = false

func _player_in_compartment(player_id: int, compartment: String) -> bool:
	return players.has(player_id) and players[player_id].compartment == compartment

func _move_player(player_id: int, target_compartment: String) -> void:
	if not players.has(player_id) or not COMPARTMENTS.has(target_compartment):
		return
	var current: String = players[player_id].compartment
	if target_compartment == current:
		return
	var connections: Array = COMPARTMENTS[current].connections
	if not connections.has(target_compartment):
		return
	players[player_id].compartment = target_compartment
	for station_id in stations:
		if stations[station_id].occupant == player_id and stations[station_id].compartment != target_compartment:
			_clear_station_occupant(station_id)

func _pickup_tool(player_id: int, tool_id: String) -> void:
	if not tools.has(tool_id) or not players.has(player_id):
		return
	var tool: Dictionary = tools[tool_id]
	var player: Dictionary = players[player_id]
	if tool.holder != UNOCCUPIED:
		return
	if player.equipped_tool != "":
		return
	if player.compartment != tool.compartment:
		return
	tool.holder = player_id
	player.equipped_tool = tool_id

func _drop_tool(player_id: int, tool_id: String) -> void:
	if not tools.has(tool_id) or not players.has(player_id):
		return
	var tool: Dictionary = tools[tool_id]
	var player: Dictionary = players[player_id]
	if player.equipped_tool != tool_id:
		return
	tool.holder = UNOCCUPIED
	tool.compartment = player.compartment
	player.equipped_tool = ""

func _set_tube_armed(player_id: int, tube_index: int, armed: bool) -> void:
	if not players.has(player_id):
		return
	if players[player_id].compartment != CONNING_TOWER_COMPARTMENT:
		return
	if tube_index < 0 or tube_index >= torpedo_tubes.size():
		return
	var tube: Dictionary = torpedo_tubes[tube_index]
	if armed and not tube.loaded:
		return
	tube.armed = armed

## Fires every currently-armed, loaded tube at once. Each tube's gyro offset
## is spread symmetrically around the TDC's aimed gyro_angle - with
## TORPEDO_TUBE_COUNT tubes, adjacent tube indices differ by exactly
## spread_angle degrees, and the offsets straddle zero evenly (e.g. with 4
## tubes: -1.5, -0.5, 0.5, 1.5 spread-lengths) - so a tube's offset only
## depends on its fixed position, not on which other tubes happen to be
## armed alongside it.
func _fire_torpedo(player_id: int) -> void:
	if not players.has(player_id):
		return
	if players[player_id].compartment != CONNING_TOWER_COMPARTMENT:
		return
	var tube_count := torpedo_tubes.size()
	for i in tube_count:
		var tube: Dictionary = torpedo_tubes[i]
		if not tube.armed or not tube.loaded:
			continue
		var gyro_offset: float = tdc.gyro_angle + tdc.spread_angle * (float(i) - float(tube_count - 1) / 2.0)
		torpedoes.append({
			"position": position,
			"heading": heading,
			"gyro_offset": gyro_offset,
			"life_ticks": 0,
		})
		tube.loaded = false
		tube.armed = false
		tube.reload_ticks_remaining = torpedo_reload_ticks

func _replace_fuse(player_id: int) -> void:
	if not players.has(player_id):
		return
	if players[player_id].compartment != ENGINEERING_COMPARTMENT:
		return
	if not fuse_blown:
		return
	fuse_blown = false

func _set_gear(value: String) -> void:
	match value:
		GEAR_FORWARD, GEAR_NEUTRAL, GEAR_REVERSE:
			gear = value
		_:
			pass

func _gear_multiplier(g: String) -> float:
	match g:
		GEAR_FORWARD:
			return 1.0
		GEAR_REVERSE:
			return -0.5
		_:
			return 0.0

## Builds convoy_count convoys, each at a random distance/bearing from the
## sub's own reset position (0,0) and a random course heading, with a random
## destroyer/cargo mix within the configured min/max counts. Ships within one
## convoy start in a simple line-abreast formation, spaced perpendicular to
## their shared course. Convoy 0 always spawns at convoy_guaranteed_close_
## distance (still a random bearing) rather than the full random range, so
## there's always at least one nearby to find early on.
func _spawn_convoys() -> void:
	ships = []
	convoys = []
	var ship_seq := 0
	for convoy_id in convoy_count:
		convoys.append({"id": convoy_id, "alert": false})
		var spawn_distance := convoy_guaranteed_close_distance if convoy_id == 0 else randf_range(convoy_spawn_min_distance, convoy_spawn_max_distance)
		var spawn_angle := randf() * TAU
		var convoy_center := Vector2(spawn_distance, 0.0).rotated(spawn_angle)
		var course_heading := randf() * 360.0
		var perp := Vector2.RIGHT.rotated(deg_to_rad(course_heading + 90.0))

		var destroyer_count := randi_range(convoy_destroyers_min, convoy_destroyers_max)
		var cargo_count := randi_range(convoy_cargo_min, convoy_cargo_max)
		var total_count := destroyer_count + cargo_count
		var slot := 0
		for i in destroyer_count:
			ships.append(_make_ship(ship_seq, convoy_id, "destroyer", convoy_center, course_heading, perp, slot, total_count))
			ship_seq += 1
			slot += 1
		for i in cargo_count:
			ships.append(_make_ship(ship_seq, convoy_id, "cargo", convoy_center, course_heading, perp, slot, total_count))
			ship_seq += 1
			slot += 1

func _make_ship(id: int, convoy_id: int, type: String, convoy_center: Vector2, course_heading: float, perp: Vector2, slot: int, total_count: int) -> Dictionary:
	var offset := perp * convoy_formation_spacing * (float(slot) - float(total_count - 1) / 2.0)
	return {
		"id": id,
		"convoy_id": convoy_id,
		"type": type,
		"alive": true,
		"position": convoy_center + offset,
		"heading": course_heading,
		"course_heading": course_heading,
		"speed": destroyer_transit_speed if type == "destroyer" else cargo_transit_speed,
		"attack_cooldown": 0,
		"sinking": false,
		"sink_progress": 0.0,
	}

## The sub's own three-tier detectability model, from the DETECTING ship's
## side - see the Detection export group for the tunables. Surfaced and
## periscope-depth ranges apply regardless of how fast the sub is moving;
## below periscope depth, the sub is only loud enough to catch at all while
## its own "speed" fraction is at detection_deep_speed_threshold or higher,
## and even then only out to the much shorter detection_range_deep_fast.
func _current_detection_range() -> float:
	if depth <= surfaced_max_depth:
		return detection_range_surfaced
	if depth <= periscope_max_depth:
		return detection_range_periscope_depth
	# "speed" (not speed * max_speed) is already the sub's own 0..~1 fraction
	# of full speed - the exact same number the player's own speed gauge
	# reads - so it's compared against the threshold directly, with no
	# max_speed division: max_speed is a separate world-units/sec scalar used
	# only for the actual position step, on a completely different scale.
	if absf(speed) >= detection_deep_speed_threshold:
		return detection_range_deep_fast
	return 0.0

## The same three-tier model as _current_detection_range(), read from the
## SUB's own side for the Sonar station's "Noise" gauge - how detectable the
## sub itself currently is, as a plain 0-100 number rather than a range in
## world units, so it reads the same regardless of how detection_range_* are
## tuned. See the Detection export group for the four level values.
func _current_noise() -> float:
	if depth <= surfaced_max_depth:
		return noise_surfaced
	if depth <= periscope_max_depth:
		return noise_periscope_depth
	if absf(speed) >= detection_deep_speed_threshold:
		return noise_deep_fast
	return noise_deep_quiet

func _ship_detects_player(ship_position: Vector2) -> bool:
	var detection_range := _current_detection_range()
	if detection_range <= 0.0:
		return false
	return ship_position.distance_to(position) <= detection_range

## Ships never re-check detection once their convoy is alert (see the
## Convoys export group's cargo_transit_speed doc comment) - alert is a
## one-way switch for the rest of the run.
func _step_ships() -> void:
	var convoy_alert := {}
	for convoy in convoys:
		convoy_alert[convoy.id] = convoy.alert

	for ship in ships:
		if not ship.alive or ship.sinking:
			continue
		if not convoy_alert.get(ship.convoy_id, false) and ship.type == "destroyer" and _ship_detects_player(ship.position):
			convoy_alert[ship.convoy_id] = true

	for convoy in convoys:
		convoy.alert = convoy_alert.get(convoy.id, false)

	for ship in ships:
		# A sinking ship is dead in the water - no more course-keeping,
		# chasing, or attacking, on top of already being excluded from
		# detection above. It still exists in `ships` (and keeps showing up
		# in periscope.contacts) until _step_sinking_ships() finishes it off.
		if not ship.alive or ship.sinking:
			continue
		var alert: bool = convoy_alert.get(ship.convoy_id, false)
		var turn_rate: float = destroyer_turn_rate if ship.type == "destroyer" else cargo_turn_rate
		var desired_heading: float = ship.course_heading

		if alert:
			var to_sub: Vector2 = position - ship.position
			if ship.type == "destroyer":
				desired_heading = rad_to_deg(to_sub.angle())
				ship.speed = destroyer_attack_speed
			else:
				# Flee directly away from the sub's current position - the
				# opposite direction from to_sub (ship -> sub), not a mirrored
				# angle, so negate the VECTOR before reading its angle.
				desired_heading = rad_to_deg((-to_sub).angle())
				ship.speed = cargo_flee_speed

		var diff := wrapf(desired_heading - ship.heading, -180.0, 180.0)
		var max_turn := turn_rate * DT
		ship.heading = fposmod(ship.heading + clampf(diff, -max_turn, max_turn), 360.0)
		var heading_rad := deg_to_rad(ship.heading)
		ship.position += Vector2(cos(heading_rad), sin(heading_rad)) * ship.speed * DT

		if ship.type == "destroyer" and alert:
			var distance_to_sub := position.distance_to(ship.position)
			if distance_to_sub <= destroyer_attack_range:
				ship.attack_cooldown -= 1
				if ship.attack_cooldown <= 0:
					ship.attack_cooldown = destroyer_attack_cooldown_ticks
					if not invulnerable:
						for i in randi_range(destroyer_min_leaks_per_hit, destroyer_max_leaks_per_hit):
							_spawn_leak()
			else:
				ship.attack_cooldown = 0

## Advances every currently-sinking ship's sink_progress (0..1 over
## ship_sink_duration seconds) and finishes it off (alive = false) once it
## reaches 1 - separate from _step_ships() above since a sinking ship is
## deliberately frozen in place (no course-keeping, no attacking) for its
## whole death animation, not stepped the normal way at all.
func _step_sinking_ships() -> void:
	for ship in ships:
		if not ship.sinking:
			continue
		ship.sink_progress = minf(1.0, ship.sink_progress + DT / ship_sink_duration)
		if ship.sink_progress >= 1.0:
			ship.alive = false
			ship.sinking = false

# Ambient background traffic - just walks a fixed circle around the map
# center forever. No heading/turn-rate model like the convoy ships above;
# angular speed is derived directly from passive_circle_speed and each
# contact's own radius so a farther-out contact still moves at the same
# real speed, just sweeping through fewer degrees per second.
func _step_passive_contacts() -> void:
	for contact in passive_contacts:
		var angular_speed: float = passive_circle_speed / contact.radius
		contact.angle = fposmod(contact.angle + angular_speed * DT, TAU)
		contact.position = Vector2(contact.radius, 0.0).rotated(contact.angle)

## A torpedo is aimed by its GYRO, not by a target heading it turns to and
## then stops at - the gyro holds a fixed continuous deflection (like a
## rudder held at a set angle) for the rest of its flight, once armed. It
## runs straight along its launch heading (the sub's heading at the moment
## it was fired) for torpedo_gyro_activation_distance, then the gyro engages
## and keeps turning it at a constant rate - proportional to how far its own
## gyro_offset sits within +/-tdc_gyro_limit - for the ENTIRE remainder of
## its life. It never "arrives" at gyro_offset and straightens out: a gyro_
## offset at the full tdc_gyro_limit turns continuously at torpedo_turn_rate;
## half that limit turns at half that rate; 0 never turns at all. Speed is
## constant throughout, so life_ticks * torpedo_speed * DT is exactly the
## distance traveled regardless of how much of that path has curved.
func _step_torpedoes() -> void:
	var still_flying := []
	for t in torpedoes:
		var distance_traveled: float = t.life_ticks * torpedo_speed * DT
		if distance_traveled >= torpedo_gyro_activation_distance:
			var turn_fraction := clampf(t.gyro_offset / tdc_gyro_limit, -1.0, 1.0)
			t.heading = fposmod(t.heading + turn_fraction * torpedo_turn_rate * DT, 360.0)
		var heading_rad := deg_to_rad(t.heading)
		t.position += Vector2(cos(heading_rad), sin(heading_rad)) * torpedo_speed * DT
		t.life_ticks += 1

		var hit := false
		for ship in ships:
			if ship.alive and not ship.sinking and t.position.distance_to(ship.position) <= torpedo_hit_radius:
				# Doesn't vanish outright - starts the sink animation instead
				# (see _step_sinking_ships()), so it's still there, dead in
				# the water, for the periscope view to show tilting and
				# settling. A ship already sinking can't be hit again.
				ship.sinking = true
				ship.sink_progress = 0.0
				hit = true
				break
		if not hit and t.life_ticks < torpedo_max_lifetime_ticks:
			still_flying.append(t)
	torpedoes = still_flying

	for tube in torpedo_tubes:
		if not tube.loaded:
			tube.reload_ticks_remaining -= 1
			if tube.reload_ticks_remaining <= 0:
				tube.loaded = true

## A new leak at a random spot in a random hull compartment (see
## LEAK_COMPARTMENTS) - called once per leak an enemy hit springs (see
## _step_ships()'s destroyer attack block).
func _spawn_leak() -> void:
	leaks.append({
		"id": next_leak_id,
		"compartment": LEAK_COMPARTMENTS[randi() % LEAK_COMPARTMENTS.size()],
		"x": randf_range(leak_edge_margin, 1.0 - leak_edge_margin),
		"y": randf_range(leak_edge_margin, 1.0 - leak_edge_margin),
		"weld_progress": 0.0,
	})
	next_leak_id += 1

## Advances weld_progress on every leak currently under a lit torch (see
## welding_active, populated by WELD_AT) and removes any that finish -
## checked every tick, not just when a new WELD_AT arrives, so holding the
## torch still over a leak keeps counting between messages. Compared in room-
## canvas PIXELS (x/y * ROOM_WIDTH/ROOM_HEIGHT), not raw normalized 0..1
## distance, so weld_hit_radius means the same physical spot on a wide vs.
## tall room instead of being skewed by its aspect ratio.
func _step_welding() -> void:
	if welding_active.is_empty() or leaks.is_empty():
		return
	for weld in welding_active.values():
		for leak in leaks:
			if leak.compartment != weld.compartment:
				continue
			var dx: float = (weld.x - leak.x) * ROOM_WIDTH
			var dy: float = (weld.y - leak.y) * ROOM_HEIGHT
			if sqrt(dx * dx + dy * dy) <= weld_hit_radius:
				leak.weld_progress += DT
	leaks = leaks.filter(func(l): return l.weld_progress < weld_repair_seconds)

func _step_flooding() -> void:
	if leaks.size() > 0:
		flooding = minf(100.0, flooding + leak_flood_rate * leaks.size() * DT)
	if bilge_pump_active:
		flooding = maxf(0.0, flooding - bilge_pump_flood_removal_rate * DT)

	# O2 only regenerates at/near the surface (fresh air through the hatch
	# or a snorkel) - anywhere deeper it just ticks down at a snail's pace
	# from crew breathing, and either way it's capped the instant flooding
	# rises. Heavy flooding's own sink rate (above) is what stops a
	# damaged sub from just sitting at the surface breathing indefinitely -
	# it gets dragged back down past the safe depth on its own.
	if depth <= o2_replenish_min_depth:
		o2 = minf(100.0, o2 + o2_replenish_rate * DT)
	else:
		o2 = maxf(0.0, o2 - o2_natural_decline_rate * DT)
	o2 = minf(o2, 100.0 - flooding)
	if o2 <= 0.0 and not invulnerable and not debug_ignore_game_over:
		sunk = true
