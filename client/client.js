const NAV_SWIPE_THRESHOLD_RATIO = 0.2;
// A weld stroke that covers NAV_SWIPE_THRESHOLD_RATIO of the screen within
// this many ms reads as a deliberate fast swipe (wanting to change
// compartment) rather than someone just tracing a wide leak - see the
// welder's own swipe-override check in onRoomCanvasPointerMove. There's no
// equivalent time limit on the plain swipe-nav gesture itself (any drag past
// the distance threshold counts, however slow), only on this override,
// since a slow, deliberate weld drag has to stay possible.
const WELD_SWIPE_MAX_MS = 350;

// Which stations exist in each compartment, for the station-selection list.
// "real" stations have server-side occupancy (station_id matches a real
// server station); pseudo-stations (nav_map, torpedo_tube) are purely a
// client-side view grouping with no occupancy claim - nav_map because the
// design doc explicitly allows multiple simultaneous users, torpedo_tube
// because firing is gated by compartment presence only, not exclusivity.
const STATIONS_BY_COMPARTMENT = {
  control: [
    { id: 'station_helm', label: 'Helm (rudder + engine order)', real: true },
    { id: 'station_dive', label: 'Dive', real: true },
    { id: 'nav_map', label: 'Navigation Map', real: false },
  ],
  information: [
    { id: 'station_sonar', label: 'Sonar', real: true },
  ],
  forward_torpedo: [
    { id: 'torpedo_tube', label: 'Torpedo Tube', real: false },
    // Physical tube-loading controls, separate from the TDC targeting
    // computer (which lives in the Conning Tower instead, alongside the
    // attack periscope) - no server-side occupancy or dedicated controls
    // wired up yet, just a room-renderer canvas so it's visible while
    // testing the Sub Editor's own layout for it.
    { id: 'station_torpedotubes', label: 'Torpedo Tube Loading', real: false },
  ],
  engineering: [
    { id: 'station_engine_controls', label: 'Engine Controls', real: true },
    // Newly exported from the Sub Editor - no server-side occupancy or
    // dedicated controls wired up yet, just a room-renderer canvas so it's
    // visible while we test the loading pipeline against it.
    { id: 'station_electrical', label: 'Electrical', real: false },
  ],
  conning_tower: [
    { id: 'station_tdc', label: 'Torpedo Data Computer', real: false },
    { id: 'station_periscope', label: 'Attack Periscope', real: false },
  ],
};

// Compartments reachable by a vertical swipe instead of the normal left/
// right flow through COMPARTMENT_LAYOUT - the Conning Tower sits "above"
// Control rather than beside it in the linear chain, so it needs its own
// up/down link instead of an index step through compartmentLayout.
const COMPARTMENT_VERTICAL_LINKS = {
  control: { down: 'conning_tower' },
  conning_tower: { up: 'control' },
};

let socket = null;
let sequence = 0;
let myPlayerNumber = null;
let myPlayerId = null;

let compartmentLayout = [];
let myCompartment = null;

// Compartment view (looking around the room) vs station view (operating one
// specific station's dedicated UI), per the design doc's non-negotiable
// station model - see Master Design Doc Rev1 Core Principles §6-7.
let viewMode = 'compartment';
let selectedStationId = null;

let stationsState = {};
let playersState = {};
let toolsState = {};

// --- Room Renderer wiring ----------------------------------------------
//
// Sub Editor exports a room's layout as layouts/<compartment_id>.json (plus
// a packed spritesheet) - RoomRenderer (room_renderer.js) knows how to load
// and draw one; this just keeps it pointed at whatever room/station the
// player is currently looking at. Purely visual for now: it draws the
// authored layout as-is, it doesn't yet read live game state to drive gauge
// needles/texture swaps or wire up dragging - see room_renderer.js's header.
let currentRoomId = null;
let currentRoomEntry = null;
let lastGameState = null; // most recent state.data broadcast, for output bindings (gauges, texture swaps, visual states)
let activeDrag = null; // { objId, t } - the one object (if any) being dragged via the room canvas right now, for rendering
let dragSession = null; // { objId, geom, t, lastRaw } - the same drag's internal delta-tracking state
let lastKnownT = {}; // objId -> t, persists across separate drags so releasing and re-grabbing a control never resets it
let hPatternDragOverride = null; // { objId, x, y } - a drag_h_pattern control's live rail position while being dragged, for rendering
let hPatternDragSession = null; // { objId, activeNodeId } - the same drag's internal state
let lastKnownHPatternNode = {}; // objId -> nodeId, persists across separate drags so releasing and re-grabbing a shifter never resets it
// objId -> bool, for a Toggle Switch whose State Binding is blank or doesn't
// resolve (a purely decorative switch with no backing server value) - the
// only way such a switch's sprite can ever visually flip, since there's no
// real state to read back. Same "client's own memory" idea as lastKnownT.
let lastKnownToggleState = {};
// The welder tool - a compartment-view-only mode toggled by its own button
// (see #welder-toggle-btn) rather than the pickup/equip tool system, per the
// user's own spec. While on, dragging anywhere on the room canvas in
// compartment view paints weld sparks/decals (client-local VFX, see
// RoomRenderer.weldAt) and reports the torch's position to the server
// (WELD_AT) so it can actually repair a leak underneath it.
let welderOn = false;
let weldingSession = null; // { pointerId } - which pointer is currently painting
let lastServerTick = -1; // for detecting a server-side RESET_GAME (tick rolling back to 0) - see applyState()
let lastLeakCount = 0; // for detecting a fresh hit (active_leaks rising) - see applyState()

// --- Camera shake (a hit just landed) --------------------------------------
//
// Applied directly to #room-canvas itself via style.transform, not a CSS
// transition/class - a transition EASES between two positions, which reads
// as a smooth wobble, while a hit needs a sharp, random JITTER that decays
// over time. Runs its own requestAnimationFrame loop independent of
// renderCurrentRoomCanvases() (which only fires on a new state broadcast)
// so the shake animates smoothly every real frame regardless of network
// timing, and composes fine with the screen-transition slide classes since
// those transform #viewport/#room-canvas-panel (the PARENT), never the
// canvas element itself.
let shakeEndMs = 0;
let shakeMagnitude = 0;
const SHAKE_DURATION_MS = 350;

function triggerCameraShake(magnitude = 14) {
  shakeEndMs = Date.now() + SHAKE_DURATION_MS;
  shakeMagnitude = magnitude;
}

function updateCameraShake() {
  const canvas = el('room-canvas');
  const now = Date.now();
  if (now < shakeEndMs) {
    const remaining = (shakeEndMs - now) / SHAKE_DURATION_MS;
    const dx = (Math.random() * 2 - 1) * shakeMagnitude * remaining;
    const dy = (Math.random() * 2 - 1) * shakeMagnitude * remaining;
    canvas.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
  } else if (canvas.style.transform) {
    canvas.style.transform = '';
  }
  requestAnimationFrame(updateCameraShake);
}
requestAnimationFrame(updateCameraShake);

// --- Scope view state (zoom/pan on a nav_map scope) -----------------------
//
// Purely client-side camera state for a scope object's own display, never
// sent to the server - wheel scroll or touch pinch zooms, a single-finger/
// mouse drag pans once zoomed in. Keyed by object id so it persists across
// re-renders and separate gestures the same way lastKnownT does for drag
// controls.
let scopeZoom = {}; // objId -> zoom multiplier (1 = the object's own authored range)
let scopePan = {}; // objId -> {x, y} world-unit offset the view is centered on
let scopeDragSession = null; // { objId, pointerId, startClientX, startClientY, startPan } - single-pointer pan
const scopePinchPointers = new Map(); // pointerId -> {x, y} screen coords, while 2 fingers are down on the same scope
let scopePinchStartDist = null;
let scopePinchObjId = null;
let scopePinchStartZoom = 1;

function loadCurrentRoom() {
  if (!myCompartment || myCompartment === currentRoomId) return;
  currentRoomId = myCompartment;
  currentRoomEntry = null;
  RoomRenderer.load(myCompartment)
    .then((entry) => {
      if (myCompartment !== currentRoomId) return; // compartment changed again before this resolved
      currentRoomEntry = entry;
      renderCurrentRoomCanvases();
    })
    .catch((err) => {
      console.warn(`Room Renderer: ${err.message}`);
    });
}

function renderCurrentRoomCanvases() {
  const stationId = viewMode === 'station' ? selectedStationId : null;
  RoomRenderer.draw(
    el('room-canvas'), currentRoomEntry, stationId, lastGameState,
    activeDrag, lastKnownT, hPatternDragOverride, lastKnownHPatternNode,
    { zoom: scopeZoom, pan: scopePan }, lastKnownToggleState, currentRoomId,
  );
}

// --- Room canvas interaction ---------------------------------------------
//
// Generic pointer wiring for whatever the currently-visible room/station
// contains: click/open_station fire once on pointerdown, drag_linear/
// drag_rotate track the pointer for the whole gesture. Every control's
// actual behavior (its range, snap positions, visual sweep) lives in the
// object's own data - this code doesn't know or care what a "helm wheel" or
// "sonar dial" is, only how to interpret drag_rotate/drag_linear/click in
// general. drag_h_pattern isn't wired up yet (see room_renderer.js header).
//
// Dragging is relative motion, not absolute position: grabbing a wheel
// doesn't snap it to whatever angle the click point happens to be at, and
// pulling outward for leverage before turning doesn't move it either - only
// the actual rotation/travel of the pointer changes the value, same as a
// real dial or lever, measured incrementally each frame so a full-circle
// (or repeated) drag on something like the sonar dial accumulates correctly
// instead of wrapping oddly.

function canvasToWorld(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
}

function currentStationIdForCanvas() {
  return viewMode === 'station' ? selectedStationId : null;
}

function findCurrentCanvasObject(objId) {
  return RoomRenderer.objectsFor(currentRoomEntry, currentStationIdForCanvas()).find((o) => o.id === objId) || null;
}

// A handful of actions need a SECOND fixed field alongside the control's own
// value - e.g. SET_TUBE_ARMED needs { tube: 0, armed: true|false }, where
// "armed" is the control's own payloadKey-driven value but "tube" is a
// constant baked into this specific object (obj.extraPayloadKey/Value,
// authored in the Sub Editor). Every payload this client ever sends goes
// through this, so a control needing one just needs those two fields filled
// in - no per-interaction-type special casing required.
function withExtraPayload(obj, payload) {
  if (!obj.extraPayloadKey) return payload;
  return { ...payload, [obj.extraPayloadKey]: obj.extraPayloadValue };
}

// Most server actions take { value: <number> }, but a few need a different
// JSON key (SET_GEAR wants { gear: ... }) - obj.payloadKey, authored in the
// Sub Editor (auto-filled there when Binding is set to a recognized
// action), names it when it isn't the default "value".
function sendDragValue(obj, t) {
  if (!obj.binding) return;
  sendInput(obj.binding, withExtraPayload(obj, { [obj.payloadKey || 'value']: RoomRenderer.computeGameValue(obj, t) }));
}

// A drag_h_pattern node's value isn't a t-interpolated number like
// drag_linear/drag_rotate - it's whatever discrete value that gate
// represents (e.g. "forward"/"neutral"/"reverse" for a gear shifter).
function sendHPatternValue(obj, node) {
  if (!obj.binding || !node) return;
  sendInput(obj.binding, withExtraPayload(obj, { [obj.payloadKey || 'value']: node.value }));
}

function rawPositionAlongPath(geom, world) {
  return geom.kind === 'rotate'
    ? (Math.atan2(world.y - geom.cy, world.x - geom.cx) * 180) / Math.PI
    : geom.axis === 'horizontal'
      ? world.x
      : world.y;
}

// x/y are already in room-canvas pixel space (canvasToWorld()'s own output)
// - normalized here to the 0..1 fraction the server's WELD_AT expects,
// against this same canvas's own width/height (960x540, the fixed design
// resolution every room is authored at - see simulation.gd's ROOM_WIDTH/
// ROOM_HEIGHT, which this has to keep meaning the same physical spot as).
function doWeld(canvas, x, y) {
  RoomRenderer.weldAt(x, y, currentRoomId);
  sendInput('WELD_AT', { x: x / canvas.width, y: y / canvas.height });
}

function onRoomCanvasPointerDown(event) {
  if (!currentRoomEntry || screenTransitioning) return;
  const canvas = event.currentTarget;
  // The welder takes priority over every other canvas interaction while
  // it's on, the same "tool use always wins" gesture-priority rule as a
  // swipe - painting over a station icon shouldn't accidentally open it.
  if (welderOn && viewMode === 'compartment') {
    canvasGestureClaimed = true;
    weldingSession = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      startTime: Date.now(),
    };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
    const world = canvasToWorld(canvas, event.clientX, event.clientY);
    doWeld(canvas, world.x, world.y);
    return;
  }
  const world = canvasToWorld(canvas, event.clientX, event.clientY);
  const hit = RoomRenderer.hitTestInteractive(
    currentRoomEntry, currentStationIdForCanvas(), world.x, world.y,
    lastGameState, activeDrag, lastKnownT, hPatternDragOverride, lastKnownHPatternNode,
  );
  // Tells the station-nav swipe layer (on #main-layout, an ancestor of this
  // canvas) whether this same pointerdown already grabbed a real control -
  // if so, it must not also register as a swipe gesture.
  canvasGestureClaimed = !!hit;
  if (!hit) return;
  event.preventDefault();

  if (hit.interaction === 'open_station') {
    if (hit.targetStationId) enterStation(hit.targetStationId);
    return;
  }
  if (hit.interaction === 'click') {
    // A toggle switch covers two different shapes of server action:
    // - two distinct trigger actions with no payload (e.g. START_ENGINE/
    //   STOP_ENGINE) - Binding and OFF Binding are different action names,
    //   payloadKey is unset, and {} is sent to whichever one fires.
    // - one action that just takes a boolean (e.g. SET_ELECTRIC_MOTOR's
    //   { active: bool }) - Binding and OFF Binding are the SAME action
    //   name, and payloadKey says which key carries the target state, so
    //   {[payloadKey]: !isOn} is sent instead of an empty payload (which
    //   would always read as false server-side and never actually turn it
    //   on).
    if (hit.toggleEnabled) {
      // No State Binding (or one that doesn't resolve to anything) means
      // there's no real server-tracked value for this switch at all - a
      // purely decorative toggle. isOn then comes from this client's own
      // memory of the last click instead, so the sprite can still flip;
      // see lastKnownToggleState above and resolveVisualState's own comment.
      const resolved = RoomRenderer.resolvePath(lastGameState, hit.toggleStateBinding);
      const isOn = resolved != null ? !!resolved : !!lastKnownToggleState[hit.id];
      const action = isOn ? hit.toggleOffBinding : hit.binding;
      const payload = withExtraPayload(hit, hit.payloadKey ? { [hit.payloadKey]: !isOn } : {});
      if (action) sendInput(action, payload);
      if (resolved == null) {
        lastKnownToggleState[hit.id] = !isOn;
        renderCurrentRoomCanvases();
      }
    } else if (hit.binding) {
      sendInput(hit.binding, withExtraPayload(hit, {}));
    }
    return;
  }
  if (hit.interaction === 'drag_linear' || hit.interaction === 'drag_rotate') {
    const geom = RoomRenderer.getSnapPathGeometry(hit);
    if (!geom) return;
    canvas.setPointerCapture(event.pointerId);
    const t = lastKnownT[hit.id] ?? RoomRenderer.inferRestingT(hit);
    dragSession = { objId: hit.id, geom, t, lastRaw: rawPositionAlongPath(geom, world) };
    activeDrag = { objId: hit.id, t };
    lastKnownT[hit.id] = t;
    renderCurrentRoomCanvases();
    sendDragValue(hit, t);
    return;
  }
  if (hit.interaction === 'drag_h_pattern') {
    if (!hit.hPatternNodes || !hit.hPatternNodes.length) return;
    canvas.setPointerCapture(event.pointerId);
    const restingNode = RoomRenderer.inferHPatternRestingNode(hit);
    const activeNodeId = lastKnownHPatternNode[hit.id] || (restingNode && restingNode.id);
    if (!activeNodeId) return;
    lastKnownHPatternNode[hit.id] = activeNodeId;
    const activeNode = hit.hPatternNodes.find((n) => n.id === activeNodeId) || restingNode;
    hPatternDragSession = { objId: hit.id, activeNodeId };
    hPatternDragOverride = { objId: hit.id, x: activeNode.x, y: activeNode.y };
    renderCurrentRoomCanvases();
  }
}

function onRoomCanvasPointerMove(event) {
  if (weldingSession && weldingSession.pointerId === event.pointerId) {
    const canvas = event.currentTarget;
    // A long, FAST drag overrides the weld and acts as a compartment swipe
    // instead - on touch, the welder otherwise eats every drag gesture and
    // there'd be no way left to navigate between compartments while it's on.
    // A normal weld stroke (holding the torch over/around a leak) is neither
    // long enough nor fast enough to ever trigger this by accident.
    const elapsed = Date.now() - weldingSession.startTime;
    if (elapsed <= WELD_SWIPE_MAX_MS) {
      const deltaX = event.clientX - weldingSession.startX;
      const deltaY = event.clientY - weldingSession.startY;
      if (resolveCompartmentSwipe(deltaX, deltaY)) {
        canvas.releasePointerCapture(event.pointerId);
        weldingSession = null;
        sendInput('STOP_WELDING', {});
        return;
      }
    }
    const world = canvasToWorld(canvas, event.clientX, event.clientY);
    doWeld(canvas, world.x, world.y);
    return;
  }
  if (hPatternDragSession) {
    const obj = findCurrentCanvasObject(hPatternDragSession.objId);
    if (!obj) {
      hPatternDragSession = null;
      hPatternDragOverride = null;
      return;
    }
    const world = canvasToWorld(event.currentTarget, event.clientX, event.clientY);
    const localX = world.x - obj.x;
    const localY = world.y - obj.y;
    const rail = RoomRenderer.projectHPatternRail(obj, hPatternDragSession.activeNodeId, localX, localY);
    if (!rail) return;
    hPatternDragOverride = { objId: obj.id, x: rail.x, y: rail.y };
    if (rail.snappedNodeId && rail.snappedNodeId !== hPatternDragSession.activeNodeId) {
      hPatternDragSession.activeNodeId = rail.snappedNodeId;
      lastKnownHPatternNode[obj.id] = rail.snappedNodeId;
      sendHPatternValue(obj, obj.hPatternNodes.find((n) => n.id === rail.snappedNodeId));
    }
    renderCurrentRoomCanvases();
    return;
  }

  if (!dragSession) return;
  const obj = findCurrentCanvasObject(dragSession.objId);
  if (!obj) {
    dragSession = null;
    activeDrag = null;
    return;
  }
  const world = canvasToWorld(event.currentTarget, event.clientX, event.clientY);
  const raw = rawPositionAlongPath(dragSession.geom, world);

  let deltaRaw = raw - dragSession.lastRaw;
  if (dragSession.geom.kind === 'rotate') {
    // Normalize to (-180, 180] so crossing the atan2 wraparound point
    // doesn't register as a huge jump in the wrong direction.
    while (deltaRaw > 180) deltaRaw -= 360;
    while (deltaRaw < -180) deltaRaw += 360;
  }
  const range = dragSession.geom.kind === 'rotate'
    ? dragSession.geom.rotMax - dragSession.geom.rotMin
    : dragSession.geom.travelMax - dragSession.geom.travelMin;
  const deltaT = range ? deltaRaw / range : 0;
  // dragInfinite (a compass-style dial with no end stops) leaves t
  // unclamped so it can spin through any number of full turns - every
  // downstream use (visual rotation, the value sent to the server) wraps
  // it via modulo instead. Every other drag control keeps its real [0,1]
  // end stops.
  const newT = obj.interaction === 'drag_rotate' && obj.dragInfinite
    ? dragSession.t + deltaT
    : Math.max(0, Math.min(1, dragSession.t + deltaT));

  dragSession.t = newT;
  dragSession.lastRaw = raw;
  lastKnownT[obj.id] = newT;
  activeDrag = { objId: obj.id, t: newT };
  renderCurrentRoomCanvases();
  sendDragValue(obj, newT);
}

function onRoomCanvasPointerUp() {
  if (weldingSession) {
    weldingSession = null;
    sendInput('STOP_WELDING', {});
  }
  // Releasing while not yet within a neighbor's 10% snap zone leaves
  // hPatternDragSession's activeNodeId (and lastKnownHPatternNode) exactly
  // where they were - clearing the live rail override here just snaps the
  // rendered handle back to that node's exact position, same as letting go
  // of a real shift lever before it reaches the next gate.
  if (!dragSession && !activeDrag && !hPatternDragSession && !hPatternDragOverride) return;
  // dragSpringToCenter: a steering-wheel/joystick-style control snaps back
  // to its exact center (t=0.5 - the midpoint of Min/Max, e.g. 0 for a
  // -1..1 range) the instant it's released, rather than staying wherever it
  // was let go - the server's own continuous per-tick integration (see
  // SET_PERISCOPE_TURN) is what keeps the value "held" while dragged, so
  // releasing has to actively send a real zero, not just stop sending.
  if (dragSession) {
    const obj = findCurrentCanvasObject(dragSession.objId);
    if (obj && obj.dragSpringToCenter) {
      lastKnownT[obj.id] = 0.5;
      sendDragValue(obj, 0.5);
    }
  }
  dragSession = null;
  activeDrag = null;
  hPatternDragSession = null;
  hPatternDragOverride = null;
  renderCurrentRoomCanvases();
}

// --- Scope zoom/pan gestures ----------------------------------------------
//
// A scope object (e.g. the nav map) has interaction: 'none', so it never
// shows up in onRoomCanvasPointerDown's own hit-test - these are entirely
// separate listeners on the same canvas. canvasGestureClaimed (set by
// onRoomCanvasPointerDown on every pointerdown, whether or not it found
// something) keeps this layer from also reacting when the same touch
// actually grabbed a real control.

function onScopeWheel(event) {
  if (!currentRoomEntry) return;
  const world = canvasToWorld(roomCanvasEl, event.clientX, event.clientY);
  const hit = RoomRenderer.hitTestScope(currentRoomEntry, currentStationIdForCanvas(), world.x, world.y);
  if (!hit) return;
  event.preventDefault();
  const factor = Math.exp(-event.deltaY * 0.001);
  const current = scopeZoom[hit.id] ?? 1;
  scopeZoom[hit.id] = Math.max(0.25, Math.min(4, current * factor));
  renderCurrentRoomCanvases();
}

function onScopePointerDown(event) {
  if (!currentRoomEntry || canvasGestureClaimed || screenTransitioning) return;
  const world = canvasToWorld(roomCanvasEl, event.clientX, event.clientY);
  const hit = RoomRenderer.hitTestScope(currentRoomEntry, currentStationIdForCanvas(), world.x, world.y);
  if (!hit) return;
  // A scope (e.g. the nav map) can take up most of the canvas - a swipe
  // has to start outside its bounds to count as compartment/station
  // navigation, or panning/zooming the map would also trigger a
  // compartment change or station leave/cycle underneath it. Claiming the
  // gesture here (same flag onRoomCanvasPointerDown sets for an actual
  // control) reaches onViewportPointerDown/onMainLayoutPointerDown when
  // this event bubbles up to #main-layout right after this.
  canvasGestureClaimed = true;
  scopePinchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (scopePinchPointers.size === 2) {
    const pts = [...scopePinchPointers.values()];
    scopePinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    scopePinchObjId = hit.id;
    scopePinchStartZoom = scopeZoom[hit.id] ?? 1;
    scopeDragSession = null; // a second finger landing takes over from a single-finger pan
  } else if (scopePinchPointers.size === 1) {
    scopeDragSession = {
      objId: hit.id,
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startPan: { ...(scopePan[hit.id] || { x: 0, y: 0 }) },
    };
  }
}

function onScopePointerMove(event) {
  if (scopePinchPointers.has(event.pointerId)) {
    scopePinchPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  }
  if (scopePinchPointers.size === 2 && scopePinchStartDist) {
    const pts = [...scopePinchPointers.values()];
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    const factor = dist / scopePinchStartDist;
    scopeZoom[scopePinchObjId] = Math.max(0.25, Math.min(4, scopePinchStartZoom * factor));
    renderCurrentRoomCanvases();
    return;
  }
  if (scopeDragSession && scopeDragSession.pointerId === event.pointerId) {
    const obj = findCurrentCanvasObject(scopeDragSession.objId);
    if (!obj) {
      scopeDragSession = null;
      return;
    }
    const zoom = scopeZoom[obj.id] ?? 1;
    const range = (obj.navMapRange ?? 300) / zoom;
    const halfW = (obj.width * (obj.scaleX ?? 1) / 2) * (obj.scopeFillFraction ?? 0.95);
    const scale = halfW / range;
    const rect = roomCanvasEl.getBoundingClientRect();
    const canvasScaleX = roomCanvasEl.width / rect.width;
    const canvasScaleY = roomCanvasEl.height / rect.height;
    const dxWorld = ((event.clientX - scopeDragSession.startClientX) * canvasScaleX) / scale;
    const dyWorld = ((event.clientY - scopeDragSession.startClientY) * canvasScaleY) / scale;
    // The map displays north-up (see room_renderer.js's worldToScreenOffset:
    // screenX = worldY, screenY = -worldX) rather than the simulation's raw
    // world axes, so a screen-space drag maps to pan axes swapped the same
    // way: dragging right shifts world Y, dragging down shifts world X
    // (negated) - not a straight dx->x, dy->y correspondence.
    scopePan[obj.id] = {
      x: scopeDragSession.startPan.x + dyWorld,
      y: scopeDragSession.startPan.y - dxWorld,
    };
    renderCurrentRoomCanvases();
  }
}

function onScopePointerUp(event) {
  scopePinchPointers.delete(event.pointerId);
  if (scopePinchPointers.size < 2) {
    scopePinchStartDist = null;
    scopePinchObjId = null;
  }
  if (scopeDragSession && scopeDragSession.pointerId === event.pointerId) scopeDragSession = null;
}

// document.getElementById directly, not el() - el() isn't defined until
// further down the script and this runs immediately as the script loads.
const roomCanvasEl = document.getElementById('room-canvas');
roomCanvasEl.addEventListener('pointerdown', onRoomCanvasPointerDown);
roomCanvasEl.addEventListener('pointermove', onRoomCanvasPointerMove);
roomCanvasEl.addEventListener('pointerup', onRoomCanvasPointerUp);
roomCanvasEl.addEventListener('wheel', onScopeWheel, { passive: false });
roomCanvasEl.addEventListener('pointerdown', onScopePointerDown);
roomCanvasEl.addEventListener('pointermove', onScopePointerMove);
roomCanvasEl.addEventListener('pointerup', onScopePointerUp);
roomCanvasEl.addEventListener('pointercancel', onScopePointerUp);
roomCanvasEl.addEventListener('pointercancel', onRoomCanvasPointerUp);

const el = (id) => document.getElementById(id);

function setStatus(text) {
  el('connection-status').textContent = text;
}

function connect() {
  const address = el('server-address').value.trim();
  if (!address) return;
  if (socket) {
    socket.close();
  }
  setStatus('CONNECTING');
  socket = new WebSocket(`ws://${address}`);

  socket.addEventListener('open', () => setStatus('CONNECTED'));
  socket.addEventListener('close', () => setStatus('DISCONNECTED'));
  socket.addEventListener('error', () => setStatus('ERROR'));
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'state') {
      // Deliberately NOT applied here - see renderLoop() below. The server
      // broadcasts state 60 times/sec; a device whose render (canvas redraw
      // + DOM text updates) takes longer than 1/60 sec per frame would
      // otherwise fall behind and then dutifully work through an
      // ever-growing backlog of stale messages IN ORDER, since there's
      // nothing here to skip ahead - that's exactly what produced the
      // "own input takes 20 seconds to show up, and it keeps getting worse"
      // symptom on a weaker tablet: every historical frame still got
      // rendered before the next, instead of jumping straight to current.
      pendingStateMessage = message;
    } else {
      handleMessage(message);
    }
  });
}

// Runs at whatever rate this device's own display can actually sustain
// (requestAnimationFrame throttles itself to real monitor/compositor
// capability, unlike a raw setInterval) - always renders the LATEST
// broadcast received since the last frame, discarding any older ones that
// arrived in between rather than rendering through all of them. A fast
// device effectively renders every tick anyway (60fps loop, 60Hz broadcast);
// a slow one just renders fewer frames, each one current, instead of
// accumulating lag.
let pendingStateMessage = null;
function renderLoop() {
  if (pendingStateMessage) {
    const message = pendingStateMessage;
    pendingStateMessage = null;
    applyState(message);
  }
  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);

function handleMessage(message) {
  if (message.type === 'welcome') {
    myPlayerId = message.player_id;
    myPlayerNumber = parseInt(message.player_id.split('_')[1], 10);
    compartmentLayout = message.layout;
    myCompartment = message.start_compartment;
    el('player-id').textContent = myPlayerId;
    // Only the scope-math constants are taken from the server here - gyro/
    // spread rail range is fixed client-side to match the server's export
    // defaults (see tdcConfig below) so the two lever controls can be
    // created eagerly, like every other lever, instead of only after the
    // first server round-trip.
    tdcConfig.tubeCount = message.torpedo_tube_count ?? tdcConfig.tubeCount;
    tdcConfig.torpedoSpeed = message.torpedo_speed ?? tdcConfig.torpedoSpeed;
    tdcConfig.torpedoTurnRate = message.torpedo_turn_rate ?? tdcConfig.torpedoTurnRate;
    tdcConfig.torpedoMaxLifetimeTicks = message.torpedo_max_lifetime_ticks ?? tdcConfig.torpedoMaxLifetimeTicks;
    tdcConfig.torpedoGyroActivationDistance = message.torpedo_gyro_activation_distance ?? tdcConfig.torpedoGyroActivationDistance;
  } else if (message.type === 'state') {
    applyState(message);
  }
}

// Data layer: parse the authoritative state into module state + drive each
// presentation function. Keep this split so update*UI() functions can later
// be swapped for sprite/canvas rendering without touching how state is read.
function applyState(message) {
  const data = message.data;
  lastGameState = data;

  // tick only ever counts up during a normal run - a DECREASE means the
  // server actually reset (RESET_GAME), which every client sees this way
  // regardless of who clicked the button, unlike the optimistic clear in
  // resetGame() itself (which only fires for the clicker).
  if (message.tick < lastServerTick) {
    RoomRenderer.clearWelds();
    lastLeakCount = 0; // a fresh run's own leak count, not a "leaks just dropped" reading
  }
  lastServerTick = message.tick;

  // A leak only ever appears from a fresh hit (never welding, which only
  // ever REMOVES one) - so a rising count is a reliable "we just took a hit"
  // signal without the server needing a dedicated one-shot event field.
  if (data.active_leaks > lastLeakCount) {
    triggerCameraShake();
  }
  lastLeakCount = data.active_leaks;

  el('server-tick').textContent = message.tick;
  el('speed').textContent = data.speed.toFixed(2);
  el('heading').textContent = `${data.heading.toFixed(0)}°`;
  el('depth').textContent = data.depth.toFixed(1);
  el('o2').textContent = `${data.o2.toFixed(1)}%`;
  el('flooding').textContent = `${data.flooding.toFixed(1)}%`;
  el('active-leaks').textContent = data.active_leaks;

  el('game-over-banner').hidden = !data.sunk;
  el('victory-banner').hidden = !data.won;
  el('cargo-sunk').textContent = `${data.cargo_sunk} cargo, ${data.destroyers_sunk} destroyer`;
  el('returned-banner').hidden = !data.returned;
  el('returned-summary').textContent = `Sunk ${data.cargo_sunk} cargo and ${data.destroyers_sunk} destroyers`;
  let portStatus = `${Math.round(data.port_distance)} u`;
  if (!data.left_port) portStatus += ' (in harbor)';
  else if (data.dock_progress > 0) portStatus += ` - docking ${Math.round(data.dock_progress * 100)}%`;
  el('port-status').textContent = portStatus;

  const invulnBtn = el('invulnerable-btn');
  invulnBtn.textContent = `Invulnerable: ${data.invulnerable ? 'ON' : 'OFF'}`;
  invulnBtn.dataset.state = data.invulnerable ? 'on' : 'off';

  const ignoreOverheatBtn = el('ignore-overheat-btn');
  ignoreOverheatBtn.textContent = `Ignore Overheat/Efficiency: ${data.ignore_overheat_effects ? 'ON' : 'OFF'}`;
  ignoreOverheatBtn.dataset.state = data.ignore_overheat_effects ? 'on' : 'off';

  const unlimitedSuppliesBtn = el('unlimited-supplies-btn');
  unlimitedSuppliesBtn.textContent = `Unlimited Supplies: ${data.unlimited_supplies ? 'ON' : 'OFF'}`;
  unlimitedSuppliesBtn.dataset.state = data.unlimited_supplies ? 'on' : 'off';

  const ignoreGameOverBtn = el('ignore-game-over-btn');
  ignoreGameOverBtn.textContent = `Ignore Game Over: ${data.ignore_game_over ? 'ON' : 'OFF'}`;
  ignoreGameOverBtn.dataset.state = data.ignore_game_over ? 'on' : 'off';

  stationsState = data.stations;
  playersState = data.players;
  toolsState = data.tools;

  if (myPlayerNumber !== null && playersState[myPlayerNumber]) {
    myCompartment = playersState[myPlayerNumber].compartment;
  }
  loadCurrentRoom();

  enforceStationSafetyNet();
  updateCompartmentUI();
  updateToolRackUI();
  updateSonarUI(data.sonar);
  updateTorpedoUI(data.tdc, data.torpedo_tubes);
  updateTdcScope(data.tdc, data.torpedo_tubes);
  updateEngineRoomUI(data.engine);
  updateMapUI(data.map);

  helmLever.onState(data.rudder);
  diveLever.onState(data.dive_planes);
  el('helm-readout').textContent = `Rudder: ${data.rudder.toFixed(2)}`;
  el('dive-readout').textContent = `Planes: ${data.dive_planes.toFixed(2)}`;
  updateLeverStatusLine('helm-station-status', 'station_helm', 'Helm');
  updateLeverStatusLine('dive-station-status', 'station_dive', 'Dive');

  engineOrderLever.onState(data.engine_order);
  el('engine-order-readout').textContent = `Value: ${data.engine_order.toFixed(2)}`;

  sonarLever.onState(data.sonar_dial);
  el('sonar-dial-readout').textContent = `Dial: ${data.sonar_dial.toFixed(0)}°`;
  updateLeverStatusLine('sonar-station-status', 'station_sonar', 'Sonar');

  if (data.tdc) {
    gyroLever.onState(data.tdc.gyro_angle);
    spreadLever.onState(data.tdc.spread_angle);
  }

  renderCurrentRoomCanvases(); // every tick, so output-bound gauges/needles/states animate live
}

function sendInput(action, data) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  sequence += 1;
  socket.send(JSON.stringify({ type: 'input', sequence: sequence, action: action, data: data }));
}

function stationOccupant(stationId) {
  return stationsState[stationId] ? stationsState[stationId].occupant : -1;
}

function isRealStation(stationId) {
  return !!stationsState[stationId];
}

// --- Compartment / station navigation ---------------------------------------
//
// Per Master Design Doc Rev1 §6-7: a compartment is a room you look around;
// a station is a specific workstation with its own dedicated UI, entered by
// selecting it (which claims occupancy) and left via an explicit action
// (which releases it). Tools are the documented exception - used directly
// from the compartment view, never requiring a station.

function stationsForCurrentCompartment() {
  return STATIONS_BY_COMPARTMENT[myCompartment] || [];
}

function stationLabel(stationId) {
  for (const list of Object.values(STATIONS_BY_COMPARTMENT)) {
    const found = list.find((s) => s.id === stationId);
    if (found) return found.label;
  }
  return stationId;
}

// A quick directional slide+fade, played on the two panels that make up
// "the screen" (the debug viewport and the room canvas, siblings in the
// DOM) for both compartment changes and station changes - before
// applyChange() actually swaps the underlying content. applyChange runs
// mid-transition (content changes while off-screen/faded, same trick most
// mobile app screen transitions use) so the visible result reads as one
// continuous swipe rather than a cut.
const SCREEN_ANIM_MS = 180;

// True for the ENTIRE slide-out + slide-in round trip (~2x SCREEN_ANIM_MS),
// not just the setTimeout below - #viewport/#room-canvas-panel are CSS-
// transformed (translateX/Y) for that whole time, via a real `transition:
// transform 0.18s ease` on each, and canvasToWorld() (used by every canvas
// click/drag hit-test) reads getBoundingClientRect(), which reports
// wherever that transform CURRENTLY has the element, not its resting
// position. A tap on a station icon that lands mid-transition (very easy to
// do - swipe/arrow into a compartment, then immediately tap the station
// that's right there) was computing world coordinates against that
// transiently-offset rect and missing the icon entirely; a second tap,
// after everything has settled, always worked. Canvas pointerdown handlers
// check this and simply ignore input until it clears, rather than
// hit-testing against a rect that's still moving.
let screenTransitioning = false;

function animateScreenTransition(direction, applyChange) {
  screenTransitioning = true;
  const targets = [el('viewport'), el('room-canvas-panel')];
  const outClass = `station-slide-${direction}`;
  targets.forEach((t) => t.classList.add(outClass));
  setTimeout(() => {
    applyChange();
    const inClass = direction === 'left' ? 'station-slide-right'
      : direction === 'right' ? 'station-slide-left'
        : direction === 'up' ? 'station-slide-down'
          : direction === 'down' ? 'station-slide-up'
            : null;
    targets.forEach((t) => {
      t.classList.remove(outClass);
      if (inClass) {
        t.classList.add(inClass);
        void t.offsetWidth; // force a reflow so the browser registers the "entering from the opposite edge" position before it's transitioned away from
        requestAnimationFrame(() => t.classList.remove(inClass));
      }
    });
    // Removing inClass just above starts its own 0.18s transition back to
    // the resting transform - the rect isn't trustworthy again until that
    // finishes too, not just once this callback runs.
    setTimeout(() => { screenTransitioning = false; }, SCREEN_ANIM_MS);
  }, SCREEN_ANIM_MS);
}

// How long enforceStationSafetyNet() tolerates NOT yet seeing ourselves as a
// real station's occupant right after we just asked to be - the server's
// very next broadcast is often already in flight (generated before it even
// received our REQUEST_STATION), so it still shows the OLD occupancy for at
// least one tick. Without this grace period, that stale broadcast looks
// identical to "someone else has it" and the safety net bounces us straight
// back to compartment view an instant after entering - the animation plays,
// but it never actually sticks, and only a second click (issued once the
// server has caught up) ever works. See enforceStationSafetyNet().
const STATION_REQUEST_GRACE_MS = 500;
let lastStationRequestMs = 0;

// animDirection defaults to 'up' (a fresh entry from the compartment view,
// with no swipe direction of its own to match) - cycleStation() passes
// 'left'/'right' instead, matching whichever way was actually swiped.
function enterStation(stationId, animDirection = 'up') {
  if (viewMode === 'station' && selectedStationId === stationId) return;
  // Occupancy is checked up front, before playing any animation - entry
  // failing because someone else has the station shouldn't still slide the
  // screen away and back for nothing.
  if (isRealStation(stationId)) {
    const occupant = stationOccupant(stationId);
    if (occupant !== -1 && occupant !== myPlayerNumber) return; // someone else has it
  }
  animateScreenTransition(animDirection, () => {
    // Release whatever station we're already occupying first - needed now
    // that cycleStation() can call straight into a different station
    // without going through leaveStation(), which would otherwise leave
    // the old one stuck occupied server-side.
    if (viewMode === 'station' && selectedStationId && isRealStation(selectedStationId) && stationOccupant(selectedStationId) === myPlayerNumber) {
      sendInput('RELEASE_STATION', { station_id: selectedStationId });
    }
    if (isRealStation(stationId)) {
      sendInput('REQUEST_STATION', { station_id: stationId });
      lastStationRequestMs = Date.now();
    }
    viewMode = 'station';
    selectedStationId = stationId;
    refreshViewVisibility();
    renderCurrentRoomCanvases();
  });
}

// Swipe left/right (or arrow keys) while at a station cycles to another
// station in the same compartment - but only to one that's actually free
// (or the shared Navigation Map, which has no exclusive occupant); it never
// bumps another player off their station. Silently does nothing if every
// other station in the compartment is taken.
function cycleStation(direction) {
  const stations = stationsForCurrentCompartment();
  if (stations.length < 2) return;
  const currentIndex = stations.findIndex((s) => s.id === selectedStationId);
  if (currentIndex === -1) return;
  const n = stations.length;
  for (let step = 1; step < n; step += 1) {
    const candidate = stations[(currentIndex + direction * step + n) % n];
    const occupant = stationOccupant(candidate.id);
    if (occupant === -1 || occupant === myPlayerNumber) {
      enterStation(candidate.id, direction > 0 ? 'left' : 'right');
      return;
    }
  }
}

function leaveStation() {
  if (viewMode !== 'station' || !selectedStationId) return;
  animateScreenTransition('down', () => {
    if (isRealStation(selectedStationId) && stationOccupant(selectedStationId) === myPlayerNumber) {
      sendInput('RELEASE_STATION', { station_id: selectedStationId });
    }
    viewMode = 'compartment';
    selectedStationId = null;
    refreshViewVisibility();
    renderCurrentRoomCanvases();
  });
}

// Guards against desync: if we think we're at a station but the server no
// longer shows us as its occupant (e.g. it got cleared by some other path),
// or the station doesn't belong to our current compartment, bounce back to
// the compartment view rather than showing a stale/broken station screen.
function enforceStationSafetyNet() {
  if (viewMode !== 'station' || !selectedStationId) return;
  const validHere = stationsForCurrentCompartment().some((s) => s.id === selectedStationId);
  let bounced = false;
  if (!validHere) {
    viewMode = 'compartment';
    selectedStationId = null;
    bounced = true;
  } else if (
    isRealStation(selectedStationId)
    && stationOccupant(selectedStationId) !== myPlayerNumber
    && Date.now() - lastStationRequestMs > STATION_REQUEST_GRACE_MS
  ) {
    viewMode = 'compartment';
    selectedStationId = null;
    bounced = true;
  }
  if (bounced) renderCurrentRoomCanvases();
}

function refreshViewVisibility() {
  el('compartment-view').hidden = viewMode !== 'compartment';
  document.querySelectorAll('.station-view').forEach((view) => {
    view.hidden = !(viewMode === 'station' && view.dataset.station === selectedStationId);
  });
  el('welder-toggle-btn').hidden = viewMode !== 'compartment';
  // Leaving the compartment view (or the room canvas losing the drag
  // entirely) while a torch stroke is in progress would otherwise leave the
  // server thinking that spot is still being welded forever.
  if (viewMode !== 'compartment' && weldingSession) {
    weldingSession = null;
    sendInput('STOP_WELDING', {});
  }
}

let lastStationListSignature = null;

function updateCompartmentUI() {
  refreshViewVisibility();

  el('compartment-name').textContent = `Compartment: ${myCompartment}`;

  const others = Object.entries(playersState)
    .filter(([id]) => parseInt(id, 10) !== myPlayerNumber)
    .filter(([, p]) => p.compartment === myCompartment)
    .map(([id, p]) => {
      const atStation = Object.entries(stationsState).find(([, s]) => s.occupant === parseInt(id, 10));
      const parts = [];
      if (atStation) parts.push(`at ${stationLabel(atStation[0])}`);
      if (p.equipped_tool) parts.push(`holding ${p.equipped_tool}`);
      return `player_${id}${parts.length ? ' (' + parts.join(', ') + ')' : ''}`;
    });

  el('players-here').textContent = others.length
    ? `Players here: ${others.join(', ')}`
    : 'Players here: (just you)';

  const stations = stationsForCurrentCompartment();
  const signature = `${myCompartment}|${stations.map((s) => `${s.id}:${stationOccupant(s.id)}`).join(',')}`;
  if (signature === lastStationListSignature) return;
  lastStationListSignature = signature;

  const listEl = el('station-list');
  listEl.innerHTML = '';
  for (const station of stations) {
    const occupant = station.real ? stationOccupant(station.id) : -1;
    const row = document.createElement('div');
    row.className = 'tool-row';
    const label = document.createElement('span');
    if (occupant === -1) {
      label.textContent = `${station.label} (free)`;
    } else if (occupant === myPlayerNumber) {
      label.textContent = `${station.label} (you)`;
    } else {
      label.textContent = `${station.label} (player_${occupant})`;
    }
    const button = document.createElement('button');
    button.textContent = 'Enter';
    button.disabled = occupant !== -1 && occupant !== myPlayerNumber;
    button.addEventListener('click', () => enterStation(station.id));
    row.appendChild(label);
    row.appendChild(button);
    listEl.appendChild(row);
  }
}

document.querySelectorAll('.leave-station-btn').forEach((btn) => {
  btn.addEventListener('click', leaveStation);
});

// --- Generic lever control (vertical or horizontal drag) -------------------
//
// Occupancy is claimed/released by entering/leaving the station (above), not
// by the drag gesture itself - a lever only ever appears inside a station
// view you're already occupying.

function createLever({ prefix, stationId, action, min, max, orientation = 'vertical' }) {
  const railEl = () => el(`${prefix}-rail`);
  const handleEl = () => el(`${prefix}-handle`);
  let dragging = false;
  let lastValue = min;

  function clampValue(x) {
    return Math.max(min, Math.min(max, x));
  }

  function fractionFromEvent(event) {
    const rect = railEl().getBoundingClientRect();
    if (orientation === 'horizontal') {
      return Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    }
    return Math.max(0, Math.min(1, 1 - (event.clientY - rect.top) / rect.height));
  }

  function valueFromEvent(event) {
    return clampValue(min + fractionFromEvent(event) * (max - min));
  }

  function setPosition(value) {
    const fraction = Math.max(0, Math.min(1, (clampValue(value) - min) / (max - min)));
    if (orientation === 'horizontal') {
      const railWidth = railEl().clientWidth;
      const handleWidth = handleEl().clientWidth;
      handleEl().style.left = `${fraction * (railWidth - handleWidth)}px`;
    } else {
      const railHeight = railEl().clientHeight;
      const handleHeight = handleEl().clientHeight;
      handleEl().style.top = `${(1 - fraction) * (railHeight - handleHeight)}px`;
    }
  }

  function canOperate() {
    const occupant = stationOccupant(stationId);
    return occupant === -1 || occupant === myPlayerNumber;
  }

  function onDragStart(event) {
    if (!canOperate()) return;
    dragging = true;
    railEl().setPointerCapture(event.pointerId);
    const value = valueFromEvent(event);
    setPosition(value);
    sendInput(action, { value: value });
  }

  function onDragMove(event) {
    if (!dragging) return;
    const value = valueFromEvent(event);
    setPosition(value);
    sendInput(action, { value: value });
  }

  function onDragEnd() {
    dragging = false;
  }

  railEl().addEventListener('pointerdown', onDragStart);
  railEl().addEventListener('pointermove', onDragMove);
  railEl().addEventListener('pointerup', onDragEnd);
  railEl().addEventListener('pointercancel', onDragEnd);

  return {
    onState(value) {
      lastValue = value;
      if (!dragging) setPosition(value);
    },
    reposition() {
      if (!dragging) setPosition(lastValue);
    },
  };
}

const engineOrderLever = createLever({ prefix: 'engine', stationId: 'station_helm', action: 'SET_ENGINE_ORDER', min: 0, max: 1 });
const helmLever = createLever({ prefix: 'helm', stationId: 'station_helm', action: 'SET_RUDDER', min: -1, max: 1 });
const diveLever = createLever({ prefix: 'dive', stationId: 'station_dive', action: 'SET_DIVE_PLANES', min: -1, max: 1 });
const sonarLever = createLever({ prefix: 'sonar', stationId: 'station_sonar', action: 'SET_SONAR_DIAL', min: 0, max: 360, orientation: 'horizontal' });
const throttleLever = createLever({ prefix: 'throttle', stationId: 'station_engine_controls', action: 'SET_THROTTLE', min: 0, max: 1 });
const coolantLever = createLever({ prefix: 'coolant', stationId: 'station_engine_controls', action: 'SET_COOLANT_FLOW', min: 0, max: 1 });

// Mirrors the server's own @export defaults (see simulation.gd's "Torpedo"
// group) so the gyro/spread rails can be created eagerly like every other
// lever above; torpedoSpeed/torpedoTurnRate/torpedoMaxLifetimeTicks are only
// used for the TDC scope's predicted-path drawing and get overwritten with
// the server's real, possibly-retuned values as soon as it connects (see the
// 'welcome' handler above).
let tdcConfig = {
  gyroLimit: 90,
  spreadLimit: 45,
  tubeCount: 4,
  torpedoSpeed: 20,
  torpedoTurnRate: 45,
  torpedoMaxLifetimeTicks: 600,
  torpedoGyroActivationDistance: 50,
};
const gyroLever = createLever({ prefix: 'gyro', stationId: 'torpedo_tube', action: 'SET_TDC_GYRO', min: -tdcConfig.gyroLimit, max: tdcConfig.gyroLimit, orientation: 'horizontal' });
const spreadLever = createLever({ prefix: 'spread', stationId: 'torpedo_tube', action: 'SET_TDC_SPREAD', min: 0, max: tdcConfig.spreadLimit, orientation: 'horizontal' });

function updateLeverStatusLine(elementId, stationId, label) {
  const occupant = stationOccupant(stationId);
  const statusEl = el(elementId);
  if (occupant === -1) {
    statusEl.textContent = `${label}: FREE`;
  } else if (occupant === myPlayerNumber) {
    statusEl.textContent = `${label}: YOU HAVE CONTROL`;
  } else {
    statusEl.textContent = `${label}: player_${occupant}`;
  }
}

// --- Generic hold-to-operate button (used within a station you occupy) ----

function createHoldButton({ buttonId, action, activeKey }) {
  const button = () => el(buttonId);
  let active = false;

  function onDown(event) {
    active = true;
    event.preventDefault();
    sendInput(action, { [activeKey]: true });
  }

  function onUp() {
    if (!active) return;
    active = false;
    sendInput(action, { [activeKey]: false });
  }

  button().addEventListener('pointerdown', onDown);
  button().addEventListener('pointerup', onUp);
  button().addEventListener('pointercancel', onUp);
  button().addEventListener('pointerleave', onUp);
}

createHoldButton({ buttonId: 'tune-btn', action: 'SET_TUNING', activeKey: 'active' });

// The welder is a plain on/off mode toggle (not a hold-button, and not tied
// to the pickup/equip tool system) - while on, dragging on the room canvas
// in compartment view paints and reports weld position; see
// onRoomCanvasPointerDown/Move/Up.
el('welder-toggle-btn').addEventListener('click', () => {
  welderOn = !welderOn;
  el('welder-toggle-btn').textContent = `Welder: ${welderOn ? 'ON' : 'OFF'}`;
  el('welder-toggle-btn').classList.toggle('active', welderOn);
  if (!welderOn && weldingSession) {
    weldingSession = null;
    sendInput('STOP_WELDING', {});
  }
});

// --- Sonar -----------------------------------------------------------------

function updateSonarUI(sonar) {
  const readout = el('sonar-readout');
  if (!sonar || !sonar.contact) {
    readout.textContent = 'No contact - sweep the dial to find one';
  } else {
    readout.textContent =
      `Contact: true ${sonar.bearing_true.toFixed(0)}° / relative ${sonar.bearing_relative.toFixed(0)}°, distance ${sonar.distance.toFixed(0)}m`;
  }
}

// --- Torpedo Data Computer ---------------------------------------------------
//
// Tube arming is a separate step from firing: arming a loaded tube marks it
// to launch on the next FIRE press, so a spread is built up by arming
// several tubes first, then firing them together - see SET_TUBE_ARMED /
// FIRE_TORPEDO in simulation.gd. The tube buttons are created once and their
// text/state updated in place every tick, rather than rebuilt from scratch,
// since the tube count itself never changes mid-game.

let tubeButtonsBuilt = false;

// Each tube gets its own indicator light above its arm toggle - a dedicated
// sprite/color per state (dull dark green = empty/reloading, bright green =
// loaded, bright red = armed) rather than relying on the toggle button's own
// text/color alone, so tube status reads at a glance.
function ensureTubeButtons(tubeCount) {
  if (tubeButtonsBuilt) return;
  const container = el('tube-list');
  container.innerHTML = '';
  for (let i = 0; i < tubeCount; i += 1) {
    const block = document.createElement('div');
    block.className = 'tube-block';

    const light = document.createElement('div');
    light.className = 'tube-light';

    const btn = document.createElement('button');
    btn.className = 'tube-btn interactive';
    btn.addEventListener('click', () => {
      const armed = btn.dataset.armed === 'true';
      const loaded = btn.dataset.loaded === 'true';
      if (!loaded && !armed) return; // reloading - nothing to toggle yet
      sendInput('SET_TUBE_ARMED', { tube: i, armed: !armed });
    });

    block.appendChild(light);
    block.appendChild(btn);
    container.appendChild(block);
  }
  tubeButtonsBuilt = true;
}

function updateTorpedoUI(tdc, tubes) {
  if (!tdc || !tubes) return;

  ensureTubeButtons(tubes.length);
  const container = el('tube-list');
  tubes.forEach((tube, i) => {
    const block = container.children[i];
    if (!block) return;
    const light = block.children[0];
    const btn = block.children[1];
    btn.dataset.loaded = String(tube.loaded);
    btn.dataset.armed = String(tube.armed);
    btn.disabled = !tube.loaded && !tube.armed;
    btn.classList.toggle('armed', tube.armed);

    const lightState = tube.armed ? 'armed' : (tube.loaded ? 'loaded' : 'empty');
    light.classList.remove('empty', 'loaded', 'armed');
    light.classList.add(lightState);

    if (tube.armed) {
      btn.textContent = `Tube ${i + 1}: ARMED`;
    } else if (tube.loaded) {
      btn.textContent = `Tube ${i + 1}: LOADED`;
    } else {
      btn.textContent = `Tube ${i + 1}: RELOAD ${Math.round(tube.reload_fraction * 100)}%`;
    }
  });

  const gyro = tdc.gyro_angle;
  const gyroLabel = gyro === 0 ? '0°' : `${Math.abs(gyro).toFixed(0)}° ${gyro < 0 ? 'PORT' : 'STBD'}`;
  el('gyro-readout').textContent = `Gyro: ${gyroLabel}`;
  el('spread-readout').textContent = `Spread: ${tdc.spread_angle.toFixed(0)}°`;

  const armedCount = tubes.filter((t) => t.armed).length;
  el('torpedo-status').textContent = armedCount > 0
    ? `${armedCount} tube${armedCount === 1 ? '' : 's'} armed - ready to fire`
    : 'No tubes armed';
  el('fire-torpedo-btn').disabled = armedCount === 0;
}

el('fire-torpedo-btn').addEventListener('click', () => sendInput('FIRE_TORPEDO', {}));

// TDC scope: circular, matching the sonar scope's own look (#06121a fill,
// #1c3040 range rings) - a ship-relative (not compass) plot with the sub
// icon fixed at the center and "up" = dead ahead. Each tube's track is
// simulated point-by-point using the same straight-then-turn model as the
// server's own _step_torpedoes() (see torpedo_gyro_activation_distance), so
// the drawn curve is an accurate preview of where that torpedo will
// actually go - including exactly how far out its gyro engages - not just a
// straight line at the aimed angle.
function drawPredictedTrack(ctx, originX, originY, scale, maxRange, offsetDegrees, armed) {
  const turnRate = tdcConfig.torpedoTurnRate;
  const speed = tdcConfig.torpedoSpeed;
  const activationDistance = tdcConfig.torpedoGyroActivationDistance;
  const turnDir = offsetDegrees >= 0 ? 1 : -1;
  const absOffset = Math.abs(offsetDegrees);

  let traveled = 0;
  let headingDeg = 0;
  let relX = 0;
  let relY = 0;

  ctx.beginPath();
  ctx.moveTo(originX, originY);

  const stepDist = 2; // world units per sample
  while (traveled < maxRange) {
    const stepTime = stepDist / speed;
    if (traveled >= activationDistance) {
      const remainingTurn = Math.max(0, absOffset - Math.abs(headingDeg));
      headingDeg += turnDir * Math.min(turnRate * stepTime, remainingTurn);
    }
    const headingRad = (headingDeg * Math.PI) / 180;
    relX += Math.sin(headingRad) * stepDist;
    relY += Math.cos(headingRad) * stepDist;
    traveled += stepDist;
    ctx.lineTo(originX + relX * scale, originY - relY * scale);
  }

  ctx.strokeStyle = armed ? '#4caf50' : '#3a4a52';
  ctx.lineWidth = armed ? 2 : 1;
  ctx.stroke();
}

function updateTdcScope(tdc, tubes) {
  const canvas = el('tdc-scope');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;

  // A full circle, same as the sonar scope (#06121a fill, #1c3040 rings) and
  // the same 280x280 canvas - but the sub sits near the BOTTOM of that
  // circle rather than at its center, so the entire circle is usable
  // plotting space instead of only the top half. A dead-ahead track now
  // travels almost the full diameter (bottom of the circle to the top)
  // before running out of range, and angled tracks sweep out through the
  // rest of the circle's area on their way to the rim.
  const circleX = width / 2;
  const circleY = height / 2;
  const outerRadius = Math.min(width, height) / 2 - 12;
  const originX = circleX;
  const originY = circleY + outerRadius - 14; // inset from the rim so the ship icon itself isn't clipped

  const maxRange = Math.max(1, tdcConfig.torpedoSpeed * (tdcConfig.torpedoMaxLifetimeTicks / 60));
  const plotRadius = originY - (circleY - outerRadius); // pixel distance from the sub to the far rim - the full plotted range
  const scale = plotRadius / maxRange;

  ctx.clearRect(0, 0, width, height);

  ctx.fillStyle = '#06121a';
  ctx.beginPath();
  ctx.arc(circleX, circleY, outerRadius, 0, Math.PI * 2);
  ctx.fill();

  // Everything below is clipped to the outer circle: the range rings and
  // reference line are centered on the SUB (originX/originY), not on the
  // display's own geometric center, so each ring is an accurate "same
  // distance from the ship" line in every direction - but centering them on
  // an off-center sub means they'd otherwise spill past the scope's own
  // boundary, hence the clip.
  ctx.save();
  ctx.beginPath();
  ctx.arc(circleX, circleY, outerRadius, 0, Math.PI * 2);
  ctx.clip();

  const rangeRingCount = 3;
  ctx.strokeStyle = '#1c3040';
  ctx.lineWidth = 1;
  for (let i = 1; i <= rangeRingCount; i += 1) {
    ctx.beginPath();
    ctx.arc(originX, originY, (plotRadius * i) / rangeRingCount, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.strokeStyle = '#2c4a5c';
  ctx.beginPath();
  ctx.moveTo(originX, originY);
  ctx.lineTo(originX, circleY - outerRadius);
  ctx.stroke();

  if (tdc && tubes && tubes.length) {
    const tubeCount = tubes.length;
    tubes.forEach((tube, i) => {
      const offset = tdc.gyro_angle + tdc.spread_angle * (i - (tubeCount - 1) / 2);
      drawPredictedTrack(ctx, originX, originY, scale, maxRange, offset, tube.armed);
    });
  }

  ctx.restore();

  ctx.fillStyle = '#4caf50';
  ctx.beginPath();
  ctx.moveTo(originX, originY - 8);
  ctx.lineTo(originX - 6, originY + 6);
  ctx.lineTo(originX + 6, originY + 6);
  ctx.closePath();
  ctx.fill();
}

// --- Navigation map ----------------------------------------------------------
//
// The one place this client draws real graphics instead of DOM text. Kept as
// its own presentation function fed by plain state (position/heading/an
// optional ships[] list) so it can later be swapped for a sprite-based
// renderer without touching how that state is parsed.

const MAP_SCALE = 1.5; // pixels per world unit
const MAP_GRID_SPACING = 25; // world units per grid line

function updateMapUI(map) {
  if (!map) return;

  const showEnemyBtn = el('show-enemy-btn');
  showEnemyBtn.textContent = `Show Enemy Ships: ${map.debug_show_enemy ? 'ON' : 'OFF'}`;
  showEnemyBtn.dataset.state = map.debug_show_enemy ? 'on' : 'off';

  const canvas = el('nav-map');
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const centerX = width / 2;
  const centerY = height / 2;

  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = '#1c3040';
  ctx.lineWidth = 1;
  const gridPx = MAP_GRID_SPACING * MAP_SCALE;
  const offsetX = (((map.position.x * MAP_SCALE) % gridPx) + gridPx) % gridPx;
  const offsetY = (((map.position.y * MAP_SCALE) % gridPx) + gridPx) % gridPx;
  for (let x = -offsetX; x <= width; x += gridPx) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = -offsetY; y <= height; y += gridPx) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  if (map.port) {
    // Home port: a dashed ring at its docking radius, drawn under everything.
    ctx.save();
    ctx.strokeStyle = '#4fc3f7';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(centerX + (map.port.x - map.position.x) * MAP_SCALE, centerY + (map.port.y - map.position.y) * MAP_SCALE, map.port.radius * MAP_SCALE, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  drawShipMarker(ctx, centerX, centerY, map.heading, '#4caf50');

  (map.ships || []).forEach((ship) => {
    const sx = centerX + (ship.x - map.position.x) * MAP_SCALE;
    const sy = centerY + (ship.y - map.position.y) * MAP_SCALE;
    if (sx >= 0 && sx <= width && sy >= 0 && sy <= height) {
      drawShipMarker(ctx, sx, sy, ship.heading, ship.type === 'destroyer' ? '#e53935' : '#ffb300');
    }
  });

  (map.torpedoes || []).forEach((t) => {
    const tx = centerX + (t.x - map.position.x) * MAP_SCALE;
    const ty = centerY + (t.y - map.position.y) * MAP_SCALE;
    if (tx >= 0 && tx <= width && ty >= 0 && ty <= height) {
      drawTorpedoMarker(ctx, tx, ty, t.heading);
    }
  });
}

// A fired torpedo's own marker on the nav map - deliberately smaller and
// differently shaped than drawShipMarker's triangle so it doesn't get
// mistaken for the sub or the enemy, just a short heading tick with a dot at
// its leading edge. Same raw world-axis convention as the ship/enemy
// markers above (no compass rotation) since position and heading are both
// plotted in that same raw convention throughout this function.
function drawTorpedoMarker(ctx, x, y, headingDegrees) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((headingDegrees * Math.PI) / 180);
  ctx.strokeStyle = '#ffca28';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-4, 0);
  ctx.lineTo(3, 0);
  ctx.stroke();
  ctx.fillStyle = '#ffca28';
  ctx.beginPath();
  ctx.arc(3, 0, 1.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawShipMarker(ctx, x, y, headingDegrees, color) {
  ctx.save();
  ctx.translate(x, y);
  if (headingDegrees !== null) {
    ctx.rotate((headingDegrees * Math.PI) / 180);
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(8, 0);
  ctx.lineTo(-6, 5);
  ctx.lineTo(-6, -5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

el('show-enemy-btn').addEventListener('click', (event) => {
  const currentlyOn = event.currentTarget.dataset.state === 'on';
  sendInput('SET_SHOW_ENEMY', { value: !currentlyOn });
});

// Only visible at all below the mobile CSS breakpoint (see style.css) -
// the debug panel collapses by default there so the room canvas gets the
// full screen, but a handful of controls (START/STOP engine, FIRE,
// Replace Fuse, HOLD TO TUNE/REPAIR, tool pickup/drop) don't have a Sub
// Editor-authored equivalent on the canvas yet, so this stays reachable
// instead of just being removed.
el('mobile-panel-toggle').addEventListener('click', (event) => {
  const nowVisible = el('viewport').classList.toggle('mobile-panel-visible');
  event.currentTarget.textContent = nowVisible ? 'Hide Debug Panel' : 'Show Debug Panel';
});

// Available on every platform: "Full Screen" hides every debug control
// (whether or not it was toggled visible) and fits the canvas to the whole
// screen. The debug-free, fitted layout is pure CSS (see body.mobile-fullscreen
// in style.css) so it works even where the Fullscreen/orientation-lock APIs
// don't (iOS Safari supports neither for a non-<video> element) - those are
// still requested where available, best-effort, for real OS-level fullscreen
// and, on mobile, a forced landscape lock.
function updateFullscreenBtnLabel() {
  el('fullscreen-btn').textContent = document.body.classList.contains('mobile-fullscreen') ? 'Exit Full Screen' : 'Full Screen';
}

async function enterMobileFullscreen() {
  document.body.classList.add('mobile-fullscreen');
  updateFullscreenBtnLabel();
  try {
    if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
  } catch (err) {
    // Unsupported or blocked - the CSS-only layout above still applies.
  }
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');
    }
  } catch (err) {
    // Requires fullscreen + browser support (mainly Android Chrome) - on
    // iOS there is no JS orientation lock at all, so the user just rotates
    // their device by hand.
  }
}

function exitMobileFullscreen() {
  document.body.classList.remove('mobile-fullscreen');
  updateFullscreenBtnLabel();
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  if (screen.orientation && screen.orientation.unlock) {
    try { screen.orientation.unlock(); } catch (err) { /* not locked / unsupported */ }
  }
}

el('fullscreen-btn').addEventListener('click', () => {
  if (document.body.classList.contains('mobile-fullscreen')) {
    exitMobileFullscreen();
  } else {
    enterMobileFullscreen();
  }
});

// The OS/browser can exit real fullscreen on its own (Esc key, Android back
// gesture) without going through our button - follow it so the button label
// and debug-free layout don't get out of sync with what's actually shown.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && document.body.classList.contains('mobile-fullscreen')) {
    exitMobileFullscreen();
  }
});

// --- Engine room -------------------------------------------------------------

function updateEngineRoomUI(engine) {
  if (!engine) return;

  el('engine-ordered-readout').textContent = `Ordered (from Control): ${engine.ordered.toFixed(2)}`;
  el('engine-running-status').textContent = engine.running ? 'RUNNING' : 'STOPPED';

  el('throttle-readout').textContent = `Throttle: ${engine.throttle.toFixed(2)}`;
  updateLeverStatusLine('throttle-station-status', 'station_engine_controls', 'Throttle');
  throttleLever.onState(engine.throttle);

  el('coolant-readout').textContent = `Coolant: ${engine.coolant_flow.toFixed(2)}`;
  updateLeverStatusLine('coolant-station-status', 'station_engine_controls', 'Coolant');
  coolantLever.onState(engine.coolant_flow);

  document.querySelectorAll('.gear-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.gear === engine.gear);
  });

  el('gauge-rpm').textContent = Math.round(engine.rpm);
  el('gauge-temp').textContent = `${engine.temperature.toFixed(0)}°${engine.overheat_fraction > 0 ? ' ⚠' : ''}`;
  el('gauge-oil').textContent = engine.oil_pressure.toFixed(0);
  el('gauge-fuel').textContent = `${engine.fuel.toFixed(0)}%`;
  el('gauge-efficiency').textContent = `${engine.efficiency.toFixed(0)}%`;

  el('tune-btn').textContent = engine.tuning_active ? 'TUNING...' : 'HOLD TO TUNE';

  el('fuse-status').textContent = engine.fuse_blown ? 'Fuse: BLOWN' : 'Fuse: OK';
  el('replace-fuse-btn').hidden = !engine.fuse_blown;
}

el('start-engine-btn').addEventListener('click', () => sendInput('START_ENGINE', {}));
el('stop-engine-btn').addEventListener('click', () => sendInput('STOP_ENGINE', {}));
el('replace-fuse-btn').addEventListener('click', () => sendInput('REPLACE_FUSE', {}));

document.querySelectorAll('.gear-btn').forEach((btn) => {
  btn.addEventListener('click', () => sendInput('SET_GEAR', { gear: btn.dataset.gear }));
});

// --- Tool rack (compartment-view exception: no station required) ----------

function myEquippedTool() {
  const me = playersState[myPlayerNumber];
  return me ? me.equipped_tool : '';
}

let lastRackSignature = null;

function updateToolRackUI() {
  const heldToolId = myEquippedTool();
  const visibleToolIds = Object.entries(toolsState)
    .filter(([, tool]) => tool.holder === -1 && tool.compartment === myCompartment)
    .map(([toolId]) => toolId);

  // Rebuilding this DOM on every state broadcast (60/sec) would replace the
  // buttons out from under an in-progress mouse click before mouseup fires,
  // silently swallowing the click. Only rebuild when what's shown changes.
  const signature = `${myCompartment}|${heldToolId}|${visibleToolIds.join(',')}`;
  if (signature === lastRackSignature) return;
  lastRackSignature = signature;

  const rackEl = el('rack-tools');
  rackEl.innerHTML = '';
  for (const toolId of visibleToolIds) {
    const row = document.createElement('div');
    row.className = 'tool-row';
    const label = document.createElement('span');
    label.textContent = toolId;
    const button = document.createElement('button');
    button.textContent = 'Pick up';
    button.disabled = !!heldToolId;
    button.addEventListener('click', () => sendInput('PICKUP_TOOL', { tool_id: toolId }));
    row.appendChild(label);
    row.appendChild(button);
    rackEl.appendChild(row);
  }

  const heldEl = el('held-tool');
  heldEl.innerHTML = '';
  if (heldToolId) {
    const label = document.createElement('span');
    label.textContent = `You are holding: ${heldToolId}`;
    const button = document.createElement('button');
    button.textContent = 'Drop';
    button.addEventListener('click', () => sendInput('DROP_TOOL', { tool_id: heldToolId }));
    heldEl.appendChild(label);
    heldEl.appendChild(button);
  } else {
    heldEl.textContent = 'You are not holding a tool.';
  }
}

// --- Compartment / station navigation (large swipe, gesture priority) ----
//
// Compartment view: horizontal swipe (or Left/Right arrows) moves between
// compartments. Station view: horizontal swipe/arrows cycle to another
// (unoccupied) station in the same compartment; a downward swipe (or Down
// arrow) leaves the station - the same effect as the Leave Station button.
// canvasGestureClaimed keeps this layer out of the way of an actual drag/
// click on a control inside the room canvas, which lives in its own sibling
// panel (#room-canvas-panel) alongside #viewport, both under #main-layout.

let navPointerId = null;
let navStartX = 0;
let navStartY = 0;
let canvasGestureClaimed = false;

function isInteractiveTarget(target) {
  return !!(target && target.closest && target.closest('.interactive'));
}

// A clicked <button> keeps keyboard focus in most browsers (Safari is the
// one exception) - left alone, onKeyDown's own isInteractiveTarget(event.
// target) check (event.target for a keydown being whatever element
// currently has focus) then bails out of EVERY subsequent arrow-key press,
// silently blocking compartment/station nav until focus happens to land
// somewhere else. This is general, not specific to any one button (first
// noticed with the welder toggle, but every debug-bar/hold button has the
// same issue) - none of them need to keep focus once clicked.
document.addEventListener('click', (event) => {
  if (event.target instanceof HTMLButtonElement) {
    event.target.blur();
  }
});

function onViewportPointerDown(event) {
  if (viewMode !== 'compartment') return;
  if (isInteractiveTarget(event.target)) return;
  if (roomCanvasEl.contains(event.target) && canvasGestureClaimed) return;
  navPointerId = event.pointerId;
  navStartX = event.clientX;
  navStartY = event.clientY;
}

// Shared by the normal swipe-nav gesture AND the welder's own long-fast-
// swipe override below - same distance thresholds, same axis-priority
// (predominantly vertical checks COMPARTMENT_VERTICAL_LINKS first), same
// move execution. Returns true if it actually triggered a move, so a caller
// (the welder) can tell whether to treat the gesture as "was a swipe" even
// when e.g. a vertical swipe from a compartment with no vertical link does
// nothing.
function resolveCompartmentSwipe(deltaX, deltaY) {
  const thresholdX = window.innerWidth * NAV_SWIPE_THRESHOLD_RATIO;
  const thresholdY = window.innerHeight * NAV_SWIPE_THRESHOLD_RATIO;

  if (Math.abs(deltaY) >= thresholdY && Math.abs(deltaY) >= Math.abs(deltaX)) {
    const links = COMPARTMENT_VERTICAL_LINKS[myCompartment];
    const target = links && (deltaY > 0 ? links.down : links.up);
    if (target) {
      animateScreenTransition(deltaY > 0 ? 'down' : 'up', () => {
        sendInput('MOVE_TO_COMPARTMENT', { compartment: target });
      });
      return true;
    }
    return false;
  }

  if (Math.abs(deltaX) < thresholdX) return false;
  attemptMove(deltaX < 0 ? 1 : -1);
  return true;
}

function onViewportPointerUp(event) {
  if (viewMode !== 'compartment') return;
  if (navPointerId !== event.pointerId) return;
  const deltaX = event.clientX - navStartX;
  const deltaY = event.clientY - navStartY;
  navPointerId = null;
  resolveCompartmentSwipe(deltaX, deltaY);
}

function onViewportPointerCancel(event) {
  if (navPointerId === event.pointerId) navPointerId = null;
}

function attemptMove(direction) {
  const index = compartmentLayout.indexOf(myCompartment);
  if (index === -1) return;
  const targetIndex = index + direction;
  if (targetIndex < 0 || targetIndex >= compartmentLayout.length) return;
  animateScreenTransition(direction > 0 ? 'left' : 'right', () => {
    sendInput('MOVE_TO_COMPARTMENT', { compartment: compartmentLayout[targetIndex] });
  });
}

let stationNavPointerId = null;
let stationNavStartX = 0;
let stationNavStartY = 0;

function onMainLayoutPointerDown(event) {
  if (viewMode !== 'station') return;
  if (isInteractiveTarget(event.target)) return;
  if (roomCanvasEl.contains(event.target) && canvasGestureClaimed) return;
  stationNavPointerId = event.pointerId;
  stationNavStartX = event.clientX;
  stationNavStartY = event.clientY;
}

function onMainLayoutPointerUp(event) {
  if (viewMode !== 'station') return;
  if (stationNavPointerId !== event.pointerId) return;
  const deltaX = event.clientX - stationNavStartX;
  const deltaY = event.clientY - stationNavStartY;
  stationNavPointerId = null;
  const thresholdX = window.innerWidth * NAV_SWIPE_THRESHOLD_RATIO;
  const thresholdY = window.innerHeight * NAV_SWIPE_THRESHOLD_RATIO;
  if (deltaY >= thresholdY && deltaY > Math.abs(deltaX)) {
    leaveStation();
    return;
  }
  if (Math.abs(deltaX) >= thresholdX && Math.abs(deltaX) >= Math.abs(deltaY)) {
    cycleStation(deltaX < 0 ? 1 : -1);
  }
}

function onMainLayoutPointerCancel(event) {
  if (stationNavPointerId === event.pointerId) stationNavPointerId = null;
}

function onKeyDown(event) {
  const tag = event.target && event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (isInteractiveTarget(event.target)) return;
  if (viewMode === 'compartment') {
    if (event.key === 'ArrowRight') attemptMove(1);
    else if (event.key === 'ArrowLeft') attemptMove(-1);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      // Same COMPARTMENT_VERTICAL_LINKS lookup the swipe gesture uses, but
      // deliberately NOT the same key-to-direction mapping: the swipe's own
      // "swipe down to climb up into the Conning Tower" only reads
      // naturally as a touch metaphor (like pulling down a ladder rung), and
      // feels backwards on a keyboard, where Up should just mean up. So
      // ArrowUp takes links.down (entering the Conning Tower) and ArrowDown
      // takes links.up (leaving it) - inverted from the swipe, while the
      // animation direction is still keyed the same way as the swipe uses
      // for that same transition, so it looks identical either way.
      const links = COMPARTMENT_VERTICAL_LINKS[myCompartment];
      const target = links && (event.key === 'ArrowUp' ? links.down : links.up);
      if (target) {
        animateScreenTransition(event.key === 'ArrowUp' ? 'down' : 'up', () => {
          sendInput('MOVE_TO_COMPARTMENT', { compartment: target });
        });
      }
    }
  } else if (viewMode === 'station') {
    if (event.key === 'ArrowRight') cycleStation(1);
    else if (event.key === 'ArrowLeft') cycleStation(-1);
    else if (event.key === 'ArrowDown') leaveStation();
  }
}

// Attached to #main-layout (the common ancestor of both the debug viewport
// and the room canvas panel), not just #viewport - on a narrow/mobile
// layout where only the room canvas is visible at a time, a compartment
// swipe still has to work when it's done directly on the game screen, not
// just over the debug panel. onViewportPointerDown/Up are compartment-only
// and onMainLayoutPointerDown/Up are station-only, so both safely coexist
// as separate listeners on the same element - never active at once.
const mainLayoutEl = el('main-layout');
mainLayoutEl.addEventListener('pointerdown', onViewportPointerDown);
mainLayoutEl.addEventListener('pointerup', onViewportPointerUp);
mainLayoutEl.addEventListener('pointercancel', onViewportPointerCancel);
mainLayoutEl.addEventListener('pointerdown', onMainLayoutPointerDown);
mainLayoutEl.addEventListener('pointerup', onMainLayoutPointerUp);
mainLayoutEl.addEventListener('pointercancel', onMainLayoutPointerCancel);

window.addEventListener('keydown', onKeyDown);

window.addEventListener('resize', () => {
  engineOrderLever.reposition();
  helmLever.reposition();
  diveLever.reposition();
  sonarLever.reposition();
  throttleLever.reposition();
  coolantLever.reposition();
});

el('connect-btn').addEventListener('click', connect);

function resetGame() {
  sendInput('RESET_GAME', {});
  // Optimistic/immediate for whoever clicked the button - the robust catch-
  // all for every client (including anyone who DIDN'T click it) is the
  // server_tick rollback check in applyState(), since tick resets to 0 too.
  RoomRenderer.clearWelds();
}

el('reset-btn').addEventListener('click', resetGame);
el('reset-btn-banner').addEventListener('click', resetGame);
el('reset-btn-victory').addEventListener('click', resetGame);
el('reset-btn-returned').addEventListener('click', resetGame);

el('invulnerable-btn').addEventListener('click', (event) => {
  const currentlyOn = event.currentTarget.dataset.state === 'on';
  sendInput('SET_INVULNERABLE', { value: !currentlyOn });
});

el('ignore-overheat-btn').addEventListener('click', (event) => {
  const currentlyOn = event.currentTarget.dataset.state === 'on';
  sendInput('SET_IGNORE_OVERHEAT_EFFECTS', { value: !currentlyOn });
});

el('unlimited-supplies-btn').addEventListener('click', (event) => {
  const currentlyOn = event.currentTarget.dataset.state === 'on';
  sendInput('SET_UNLIMITED_SUPPLIES', { value: !currentlyOn });
});

el('ignore-game-over-btn').addEventListener('click', (event) => {
  const currentlyOn = event.currentTarget.dataset.state === 'on';
  sendInput('SET_IGNORE_GAME_OVER', { value: !currentlyOn });
});

// Resets the Sub Editor's own nav_map Scope object (drawn on the room
// canvas, not this debug panel's separate always-centered #nav-map canvas
// below) back to its authored default view - undoes whatever panning/
// zooming a player's drag/pinch gestures have built up, in case they've
// scrolled the chart away from the ship and want back to a known state.
el('recenter-map-btn').addEventListener('click', () => {
  scopePan = {};
  scopeZoom = {};
  renderCurrentRoomCanvases();
});

refreshViewVisibility();
