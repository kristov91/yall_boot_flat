// The "binding sheet" - every real input action (apply_input()'s match arms)
// and output state path (get_state()'s broadcast shape) the server actually
// understands, hand-transcribed from server/simulation.gd - not guessed, and
// not left to the game client's own docs to restate.
//
// Loaded as a plain global (via a <script> tag, no bundler) by BOTH
// editor.js (feeds autocomplete on every Binding/State Binding field, and
// lets picking a known action auto-fill its value range and payload key) AND
// binding-sheet.html (a human-readable table view of this same data) - kept
// as its own file specifically so those two never drift apart the way a
// second, hand-copied list would. If the server adds, renames, or reshapes
// an action/state field, this is the ONE place to update; both consumers
// pick the change up automatically.
//
// See also: sub-editor/help.html (open via the "Help / Docs" toolbar link)
// for the full field-by-field editor reference, including how Binding/State
// Binding/Payload Key relate to this list.

const SERVER_ACTIONS = [
  { name: 'SET_ENGINE_ORDER', payloadKey: 'value', valueType: 'float', min: -1, max: 1 },
  { name: 'SET_RUDDER', payloadKey: 'value', valueType: 'float', min: -1, max: 1 },
  { name: 'SET_DIVE_PLANES', payloadKey: 'value', valueType: 'float', min: -1, max: 1 },
  { name: 'SET_BLOW_VALVE', payloadKey: 'value', valueType: 'float', min: 0, max: 1, note: 'Dive station BLOW valve opening (0 shut, 1 fully open). Forces water out of the ballast tanks using comp_air - the boat gets lighter and rises.' },
  { name: 'SET_FLOOD_VALVE', payloadKey: 'value', valueType: 'float', min: 0, max: 1, note: 'Dive station FLOOD valve opening (0 shut, 1 fully open). Lets sea water into the ballast tanks - the boat gets heavier and sinks.' },
  { name: 'SET_SONAR_DIAL', payloadKey: 'value', valueType: 'float', min: 0, max: 360 },
  { name: 'START_ENGINE', payloadKey: null, valueType: 'trigger' },
  { name: 'STOP_ENGINE', payloadKey: null, valueType: 'trigger' },
  { name: 'SET_THROTTLE', payloadKey: 'value', valueType: 'float', min: 0, max: 1 },
  { name: 'SET_GEAR', payloadKey: 'gear', valueType: 'string', options: ['forward', 'neutral', 'reverse'] },
  { name: 'SET_COOLANT_FLOW', payloadKey: 'value', valueType: 'float', min: 0, max: 1 },
  { name: 'SET_TUNING', payloadKey: 'active', valueType: 'bool' },
  { name: 'SET_CHARGING', payloadKey: 'active', valueType: 'bool' },
  { name: 'SET_BILGE_PUMP', payloadKey: 'active', valueType: 'bool' },
  { name: 'SET_ELECTRIC_MOTOR', payloadKey: 'active', valueType: 'bool' },
  {
    name: 'WELD_AT', payloadKey: 'x', valueType: 'float', min: 0, max: 1,
    note: 'Not a control you\'d bind from the Sub Editor - the client\'s own welder tool sends this continuously (x, y both 0-1, normalized against the server\'s room_width/room_height) while a player drags the torch across the compartment view. Repairs any leak within weld_hit_radius after weld_repair_seconds of continuous contact. See STOP_WELDING.',
  },
  { name: 'STOP_WELDING', payloadKey: null, valueType: 'trigger', note: 'Sent when the welder torch lifts (pointer up, or the tool toggled off) - clears that player\'s in-progress weld so it stops silently counting toward a leak after they\'ve let go.' },
  { name: 'REPLACE_FUSE', payloadKey: null, valueType: 'trigger' },
  { name: 'FIRE_TORPEDO', payloadKey: null, valueType: 'trigger' },
  { name: 'SET_TDC_GYRO', payloadKey: 'value', valueType: 'float', min: -90, max: 90 },
  { name: 'SET_TDC_SPREAD', payloadKey: 'value', valueType: 'float', min: 0, max: 45 },
  {
    name: 'SET_PERISCOPE_TURN', payloadKey: 'value', valueType: 'float', min: -1, max: 1,
    note: 'Steering-wheel style, same relationship as SET_RUDDER -> heading: this sets a held turn-RATE deflection (-1 full left .. 1 full right), not an absolute bearing - periscope.bearing keeps turning every tick at periscope_turn_rate * this value for as long as it stays nonzero, and only stops once it is set back to 0. Pair the control with Deadzone + Spring to Center (Interaction section) so releasing the handle reliably sends exactly 0.',
  },
  {
    name: 'SET_SONAR_SENSITIVITY', payloadKey: 'value', valueType: 'float', min: 0.5, max: 2,
    note: 'Receiver gain - multiplies the FINAL sonar.db reading (contact + ambient) and sonar.pulse_hz. Turning it up makes a faint contact easier to hear but amplifies ambient hum right along with it, a real tradeoff rather than a free "hear everything" dial. Min/Max here match the server\'s sonar_sensitivity_min/max exports - retune both together if those change.',
  },
  {
    name: 'SET_TUBE_ARMED', payloadKey: 'armed', valueType: 'bool',
    note: 'Takes TWO payload keys (tube: int, armed: bool) - use Payload Key = armed for the control\'s own on/off, plus Extra Payload Key = tube / Extra Payload Value = <that tube\'s index> (a fixed per-instance value, e.g. one Toggle Switch object per tube) to supply the second field. See Help & Docs -> Bindings & Payload Keys.',
  },
];

const SERVER_STATE_PATHS = [
  { path: 'engine_order', type: 'float', min: -1, max: 1 },
  { path: 'speed', type: 'float', note: 'Derived - eases toward propulsion_fraction (throttle x gear multiplier), not a value with one fixed authored range. Roughly -0.5 (full astern) to 1 (full ahead) in practice; watch the live debug readout while playtesting and pick a Value Min/Max that covers what you actually see (0 to 1 is fine for a forward-only gauge).' },
  { path: 'depth', type: 'float', min: 0, max: 200 },
  { path: 'heading', type: 'float', min: 0, max: 360 },
  { path: 'rudder', type: 'float', min: -1, max: 1 },
  { path: 'dive_planes', type: 'float', min: -1, max: 1 },
  { path: 'blow_valve', type: 'float', min: 0, max: 1 },
  { path: 'flood_valve', type: 'float', min: 0, max: 1 },
  { path: 'ballast', type: 'float', min: 0, max: 100, note: '% of the ballast tanks full of water. 50 (ballast_neutral) is neutrally buoyant; above sinks, below rises. For the BALL gauge.' },
  { path: 'comp_air', type: 'float', min: 0, max: 100, note: 'Compressed air left for blowing ballast; refills slowly while the diesel runs. For the COMP AIR gauge.' },
  { path: 'sonar_dial', type: 'float', min: 0, max: 360 },
  { path: 'sonar.db', type: 'float', min: 0, max: 100 },
  { path: 'sonar.pulse_hz', type: 'float', min: 0, max: 5 },
  { path: 'sonar.distance', type: 'float', min: 0 },
  { path: 'sonar.bearing_true', type: 'float', min: 0, max: 360 },
  { path: 'sonar.bearing_relative', type: 'float', min: 0, max: 360 },
  { path: 'sonar.contact', type: 'bool' },
  { path: 'o2', type: 'float', min: 0, max: 100 },
  { path: 'flooding', type: 'float', min: 0, max: 100 },
  { path: 'active_leaks', type: 'float', min: 0, note: 'Unbounded count - grows on each enemy hit, only drops as individual leaks get welded shut (see the `leaks` array below). No natural max for a gauge range; better read as a plain number than driven through a needle/slider.' },
  {
    path: 'leaks', type: 'array',
    note: 'Every active leak, NOT a single value - each entry is {id, compartment, x, y (normalized 0-1, see the server\'s room_width/room_height), weld_progress (seconds, compare against weld_repair_seconds from the one-time world-info payload)}. Not meant for a generic gauge (no single stable path into a list that changes size) - the client\'s own leak/welder rendering reads it directly.',
  },
  { path: 'sunk', type: 'bool' },
  { path: 'invulnerable', type: 'bool' },
  { path: 'unlimited_supplies', type: 'bool', note: 'Debug-only, set via the client\'s own "Unlimited Supplies" button (not a Sub Editor-authored control) - fuel/battery still drain and broadcast normally, but running out has no gameplay effect while this is on.' },
  { path: 'ignore_game_over', type: 'bool', note: 'Debug-only, set via the client\'s own "Ignore Game Over" button - flooding/O2 still drain and broadcast normally and can still hit 0, but the round never actually ends, so leaks/flooding can be tested repeatedly without a Reset Game every time.' },
  { path: 'enemy_alive', type: 'bool', note: 'True while ANY convoy ship (cargo or destroyer, any convoy) is still afloat - not tied to one specific ship.' },
  {
    path: 'noise', type: 'float', min: 0, max: 100,
    note: 'How detectable the sub itself currently is (0 = silent running, 100 = fully exposed) - drives the Sonar station\'s own "Noise" gauge. Purely a function of depth and speed (see the server\'s Detection export group): surfaced is always loudest regardless of speed; below periscope depth is only ever caught while moving at half speed or more, and is silent otherwise.',
  },
  {
    path: 'sonar_sensitivity', type: 'float', min: 0.5, max: 2,
    note: 'Current receiver gain, set via SET_SONAR_SENSITIVITY - bind a readout gauge to this to show the dial\'s own current setting.',
  },
  { path: 'tdc.gyro_angle', type: 'float', min: -90, max: 90 },
  { path: 'tdc.spread_angle', type: 'float', min: 0, max: 45 },
  { path: 'periscope.available', type: 'bool', note: 'False when too deep for the scope to reach the surface (see periscope_max_depth on the server) - drive a "too deep to raise scope" visual state from this rather than assuming the scope always has something to show.' },
  { path: 'periscope.bearing', type: 'float', min: 0, max: 360, note: 'Absolute compass direction the scope is currently pointed - computed fresh every tick as the sub\'s heading plus its own offset off the bow (that offset is what SET_PERISCOPE_TURN\'s held deflection actually integrates), so the scope turns right along with the sub for free, same as a real periscope mounted to the hull.' },
  {
    path: 'periscope.contacts', type: 'array', note: 'Every optically-visible ship (any convoy), NOT a single value - each entry is {id, type, bearing_true, bearing_relative, distance, sinking, sink_progress}. sinking/sink_progress (0..1 over the server\'s ship_sink_duration) cover a hit ship\'s tilt-and-settle death animation - it stays in this list, dead in the water, for that whole time instead of vanishing outright. There\'s no meaningful single State Binding path into this list (which ship is "first" changes as ships move/sink), so it isn\'t meant for a generic gauge - the periscope Scope Display Channel already reads it directly to draw every visible ship at once. Bind gauges to periscope.available/bearing above instead.',
  },
  {
    path: 'torpedo_tubes.0.state', type: 'string', options: ['empty', 'loaded', 'armed'],
    note: 'torpedo_tubes is a 4-entry array (indices 0-3, one per tube) - bind one Indicator Light per tube to torpedo_tubes.0.state / .1.state / .2.state / .3.state, each independently.',
  },
  { path: 'torpedo_tubes.1.state', type: 'string', options: ['empty', 'loaded', 'armed'] },
  { path: 'torpedo_tubes.2.state', type: 'string', options: ['empty', 'loaded', 'armed'] },
  { path: 'torpedo_tubes.3.state', type: 'string', options: ['empty', 'loaded', 'armed'] },
  { path: 'torpedo_tubes.0.loaded', type: 'bool', note: 'Same underlying data as .state, unpacked - use this instead if a control only needs one boolean rather than the 3-way state. Same array shape - .1.loaded, .2.loaded, .3.loaded also exist.' },
  { path: 'torpedo_tubes.0.armed', type: 'bool' },
  { path: 'torpedo_tubes.0.reload_fraction', type: 'float', min: 0, max: 1, note: 'For a reload progress meter - 0 right after firing, 1 once loaded again.' },
  { path: 'engine.ordered', type: 'float', min: -1, max: 1 },
  { path: 'engine.running', type: 'bool' },
  { path: 'engine.throttle', type: 'float', min: 0, max: 1 },
  { path: 'engine.gear', type: 'string', options: ['forward', 'neutral', 'reverse'] },
  { path: 'engine.rpm', type: 'float', min: 0, max: 2000, note: "Matches the server's rpm_max export default (2000) - retune this if that Inspector value changes. engine.rpm_fraction below is the same reading pre-normalized to 0-1, if that's easier to wire up." },
  { path: 'engine.rpm_fraction', type: 'float', min: 0, max: 1 },
  { path: 'engine.temperature', type: 'float', min: 20, max: 150, note: "20 = ambient_temperature (idle/cold) default, 150 = engine_max_temp default (overheat/damage threshold). engine_nominal_temp (90, default) is where overheat_fraction starts climbing above 0 - useful as a gauge's warning-zone start." },
  { path: 'engine.coolant_flow', type: 'float', min: 0, max: 1 },
  { path: 'engine.oil_pressure', type: 'float', min: 0, max: 80, note: "Matches the server's oil_pressure_max export default (80)." },
  { path: 'engine.fuel', type: 'float', min: 0, max: 100 },
  { path: 'engine.efficiency', type: 'float', min: 0, max: 100 },
  { path: 'engine.tuning_active', type: 'bool' },
  { path: 'engine.fuse_blown', type: 'bool' },
  { path: 'engine.overheat_fraction', type: 'float', min: 0, max: 1 },
  { path: 'map.heading', type: 'float', min: 0, max: 360 },
  { path: 'electrical.battery_charge', type: 'float', min: 0, max: 100 },
  { path: 'electrical.charging', type: 'bool' },
  { path: 'electrical.bilge_pump_active', type: 'bool' },
  { path: 'electrical.electric_motor_active', type: 'bool' },
  { path: 'electrical.power_draw', type: 'float' },
];
