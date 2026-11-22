// Sub Editor - a standalone, local, no-build layout tool.
//
// Produces plain JSON room layouts (id/name/objects[]), where each object
// declares WHAT it looks like, WHERE it is, HOW it's interacted with, and
// WHAT GAME VALUE it binds to - never any game logic itself. The submarine
// game client is expected to load this JSON at runtime and instantiate the
// matching control type per object, per ClaudeDocs/Sub Editor.md.

const STORAGE_KEY = 'sub_editor_project_v1';
const ROOM_WIDTH = 960;
const ROOM_HEIGHT = 540;

// --- Known server bindings --------------------------------------------------
//
// SERVER_ACTIONS and SERVER_STATE_PATHS - the "binding sheet" - now live in
// their own file, server-bindings.js (loaded via a <script> tag in
// index.html before this file), so binding-sheet.html can render the exact
// same data as a human-readable page instead of a second, hand-copied list
// that could drift out of sync. See that file's own header comment for what
// this data is and how it's kept current. This section just consumes it:
// feeds autocomplete on every Binding/State Binding field below and lets
// picking a known action auto-fill its value range and payload key.
//
// See also: sub-editor/help.html and sub-editor/binding-sheet.html (both
// reachable from the toolbar) for the human-readable references.

function findServerAction(name) {
  return SERVER_ACTIONS.find((a) => a.name === name) || null;
}

function findServerStatePath(path) {
  return SERVER_STATE_PATHS.find((s) => s.path === path) || null;
}

function populateBindingDatalists() {
  const actionsList = el('server-actions-datalist');
  SERVER_ACTIONS.forEach((a) => {
    const opt = document.createElement('option');
    opt.value = a.name;
    actionsList.appendChild(opt);
  });
  const statePathsList = el('server-state-paths-datalist');
  SERVER_STATE_PATHS.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.path;
    statePathsList.appendChild(opt);
  });
}

// Human-readable summary of what a Binding actually does, shown under the
// field so an author can confirm they picked the right one without needing
// to cross-reference the Binding Sheet separately.
function describeServerAction(action) {
  if (action.valueType === 'trigger') return `${action.name} - trigger, no payload (fires once per click).`;
  if (action.valueType === 'bool') return `${action.name} - sends { ${action.payloadKey}: true|false }.`;
  if (action.valueType === 'string') {
    const opts = action.options ? action.options.join('/') : 'string';
    return `${action.name} - sends { ${action.payloadKey}: "${opts}" }.`;
  }
  return `${action.name} - sends { ${action.payloadKey}: <${action.min} to ${action.max}> }.`;
}

function refreshBindingHint(bindingName) {
  const hintEl = el('insp-binding-hint');
  if (!hintEl) return;
  if (!bindingName) {
    hintEl.textContent = '';
    return;
  }
  const action = findServerAction(bindingName);
  hintEl.textContent = action
    ? describeServerAction(action)
    : `"${bindingName}" isn't in the server's known action list - double-check the exact name.`;
}

// When Binding is set to a recognized action, auto-fill the fields that
// action actually needs - payload key, and (for a drag control) its real
// game-value range - instead of leaving the author to look them up and
// retype them by hand.
function applyKnownActionDefaults(obj) {
  const action = findServerAction(obj.binding);
  if (!action) return;
  obj.payloadKey = action.payloadKey && action.payloadKey !== 'value' ? action.payloadKey : '';
  el('insp-payload-key').value = obj.payloadKey;
  if (action.valueType === 'float' && (obj.interaction === 'drag_linear' || obj.interaction === 'drag_rotate')) {
    obj.min = action.min;
    obj.max = action.max;
    el('insp-min').value = obj.min;
    el('insp-max').value = obj.max;
  }
}

// Fractional position of each named anchor within whatever viewport rect is
// currently in effect (the design canvas normally, or the Device Preview's
// viewport rect when one is active).
const ANCHOR_POINTS = {
  'top-left': [0, 0],
  'top-center': [0.5, 0],
  'top-right': [1, 0],
  'middle-left': [0, 0.5],
  center: [0.5, 0.5],
  'middle-right': [1, 0.5],
  'bottom-left': [0, 1],
  'bottom-center': [0.5, 1],
  'bottom-right': [1, 1],
};

// Aspect ratios to preview the room at - real device pixel counts don't map
// onto this room's abstract design units, so only the ratio matters: the
// preview viewport is the largest rect of that ratio centered in the room.
const DEVICE_PRESETS = {
  'phone-portrait': { name: 'Phone Portrait', width: 375, height: 667 },
  'phone-landscape': { name: 'Phone Landscape', width: 667, height: 375 },
  'tablet-portrait': { name: 'Tablet Portrait', width: 768, height: 1024 },
  'tablet-landscape': { name: 'Tablet Landscape', width: 1024, height: 768 },
  laptop: { name: 'Laptop', width: 1280, height: 720 },
};
let devicePreview = null;

// Fields that define a prefab's *appearance* - what a prefab instance
// pushes to its siblings. Per the design doc's own example: only artwork
// propagates. Name, position, interaction, and binding are always
// per-instance and are never touched by a push.
const PREFAB_APPEARANCE_FIELDS = ['type', 'width', 'height', 'color', 'assetId', 'pivotX', 'pivotY', 'uniformScale'];

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']);

const el = (id) => document.getElementById(id);

function defaultRooms() {
  return {
    forward_torpedo: { id: 'forward_torpedo', name: 'Forward Torpedo', objects: [], stations: {} },
    information: { id: 'information', name: 'Information', objects: [], stations: {} },
    control: { id: 'control', name: 'Control Room', objects: [], stations: {} },
    engineering: { id: 'engineering', name: 'Engineering', objects: [], stations: {} },
    // Reached by swiping down from Control, not part of the left/right
    // compartment chain - see COMPARTMENTS/COMPARTMENT_LAYOUT in
    // simulation.gd and COMPARTMENT_VERTICAL_LINKS in client.js.
    conning_tower: { id: 'conning_tower', name: 'Conning Tower', objects: [], stations: {} },
  };
}

let rooms = defaultRooms();
let currentRoomId = 'control';
let currentStationId = null; // null = editing the compartment view; else a station id within the current room
let assets = {}; // assetId -> { id, name, dataUrl, image }
let prefabs = {}; // prefabId -> appearance template
// sourceFilename values Delete has explicitly removed - checked by
// scanAssetsFolder() so a deleted asset's still-present file doesn't get
// silently re-imported on the next scan (including the silent one that runs
// on every page load). "Load Images..." deliberately ignores this set, so
// re-adding one on purpose is still just one click away.
let deletedAssetFilenames = new Set();
let nextObjectSeq = 1;
let nextAssetSeq = 1;
let nextPrefabSeq = 1;

let selectedIds = new Set();

const view = { offsetX: 48, offsetY: 27, zoom: 0.9 };

let dragMode = null; // null | 'pan' | 'move-objects' | 'box-select' | 'move-pivot'
let dragMouseStart = { x: 0, y: 0 };
let dragViewStart = { offsetX: 0, offsetY: 0 };
let dragObjectStarts = new Map(); // id -> {x, y}
let boxSelectRect = null; // {x0,y0,x1,y1} in world space, while box-selecting
let spaceHeld = false;
let pivotDragStart = null; // {x0, y0, pivotX0, pivotY0} while dragging a pivot handle
let snapStopDragInfo = null; // {objId, index} while dragging a snap-stop point along its path
let hPatternDragNodeId = null; // node id while dragging an H-pattern node
let lastClickedHPatternNodeId = null; // for shift-click-to-connect chaining
let lastClickedHPatternNodeObjId = null; // which object that last-clicked node belongs to

// --- Live Test Mode --------------------------------------------------------
//
// Lets a control be dragged/clicked the way a player actually would, purely
// in the browser - no server needed, per the design doc's "instrument
// builder" idea. Reuses the exact same range/snap/h-pattern data and math
// the Preview slider and snap-stop dragging already use; it just drives it
// from a live mouse gesture on the object itself (or its hitbox, if it has
// one) instead of a slider or a small handle.
let testMode = false;
let testDragObjId = null;
let testDragHPatternOffset = null; // {x,y} local free-drag position while test-dragging a drag_h_pattern control - null when not actively dragging one (renders at hPatternActiveNode's exact position instead)

// --- Zone painting -------------------------------------------------------
let paintMode = null; // 'leak' | 'fire' | null - which zone type the brush paints, if any
let brushSize = 30;
let activeZoneObj = null; // the zone object being extended by the current stroke
let lastMouseWorldPos = null; // for the brush-size cursor preview
let resizeDragStart = null; // {corner, anchor, objectStarts} while resizing a multi-selection

let assetsDirHandle = null; // FileSystemDirectoryHandle, if the user has chosen an assets folder
let exportDirHandle = null; // FileSystemDirectoryHandle, if the user has chosen a folder to export straight into (e.g. the game client's own layouts/ folder) instead of downloading

// Live, non-persisted preview of an output-bound object's animation range,
// driven by the "Preview" slider in the inspector - never written to the
// object itself, purely a render-time override.
let previewOutputObjectId = null;
let previewOutputT = 0;
let previewInputObjectId = null;
let previewInputT = 0;
let uniformResizeEnabled = false;

// Live, non-persisted preview of which visual state is shown, driven by the
// "Preview State" dropdown - never written to the object, purely a
// render-time override, same pattern as the output/input previews above.
let previewStateObjectId = null;
let previewStateName = null;

// While set, the room/station is in "Object Edit Mode": the named group has
// been temporarily expanded into its loose member objects (childIds) so all
// the normal canvas/inspector tooling can edit them directly, and every
// other object in the container is dimmed and non-interactive. Exiting
// re-collapses the members back into a single group under the same id.
let editingGroup = null;

// --- Undo / redo -------------------------------------------------------
//
// Whole-document snapshots rather than per-action inverses: this app's
// state is small (a handful of rooms/stations, at most dozens of objects
// each), so deep-cloning rooms+prefabs before every discrete action is far
// simpler and less error-prone than hand-writing an inverse for every one
// of the many mutation types (move, resize, group, prefab push, etc.), and
// is imperceptibly cheap at this scale. Asset images and view pan/zoom are
// deliberately excluded - those are workspace state, not document content.

const MAX_UNDO_STEPS = 100;
let undoStack = [];
let redoStack = [];

function snapshotDocumentState() {
  return JSON.parse(
    JSON.stringify({ rooms, prefabs, currentRoomId, currentStationId, selectedIds: [...selectedIds] }),
  );
}

// Call this BEFORE applying a discrete mutation (add/delete/duplicate/
// group/drag-start/field-edit-start/etc.), never from inside a per-frame
// drag-move handler - that would flood the stack with useless micro-steps.
function pushUndoSnapshot() {
  undoStack.push(snapshotDocumentState());
  if (undoStack.length > MAX_UNDO_STEPS) undoStack.shift();
  redoStack = [];
  refreshUndoRedoButtons();
}

function refreshUndoRedoButtons() {
  el('undo-btn').disabled = undoStack.length === 0;
  el('redo-btn').disabled = redoStack.length === 0;
}

function restoreDocumentState(snap) {
  rooms = snap.rooms;
  prefabs = snap.prefabs;
  currentRoomId = rooms[snap.currentRoomId] ? snap.currentRoomId : Object.keys(rooms)[0];
  currentStationId = snap.currentStationId;
  selectedIds = new Set(snap.selectedIds);
  previewOutputObjectId = null;
  previewInputObjectId = null;
  previewStateObjectId = null;
  previewStateName = null;
  dragMode = null;
  editingGroup = null;
  updateObjectEditModeBanner();
  renderRoomSelect();
  renderViewSelect();
  renderAssetList();
  renderPrefabList();
  refreshSelectionUI();
  scheduleSave();
  refreshUndoRedoButtons();
}

function undo() {
  if (!undoStack.length) return;
  const current = snapshotDocumentState();
  const previous = undoStack.pop();
  redoStack.push(current);
  restoreDocumentState(previous);
}

function redo() {
  if (!redoStack.length) return;
  const current = snapshotDocumentState();
  const next = redoStack.pop();
  undoStack.push(current);
  restoreDocumentState(next);
}

el('undo-btn').addEventListener('click', undo);
el('redo-btn').addEventListener('click', redo);

function currentRoom() {
  return rooms[currentRoomId];
}

// Returns whichever object list is currently being edited: the room's
// compartment view (background/station-hotspots/tools), or one specific
// station's own dedicated screen, per the game's compartment -> station ->
// dedicated-UI model. Everything that reads/writes "the current objects"
// should go through this rather than `currentRoom().objects` directly, so
// station screens are full peers of the compartment view.
function currentContainer() {
  const room = currentRoom();
  if (currentStationId && room.stations && room.stations[currentStationId]) {
    return room.stations[currentStationId];
  }
  return room;
}

function ensureRoomStations(room) {
  if (!room.stations) room.stations = {};
  return room.stations;
}

// --- Layers --------------------------------------------------------------
//
// A layer is a lock/export grouping tag on top-level objects within a single
// container (a room's compartment view, or one station's view) - not a
// transform-composing structure like a Group. Locking a layer protects its
// objects from being selected/edited without changing their data, and each
// layer can independently opt into being flattened to a single raster image
// at export time (useful for a background built from many decoration
// objects that never need to be interacted with individually in-game).

function ensureContainerLayers(container) {
  if (!container.layers || !container.layers.length) {
    container.layers = [{ id: 'default', name: 'Default', selected: true, flattenOnExport: false }];
  }
  // Migrate the old single-layer "locked" toggle to "selected" (inverted) -
  // any project saved before this existed has `locked` but no `selected`
  // yet, and without this every layer would come up de-selected (i.e.
  // locked) under the new model instead of preserving what it actually was.
  container.layers.forEach((layer) => {
    if (layer.selected === undefined) {
      layer.selected = !layer.locked;
      delete layer.locked;
    }
  });
  return container.layers;
}

function getLayerForObject(container, obj) {
  const layers = ensureContainerLayers(container);
  return layers.find((l) => l.id === (obj.layerId || 'default')) || layers[0];
}

// Name kept from the old lock-based model - the contract ("true = this
// object can't be interacted with") is unchanged, only the per-layer toggle
// that decides it flipped from an explicit Lock to a multi-select "Select
// to edit" (unselected layers act locked).
function isObjectLocked(obj) {
  return !getLayerForObject(currentContainer(), obj).selected;
}

// Locked (by its layer) OR outside the current Object Edit Mode scope -
// either way, the canvas/list should show it but refuse to select it.
function isInteractionBlocked(obj) {
  if (isObjectLocked(obj)) return true;
  if (editingGroup && !editingGroup.childIds.has(obj.id)) return true;
  return false;
}

// Per-type "meta layer" visibility (player spawns, leak/fire zones) - purely
// an editor viewing convenience, so it only governs the canvas, never the
// Objects list, which always lets you find and re-enable a hidden one.
let metaLayerVisibility = { player_spawn: true, leak_zone: true, fire_zone: true };

function isCanvasVisible(obj) {
  return metaLayerVisibility[obj.type] !== false;
}

function findObject(id) {
  return currentContainer().objects.find((o) => o.id === id) || null;
}

function selectedObjects() {
  return currentContainer().objects.filter((o) => selectedIds.has(o.id));
}

// --- Persistence -------------------------------------------------------

function scheduleSave() {
  clearTimeout(scheduleSave._t);
  scheduleSave._t = setTimeout(saveToLocalStorage, 300);
}

function buildProjectPayload() {
  const assetPayload = {};
  for (const [id, asset] of Object.entries(assets)) {
    assetPayload[id] = { id: asset.id, name: asset.name, dataUrl: asset.dataUrl, sourceFilename: asset.sourceFilename, category: asset.category || '', hidden: !!asset.hidden };
  }
  return {
    rooms, assets: assetPayload, prefabs, nextObjectSeq, nextAssetSeq, nextPrefabSeq, currentRoomId, currentStationId,
    deletedAssetFilenames: [...deletedAssetFilenames],
    hiddenCategories: [...hiddenCategories],
  };
}

// True once this session has already warned about a dropped-assets autosave,
// so the browser's localStorage quota (typically 5-10MB, easily exceeded by
// embedded image data) doesn't nag on every single edit after the first hit -
// but it must warn at least once, loudly, because silently falling back to
// an assets-less autosave is exactly how a full asset registry got lost
// before: the user only found out on their next reload, once it was too late.
let warnedAboutDroppedAssetsSave = false;

function saveToLocalStorage() {
  const payload = buildProjectPayload();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    // Likely quota exceeded from embedded image data - fall back to saving
    // the layout without images rather than losing the autosave entirely,
    // but make sure the user actually finds out, since this is the exact
    // silent failure mode that caused all asset bindings to be lost before.
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...payload, assets: {} }));
      if (!warnedAboutDroppedAssetsSave) {
        warnedAboutDroppedAssetsSave = true;
        alert(
          'Autosave storage is full, so your asset images could NOT be included in the autosave ' +
          '(the room layout itself was still saved). Use "Save Project Backup..." now to save a ' +
          'complete backup file, including images, to disk.',
        );
      }
    } catch (err2) {
      console.warn('Could not auto-save project:', err2);
    }
  }
}

function applyProjectPayload(payload) {
  if (payload.rooms) rooms = payload.rooms;
  // Defensive cleanup for a fake "room" entry a since-fixed Import Room JSON
  // bug could have left behind (importing a layouts.json bundle used to
  // merge its "spritesheet" metadata key straight into rooms as if it were
  // one) - a real room always has an objects array, so anything without one
  // is not a room and would crash every future export.
  Object.keys(rooms).forEach((id) => {
    if (!Array.isArray(rooms[id]?.objects)) delete rooms[id];
  });
  if (payload.prefabs) prefabs = payload.prefabs;
  nextObjectSeq = payload.nextObjectSeq || 1;
  nextAssetSeq = payload.nextAssetSeq || 1;
  nextPrefabSeq = payload.nextPrefabSeq || 1;
  currentRoomId = payload.currentRoomId && rooms[payload.currentRoomId] ? payload.currentRoomId : Object.keys(rooms)[0];
  const restoredStations = ensureRoomStations(currentRoom());
  currentStationId = payload.currentStationId && restoredStations[payload.currentStationId] ? payload.currentStationId : null;
  assets = {};
  for (const [id, a] of Object.entries(payload.assets || {})) {
    const img = new Image();
    img.onload = render;
    img.src = a.dataUrl;
    assets[id] = { id: a.id, name: a.name, dataUrl: a.dataUrl, image: img, sourceFilename: a.sourceFilename, category: a.category || '', hidden: !!a.hidden };
  }
  deletedAssetFilenames = new Set(payload.deletedAssetFilenames || []);
  hiddenCategories = new Set(payload.hiddenCategories || []);
}

function loadFromLocalStorage() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  try {
    applyProjectPayload(JSON.parse(raw));
  } catch (err) {
    console.warn('Could not load saved project:', err);
  }
}

// Full, portable project backup - everything scheduleSave() would autosave
// (rooms, prefabs, and every asset's actual image data), written to a file
// the user controls instead of browser storage. Browser storage (localStorage
// quota, a cleared cache/profile, a different browser) can be lost or capped
// without warning; a file on disk can't be silently evicted, and restoring
// from one recreates every asset under its exact original id, so room
// objects' assetId references never need to be reconciled against a fresh
// scan at all.
function saveProjectBackupToFile() {
  const payload = buildProjectPayload();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  downloadFile(`sub_editor_backup_${stamp}.json`, JSON.stringify(payload));
  const status = el('project-backup-status');
  if (status) status.textContent = `Backup saved: sub_editor_backup_${stamp}.json`;
}

function restoreProjectFromBackupFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(reader.result);
      if (!payload || typeof payload !== 'object' || !payload.rooms) {
        throw new Error('This does not look like a Sub Editor project backup file.');
      }
      if (!confirm('Restore this backup? It will replace every room, prefab, and asset currently loaded in the editor.')) return;
      pushUndoSnapshot();
      applyProjectPayload(payload);
      renderRoomSelect();
      renderViewSelect();
      renderAssetList();
      renderPrefabList();
      renderObjectList();
      selectedIds = new Set();
      refreshSelectionUI();
      render();
      scheduleSave();
      const status = el('project-backup-status');
      if (status) status.textContent = `Restored from ${file.name}`;
    } catch (err) {
      alert(`Could not restore that backup: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

el('save-backup-btn').addEventListener('click', saveProjectBackupToFile);
el('load-backup-btn').addEventListener('click', () => el('backup-file-input').click());
el('backup-file-input').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (file) restoreProjectFromBackupFile(file);
  event.target.value = '';
});

// --- Object CRUD ---------------------------------------------------------

function makeObjectId(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'object';
  let id = base;
  let n = 1;
  const container = currentContainer();
  while (container.objects.some((o) => o.id === id)) {
    id = `${base}_${n}`;
    n += 1;
  }
  return id;
}

function addObject({ assetId = null, width = 60, height = 60, name = null, type = 'decoration', color = '#4caf50', previewShape = 'rectangle' }) {
  pushUndoSnapshot();
  const finalName = name || `Object ${nextObjectSeq}`;
  const obj = {
    id: makeObjectId(finalName),
    name: finalName,
    type,
    x: ROOM_WIDTH / 2,
    y: ROOM_HEIGHT / 2,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    width,
    height,
    assetId,
    color,
    previewShape,
    pivotX: 0.5,
    pivotY: 0.5,
    interaction: 'none',
    axis: 'vertical',
    min: 0,
    max: 1,
    reverse: false,
    binding: '',
    targetStationId: '',
    notes: '',
    outputType: 'none',
    outputBinding: '',
    outputMin: 0,
    outputMax: 1,
    outputRotationMin: -45,
    outputRotationMax: 45,
    outputAxis: 'vertical',
    outputTravelMin: 0,
    outputTravelMax: 0,
  };
  if (type === 'player_spawn') obj.spawnType = 'room_enter';
  if (type === 'scope') {
    obj.scopeFillFraction = 0.95;
    obj.displayChannel = '';
    obj.navMapRange = 300;
    obj.sonarRange = 200;
    obj.sonarPulseSpeedScale = 0.25;
    obj.tdcRange = 1000;
    obj.tdcSpeed = 20;
    obj.tdcTurnRate = 45;
    obj.tdcActivationDistance = 50;
    obj.tdcGyroLimit = 90;
    obj.periscopeFov = 20;
    obj.periscopeReferenceDistance = 500;
  }
  nextObjectSeq += 1;
  currentContainer().objects.push(obj);
  if (editingGroup) editingGroup.childIds.add(obj.id);
  selectSingle(obj.id);
  renderObjectList();
  render();
  scheduleSave();
}

function deleteObjects(ids) {
  pushUndoSnapshot();
  const room = currentContainer();
  room.objects = room.objects.filter((o) => !ids.includes(o.id));
  ids.forEach((id) => selectedIds.delete(id));
  refreshSelectionUI();
  renderObjectList();
  render();
  scheduleSave();
}

function duplicateObjects(ids) {
  pushUndoSnapshot();
  const room = currentContainer();
  const newIds = [];
  ids.forEach((id) => {
    const obj = findObject(id);
    if (!obj) return;
    const copy = JSON.parse(JSON.stringify(obj));
    copy.name = `${obj.name} copy`;
    copy.id = makeObjectId(copy.name);
    translateObjectXY(copy, 20, 20);
    room.objects.push(copy);
    newIds.push(copy.id);
  });
  if (editingGroup) newIds.forEach((id) => editingGroup.childIds.add(id));
  selectedIds = new Set(newIds);
  refreshSelectionUI();
  renderObjectList();
  render();
  scheduleSave();
}

function moveObjectOrder(index, direction) {
  const room = currentContainer();
  const newIndex = index + direction;
  if (newIndex < 0 || newIndex >= room.objects.length) return;
  pushUndoSnapshot();
  const [item] = room.objects.splice(index, 1);
  room.objects.splice(newIndex, 0, item);
  renderObjectList();
  render();
  scheduleSave();
}

// --- Grouping --------------------------------------------------------------

function groupSelected() {
  const objs = selectedObjects();
  if (objs.length < 2) return;
  pushUndoSnapshot();

  const cx = objs.reduce((s, o) => s + o.x, 0) / objs.length;
  const cy = objs.reduce((s, o) => s + o.y, 0) / objs.length;

  const children = objs.map((o) => {
    const clone = JSON.parse(JSON.stringify(o));
    clone.offsetX = o.x - cx;
    clone.offsetY = o.y - cy;
    delete clone.x;
    delete clone.y;
    return clone;
  });

  const group = {
    id: makeObjectId('Group'),
    name: 'Group',
    type: 'group',
    x: cx,
    y: cy,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    children,
  };
  const layerIds = new Set(objs.map((o) => o.layerId || 'default'));
  if (layerIds.size === 1) group.layerId = [...layerIds][0];

  const room = currentContainer();
  const ids = new Set(objs.map((o) => o.id));
  room.objects = room.objects.filter((o) => !ids.has(o.id));
  room.objects.push(group);

  if (editingGroup) {
    ids.forEach((id) => editingGroup.childIds.delete(id));
    editingGroup.childIds.add(group.id);
  }

  selectSingle(group.id);
  renderObjectList();
  render();
  scheduleSave();
}

function ungroupSelected() {
  const objs = selectedObjects();
  if (objs.length !== 1 || objs[0].type !== 'group') return;
  pushUndoSnapshot();
  const group = objs[0];

  const rad = (group.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const room = currentContainer();
  const restored = group.children.map((child) => {
    const ox = child.offsetX * group.scaleX;
    const oy = child.offsetY * group.scaleY;
    const { offsetX, offsetY, ...rest } = child;
    const obj = {
      ...rest,
      x: group.x + ox * cos - oy * sin,
      y: group.y + ox * sin + oy * cos,
      rotation: (rest.rotation || 0) + group.rotation,
      scaleX: (rest.scaleX || 1) * group.scaleX,
      scaleY: (rest.scaleY || 1) * group.scaleY,
    };
    return obj;
  });

  room.objects = room.objects.filter((o) => o.id !== group.id);
  const newIds = [];
  restored.forEach((obj) => {
    obj.id = makeObjectId(obj.name);
    room.objects.push(obj);
    newIds.push(obj.id);
  });

  if (editingGroup) {
    editingGroup.childIds.delete(group.id);
    newIds.forEach((id) => editingGroup.childIds.add(id));
  }

  selectedIds = new Set(newIds);
  refreshSelectionUI();
  renderObjectList();
  render();
  scheduleSave();
}

// --- Object Edit Mode ----------------------------------------------------
//
// Double-clicking a group temporarily expands it into its loose member
// objects (reusing the exact same math as ungroupSelected/groupSelected)
// so every normal tool - move, resize, add, delete, nested grouping, the
// inspector - works on its parts directly, without permanently breaking the
// group apart. Everything else in the container is dimmed and locked out
// for the duration. Exiting re-collapses the members back under the same
// group id, name, prefab link and layer, in their original z-order slot.
// Only one level is supported at a time - entering while already editing,
// or switching rooms/stations/undo/redo while editing, force-exits first.

function enterObjectEditMode(groupId) {
  if (editingGroup) return;
  const container = currentContainer();
  const index = container.objects.findIndex((o) => o.id === groupId);
  if (index === -1) return;
  const group = container.objects[index];
  if (group.type !== 'group') return;

  pushUndoSnapshot();

  const rad = (group.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const restored = group.children.map((child) => {
    const ox = child.offsetX * group.scaleX;
    const oy = child.offsetY * group.scaleY;
    const { offsetX, offsetY, ...rest } = child;
    return {
      ...rest,
      id: makeObjectId(rest.name),
      x: group.x + ox * cos - oy * sin,
      y: group.y + ox * sin + oy * cos,
      rotation: (rest.rotation || 0) + group.rotation,
      scaleX: (rest.scaleX || 1) * group.scaleX,
      scaleY: (rest.scaleY || 1) * group.scaleY,
    };
  });

  container.objects.splice(index, 1, ...restored);

  editingGroup = {
    childIds: new Set(restored.map((o) => o.id)),
    groupMeta: { id: group.id, name: group.name, prefabId: group.prefabId, layerId: group.layerId },
  };
  selectedIds = new Set();
  refreshSelectionUI();
  renderObjectList();
  render();
  scheduleSave();
  updateObjectEditModeBanner();
}

function exitObjectEditMode() {
  if (!editingGroup) return;
  const container = currentContainer();
  const childIds = editingGroup.childIds;
  const memberObjs = container.objects.filter((o) => childIds.has(o.id));

  if (!memberObjs.length) {
    // Every part was deleted while editing - there's nothing left to
    // collapse back into a group, so just leave edit mode.
    editingGroup = null;
    refreshSelectionUI();
    renderObjectList();
    render();
    updateObjectEditModeBanner();
    return;
  }

  pushUndoSnapshot();

  const cx = memberObjs.reduce((s, o) => s + o.x, 0) / memberObjs.length;
  const cy = memberObjs.reduce((s, o) => s + o.y, 0) / memberObjs.length;
  const children = memberObjs.map((o) => {
    const clone = JSON.parse(JSON.stringify(o));
    clone.offsetX = o.x - cx;
    clone.offsetY = o.y - cy;
    delete clone.x;
    delete clone.y;
    return clone;
  });

  const group = {
    id: editingGroup.groupMeta.id,
    name: editingGroup.groupMeta.name,
    type: 'group',
    x: cx,
    y: cy,
    rotation: 0,
    scaleX: 1,
    scaleY: 1,
    children,
  };
  if (editingGroup.groupMeta.prefabId) group.prefabId = editingGroup.groupMeta.prefabId;
  if (editingGroup.groupMeta.layerId) group.layerId = editingGroup.groupMeta.layerId;

  // Keep the group's original z-order slot: insert it where its earliest
  // member used to sit, counted among the objects that are staying.
  const firstIndexOriginal = container.objects.findIndex((o) => childIds.has(o.id));
  const insertAt = container.objects.slice(0, firstIndexOriginal).filter((o) => !childIds.has(o.id)).length;
  container.objects = container.objects.filter((o) => !childIds.has(o.id));
  container.objects.splice(insertAt, 0, group);

  editingGroup = null;
  selectSingle(group.id);
  renderObjectList();
  render();
  scheduleSave();
  updateObjectEditModeBanner();
}

function updateObjectEditModeBanner() {
  const banner = el('object-edit-banner');
  banner.hidden = !editingGroup;
  if (editingGroup) el('object-edit-banner-name').textContent = editingGroup.groupMeta.name;
}

el('exit-object-edit-btn').addEventListener('click', exitObjectEditMode);

// --- Prefabs -----------------------------------------------------------

function renderPrefabList() {
  const listEl = el('prefab-list');
  listEl.innerHTML = '';
  Object.values(prefabs).forEach((prefab) => {
    const row = document.createElement('div');
    row.className = 'asset-row';

    const swatch = document.createElement('div');
    swatch.className = 'prefab-swatch';
    if (prefab.assetId && assets[prefab.assetId]) {
      const img = document.createElement('img');
      img.src = assets[prefab.assetId].dataUrl;
      img.className = 'asset-thumb';
      swatch.appendChild(img);
    } else {
      swatch.style.background = prefab.color || '#4caf50';
    }
    swatch.title = `Click to place "${prefab.name}"`;
    swatch.addEventListener('click', () => placePrefabInstance(prefab.id));

    const label = document.createElement('span');
    label.textContent = prefab.name;

    row.appendChild(swatch);
    row.appendChild(label);
    listEl.appendChild(row);
  });
}

function placePrefabInstance(prefabId) {
  const prefab = prefabs[prefabId];
  if (!prefab) return;
  pushUndoSnapshot();
  const instance = JSON.parse(JSON.stringify(prefab));
  delete instance.id;
  instance.name = prefab.name;
  instance.id = makeObjectId(prefab.name);
  instance.prefabId = prefabId;
  instance.x = ROOM_WIDTH / 2;
  instance.y = ROOM_HEIGHT / 2;
  instance.rotation = 0;
  instance.scaleX = 1;
  instance.scaleY = 1;
  if (prefab.type !== 'group') {
    instance.interaction = 'none';
    instance.axis = 'vertical';
    instance.min = 0;
    instance.max = 1;
    instance.reverse = false;
    instance.binding = '';
    instance.notes = '';
  }
  currentContainer().objects.push(instance);
  if (editingGroup) editingGroup.childIds.add(instance.id);
  selectSingle(instance.id);
  renderObjectList();
  render();
  scheduleSave();
}

function saveAsPrefab(obj) {
  const name = (prompt('Prefab name:', obj.name) || '').trim();
  if (!name) return;
  pushUndoSnapshot();
  const id = `prefab_${nextPrefabSeq}`;
  nextPrefabSeq += 1;
  const template = { id, name, type: obj.type };
  PREFAB_APPEARANCE_FIELDS.forEach((field) => {
    if (field !== 'type') template[field] = obj[field];
  });
  if (obj.type === 'group') {
    template.children = JSON.parse(JSON.stringify(obj.children));
  }
  prefabs[id] = template;
  obj.prefabId = id;
  renderPrefabList();
  refreshSelectionUI();
  scheduleSave();
}

function pushPrefabAppearance(obj) {
  const prefabId = obj.prefabId;
  const prefab = prefabs[prefabId];
  if (!prefab) return;
  pushUndoSnapshot();

  // Update the stored template from this instance's current appearance.
  PREFAB_APPEARANCE_FIELDS.forEach((field) => {
    prefab[field] = obj[field];
  });
  if (obj.type === 'group') {
    prefab.children = JSON.parse(JSON.stringify(obj.children));
  }

  // Propagate to every other instance of this prefab, across all rooms and
  // all of their stations - appearance only. Name, position, interaction,
  // and binding are left untouched on every instance, including this one.
  const applyToInstance = (other) => {
    if (other.prefabId !== prefabId || other.id === obj.id) return;
    PREFAB_APPEARANCE_FIELDS.forEach((field) => {
      other[field] = prefab[field];
    });
    if (prefab.type === 'group') {
      other.children = JSON.parse(JSON.stringify(prefab.children));
    }
  };
  Object.values(rooms).forEach((room) => {
    room.objects.forEach(applyToInstance);
    Object.values(room.stations || {}).forEach((station) => station.objects.forEach(applyToInstance));
  });

  renderPrefabList();
  render();
  scheduleSave();
}

function unlinkFromPrefab(obj) {
  pushUndoSnapshot();
  delete obj.prefabId;
  refreshSelectionUI();
  scheduleSave();
}

// --- Selection / inspector -------------------------------------------------

function selectSingle(id) {
  selectedIds = new Set(id ? [id] : []);
  refreshSelectionUI();
}

function refreshSelectionUI() {
  const objs = selectedObjects();
  el('inspector-empty').hidden = objs.length !== 0;
  el('inspector-multi').hidden = objs.length <= 1;
  el('inspector-form').hidden = objs.length !== 1;

  if (objs.length !== 1 || objs[0].id !== previewOutputObjectId) {
    previewOutputObjectId = null;
  }
  if (objs.length !== 1 || objs[0].id !== lastClickedHPatternNodeObjId) {
    lastClickedHPatternNodeId = null;
  }
  if (objs.length !== 1 || objs[0].id !== previewStateObjectId) {
    previewStateObjectId = null;
    previewStateName = null;
  }
  if (objs.length !== 1 || objs[0].id !== previewInputObjectId) {
    previewInputObjectId = null;
  }

  if (objs.length === 1) {
    updateInspectorFromObject(objs[0]);
  } else if (objs.length > 1) {
    el('multi-select-summary').textContent = `${objs.length} objects selected.`;
  }
  renderObjectList();
  render();
}

function updateInspectorFromObject(obj) {
  const isGroup = obj.type === 'group';
  const isSpawn = obj.type === 'player_spawn';
  const isZone = obj.type === 'leak_zone' || obj.type === 'fire_zone';
  const isScope = obj.type === 'scope';

  el('insp-name').value = obj.name;
  el('insp-id').value = obj.id;
  el('insp-x').value = Math.round(obj.x);
  el('insp-y').value = Math.round(obj.y);
  el('insp-rotation').value = obj.rotation;
  el('insp-scale-x').value = obj.scaleX;
  el('insp-scale-y').value = obj.scaleY;
  el('insp-scale-uniform').checked = !!obj.uniformScale;

  el('insp-type-section').hidden = isGroup || isZone;
  el('insp-anchor-section').hidden = isGroup || isSpawn || isZone;
  el('insp-shape-section').hidden = isGroup || isSpawn || isZone;
  el('insp-spawn-section').hidden = !isSpawn;
  el('insp-scope-section').hidden = !isScope;
  el('insp-zone-section').hidden = !isZone;
  el('insp-interaction-section').hidden = isGroup || isSpawn || isZone || isScope;
  el('insp-output-section').hidden = isGroup || isSpawn || isZone || isScope;
  el('insp-states-section').hidden = isGroup || isSpawn || isZone || isScope || (obj.toggleEnabled && obj.interaction === 'click');
  el('insp-binding-section').hidden = isGroup || isSpawn || isZone || isScope;
  el('ungroup-btn').hidden = !isGroup;

  if (isScope) {
    el('insp-scope-shape').value = obj.previewShape ?? 'circle';
    el('insp-scope-channel').value = obj.displayChannel ?? '';
    el('insp-scope-fill').value = obj.scopeFillFraction ?? 0.95;
    el('insp-scope-navmap-range').value = obj.navMapRange ?? 300;
    el('insp-scope-navmap-range-field').hidden = obj.displayChannel !== 'nav_map';
    el('insp-scope-sonar-range').value = obj.sonarRange ?? 200;
    el('insp-scope-sonar-pulse-speed').value = obj.sonarPulseSpeedScale ?? 0.25;
    el('insp-scope-sonar-range-field').hidden = obj.displayChannel !== 'sonar';
    el('insp-scope-tdc-range').value = obj.tdcRange ?? 1000;
    el('insp-scope-tdc-speed').value = obj.tdcSpeed ?? 20;
    el('insp-scope-tdc-turn-rate').value = obj.tdcTurnRate ?? 45;
    el('insp-scope-tdc-activation-distance').value = obj.tdcActivationDistance ?? 50;
    el('insp-scope-tdc-gyro-limit').value = obj.tdcGyroLimit ?? 90;
    el('insp-scope-tdc-fields').hidden = obj.displayChannel !== 'tdc';
    el('insp-scope-periscope-fov').value = obj.periscopeFov ?? 20;
    el('insp-scope-periscope-reference-distance').value = obj.periscopeReferenceDistance ?? 500;
    el('insp-scope-periscope-fields').hidden = obj.displayChannel !== 'periscope';
  }

  if (isSpawn) {
    el('insp-type').value = obj.type;
    el('insp-spawn-type').value = obj.spawnType ?? 'room_enter';
    populateStationTargetDropdown('insp-spawn-station-target');
    el('insp-spawn-station-target').value = obj.targetStationId ?? '';
    el('insp-spawn-station-field').hidden = (obj.spawnType ?? 'room_enter') !== 'station_link';
  }

  if (isZone) {
    el('insp-zone-radius').value = obj.radius ?? 20;
    el('zone-point-count').textContent = `${(obj.points ?? []).length} brush point(s)`;
  }

  if (!isGroup && !isSpawn && !isZone) {
    el('insp-anchor').value = obj.anchor ?? 'none';
    el('insp-anchor-offset-fields').hidden = !obj.anchor || obj.anchor === 'none';
    el('insp-anchor-offset-x').value = obj.anchorOffsetX ?? 0;
    el('insp-anchor-offset-y').value = obj.anchorOffsetY ?? 0;
    el('insp-type').value = obj.type;
    el('insp-width').value = obj.width;
    el('insp-height').value = obj.height;
    el('insp-color').value = obj.color;
    el('insp-pivot-x').value = obj.pivotX ?? 0.5;
    el('insp-pivot-y').value = obj.pivotY ?? 0.5;
    el('insp-interaction').value = obj.interaction;
    el('insp-hitbox-width').value = obj.hitboxWidth ?? defaultHitboxDimension(obj.width);
    el('insp-hitbox-height').value = obj.hitboxHeight ?? defaultHitboxDimension(obj.height);
    el('insp-hitbox-uniform').checked = !!obj.hitboxUniformScale;
    el('insp-hitbox-follow-scale').checked = !!obj.hitboxFollowScale;
    el('insp-hitbox-offset-x').value = obj.hitboxOffsetX ?? 0;
    el('insp-hitbox-offset-y').value = obj.hitboxOffsetY ?? 0;
    el('insp-axis').value = obj.axis;
    el('insp-min').value = obj.min;
    el('insp-max').value = obj.max;
    el('insp-reverse').checked = obj.reverse;
    el('insp-deadzone').value = (obj.dragDeadzone ?? 0) * 100;
    el('insp-spring-center').checked = !!obj.dragSpringToCenter;
    el('insp-toggle-enabled').checked = !!obj.toggleEnabled;
    el('insp-toggle-fields').hidden = !obj.toggleEnabled;
    el('insp-toggle-state-binding').value = obj.toggleStateBinding ?? '';
    el('insp-toggle-off-binding').value = obj.toggleOffBinding ?? '';
    el('insp-binding-label').textContent = obj.toggleEnabled ? 'ON Binding' : 'Binding';
    // Existing objects saved before this checkbox existed infer it from
    // whether their two bindings already happened to match, so they display
    // correctly without needing to be manually migrated.
    const singleBinding = obj.toggleSingleBinding ?? (!!obj.binding && obj.binding === obj.toggleOffBinding);
    el('insp-toggle-single-binding').checked = singleBinding;
    el('insp-toggle-off-binding-field').hidden = singleBinding;
    el('insp-toggle-default-state').value = obj.defaultVisualState === 'true' ? 'true' : 'false';
    if (obj.toggleEnabled) refreshToggleTextureFields(obj);
    el('insp-snap-enabled').checked = !!obj.snapEnabled;
    el('insp-snap-steps-field').hidden = !obj.snapEnabled;
    el('insp-snap-steps').value = obj.snapStops ? obj.snapStops.length : 3;
    refreshSnapStopsReadout(obj);
    el('insp-drag-rot-min').value = obj.dragRotationMin ?? -45;
    el('insp-drag-rot-max').value = obj.dragRotationMax ?? 45;
    el('insp-drag-infinite').checked = !!obj.dragInfinite;
    el('insp-drag-travel-min').value = obj.dragTravelMin ?? 0;
    el('insp-drag-travel-max').value = obj.dragTravelMax ?? 0;
    if (previewInputObjectId !== obj.id) {
      el('insp-drag-preview').value = 0;
    }
    if (obj.interaction === 'drag_h_pattern' && obj.hPatternNodes) {
      renderHPatternNodeList(obj);
    }
    el('insp-binding').value = obj.binding;
    el('insp-payload-key').value = obj.payloadKey ?? '';
    el('insp-extra-payload-key').value = obj.extraPayloadKey ?? '';
    el('insp-extra-payload-value').value = obj.extraPayloadValue ?? '';
    refreshBindingHint(obj.binding);
    populateStationTargetDropdown();
    el('insp-station-target').value = obj.targetStationId ?? '';
    el('insp-notes').value = obj.notes;
    refreshInteractionFieldVisibility(obj.interaction);

    el('insp-output-type').value = obj.outputType ?? 'none';
    el('insp-output-binding').value = obj.outputBinding ?? '';
    el('insp-output-min').value = obj.outputMin ?? 0;
    el('insp-output-max').value = obj.outputMax ?? 1;
    el('insp-output-rot-min').value = obj.outputRotationMin ?? -45;
    el('insp-output-rot-max').value = obj.outputRotationMax ?? 45;
    el('insp-output-smoothing').value = obj.outputSmoothingSeconds ?? 0.25;
    el('insp-output-wobble-binding').value = obj.outputWobbleBinding ?? '';
    el('insp-output-wobble-amplitude').value = obj.outputWobbleAmplitude ?? 8;
    el('insp-output-wobble-speed-scale').value = obj.outputWobbleSpeedScale ?? 0.25;
    el('insp-output-axis').value = obj.outputAxis ?? 'vertical';
    el('insp-output-travel-min').value = obj.outputTravelMin ?? 0;
    el('insp-output-travel-max').value = obj.outputTravelMax ?? 0;
    populateAssetDropdown('insp-output-alt-asset', obj.outputAltAssetId ?? '');
    if (previewOutputObjectId !== obj.id) {
      el('insp-output-preview').value = 0;
      el('insp-output-preview-toggle').checked = false;
    }
    refreshOutputFieldVisibility(obj.outputType ?? 'none');

    el('insp-states-enabled').checked = !!obj.statesEnabled;
    el('insp-states-fields').hidden = !obj.statesEnabled;
    el('insp-state-binding').value = obj.stateBinding ?? '';
    if (!obj.visualStates) obj.visualStates = [];
    renderStatesList(obj);
    if (obj.id !== previewStateObjectId) el('insp-state-preview').value = '';
  }

  const linkedInfo = el('prefab-linked-info');
  const pushBtn = el('push-prefab-btn');
  const unlinkBtn = el('unlink-prefab-btn');
  if (obj.prefabId && prefabs[obj.prefabId]) {
    linkedInfo.textContent = `Linked to prefab: ${prefabs[obj.prefabId].name}`;
    pushBtn.hidden = false;
    unlinkBtn.hidden = false;
  } else {
    linkedInfo.textContent = 'Not linked to a prefab.';
    pushBtn.hidden = true;
    unlinkBtn.hidden = true;
  }
}

// A touch target should be comfortably tappable even when the sprite
// itself is tiny - padded out from the visual size, with a sensible
// minimum (roughly the standard ~44px mobile touch-target guideline).
function defaultHitboxDimension(visualSize) {
  return Math.max((visualSize || 0) + 20, 44);
}

// --- H-pattern shifter node graph ------------------------------------------
//
// A free-form graph of nodes (positions offset from the object's own x,y)
// connected by edges - not a fixed rails-and-crossbar shape, so any layout
// (a real H, a T, a star, whatever the control actually needs) can be built
// by hand. hPatternActiveNode is the node the control currently rests at;
// hPatternEdges is exported so the game can constrain a real drag gesture
// to only move along the drawn connections, the same way a physical shifter
// can't cut across from one gate to another without passing through neutral.

function makeHPatternNodeId(obj) {
  let n = (obj.hPatternNodes || []).length + 1;
  const existing = new Set((obj.hPatternNodes || []).map((node) => node.id));
  while (existing.has(`n${n}`)) n += 1;
  return `n${n}`;
}

function addHPatternNode(obj) {
  pushUndoSnapshot();
  const id = makeHPatternNodeId(obj);
  const count = obj.hPatternNodes.length;
  obj.hPatternNodes.push({ id, x: -30 + (count % 4) * 20, y: 20 + Math.floor(count / 4) * 20, value: count });
  renderHPatternNodeList(obj);
  render();
  scheduleSave();
}

function deleteHPatternNode(obj, nodeId) {
  pushUndoSnapshot();
  obj.hPatternNodes = obj.hPatternNodes.filter((n) => n.id !== nodeId);
  obj.hPatternEdges = obj.hPatternEdges.filter(([a, b]) => a !== nodeId && b !== nodeId);
  if (obj.hPatternActiveNode === nodeId) obj.hPatternActiveNode = obj.hPatternNodes[0]?.id ?? null;
  renderHPatternNodeList(obj);
  render();
  scheduleSave();
}

function toggleHPatternEdge(obj, idA, idB) {
  if (idA === idB) return;
  pushUndoSnapshot();
  const existingIndex = obj.hPatternEdges.findIndex(
    ([a, b]) => (a === idA && b === idB) || (a === idB && b === idA),
  );
  if (existingIndex !== -1) obj.hPatternEdges.splice(existingIndex, 1);
  else obj.hPatternEdges.push([idA, idB]);
  renderHPatternNodeList(obj);
  render();
  scheduleSave();
}

function hPatternEdgeExists(obj, idA, idB) {
  return (obj.hPatternEdges || []).some(([a, b]) => (a === idA && b === idB) || (a === idB && b === idA));
}

function renderHPatternNodeList(obj) {
  const listEl = el('hpattern-node-list');
  listEl.innerHTML = '';
  obj.hPatternNodes.forEach((node) => {
    const row = document.createElement('div');
    row.className = 'hpattern-node-row';

    const label = document.createElement('span');
    label.textContent = node.id === obj.hPatternActiveNode ? `${node.id}*` : node.id;
    label.title = 'Active/rest node marked with *';

    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.value = node.value ?? '';
    valueInput.title = 'Value exported to the game for this position - a number (e.g. 2) or a string (e.g. forward)';
    valueInput.addEventListener('focus', () => { valueInput.dataset.snapshotted = ''; });
    valueInput.addEventListener('input', () => {
      if (!valueInput.dataset.snapshotted) {
        pushUndoSnapshot();
        valueInput.dataset.snapshotted = '1';
      }
      const raw = valueInput.value;
      const num = Number(raw);
      node.value = raw.trim() !== '' && !Number.isNaN(num) ? num : raw;
      scheduleSave();
    });

    const defaultBtn = document.createElement('button');
    defaultBtn.textContent = 'Set as Default';
    defaultBtn.title = 'Starting position - where this control rests when the room loads, before anyone has touched it';
    defaultBtn.disabled = node.id === obj.hPatternActiveNode;
    defaultBtn.addEventListener('click', () => {
      pushUndoSnapshot();
      obj.hPatternActiveNode = node.id;
      renderHPatternNodeList(obj);
      render();
      scheduleSave();
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.disabled = obj.hPatternNodes.length <= 1;
    deleteBtn.addEventListener('click', () => deleteHPatternNode(obj, node.id));

    row.appendChild(label);
    row.appendChild(valueInput);
    row.appendChild(defaultBtn);
    row.appendChild(deleteBtn);
    listEl.appendChild(row);

    const others = obj.hPatternNodes.filter((n) => n.id !== node.id);
    if (others.length) {
      const connectRow = document.createElement('div');
      connectRow.className = 'hpattern-connect-row';

      const connectLabel = document.createElement('span');
      connectLabel.textContent = 'Connect:';
      connectRow.appendChild(connectLabel);

      others.forEach((other) => {
        const btn = document.createElement('button');
        const connected = hPatternEdgeExists(obj, node.id, other.id);
        btn.textContent = other.id;
        btn.className = connected ? 'hpattern-edge-btn connected' : 'hpattern-edge-btn';
        btn.title = connected ? `Disconnect from ${other.id}` : `Connect to ${other.id}`;
        btn.addEventListener('click', () => toggleHPatternEdge(obj, node.id, other.id));
        connectRow.appendChild(btn);
      });

      listEl.appendChild(connectRow);
    }
  });
}

el('hpattern-add-node-btn').addEventListener('click', () => {
  const objs = selectedObjects();
  if (objs.length === 1) addHPatternNode(objs[0]);
});

function refreshInteractionFieldVisibility(type) {
  el('insp-hitbox-section').hidden = type === 'none';
  const isDrag = type === 'drag_linear' || type === 'drag_rotate';
  el('insp-linear-fields').hidden = type !== 'drag_linear';
  el('insp-range-fields').hidden = !isDrag;
  el('insp-reverse-field').hidden = !isDrag;
  el('insp-deadzone-field').hidden = !isDrag;
  el('deadzone-hint').hidden = !isDrag;
  el('insp-spring-center-field').hidden = !isDrag;
  el('spring-center-hint').hidden = !isDrag;
  el('insp-snap-field').hidden = !isDrag;
  el('insp-drag-rotate-fields').hidden = type !== 'drag_rotate';
  el('insp-drag-linear-fields').hidden = type !== 'drag_linear';
  el('insp-drag-preview-field').hidden = !isDrag;
  el('insp-toggle-enabled-field').hidden = type !== 'click';
  if (type !== 'click') el('insp-toggle-fields').hidden = true;
  el('insp-station-target-field').hidden = type !== 'open_station';
  el('insp-hpattern-fields').hidden = type !== 'drag_h_pattern';
  el('insp-binding-field').hidden = type === 'open_station';
}

function populateStationTargetDropdown(elementId = 'insp-station-target') {
  const select = el(elementId);
  const stations = ensureRoomStations(currentRoom());
  const previous = select.value;
  select.innerHTML = '<option value="">(choose a station)</option>';
  Object.values(stations).forEach((station) => {
    const opt = document.createElement('option');
    opt.value = station.id;
    opt.textContent = station.name;
    select.appendChild(opt);
  });
  select.value = previous;
}

// Hidden (per-asset, or via its category) means "leave this out of every
// Binding-side dropdown" - reversible clutter control, not deletion. The
// currently-assigned value is always kept as an option even if hidden, so
// hiding an asset never silently blanks out a control already using it.
function isAssetHiddenFromDropdowns(asset) {
  if (!asset) return false;
  return !!asset.hidden || hiddenCategories.has(asset.category || 'Uncategorized');
}

// targetValue: the id this dropdown is ABOUT to be set to, when the caller
// is programmatically assigning a new value in the same breath (e.g. the
// Flipped Texture auto-fill) rather than just re-rendering the existing
// selection. Without this, the "keep the current value visible even if
// hidden" check below would only ever protect the OLD value still sitting
// in the DOM (select.value, read before the caller's own assignment lands),
// so a hidden target asset would get filtered out and the follow-up
// `select.value = newId` would silently fail to match any option.
function populateAssetDropdown(elementId, targetValue) {
  const select = el(elementId);
  const keep = targetValue !== undefined ? targetValue : select.value;
  select.innerHTML = '<option value="">(none)</option>';
  Object.values(assets).forEach((asset) => {
    if (isAssetHiddenFromDropdowns(asset) && asset.id !== keep) return;
    const opt = document.createElement('option');
    opt.value = asset.id;
    opt.textContent = asset.name;
    select.appendChild(opt);
  });
  select.value = keep ?? '';
}

// A toggle switch's ON/OFF textures are just its own visualStates entries
// named "true"/"false" under the hood - these two functions are the only
// place that shape gets read from/written to, so the Toggle Switch fields
// stay the single source of truth without the author ever needing to open
// the separate Visual States section for a plain two-state switch.
function refreshToggleTextureFields(obj) {
  const onState = (obj.visualStates || []).find((s) => s.name === 'true');
  const offState = (obj.visualStates || []).find((s) => s.name === 'false');
  populateAssetDropdown('insp-toggle-on-texture', onState && onState.assetId ? onState.assetId : '');
  populateAssetDropdown('insp-toggle-off-texture', offState && offState.assetId ? offState.assetId : '');
  el('insp-toggle-on-rotation').value = onState?.rotationOffset ?? 0;
  el('insp-toggle-off-rotation').value = offState?.rotationOffset ?? 0;
}

function ensureToggleStates(obj) {
  if (!obj.visualStates) obj.visualStates = [];
  ['true', 'false'].forEach((name) => {
    if (!obj.visualStates.some((s) => s.name === name)) {
      obj.visualStates.push({ name, assetId: obj.assetId ?? null, rotationOffset: 0, opacity: 1, visible: true });
    }
  });
}

function setToggleTexture(obj, stateName, assetId) {
  ensureToggleStates(obj);
  const state = obj.visualStates.find((s) => s.name === stateName);
  state.assetId = assetId || obj.assetId;
}

// Reuses the same one sprite at a different angle for ON vs OFF instead of
// needing a second, visually-flipped texture - added on top of the object's
// own authored Rotation, same mechanism as a Visual State's own Rotation
// field (see renderStatesList), just surfaced here so a toggle never needs
// the separate Visual States section it deliberately stays hidden behind.
function setToggleRotation(obj, stateName, rotationOffset) {
  ensureToggleStates(obj);
  const state = obj.visualStates.find((s) => s.name === stateName);
  state.rotationOffset = rotationOffset;
}

function refreshOutputFieldVisibility(type) {
  el('insp-output-fields').hidden = type === 'none';
  el('insp-output-rotate-fields').hidden = type !== 'rotate';
  el('insp-output-linear-fields').hidden = type !== 'linear';
  el('insp-output-texture-fields').hidden = type !== 'texture';
  // A texture swap is a binary toggle, not a ranged value - no min/max to
  // map, and a checkbox previews it instead of the continuous range slider.
  el('insp-output-range-field').hidden = type === 'texture';
  el('insp-output-preview-field').hidden = type === 'texture';
  el('insp-output-preview-toggle-field').hidden = type !== 'texture';
}

// --- Visual states -----------------------------------------------------
//
// A named set of appearance overrides (sprite/visibility/opacity) driven by
// one game value - e.g. a fuse's NORMAL/BLOWN sprites, or a hull panel's
// NORMAL/DAMAGED/BROKEN progression. Broader than the binary output texture
// swap above (any number of states, and can also hide the object entirely),
// and available on any non-group object regardless of its interaction type.

function getActiveVisualState(obj) {
  if (!obj.statesEnabled || !obj.visualStates || !obj.visualStates.length) return null;
  const name = obj.id === previewStateObjectId && previewStateName ? previewStateName : obj.defaultVisualState;
  return obj.visualStates.find((s) => s.name === name) || obj.visualStates[0];
}

function makeStateName(obj) {
  let n = (obj.visualStates || []).length + 1;
  const existing = new Set((obj.visualStates || []).map((s) => s.name));
  while (existing.has(`STATE_${n}`)) n += 1;
  return `STATE_${n}`;
}

function addVisualState(obj) {
  pushUndoSnapshot();
  const name = obj.visualStates.length === 0 ? 'NORMAL' : makeStateName(obj);
  obj.visualStates.push({ name, assetId: obj.assetId ?? null, color: obj.color ?? null, rotationOffset: 0, opacity: 1, visible: true });
  if (!obj.defaultVisualState) obj.defaultVisualState = name;
  renderStatesList(obj);
  render();
  scheduleSave();
}

function deleteVisualState(obj, name) {
  pushUndoSnapshot();
  obj.visualStates = obj.visualStates.filter((s) => s.name !== name);
  if (obj.defaultVisualState === name) obj.defaultVisualState = obj.visualStates[0]?.name ?? null;
  renderStatesList(obj);
  refreshStatePreviewDropdown(obj);
  render();
  scheduleSave();
}

function setDefaultVisualState(obj, name) {
  pushUndoSnapshot();
  obj.defaultVisualState = name;
  renderStatesList(obj);
  render();
  scheduleSave();
}

function refreshStatePreviewDropdown(obj) {
  const select = el('insp-state-preview');
  const previous = select.value;
  select.innerHTML = '<option value="">(default resting state)</option>';
  obj.visualStates.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.name;
    opt.textContent = s.name;
    select.appendChild(opt);
  });
  select.value = obj.id === previewStateObjectId ? previous : '';
}

function renderStatesList(obj) {
  const listEl = el('states-list');
  listEl.innerHTML = '';
  obj.visualStates.forEach((state) => {
    const row = document.createElement('div');
    row.className = 'state-row' + (state.name === obj.defaultVisualState ? ' is-default' : '');

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = state.name;
    nameInput.title = 'State name (matches a game-side state value)';
    nameInput.addEventListener('focus', () => { nameInput.dataset.snapshotted = ''; });
    nameInput.addEventListener('input', () => {
      if (!nameInput.dataset.snapshotted) {
        pushUndoSnapshot();
        nameInput.dataset.snapshotted = '1';
      }
      const oldName = state.name;
      const newName = nameInput.value.trim() || oldName;
      if (obj.defaultVisualState === oldName) obj.defaultVisualState = newName;
      state.name = newName;
      scheduleSave();
    });

    const assetSelect = document.createElement('select');
    assetSelect.title = 'Sprite for this state';
    Object.values(assets).forEach((asset) => {
      if (isAssetHiddenFromDropdowns(asset) && asset.id !== state.assetId) return;
      const opt = document.createElement('option');
      opt.value = asset.id;
      opt.textContent = asset.name;
      assetSelect.appendChild(opt);
    });
    const blankOpt = document.createElement('option');
    blankOpt.value = '';
    blankOpt.textContent = '(none)';
    assetSelect.insertBefore(blankOpt, assetSelect.firstChild);
    assetSelect.value = state.assetId ?? '';
    assetSelect.addEventListener('focus', () => { assetSelect.dataset.snapshotted = ''; });
    assetSelect.addEventListener('change', () => {
      if (!assetSelect.dataset.snapshotted) {
        pushUndoSnapshot();
        assetSelect.dataset.snapshotted = '1';
      }
      state.assetId = assetSelect.value || null;
      render();
      scheduleSave();
    });

    // Fallback fill used whenever this state has no sprite (assetId) picked
    // above - lets a state be a plain color, e.g. an indicator light's
    // empty/loaded/armed colors, without needing a texture asset per state.
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.title = 'Color (used when this state has no sprite)';
    colorInput.value = state.color || obj.color || '#4caf50';
    colorInput.addEventListener('focus', () => { colorInput.dataset.snapshotted = ''; });
    colorInput.addEventListener('input', () => {
      if (!colorInput.dataset.snapshotted) {
        pushUndoSnapshot();
        colorInput.dataset.snapshotted = '1';
      }
      state.color = colorInput.value;
      render();
      scheduleSave();
    });

    // Lets a state reuse the SAME sprite as another state, just turned - a
    // lever's up/down position or a switch's sideways/upright position is
    // often really one piece of art at two rotations, not two separate
    // textures. Added on top of the object's own authored rotation, not in
    // place of it.
    const rotationInput = document.createElement('input');
    rotationInput.type = 'number';
    rotationInput.step = '15';
    rotationInput.value = state.rotationOffset ?? 0;
    rotationInput.title = 'Rotation offset° (added to the object\'s own rotation) - e.g. 90 or 180 to reuse one sprite turned instead of needing a separate texture';
    rotationInput.addEventListener('focus', () => { rotationInput.dataset.snapshotted = ''; });
    rotationInput.addEventListener('input', () => {
      if (!rotationInput.dataset.snapshotted) {
        pushUndoSnapshot();
        rotationInput.dataset.snapshotted = '1';
      }
      state.rotationOffset = parseFloat(rotationInput.value);
      if (Number.isNaN(state.rotationOffset)) state.rotationOffset = 0;
      render();
      scheduleSave();
    });

    const opacityInput = document.createElement('input');
    opacityInput.type = 'number';
    opacityInput.min = '0';
    opacityInput.max = '1';
    opacityInput.step = '0.1';
    opacityInput.value = state.opacity ?? 1;
    opacityInput.title = 'Opacity';
    opacityInput.addEventListener('focus', () => { opacityInput.dataset.snapshotted = ''; });
    opacityInput.addEventListener('input', () => {
      if (!opacityInput.dataset.snapshotted) {
        pushUndoSnapshot();
        opacityInput.dataset.snapshotted = '1';
      }
      state.opacity = parseFloat(opacityInput.value);
      if (Number.isNaN(state.opacity)) state.opacity = 1;
      render();
      scheduleSave();
    });

    const visibleLabel = document.createElement('label');
    visibleLabel.title = 'Visible in this state';
    const visibleCb = document.createElement('input');
    visibleCb.type = 'checkbox';
    visibleCb.checked = state.visible !== false;
    visibleCb.addEventListener('change', () => {
      pushUndoSnapshot();
      state.visible = visibleCb.checked;
      render();
      scheduleSave();
    });
    visibleLabel.appendChild(visibleCb);

    const defaultBtn = document.createElement('button');
    defaultBtn.textContent = 'Default';
    defaultBtn.disabled = state.name === obj.defaultVisualState;
    defaultBtn.addEventListener('click', () => setDefaultVisualState(obj, state.name));

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => deleteVisualState(obj, state.name));

    row.appendChild(nameInput);
    row.appendChild(assetSelect);
    row.appendChild(colorInput);
    row.appendChild(rotationInput);
    row.appendChild(opacityInput);
    row.appendChild(visibleLabel);
    row.appendChild(defaultBtn);
    row.appendChild(deleteBtn);
    listEl.appendChild(row);
  });

  refreshStatePreviewDropdown(obj);
}

el('add-state-btn').addEventListener('click', () => {
  const objs = selectedObjects();
  if (objs.length === 1) addVisualState(objs[0]);
});

el('insp-state-preview').addEventListener('change', (event) => {
  const objs = selectedObjects();
  if (objs.length !== 1) return;
  previewStateObjectId = objs[0].id;
  previewStateName = event.target.value || null;
  render();
});

function bindInspectorField(elementId, applyFn) {
  let snapshottedThisEdit = false;
  el(elementId).addEventListener('focus', () => {
    snapshottedThisEdit = false;
  });
  el(elementId).addEventListener('input', () => {
    const objs = selectedObjects();
    if (objs.length !== 1) return;
    if (!snapshottedThisEdit) {
      pushUndoSnapshot();
      snapshottedThisEdit = true;
    }
    applyFn(objs[0], el(elementId));
    render();
    scheduleSave();
  });
}

bindInspectorField('insp-name', (obj, input) => {
  obj.name = input.value;
  renderObjectList();
});
bindInspectorField('insp-id', (obj, input) => {
  const newId = input.value.trim();
  if (!newId || newId === obj.id) return;
  if (currentContainer().objects.some((o) => o !== obj && o.id === newId)) {
    alert('An object with that ID already exists in this room.');
    input.value = obj.id;
    return;
  }
  obj.id = newId;
  selectedIds = new Set([newId]);
});
bindInspectorField('insp-type', (obj, input) => {
  obj.type = input.value;
  if (obj.type === 'player_spawn' && !obj.spawnType) obj.spawnType = 'room_enter';
  updateInspectorFromObject(obj);
});
bindInspectorField('insp-x', (obj, input) => { obj.x = parseFloat(input.value) || 0; });
bindInspectorField('insp-y', (obj, input) => { obj.y = parseFloat(input.value) || 0; });
bindInspectorField('insp-rotation', (obj, input) => { obj.rotation = parseFloat(input.value) || 0; });
// When Follow Object Scale is on, a change to the object's own Scale X/Y
// multiplies the hitbox's Width/Height by that same change ratio, keeping
// the tap/drag target growing and shrinking along with the sprite instead
// of needing to be adjusted by hand every time the object is resized.
function applyHitboxFollowScale(obj, axis, oldScale, newScale) {
  if (!obj.hitboxFollowScale || !obj.hitboxWidth || !oldScale) return;
  const ratio = newScale / oldScale;
  if (axis === 'x') {
    obj.hitboxWidth = Math.max(1, obj.hitboxWidth * ratio);
    el('insp-hitbox-width').value = obj.hitboxWidth;
  } else {
    obj.hitboxHeight = Math.max(1, obj.hitboxHeight * ratio);
    el('insp-hitbox-height').value = obj.hitboxHeight;
  }
}
bindInspectorField('insp-scale-x', (obj, input) => {
  const oldScaleX = obj.scaleX || 1;
  obj.scaleX = parseFloat(input.value) || 1;
  applyHitboxFollowScale(obj, 'x', oldScaleX, obj.scaleX);
  if (obj.uniformScale) {
    const oldScaleY = obj.scaleY || 1;
    obj.scaleY = obj.scaleX;
    el('insp-scale-y').value = obj.scaleY;
    applyHitboxFollowScale(obj, 'y', oldScaleY, obj.scaleY);
  }
});
bindInspectorField('insp-scale-y', (obj, input) => {
  const oldScaleY = obj.scaleY || 1;
  obj.scaleY = parseFloat(input.value) || 1;
  applyHitboxFollowScale(obj, 'y', oldScaleY, obj.scaleY);
  if (obj.uniformScale) {
    const oldScaleX = obj.scaleX || 1;
    obj.scaleX = obj.scaleY;
    el('insp-scale-x').value = obj.scaleX;
    applyHitboxFollowScale(obj, 'x', oldScaleX, obj.scaleX);
  }
});
bindInspectorField('insp-scale-uniform', (obj, input) => {
  obj.uniformScale = input.checked;
  if (obj.uniformScale) {
    const oldScaleY = obj.scaleY || 1;
    obj.scaleY = obj.scaleX;
    el('insp-scale-y').value = obj.scaleY;
    applyHitboxFollowScale(obj, 'y', oldScaleY, obj.scaleY);
  }
});
bindInspectorField('insp-hitbox-follow-scale', (obj, input) => {
  obj.hitboxFollowScale = input.checked;
  // Checking this only wires up FUTURE Scale X/Y edits (via
  // applyHitboxFollowScale above) - with no immediate effect of its own, it
  // looked like the checkbox did nothing whenever the object was already
  // scaled away from 1 before turning this on. Syncing once, right away,
  // catches the hitbox up to whatever scale is already set.
  if (obj.hitboxFollowScale && obj.hitboxWidth) {
    obj.hitboxWidth = Math.max(1, obj.hitboxWidth * (obj.scaleX || 1));
    obj.hitboxHeight = Math.max(1, obj.hitboxHeight * (obj.scaleY || 1));
    el('insp-hitbox-width').value = obj.hitboxWidth;
    el('insp-hitbox-height').value = obj.hitboxHeight;
  }
});
bindInspectorField('insp-anchor', (obj, input) => {
  obj.anchor = input.value;
  if (obj.anchor !== 'none' && ANCHOR_POINTS[obj.anchor] && obj.anchorOffsetX == null) {
    // Default the offset so switching anchor mode never visually jumps the
    // object in the normal (non-preview) view - it resolves back to the
    // exact same position until you actually pick a device to preview.
    const [ax, ay] = ANCHOR_POINTS[obj.anchor];
    obj.anchorOffsetX = obj.x - ax * ROOM_WIDTH;
    obj.anchorOffsetY = obj.y - ay * ROOM_HEIGHT;
  }
  el('insp-anchor-offset-fields').hidden = obj.anchor === 'none';
  el('insp-anchor-offset-x').value = obj.anchorOffsetX ?? 0;
  el('insp-anchor-offset-y').value = obj.anchorOffsetY ?? 0;
  render();
});
bindInspectorField('insp-anchor-offset-x', (obj, input) => { obj.anchorOffsetX = parseFloat(input.value) || 0; });
bindInspectorField('insp-anchor-offset-y', (obj, input) => { obj.anchorOffsetY = parseFloat(input.value) || 0; });

bindInspectorField('insp-width', (obj, input) => { obj.width = parseFloat(input.value) || 1; });
bindInspectorField('insp-height', (obj, input) => { obj.height = parseFloat(input.value) || 1; });
bindInspectorField('insp-color', (obj, input) => { obj.color = input.value; });
bindInspectorField('insp-scope-shape', (obj, input) => { obj.previewShape = input.value; });
bindInspectorField('insp-scope-channel', (obj, input) => {
  obj.displayChannel = input.value;
  el('insp-scope-navmap-range-field').hidden = obj.displayChannel !== 'nav_map';
  el('insp-scope-sonar-range-field').hidden = obj.displayChannel !== 'sonar';
  el('insp-scope-tdc-fields').hidden = obj.displayChannel !== 'tdc';
  el('insp-scope-periscope-fields').hidden = obj.displayChannel !== 'periscope';
});
bindInspectorField('insp-scope-fill', (obj, input) => { obj.scopeFillFraction = parseFloat(input.value) || 0.95; });
bindInspectorField('insp-scope-navmap-range', (obj, input) => { obj.navMapRange = parseFloat(input.value) || 300; });
bindInspectorField('insp-scope-sonar-range', (obj, input) => { obj.sonarRange = parseFloat(input.value) || 200; });
bindInspectorField('insp-scope-sonar-pulse-speed', (obj, input) => { obj.sonarPulseSpeedScale = parseFloat(input.value) || 0.25; });
bindInspectorField('insp-scope-tdc-range', (obj, input) => { obj.tdcRange = parseFloat(input.value) || 1000; });
bindInspectorField('insp-scope-tdc-speed', (obj, input) => { obj.tdcSpeed = parseFloat(input.value) || 20; });
bindInspectorField('insp-scope-tdc-turn-rate', (obj, input) => { obj.tdcTurnRate = parseFloat(input.value) || 45; });
bindInspectorField('insp-scope-tdc-activation-distance', (obj, input) => { obj.tdcActivationDistance = parseFloat(input.value) || 0; });
bindInspectorField('insp-scope-tdc-gyro-limit', (obj, input) => { obj.tdcGyroLimit = parseFloat(input.value) || 90; });
bindInspectorField('insp-scope-periscope-fov', (obj, input) => { obj.periscopeFov = parseFloat(input.value) || 20; });
bindInspectorField('insp-scope-periscope-reference-distance', (obj, input) => { obj.periscopeReferenceDistance = parseFloat(input.value) || 500; });
bindInspectorField('insp-pivot-x', (obj, input) => { obj.pivotX = parseFloat(input.value); if (Number.isNaN(obj.pivotX)) obj.pivotX = 0.5; });
bindInspectorField('insp-pivot-y', (obj, input) => { obj.pivotY = parseFloat(input.value); if (Number.isNaN(obj.pivotY)) obj.pivotY = 0.5; });
bindInspectorField('insp-interaction', (obj, input) => {
  obj.interaction = input.value;
  if (input.value !== 'none' && !obj.hitboxWidth) {
    obj.hitboxWidth = defaultHitboxDimension(obj.width);
    obj.hitboxHeight = defaultHitboxDimension(obj.height);
    obj.hitboxOffsetX = 0;
    obj.hitboxOffsetY = 0;
  }
  if (input.value === 'drag_h_pattern' && (!obj.hPatternNodes || !obj.hPatternNodes.length)) {
    obj.hPatternNodes = [
      { id: 'n1', x: -30, y: -20, value: 0 },
      { id: 'n2', x: 30, y: -20, value: 1 },
    ];
    obj.hPatternEdges = [['n1', 'n2']];
    obj.hPatternActiveNode = 'n1';
  }
  refreshInteractionFieldVisibility(input.value);
  updateInspectorFromObject(obj);
});
bindInspectorField('insp-hitbox-width', (obj, input) => {
  const newWidth = parseFloat(input.value) || 1;
  if (obj.hitboxUniformScale && obj.hitboxWidth) {
    obj.hitboxHeight = Math.max(1, obj.hitboxHeight * (newWidth / obj.hitboxWidth));
    el('insp-hitbox-height').value = obj.hitboxHeight;
  }
  obj.hitboxWidth = newWidth;
});
bindInspectorField('insp-hitbox-height', (obj, input) => {
  const newHeight = parseFloat(input.value) || 1;
  if (obj.hitboxUniformScale && obj.hitboxHeight) {
    obj.hitboxWidth = Math.max(1, obj.hitboxWidth * (newHeight / obj.hitboxHeight));
    el('insp-hitbox-width').value = obj.hitboxWidth;
  }
  obj.hitboxHeight = newHeight;
});
bindInspectorField('insp-hitbox-uniform', (obj, input) => { obj.hitboxUniformScale = input.checked; });
bindInspectorField('insp-hitbox-offset-x', (obj, input) => { obj.hitboxOffsetX = parseFloat(input.value) || 0; });
bindInspectorField('insp-hitbox-offset-y', (obj, input) => { obj.hitboxOffsetY = parseFloat(input.value) || 0; });
bindInspectorField('insp-axis', (obj, input) => { obj.axis = input.value; });
bindInspectorField('insp-min', (obj, input) => { obj.min = parseFloat(input.value) || 0; });
bindInspectorField('insp-max', (obj, input) => { obj.max = parseFloat(input.value) || 0; });
bindInspectorField('insp-reverse', (obj, input) => { obj.reverse = input.checked; });
bindInspectorField('insp-deadzone', (obj, input) => {
  obj.dragDeadzone = Math.max(0, Math.min(50, parseFloat(input.value) || 0)) / 100;
});
bindInspectorField('insp-spring-center', (obj, input) => { obj.dragSpringToCenter = input.checked; });
bindInspectorField('insp-toggle-enabled', (obj, input) => {
  obj.toggleEnabled = input.checked;
  el('insp-toggle-fields').hidden = !obj.toggleEnabled;
  el('insp-binding-label').textContent = obj.toggleEnabled ? 'ON Binding' : 'Binding';
  el('insp-states-section').hidden = obj.toggleEnabled;
  if (obj.toggleEnabled) {
    // A toggle switch always drives its own two-state visuals - own it
    // entirely here instead of asking the author to also visit the
    // separate Visual States section and get the state names ("true"/
    // "false") exactly right by hand.
    obj.statesEnabled = true;
    obj.stateBinding = obj.toggleStateBinding || obj.stateBinding || '';
    if (!obj.visualStates || !obj.visualStates.length) {
      obj.visualStates = [
        { name: 'false', assetId: obj.assetId ?? null, rotationOffset: 0, opacity: 1, visible: true },
        { name: 'true', assetId: obj.assetId ?? null, rotationOffset: 0, opacity: 1, visible: true },
      ];
    }
    obj.defaultVisualState = 'false';
    // Recommended default: the common case (SET_ELECTRIC_MOTOR, SET_CHARGING,
    // SET_BILGE_PUMP, ...) is one action with a boolean payload, not two
    // separate actions - so a freshly-enabled toggle starts in single-binding
    // mode and only needs the one Binding field filled in above.
    obj.toggleSingleBinding = true;
    obj.toggleOffBinding = obj.binding || '';
    el('insp-toggle-single-binding').checked = true;
    el('insp-toggle-off-binding-field').hidden = true;
    refreshToggleTextureFields(obj);
  }
});
bindInspectorField('insp-toggle-state-binding', (obj, input) => {
  obj.toggleStateBinding = input.value;
  obj.stateBinding = input.value;
});
bindInspectorField('insp-toggle-single-binding', (obj, input) => {
  obj.toggleSingleBinding = input.checked;
  if (obj.toggleSingleBinding) obj.toggleOffBinding = obj.binding || '';
  el('insp-toggle-off-binding-field').hidden = obj.toggleSingleBinding;
  el('insp-toggle-off-binding').value = obj.toggleOffBinding ?? '';
});
bindInspectorField('insp-toggle-off-binding', (obj, input) => { obj.toggleOffBinding = input.value; });
bindInspectorField('insp-toggle-default-state', (obj, input) => { obj.defaultVisualState = input.value; });
bindInspectorField('insp-toggle-on-texture', (obj, input) => { setToggleTexture(obj, 'true', input.value); });
bindInspectorField('insp-toggle-off-texture', (obj, input) => { setToggleTexture(obj, 'false', input.value); });
bindInspectorField('insp-toggle-on-rotation', (obj, input) => { setToggleRotation(obj, 'true', parseFloat(input.value) || 0); });
bindInspectorField('insp-toggle-off-rotation', (obj, input) => { setToggleRotation(obj, 'false', parseFloat(input.value) || 0); });
bindInspectorField('insp-snap-enabled', (obj, input) => {
  obj.snapEnabled = input.checked;
  if (obj.snapEnabled && (!obj.snapStops || obj.snapStops.length < 2)) {
    obj.snapStops = regenerateSnapStops(3);
  }
  el('insp-snap-steps').value = obj.snapStops.length;
  el('insp-snap-steps-field').hidden = !obj.snapEnabled;
  refreshSnapStopsReadout(obj);
});
bindInspectorField('insp-snap-steps', (obj, input) => {
  obj.snapStops = regenerateSnapStops(parseInt(input.value, 10));
  input.value = obj.snapStops.length;
  refreshSnapStopsReadout(obj);
});

bindInspectorField('insp-drag-rot-min', (obj, input) => { obj.dragRotationMin = parseFloat(input.value) || 0; });
bindInspectorField('insp-drag-rot-max', (obj, input) => { obj.dragRotationMax = parseFloat(input.value) || 0; });
bindInspectorField('insp-drag-infinite', (obj, input) => { obj.dragInfinite = input.checked; });
bindInspectorField('insp-drag-travel-min', (obj, input) => { obj.dragTravelMin = parseFloat(input.value) || 0; });
bindInspectorField('insp-drag-travel-max', (obj, input) => { obj.dragTravelMax = parseFloat(input.value) || 0; });
bindInspectorField('insp-binding', (obj, input) => {
  obj.binding = input.value;
  applyKnownActionDefaults(obj);
  refreshBindingHint(obj.binding);
  if (obj.toggleEnabled && obj.toggleSingleBinding) {
    obj.toggleOffBinding = obj.binding;
    el('insp-toggle-off-binding').value = obj.toggleOffBinding;
  }
});
bindInspectorField('insp-payload-key', (obj, input) => { obj.payloadKey = input.value.trim(); });
bindInspectorField('insp-extra-payload-key', (obj, input) => { obj.extraPayloadKey = input.value.trim(); });
bindInspectorField('insp-extra-payload-value', (obj, input) => {
  const raw = input.value;
  const num = Number(raw);
  obj.extraPayloadValue = raw.trim() !== '' && !Number.isNaN(num) ? num : raw;
});
bindInspectorField('insp-station-target', (obj, input) => { obj.targetStationId = input.value; });
bindInspectorField('insp-notes', (obj, input) => { obj.notes = input.value; });

bindInspectorField('insp-spawn-type', (obj, input) => {
  obj.spawnType = input.value;
  el('insp-spawn-station-field').hidden = input.value !== 'station_link';
});
bindInspectorField('insp-spawn-station-target', (obj, input) => { obj.targetStationId = input.value; });

bindInspectorField('insp-zone-radius', (obj, input) => { obj.radius = parseFloat(input.value) || 1; });

bindInspectorField('insp-output-type', (obj, input) => {
  obj.outputType = input.value;
  refreshOutputFieldVisibility(input.value);
  // Convenience default: most texture-swap toggles start out just showing
  // their own current sprite for both states until the author picks an
  // actually different one, rather than opening on a blank "(none)".
  if (obj.outputType === 'texture' && !obj.outputAltAssetId) {
    obj.outputAltAssetId = obj.assetId ?? null;
    populateAssetDropdown('insp-output-alt-asset', obj.outputAltAssetId ?? '');
  }
});
bindInspectorField('insp-output-binding', (obj, input) => { obj.outputBinding = input.value; });
bindInspectorField('insp-output-min', (obj, input) => { obj.outputMin = parseFloat(input.value) || 0; });
bindInspectorField('insp-output-max', (obj, input) => { obj.outputMax = parseFloat(input.value) || 0; });
bindInspectorField('insp-output-rot-min', (obj, input) => { obj.outputRotationMin = parseFloat(input.value) || 0; });
bindInspectorField('insp-output-rot-max', (obj, input) => { obj.outputRotationMax = parseFloat(input.value) || 0; });
bindInspectorField('insp-output-smoothing', (obj, input) => { obj.outputSmoothingSeconds = parseFloat(input.value); if (Number.isNaN(obj.outputSmoothingSeconds)) obj.outputSmoothingSeconds = 0.25; });
bindInspectorField('insp-output-wobble-binding', (obj, input) => { obj.outputWobbleBinding = input.value; });
bindInspectorField('insp-output-wobble-amplitude', (obj, input) => { obj.outputWobbleAmplitude = parseFloat(input.value) || 0; });
bindInspectorField('insp-output-wobble-speed-scale', (obj, input) => { obj.outputWobbleSpeedScale = parseFloat(input.value) || 0.25; });
bindInspectorField('insp-output-axis', (obj, input) => { obj.outputAxis = input.value; });
bindInspectorField('insp-output-travel-min', (obj, input) => { obj.outputTravelMin = parseFloat(input.value) || 0; });
bindInspectorField('insp-output-travel-max', (obj, input) => { obj.outputTravelMax = parseFloat(input.value) || 0; });
bindInspectorField('insp-output-alt-asset', (obj, input) => { obj.outputAltAssetId = input.value || null; });

bindInspectorField('insp-states-enabled', (obj, input) => {
  obj.statesEnabled = input.checked;
  if (!obj.visualStates) obj.visualStates = [];
  if (obj.statesEnabled && !obj.visualStates.length) {
    obj.visualStates.push({ name: 'NORMAL', assetId: obj.assetId ?? null, opacity: 1, visible: true });
    obj.defaultVisualState = 'NORMAL';
  }
  el('insp-states-fields').hidden = !obj.statesEnabled;
  renderStatesList(obj);
});
bindInspectorField('insp-state-binding', (obj, input) => { obj.stateBinding = input.value; });

// The preview slider is deliberately NOT a bindInspectorField: it never
// mutates or saves the object, it only drives a transient render-time
// override so you can see the gauge's animation range in the editor.
el('insp-output-preview').addEventListener('input', (event) => {
  const objs = selectedObjects();
  if (objs.length !== 1) return;
  previewOutputObjectId = objs[0].id;
  previewOutputT = parseFloat(event.target.value) || 0;
  render();
});

// Same transient, non-persisted preview mechanism as the slider above, just
// a binary checkbox since a texture swap only has two states.
el('insp-output-preview-toggle').addEventListener('change', (event) => {
  const objs = selectedObjects();
  if (objs.length !== 1) return;
  previewOutputObjectId = objs[0].id;
  previewOutputT = event.target.checked ? 1 : 0;
  render();
});

// Same deliberate exclusion from bindInspectorField as the output preview
// above: a transient render-time override for scrubbing a control's full
// drag range, never written to the object or the saved document.
el('insp-drag-preview').addEventListener('input', (event) => {
  const objs = selectedObjects();
  if (objs.length !== 1) return;
  previewInputObjectId = objs[0].id;
  previewInputT = parseFloat(event.target.value) || 0;
  render();
});

el('duplicate-btn').addEventListener('click', () => duplicateObjects([...selectedIds]));
el('delete-btn').addEventListener('click', () => deleteObjects([...selectedIds]));
el('ungroup-btn').addEventListener('click', ungroupSelected);
el('save-prefab-btn').addEventListener('click', () => {
  const objs = selectedObjects();
  if (objs.length === 1) saveAsPrefab(objs[0]);
});
el('push-prefab-btn').addEventListener('click', () => {
  const objs = selectedObjects();
  if (objs.length === 1) pushPrefabAppearance(objs[0]);
});
el('unlink-prefab-btn').addEventListener('click', () => {
  const objs = selectedObjects();
  if (objs.length === 1) unlinkFromPrefab(objs[0]);
});

el('group-selected-btn').addEventListener('click', groupSelected);
el('duplicate-multi-btn').addEventListener('click', () => duplicateObjects([...selectedIds]));
el('delete-multi-btn').addEventListener('click', () => deleteObjects([...selectedIds]));

// Workspace-only toggle (not saved document data), same category as the
// preview sliders: it just changes how the next corner-handle drag behaves.
el('insp-multi-uniform-resize').addEventListener('change', (event) => {
  uniformResizeEnabled = event.target.checked;
});

el('align-left-btn').addEventListener('click', () => alignSelected('left'));
el('align-center-h-btn').addEventListener('click', () => alignSelected('center-h'));
el('align-right-btn').addEventListener('click', () => alignSelected('right'));
el('align-top-btn').addEventListener('click', () => alignSelected('top'));
el('align-middle-v-btn').addEventListener('click', () => alignSelected('middle-v'));
el('align-bottom-btn').addEventListener('click', () => alignSelected('bottom'));
el('distribute-h-btn').addEventListener('click', () => distributeSelected('horizontal'));
el('distribute-v-btn').addEventListener('click', () => distributeSelected('vertical'));

// --- Object list panel -------------------------------------------------

function renderObjectList() {
  el('object-list-title').textContent = currentStationId
    ? `OBJECTS IN STATION: ${ensureRoomStations(currentRoom())[currentStationId]?.name?.toUpperCase() || currentStationId}`
    : 'OBJECTS IN COMPARTMENT VIEW';

  const listEl = el('object-list');
  listEl.innerHTML = '';
  const room = currentContainer();
  room.objects.forEach((obj, index) => {
    const locked = isObjectLocked(obj);
    const blocked = isInteractionBlocked(obj);
    const row = document.createElement('div');
    row.className = 'list-row' + (selectedIds.has(obj.id) ? ' selected' : '') + (blocked ? ' locked' : '');

    const label = document.createElement('span');
    label.textContent = (locked ? '🔒 ' : '') + (obj.type === 'group' ? `▢ ${obj.name}` : obj.name);
    if (!blocked) {
      label.addEventListener('click', (event) => {
        if (event.shiftKey) {
          toggleSelection(obj.id);
        } else {
          selectSingle(obj.id);
        }
      });
    }

    const upBtn = document.createElement('button');
    upBtn.textContent = '↑';
    upBtn.title = 'Move forward (drawn on top)';
    upBtn.disabled = blocked || index === room.objects.length - 1;
    upBtn.addEventListener('click', () => moveObjectOrder(index, 1));

    const downBtn = document.createElement('button');
    downBtn.textContent = '↓';
    downBtn.title = 'Move backward';
    downBtn.disabled = blocked || index === 0;
    downBtn.addEventListener('click', () => moveObjectOrder(index, -1));

    row.appendChild(label);
    row.appendChild(upBtn);
    row.appendChild(downBtn);
    listEl.appendChild(row);
  });

  renderLayerList();
}

function toggleSelection(id) {
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  refreshSelectionUI();
}

// --- Layers panel ----------------------------------------------------------
//
// Rendered from inside renderObjectList() (below) so every place that
// already refreshes the object list - switching rooms/stations, adding,
// deleting, reassigning objects - keeps the layer list's object counts and
// controls in sync for free.

function renderLayerList() {
  const container = currentContainer();
  const layers = ensureContainerLayers(container);
  const listEl = el('layer-list');
  listEl.innerHTML = '';
  layers.forEach((layer) => {
    const row = document.createElement('div');
    row.className = 'layer-row';

    const selectLabel = document.createElement('label');
    selectLabel.className = 'layer-select-label';
    const selectCb = document.createElement('input');
    selectCb.type = 'checkbox';
    selectCb.checked = layer.selected !== false;
    selectCb.title = 'Selected layers can be edited - deselect to lock this layer. Multiple layers can be selected at once.';
    selectCb.addEventListener('change', () => toggleLayerSelected(layer.id, selectCb.checked));
    selectLabel.appendChild(selectCb);
    selectLabel.appendChild(document.createTextNode('Select'));

    const label = document.createElement('span');
    const count = container.objects.filter((o) => (o.layerId || 'default') === layer.id).length;
    label.textContent = `${layer.name} (${count})`;
    label.title = 'Click to rename';
    label.addEventListener('click', () => renameLayer(layer.id));

    const flattenLabel = document.createElement('label');
    flattenLabel.className = 'layer-flatten-label';
    const flattenCb = document.createElement('input');
    flattenCb.type = 'checkbox';
    flattenCb.checked = !!layer.flattenOnExport;
    flattenCb.title = 'Flatten this layer into a single image on export';
    flattenCb.addEventListener('change', () => toggleLayerFlatten(layer.id, flattenCb.checked));
    flattenLabel.appendChild(flattenCb);
    flattenLabel.appendChild(document.createTextNode('Flatten'));

    const assignBtn = document.createElement('button');
    assignBtn.textContent = 'Assign Selected';
    assignBtn.disabled = selectedIds.size === 0;
    assignBtn.addEventListener('click', () => assignSelectedToLayer(layer.id));

    row.appendChild(selectLabel);
    row.appendChild(label);
    row.appendChild(flattenLabel);
    row.appendChild(assignBtn);

    if (layer.id !== 'default') {
      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = 'Delete';
      deleteBtn.addEventListener('click', () => deleteLayer(layer.id));
      row.appendChild(deleteBtn);
    }

    listEl.appendChild(row);
  });
}

function addLayer() {
  const name = (prompt('New layer name:') || '').trim();
  if (!name) return;
  const layers = ensureContainerLayers(currentContainer());
  pushUndoSnapshot();
  const id = `layer_${Date.now().toString(36)}`;
  layers.push({ id, name, selected: true, flattenOnExport: false });
  renderObjectList();
  scheduleSave();
}

function renameLayer(layerId) {
  const layers = ensureContainerLayers(currentContainer());
  const layer = layers.find((l) => l.id === layerId);
  if (!layer) return;
  const name = (prompt('Layer name:', layer.name) || '').trim();
  if (!name) return;
  pushUndoSnapshot();
  layer.name = name;
  renderObjectList();
  scheduleSave();
}

function toggleLayerSelected(layerId, checked) {
  const container = currentContainer();
  const layers = ensureContainerLayers(container);
  const layer = layers.find((l) => l.id === layerId);
  if (!layer) return;
  pushUndoSnapshot();
  layer.selected = checked;
  if (!checked) {
    // Deselecting a layer locks it - drop any of its objects that are
    // currently selected so the inspector stops editing them.
    let changed = false;
    container.objects.forEach((o) => {
      if ((o.layerId || 'default') === layerId && selectedIds.has(o.id)) {
        selectedIds.delete(o.id);
        changed = true;
      }
    });
    if (changed) refreshSelectionUI();
  }
  renderObjectList();
  render();
  scheduleSave();
}

function toggleLayerFlatten(layerId, checked) {
  const layers = ensureContainerLayers(currentContainer());
  const layer = layers.find((l) => l.id === layerId);
  if (!layer) return;
  pushUndoSnapshot();
  layer.flattenOnExport = checked;
  scheduleSave();
}

function deleteLayer(layerId) {
  if (layerId === 'default') return;
  const container = currentContainer();
  const layers = ensureContainerLayers(container);
  if (!layers.some((l) => l.id === layerId)) return;
  pushUndoSnapshot();
  container.objects.forEach((o) => {
    if ((o.layerId || 'default') === layerId) o.layerId = 'default';
  });
  container.layers = layers.filter((l) => l.id !== layerId);
  renderObjectList();
  scheduleSave();
}

function assignSelectedToLayer(layerId) {
  const objs = selectedObjects();
  if (!objs.length) return;
  pushUndoSnapshot();
  objs.forEach((o) => { o.layerId = layerId; });
  renderObjectList();
  scheduleSave();
}

el('new-layer-btn').addEventListener('click', addLayer);

// --- Asset library -------------------------------------------------------

// Which asset-library categories are expanded, keyed by category name -
// workspace UI state, not document data, so it isn't persisted or undoable.
const assetCategoryExpanded = {};
let hiddenCategories = new Set();

// Which assets are selected for a bulk action (e.g. re-categorizing a batch
// at once) - also workspace-only, cleared on every re-render trigger that
// isn't itself a selection change.
let selectedAssetIds = new Set();

// Live asset-name filter - workspace UI state, not persisted.
let assetSearchQuery = '';
el('asset-search-input').addEventListener('input', (event) => {
  assetSearchQuery = event.target.value;
  renderAssetList();
});

function setAssetCategory(assetIds) {
  if (!assetIds.length) return;
  const label = assetIds.length === 1 ? assets[assetIds[0]]?.name : `${assetIds.length} assets`;
  const defaultValue = assetIds.length === 1 ? assets[assetIds[0]]?.category || '' : '';
  const input = prompt(`Category for ${label} (blank = Uncategorized):`, defaultValue);
  if (input === null) return; // cancelled - leave existing categories untouched
  const name = input.trim();
  assetIds.forEach((id) => {
    if (assets[id]) assets[id].category = name;
  });
  assetCategoryExpanded[name || 'Uncategorized'] = true;
  renderAssetList();
  scheduleSave();
}

function refreshAssetBulkActions() {
  const bar = el('asset-bulk-actions');
  bar.hidden = selectedAssetIds.size === 0;
  el('asset-bulk-count').textContent = `${selectedAssetIds.size} asset(s) selected`;
}

function setAssetsHidden(assetIds, hidden) {
  assetIds.forEach((id) => { if (assets[id]) assets[id].hidden = hidden; });
  renderAssetList();
  scheduleSave();
}

// A one-shot flip to an opt-in model: hide the entire existing library at
// once, then individually (or via the bulk Show button above, after
// selecting a batch) turn back on only the ones actually wanted, instead of
// hiding a long tail of unwanted assets one at a time.
el('asset-hide-all-btn').addEventListener('click', () => setAssetsHidden(Object.keys(assets), true));
el('asset-show-all-btn').addEventListener('click', () => setAssetsHidden(Object.keys(assets), false));

el('asset-bulk-category-btn').addEventListener('click', () => setAssetCategory([...selectedAssetIds]));
el('asset-bulk-hide-btn').addEventListener('click', () => setAssetsHidden([...selectedAssetIds], true));
el('asset-bulk-show-btn').addEventListener('click', () => setAssetsHidden([...selectedAssetIds], false));
el('asset-bulk-delete-btn').addEventListener('click', () => deleteAssets([...selectedAssetIds]));
el('asset-bulk-clear-btn').addEventListener('click', () => {
  selectedAssetIds = new Set();
  renderAssetList();
});

// Every asset id actually referenced anywhere in the project - every room's
// own objects, every station's objects, and every prefab template (a prefab
// is checked the same way as a single object, since it shares the same
// appearance fields) - so deleting an asset can warn about breaking
// something instead of silently leaving a dangling reference.
function collectAllUsedAssetIds() {
  const ids = new Set();
  Object.values(rooms).forEach((room) => {
    collectUsedAssetIds(room.objects || []).forEach((id) => ids.add(id));
    Object.values(room.stations || {}).forEach((station) => {
      collectUsedAssetIds(station.objects || []).forEach((id) => ids.add(id));
    });
  });
  Object.values(prefabs).forEach((prefab) => {
    collectUsedAssetIds([prefab]).forEach((id) => ids.add(id));
  });
  return ids;
}

// Asset deletion is NOT covered by Undo (pushUndoSnapshot only captures
// rooms/prefabs, deliberately excluding assets' own embedded image data so
// every undo step doesn't carry a full copy of the asset library) - the
// confirm() below is the only safety net besides a Project Backup, so it
// spells out exactly what's at risk before going through with it. A deleted
// asset's id simply stops resolving afterward - any object/prefab still
// referencing it falls back to its plain color/shape, the same graceful
// fallback already used whenever an assetId doesn't resolve, rather than
// breaking or needing cleanup here.
function deleteAssets(assetIds) {
  if (!assetIds.length) return;
  const usedIds = collectAllUsedAssetIds();
  const inUse = assetIds.filter((id) => usedIds.has(id));
  const label = assetIds.length === 1 ? (assets[assetIds[0]]?.name || assetIds[0]) : `${assetIds.length} assets`;
  let message = `Permanently delete ${label} from the library? This cannot be undone (Save Project Backup first if unsure).`;
  if (inUse.length) {
    const names = inUse.map((id) => assets[id]?.name || id).join(', ');
    message = `${names} ${inUse.length === 1 ? 'is' : 'are'} still used by at least one object or prefab. `
      + `Deleting anyway will leave ${inUse.length === 1 ? 'it' : 'them'} showing as a plain colored shape instead of its sprite. `
      + `This cannot be undone (Save Project Backup first if unsure). Delete anyway?`;
  }
  if (!confirm(message)) return;
  assetIds.forEach((id) => {
    if (assets[id]?.sourceFilename) deletedAssetFilenames.add(assets[id].sourceFilename);
    delete assets[id];
  });
  selectedAssetIds = new Set([...selectedAssetIds].filter((id) => !assetIds.includes(id)));
  renderAssetList();
  // Every asset dropdown in the inspector (Flipped Texture, per-state
  // textures, ...) is only ever rebuilt when the inspector itself refreshes
  // - it doesn't watch the assets registry - so a deleted asset would keep
  // showing as a selectable option there until the selection changed, even
  // though it's already gone from the library. refreshSelectionUI()
  // re-populates all of them immediately if an object is currently selected.
  refreshSelectionUI();
  scheduleSave();
}

function renderAssetList() {
  const listEl = el('asset-list');
  listEl.innerHTML = '';

  const query = assetSearchQuery.trim().toLowerCase();
  const visibleAssets = query
    ? Object.values(assets).filter((asset) => asset.name.toLowerCase().includes(query))
    : Object.values(assets);

  const grouped = new Map();
  visibleAssets.forEach((asset) => {
    const cat = asset.category || 'Uncategorized';
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat).push(asset);
  });

  const categories = [...grouped.keys()].sort((a, b) => {
    if (a === 'Uncategorized') return 1;
    if (b === 'Uncategorized') return -1;
    return a.localeCompare(b);
  });

  categories.forEach((cat) => {
    const catAssets = grouped.get(cat);
    const details = document.createElement('details');
    details.className = 'asset-category';
    // Collapsed by default (only open once the author has explicitly
    // expanded it) - while actively searching, force every category with a
    // match open instead, otherwise a match sitting inside a collapsed
    // category would be invisible with no indication it exists.
    details.open = query ? true : assetCategoryExpanded[cat] === true;
    details.addEventListener('toggle', () => {
      if (assetSearchQuery.trim()) return; // don't let a forced-open search state overwrite the real preference
      assetCategoryExpanded[cat] = details.open;
    });

    const summary = document.createElement('summary');

    const catHideLabel = document.createElement('label');
    catHideLabel.className = 'asset-hide-label';
    catHideLabel.title = 'Show every asset in this category in Binding-side dropdowns (Flipped Texture, per-state Texture, ...) - unchecking hides them there without deleting anything. An individual asset\'s own checkbox still overrides this.';
    // A <label>'s own click (when the checkbox itself isn't the exact target)
    // and the checkbox's synthetic click it triggers are two separate events
    // that both bubble toward <summary> - stopping only one would still let
    // the other toggle the <details> open/closed, so both need it.
    catHideLabel.addEventListener('click', (event) => event.stopPropagation());
    const catHideCb = document.createElement('input');
    catHideCb.type = 'checkbox';
    // Checked = shown, unchecked = hidden - same convention as the per-asset
    // checkbox below, so "checked" always means "visible" everywhere in this
    // panel.
    catHideCb.checked = !hiddenCategories.has(cat);
    catHideCb.addEventListener('click', (event) => event.stopPropagation());
    catHideCb.addEventListener('change', () => {
      if (catHideCb.checked) hiddenCategories.delete(cat);
      else hiddenCategories.add(cat);
      refreshSelectionUI();
      scheduleSave();
    });
    catHideLabel.appendChild(catHideCb);

    const summaryText = document.createElement('span');
    summaryText.textContent = `${cat} (${catAssets.length})`;
    summary.appendChild(catHideLabel);
    summary.appendChild(summaryText);
    details.appendChild(summary);

    catAssets.forEach((asset) => {
      const row = document.createElement('div');
      row.className = 'asset-row' + (selectedAssetIds.has(asset.id) ? ' selected' : '');

      const thumb = document.createElement('img');
      thumb.src = asset.dataUrl;
      thumb.className = 'asset-thumb';
      thumb.title = `Click to add "${asset.name}" to the room`;
      thumb.addEventListener('click', () => {
        addObject({
          assetId: asset.id,
          width: asset.image.naturalWidth || 60,
          height: asset.image.naturalHeight || 60,
          name: asset.name,
        });
      });

      // Clicking the name selects it (shift-click to multi-select) for bulk
      // actions, mirroring how the Objects list below handles selection -
      // the thumbnail stays a one-click "add to room" shortcut either way.
      const label = document.createElement('span');
      label.textContent = asset.name;
      label.title = 'Click to select, shift-click to multi-select';
      label.addEventListener('click', (event) => {
        if (event.shiftKey) {
          if (selectedAssetIds.has(asset.id)) selectedAssetIds.delete(asset.id);
          else selectedAssetIds.add(asset.id);
        } else {
          selectedAssetIds = new Set([asset.id]);
        }
        renderAssetList();
      });

      const hideCb = document.createElement('input');
      hideCb.type = 'checkbox';
      hideCb.className = 'asset-hide-checkbox';
      // Checked = shown, unchecked = hidden - stored inverted (asset.hidden)
      // internally since that's the more useful flag to test everywhere else
      // (isAssetHiddenFromDropdowns, etc.), but the checkbox itself always
      // reads the natural way: checking it turns the asset ON.
      hideCb.checked = !asset.hidden;
      hideCb.title = 'Show in Binding-side dropdowns (Flipped Texture, per-state Texture, ...) - unchecking hides it there without deleting anything';
      hideCb.addEventListener('change', () => {
        asset.hidden = !hideCb.checked;
        refreshSelectionUI();
        scheduleSave();
      });

      const categoryBtn = document.createElement('button');
      categoryBtn.textContent = '\u{1F3F7}';
      categoryBtn.title = 'Set category';
      categoryBtn.addEventListener('click', () => setAssetCategory([asset.id]));

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '\u{1F5D1}';
      deleteBtn.title = 'Delete this asset from the library';
      deleteBtn.addEventListener('click', () => deleteAssets([asset.id]));

      row.appendChild(hideCb);
      row.appendChild(thumb);
      row.appendChild(label);
      row.appendChild(categoryBtn);
      row.appendChild(deleteBtn);
      details.appendChild(row);
    });

    listEl.appendChild(details);
  });

  refreshAssetBulkActions();
  // Every asset-registry mutation (add, delete, hide, category, folder scan,
  // Load Images, backup restore) already calls this function - centralizing
  // the inspector refresh here, instead of adding it separately at each of
  // those call sites, is what actually guarantees a currently-open dropdown
  // (Flipped Texture, per-state Texture, ...) picks up the change immediately
  // rather than only on the next reselect.
  refreshSelectionUI();
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A content fingerprint used to recognize "this is the same file that used
// to live somewhere else" when reconciling a folder scan against the
// library, regardless of its current name or path.
async function hashFileContent(file) {
  const buffer = await file.arrayBuffer();
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return bytesToHex(new Uint8Array(hashBuffer));
}

// Same fingerprint, computed from an already-loaded asset's stored data URL
// (used to backfill older assets that predate content hashing) - decodes
// back to the exact same bytes hashFileContent would see from the file.
async function hashDataUrl(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(hashBuffer));
}

// Registers a File (from the file picker or a folder scan) as an asset.
// Returns the new asset's id once its image has loaded.
// filenameOverride, when given, may be a relative path (e.g. "gauges/icon.png")
// so files of the same name in different assets-folder subfolders don't
// collide - only its last path segment is ever used as the display name.
// Asset ids are derived from the file's own relative path (sourceFilename)
// rather than an incrementing counter, so re-scanning the same assets
// folder from a fully empty registry - e.g. after localStorage is lost -
// reproduces the exact same ids every time. A sequential counter here would
// assign ids purely by scan/load order, which is not reproducible across
// sessions; that mismatch is what silently broke every room's assetId
// reference after a cache loss forced a re-import (rooms kept referencing
// old ids like "asset_37" that a fresh scan would hand to a different file).
function slugifyForAssetId(sourceFilename) {
  return sourceFilename
    .toLowerCase()
    .replace(/\.[^./]+$/, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function makeAssetId(sourceFilename) {
  const slug = slugifyForAssetId(sourceFilename) || 'asset';
  let id = `asset_${slug}`;
  let n = 2;
  while (assets[id]) {
    id = `asset_${slug}_${n}`;
    n += 1;
  }
  return id;
}

function registerAssetFromFile(file, filenameOverride, category = '') {
  return Promise.all([readFileAsDataUrl(file), hashFileContent(file)]).then(
    ([dataUrl, contentHash]) =>
      new Promise((resolve) => {
        const sourceFilename = filenameOverride || file.name;
        const id = makeAssetId(sourceFilename);
        const img = new Image();
        img.onload = () => {
          renderAssetList();
          render();
          resolve(id);
        };
        const baseName = sourceFilename.split('/').pop();
        const name = baseName.replace(/\.[^.]+$/, '');
        assets[id] = { id, name, dataUrl, image: img, sourceFilename, category, contentHash };
        img.src = dataUrl;
      }),
  );
}

el('load-images-btn').addEventListener('click', () => el('image-file-input').click());
el('image-file-input').addEventListener('change', (event) => {
  const files = Array.from(event.target.files || []);
  Promise.all(files.map((file) => registerAssetFromFile(file))).then(() => {
    renderAssetList();
    scheduleSave();
  });
  // If an assets folder is chosen, also save a copy there so the folder
  // stays the persistent, canonical home for these images.
  if (assetsDirHandle) {
    files.forEach((file) => writeFileToAssetsFolder(file));
  }
  event.target.value = '';
});

el('add-placeholder-btn').addEventListener('click', () => addObject({ name: 'Node', color: '#9c27b0', previewShape: 'circle' }));
el('add-player-spawn-btn').addEventListener('click', () => addObject({ name: 'Player Spawn', type: 'player_spawn', width: 28, height: 28 }));
el('add-scope-btn').addEventListener('click', () => addObject({ name: 'Scope', type: 'scope', width: 200, height: 200, previewShape: 'circle' }));

// An indicator light is just an ordinary round object with States pre-
// enabled and starter colors instead of textures - the same multi-state
// mechanism a toggle switch's own visualStates use, just driven by a bound
// game value (State Binding) instead of by clicking. Defaults to the
// empty/loaded/armed states a torpedo tube light needs (bind one of these
// per tube, e.g. "torpedo_tubes.0.state", so each tube's light is
// independent) - rename/add/recolor states afterward for any other use.
el('add-indicator-btn').addEventListener('click', () => {
  addObject({ name: 'Indicator Light', width: 24, height: 24, color: '#1b3320', previewShape: 'circle' });
  const obj = currentContainer().objects[currentContainer().objects.length - 1];
  obj.statesEnabled = true;
  obj.stateBinding = '';
  obj.visualStates = [
    { name: 'empty', assetId: null, color: '#1b3320', opacity: 1, visible: true },
    { name: 'loaded', assetId: null, color: '#4caf50', opacity: 1, visible: true },
    { name: 'armed', assetId: null, color: '#e53935', opacity: 1, visible: true },
  ];
  obj.defaultVisualState = 'empty';
  updateInspectorFromObject(obj);
  render();
  scheduleSave();
});

function setPaintMode(mode) {
  paintMode = paintMode === mode ? null : mode;
  lastMouseWorldPos = null;
  if (paintMode) setTestMode(false);
  el('paint-leak-btn').classList.toggle('active', paintMode === 'leak');
  el('paint-fire-btn').classList.toggle('active', paintMode === 'fire');
  el('paint-hint').hidden = !paintMode;
  render();
}

el('paint-leak-btn').addEventListener('click', () => setPaintMode('leak'));
el('paint-fire-btn').addEventListener('click', () => setPaintMode('fire'));

function setTestMode(enabled) {
  testMode = enabled;
  if (testMode) {
    paintMode = null;
    el('paint-leak-btn').classList.remove('active');
    el('paint-fire-btn').classList.remove('active');
    el('paint-hint').hidden = true;
  }
  el('test-mode-btn').classList.toggle('active', testMode);
  render();
}

el('test-mode-btn').addEventListener('click', () => setTestMode(!testMode));
el('brush-size-input').addEventListener('input', (event) => {
  brushSize = parseFloat(event.target.value) || 30;
  render();
});

el('toggle-spawn-visibility').addEventListener('change', (event) => {
  metaLayerVisibility.player_spawn = event.target.checked;
  render();
});
el('toggle-leak-visibility').addEventListener('change', (event) => {
  metaLayerVisibility.leak_zone = event.target.checked;
  render();
});
el('toggle-fire-visibility').addEventListener('change', (event) => {
  metaLayerVisibility.fire_zone = event.target.checked;
  render();
});

// --- Assets folder (File System Access API) -------------------------------
//
// Optional: lets images live as real files in a folder on disk (matching
// the original Sub Editor design doc's "drop PNGs into assets/" workflow)
// instead of only inside this browser's storage. Requires a secure context
// (serve over http://localhost, not file://) and a Chromium-based browser.

const HANDLE_DB_NAME = 'sub_editor_handles';
const HANDLE_STORE_NAME = 'handles';

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(HANDLE_STORE_NAME);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveDirHandle(handle, key = 'assetsDir') {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, 'readwrite');
    tx.objectStore(HANDLE_STORE_NAME).put(handle, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadSavedDirHandle(key = 'assetsDir') {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE_NAME, 'readonly');
    const req = tx.objectStore(HANDLE_STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function updateFolderUI() {
  const chooseBtn = el('choose-folder-btn');
  const reconnectBtn = el('reconnect-folder-btn');
  const refreshBtn = el('refresh-folder-btn');
  const status = el('folder-status');

  if (!window.showDirectoryPicker) {
    status.textContent = 'Folder access needs a Chromium browser over http(s) - use Load Images instead.';
    chooseBtn.hidden = true;
    reconnectBtn.hidden = true;
    refreshBtn.hidden = true;
    return;
  }

  if (assetsDirHandle) {
    status.textContent = `Assets folder: ${assetsDirHandle.name}`;
    chooseBtn.hidden = false;
    reconnectBtn.hidden = true;
    refreshBtn.hidden = false;
  } else {
    status.textContent = '';
    chooseBtn.hidden = false;
    refreshBtn.hidden = true;
  }
}

// One level of subfolders becomes asset categories automatically (assets/
// switches/*.png -> category "switches"), matching the original design
// doc's "categories from folders" idea - a subfolder's own subfolders are
// not scanned, keeping this to the simple flat-category model. A top-level
// function (rather than nested in scanAssetsFolder) so it can be exercised
// directly against a mock directory handle, without a real folder picker.
// Purely a listing pass - it doesn't touch the assets registry, so
// scanAssetsFolder can reconcile moves before registering anything new.
async function listDirectoryImages(dirHandle, category, out) {
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === 'directory') {
      if (!category) await listDirectoryImages(handle, name, out);
      continue;
    }
    const ext = name.split('.').pop().toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const key = category ? `${category}/${name}` : name;
    out.push({ key, category: category || '', handle });
  }
}

// Reconciles the assets folder with the library. A file at a path that
// doesn't match any known asset is provisionally "new" - but before
// importing it as a separate asset, its content is fingerprinted and
// checked against every asset whose old path has disappeared from this
// scan. A match means the file was simply moved or re-categorized in a
// normal file explorer, so the existing asset is re-pointed at its new
// location/category instead of being duplicated, and nothing referencing
// it (rooms, prefabs) needs to change since its id never moves.
async function scanAssetsFolder() {
  if (!assetsDirHandle) return;

  const found = [];
  await listDirectoryImages(assetsDirHandle, null, found);

  const existingKeys = new Set(Object.values(assets).map((a) => a.sourceFilename).filter(Boolean));
  // Deleting an asset only ever removes its library entry - the underlying
  // file usually stays in the folder - so without this, the very next scan
  // (which also runs silently on every page load if the folder was already
  // granted access, not just on an explicit Refresh click) would see that
  // file as "new" again and re-import it right back, making Delete look
  // like it didn't work. deletedAssetFilenames is the deliberate exception
  // list: "Load Images..." can still re-add one of these on purpose, since
  // that path doesn't consult this set at all - only an automatic scan does.
  const newEntries = found.filter((f) => !existingKeys.has(f.key) && !deletedAssetFilenames.has(f.key));
  if (!newEntries.length) return;

  const foundKeys = new Set(found.map((f) => f.key));
  const candidatesForMove = Object.values(assets).filter((a) => a.sourceFilename && !foundKeys.has(a.sourceFilename));

  // Older assets (or any without a hash yet) need a fingerprint before they
  // can be matched - computed from their already-loaded image data.
  await Promise.all(
    candidatesForMove
      .filter((a) => !a.contentHash)
      .map((a) => hashDataUrl(a.dataUrl).then((hash) => { a.contentHash = hash; })),
  );

  await Promise.all(newEntries.map((entry) => entry.handle.getFile().then((file) => { entry.file = file; })));

  const toRegister = [];
  for (const entry of newEntries) {
    if (candidatesForMove.length) {
      const hash = await hashFileContent(entry.file);
      const matchIndex = candidatesForMove.findIndex((a) => a.contentHash === hash);
      if (matchIndex !== -1) {
        const asset = candidatesForMove.splice(matchIndex, 1)[0];
        asset.sourceFilename = entry.key;
        asset.category = entry.category;
        asset.contentHash = hash;
        continue;
      }
    }
    toRegister.push(entry);
  }

  await Promise.all(toRegister.map((entry) => registerAssetFromFile(entry.file, entry.key, entry.category)));
  renderAssetList();
  scheduleSave();
}

async function writeFileToAssetsFolder(file) {
  try {
    const fileHandle = await assetsDirHandle.getFileHandle(file.name, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(file);
    await writable.close();
  } catch (err) {
    console.warn('Could not save image into the assets folder:', err);
  }
}

el('choose-folder-btn').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    assetsDirHandle = handle;
    await saveDirHandle(handle);
    updateFolderUI();
    await scanAssetsFolder();
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('Could not open assets folder:', err);
  }
});

el('reconnect-folder-btn').addEventListener('click', async () => {
  const handle = await loadSavedDirHandle();
  if (!handle) return;
  try {
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission === 'granted') {
      assetsDirHandle = handle;
      updateFolderUI();
      await scanAssetsFolder();
    }
  } catch (err) {
    console.warn('Could not reconnect to assets folder:', err);
  }
});

el('refresh-folder-btn').addEventListener('click', scanAssetsFolder);

async function initAssetsFolder() {
  if (!window.showDirectoryPicker) {
    updateFolderUI();
    return;
  }
  const handle = await loadSavedDirHandle().catch(() => null);
  if (!handle) {
    updateFolderUI();
    return;
  }
  // queryPermission needs no user gesture; requestPermission (in the
  // Reconnect button) does, so this only silently restores access when the
  // browser has already remembered the grant.
  const permission = await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
  if (permission === 'granted') {
    assetsDirHandle = handle;
    updateFolderUI();
    await scanAssetsFolder();
  } else {
    el('reconnect-folder-btn').hidden = false;
    el('folder-status').textContent = `Previously used folder: ${handle.name} (click Reconnect)`;
  }
}

// --- Export folder ---------------------------------------------------------
//
// Same idea as the assets folder above, but for the other direction: once
// pointed at a folder (e.g. the game client's own layouts/ directory),
// Export Room / Export All Rooms write straight into it instead of
// triggering a browser download - no manual save-as, no moving the file
// into place by hand, so a fresh export is picked up by just refreshing the
// game client's tab.

function updateExportFolderUI() {
  const chooseBtn = el('choose-export-folder-btn');
  const reconnectBtn = el('reconnect-export-folder-btn');
  const status = el('export-folder-status');

  if (!window.showDirectoryPicker) {
    status.textContent = 'Folder access needs a Chromium browser over http(s) - exports will download instead.';
    chooseBtn.hidden = true;
    reconnectBtn.hidden = true;
    return;
  }

  if (exportDirHandle) {
    status.textContent = `Exporting straight into: ${exportDirHandle.name}`;
    chooseBtn.hidden = false;
    reconnectBtn.hidden = true;
  } else {
    status.textContent = '';
    chooseBtn.hidden = false;
  }
}

async function writeFileToExportFolder(filename, blob) {
  const fileHandle = await exportDirHandle.getFileHandle(filename, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
}

el('choose-export-folder-btn').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    exportDirHandle = handle;
    await saveDirHandle(handle, 'exportDir');
    updateExportFolderUI();
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('Could not open export folder:', err);
  }
});

el('reconnect-export-folder-btn').addEventListener('click', async () => {
  const handle = await loadSavedDirHandle('exportDir');
  if (!handle) return;
  try {
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    if (permission === 'granted') {
      exportDirHandle = handle;
      updateExportFolderUI();
    }
  } catch (err) {
    console.warn('Could not reconnect to export folder:', err);
  }
});

async function initExportFolder() {
  if (!window.showDirectoryPicker) {
    updateExportFolderUI();
    return;
  }
  const handle = await loadSavedDirHandle('exportDir').catch(() => null);
  if (!handle) {
    updateExportFolderUI();
    return;
  }
  const permission = await handle.queryPermission({ mode: 'readwrite' }).catch(() => 'prompt');
  if (permission === 'granted') {
    exportDirHandle = handle;
    updateExportFolderUI();
  } else {
    el('reconnect-export-folder-btn').hidden = false;
    el('export-folder-status').textContent = `Previously used folder: ${handle.name} (click Reconnect)`;
  }
}

// --- Room management -------------------------------------------------------

function renderRoomSelect() {
  const select = el('room-select');
  select.innerHTML = '';
  Object.values(rooms).forEach((room) => {
    const opt = document.createElement('option');
    opt.value = room.id;
    opt.textContent = room.name;
    select.appendChild(opt);
  });
  select.value = currentRoomId;
}

function switchRoom(roomId) {
  if (editingGroup) exitObjectEditMode();
  currentRoomId = roomId;
  currentStationId = null;
  renderViewSelect();
  selectedIds = new Set();
  refreshSelectionUI();
  scheduleSave();
}

el('room-select').addEventListener('change', (event) => switchRoom(event.target.value));

el('new-room-btn').addEventListener('click', () => {
  const name = (prompt('New room name:') || '').trim();
  if (!name) return;
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || `room_${Object.keys(rooms).length + 1}`;
  if (rooms[id]) {
    alert('A room with that ID already exists.');
    return;
  }
  pushUndoSnapshot();
  rooms[id] = { id, name, objects: [], stations: {} };
  renderRoomSelect();
  switchRoom(id);
});

// --- Stations (each room's compartment view, plus one dedicated screen
// per station, per the game's compartment -> station -> dedicated-UI model)

function renderViewSelect() {
  const select = el('view-select');
  select.innerHTML = '<option value="">Compartment View</option>';
  const stations = ensureRoomStations(currentRoom());
  Object.values(stations).forEach((station) => {
    const opt = document.createElement('option');
    opt.value = station.id;
    opt.textContent = station.name;
    select.appendChild(opt);
  });
  select.value = currentStationId || '';
  el('rename-station-btn').hidden = !currentStationId;
  el('delete-station-btn').hidden = !currentStationId;
}

el('view-select').addEventListener('change', (event) => {
  if (editingGroup) exitObjectEditMode();
  currentStationId = event.target.value || null;
  renderViewSelect();
  selectedIds = new Set();
  refreshSelectionUI();
  scheduleSave();
});

el('device-preview-select').addEventListener('change', (event) => {
  devicePreview = DEVICE_PRESETS[event.target.value] || null;
  render();
});

el('new-station-btn').addEventListener('click', () => {
  const name = (prompt('New station name:') || '').trim();
  if (!name) return;
  const stations = ensureRoomStations(currentRoom());
  const id = `station_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}` || `station_${Object.keys(stations).length + 1}`;
  if (stations[id]) {
    alert('A station with that ID already exists in this room.');
    return;
  }
  pushUndoSnapshot();
  stations[id] = { id, name, objects: [] };
  currentStationId = id;
  renderViewSelect();
  selectedIds = new Set();
  refreshSelectionUI();
  scheduleSave();
});

el('rename-station-btn').addEventListener('click', () => {
  if (!currentStationId) return;
  const stations = ensureRoomStations(currentRoom());
  const station = stations[currentStationId];
  const name = (prompt('Station name (just the display label):', station.name) || '').trim();
  if (!name) return;

  // The ID is what the game client and server actually key off of (e.g.
  // matching a hardcoded station id like "station_helm") - it's edited
  // separately from the display name because there's no reliable way to
  // derive one from the other (some real station ids intentionally don't
  // even have the usual "station_" prefix, like "nav_map").
  const oldId = currentStationId;
  const newId = (prompt('Station ID (must match what the game client/server expect):', oldId) || '').trim();
  if (!newId) return;
  if (newId !== oldId && stations[newId]) {
    alert('A station with that ID already exists in this room.');
    return;
  }

  pushUndoSnapshot();
  station.name = name;
  if (newId !== oldId) {
    station.id = newId;
    delete stations[oldId];
    stations[newId] = station;
    currentRoom().objects.forEach((obj) => {
      if (obj.targetStationId === oldId) obj.targetStationId = newId;
    });
    currentStationId = newId;
  }
  renderViewSelect();
  scheduleSave();
});

el('delete-station-btn').addEventListener('click', () => {
  if (!currentStationId) return;
  const stations = ensureRoomStations(currentRoom());
  pushUndoSnapshot();
  delete stations[currentStationId];
  currentStationId = null;
  renderViewSelect();
  selectedIds = new Set();
  refreshSelectionUI();
  scheduleSave();
});

// --- Export / import ---------------------------------------------------

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function downloadFile(filename, text) {
  downloadBlob(filename, new Blob([text], { type: 'application/json' }));
}

// --- Spritesheet packing ---------------------------------------------------
//
// Combines every image asset actually used by a set of objects (including
// group children) into one PNG, using simple shelf packing - more than
// adequate for the handful-to-dozens of sprites a submarine compartment
// needs. Exported room JSON gets a "spritesheet" block naming the PNG and
// each asset's pixel rectangle within it.

const SPRITESHEET_MAX_WIDTH = 2048;
const SPRITESHEET_PADDING = 2;

function collectUsedAssetIds(objectList) {
  const ids = new Set();
  objectList.forEach((obj) => {
    if (obj.assetId) ids.add(obj.assetId);
    if (obj.outputAltAssetId) ids.add(obj.outputAltAssetId);
    if (obj.visualStates) obj.visualStates.forEach((s) => { if (s.assetId) ids.add(s.assetId); });
    if (obj.type === 'group') {
      obj.children.forEach((child) => {
        if (child.assetId) ids.add(child.assetId);
      });
    }
  });
  return [...ids];
}

// --- Layer flattening (export-time only) -----------------------------------
//
// Renders a set of objects (in their normal z-order) to an offscreen canvas
// cropped to their combined bounds, for layers with "Flatten on Export" on.
// Purely a step of building the exported JSON/PNG - never touches the live,
// still-editable document, so unlocking the layer later shows the original
// individual objects exactly as they were.

function stripEditorOnlyFields(obj) {
  const { layerId, ...rest } = obj;
  if (obj.type === 'player_spawn') {
    // Invisible in the actual game - no sprite, no interaction, no output,
    // no game binding. Only the position data the server needs to know
    // where to place an avatar.
    const spawn = { id: rest.id, name: rest.name, type: rest.type, x: rest.x, y: rest.y, rotation: rest.rotation };
    spawn.spawnType = rest.spawnType ?? 'room_enter';
    if (spawn.spawnType === 'station_link') spawn.targetStationId = rest.targetStationId ?? '';
    return spawn;
  }
  return rest;
}

function rasterizeLayerToImage(objectsInLayer) {
  if (!objectsInLayer.length) return null;
  const bounds = getBoundsForObjects(objectsInLayer);
  const width = Math.max(1, Math.round(bounds.maxX - bounds.minX));
  const height = Math.max(1, Math.round(bounds.maxY - bounds.minY));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  // drawObjectVisual() reads these editor-viewport globals for line widths
  // and live preview overrides - none of which belong in an export.
  const savedZoom = view.zoom;
  const savedPreviewOutput = previewOutputObjectId;
  const savedPreviewInput = previewInputObjectId;
  view.zoom = 1;
  previewOutputObjectId = null;
  previewInputObjectId = null;

  ctx.translate(-bounds.minX, -bounds.minY);
  objectsInLayer.forEach((obj) => drawObjectVisual(ctx, obj));

  view.zoom = savedZoom;
  previewOutputObjectId = savedPreviewOutput;
  previewInputObjectId = savedPreviewInput;

  // Duck-typed to look like the HTMLImageElements every other asset is, so
  // packSpritesheet() and drawShapeBody() need no special-casing for it.
  canvas.complete = true;
  canvas.naturalWidth = width;
  canvas.naturalHeight = height;

  return { canvas, x: bounds.minX + width / 2, y: bounds.minY + height / 2, width, height };
}

// Builds the exported objects array for one container (a room's compartment
// view, or one station), collapsing each flatten-enabled layer into a
// single placeholder object and registering its rasterized image under
// idPrefix in tempAssets so it gets packed into the export's spritesheet.
function buildContainerExport(container, idPrefix, tempAssets) {
  const layers = ensureContainerLayers(container);
  const flattenLayerIds = new Set(layers.filter((l) => l.flattenOnExport).map((l) => l.id));
  if (!flattenLayerIds.size) {
    return container.objects.map(stripEditorOnlyFields);
  }

  const result = [];
  const placeholderByLayer = new Map();
  container.objects.forEach((obj) => {
    const layerId = obj.layerId || 'default';
    if (!flattenLayerIds.has(layerId)) {
      result.push(stripEditorOnlyFields(obj));
      return;
    }
    if (placeholderByLayer.has(layerId)) return; // this layer's placeholder is already in result

    const layerObjs = container.objects.filter((o) => (o.layerId || 'default') === layerId);
    const raster = rasterizeLayerToImage(layerObjs);
    placeholderByLayer.set(layerId, raster);
    if (!raster) return;

    const layer = layers.find((l) => l.id === layerId);
    const assetId = `flat_${idPrefix}_${layerId}`;
    tempAssets[assetId] = { id: assetId, image: raster.canvas };
    result.push({
      id: assetId,
      name: `${layer.name} (flattened)`,
      type: 'decoration',
      x: raster.x,
      y: raster.y,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      width: raster.width,
      height: raster.height,
      assetId,
      color: '#4caf50',
      pivotX: 0.5,
      pivotY: 0.5,
      interaction: 'none',
      axis: 'vertical',
      min: 0,
      max: 1,
      reverse: false,
      binding: '',
      notes: '',
    });
  });
  return result;
}

function buildExportRoom(room, tempAssets) {
  const exported = { id: room.id, name: room.name, objects: buildContainerExport(room, room.id, tempAssets) };
  const stationIds = Object.keys(room.stations || {});
  if (stationIds.length) {
    exported.stations = {};
    stationIds.forEach((stationId) => {
      const station = room.stations[stationId];
      exported.stations[stationId] = {
        id: station.id,
        name: station.name,
        objects: buildContainerExport(station, `${room.id}_${stationId}`, tempAssets),
      };
    });
  }
  return exported;
}

function packSpritesheet(assetIds) {
  const usable = assetIds
    .map((id) => assets[id])
    .filter((a) => a && a.image && a.image.complete && a.image.naturalWidth);

  if (!usable.length) return null;

  const sorted = [...usable].sort((a, b) => b.image.naturalHeight - a.image.naturalHeight);

  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  let sheetWidth = 0;
  const frames = {};

  sorted.forEach((asset) => {
    const w = asset.image.naturalWidth;
    const h = asset.image.naturalHeight;
    if (cursorX > 0 && cursorX + w > SPRITESHEET_MAX_WIDTH) {
      cursorX = 0;
      cursorY += rowHeight + SPRITESHEET_PADDING;
      rowHeight = 0;
    }
    frames[asset.id] = { x: cursorX, y: cursorY, width: w, height: h };
    cursorX += w + SPRITESHEET_PADDING;
    rowHeight = Math.max(rowHeight, h);
    sheetWidth = Math.max(sheetWidth, cursorX - SPRITESHEET_PADDING);
  });

  const canvas = document.createElement('canvas');
  canvas.width = sheetWidth;
  canvas.height = cursorY + rowHeight;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  sorted.forEach((asset) => {
    const f = frames[asset.id];
    ctx.drawImage(asset.image, f.x, f.y, f.width, f.height);
  });

  return { canvas, frames };
}

function exportWithSpritesheet(baseName, jsonPayload, objectListForAssets, tempAssets = {}) {
  const usedIds = collectUsedAssetIds(objectListForAssets);

  // tempAssets holds this export's flattened-layer images, keyed by the
  // synthetic asset ids already baked into jsonPayload/objectListForAssets.
  // packSpritesheet() only knows how to resolve ids through the global
  // assets registry, so it's merged in and removed again immediately after -
  // packing is fully synchronous, so nothing else ever observes the merge.
  Object.assign(assets, tempAssets);
  const packed = usedIds.length ? packSpritesheet(usedIds) : null;
  Object.keys(tempAssets).forEach((id) => delete assets[id]);

  const payload = packed
    ? { ...jsonPayload, spritesheet: { file: `${baseName}_spritesheet.png`, frames: packed.frames } }
    : jsonPayload;
  const jsonBlob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const packedBlob = () => new Promise((resolve) => packed.canvas.toBlob(resolve, 'image/png'));

  if (exportDirHandle) {
    writeFileToExportFolder(`${baseName}.json`, jsonBlob)
      .then(() => (packed ? packedBlob().then((blob) => writeFileToExportFolder(`${baseName}_spritesheet.png`, blob)) : null))
      .then(() => {
        el('export-folder-status').textContent = `Exported "${baseName}" to ${exportDirHandle.name} at ${new Date().toLocaleTimeString()}`;
      })
      .catch((err) => {
        console.warn('Could not write export into the chosen folder, falling back to download:', err);
        downloadBlob(`${baseName}.json`, jsonBlob);
        if (packed) setTimeout(() => packedBlob().then((blob) => downloadBlob(`${baseName}_spritesheet.png`, blob)), 150);
      });
    return;
  }

  downloadBlob(`${baseName}.json`, jsonBlob);
  if (packed) {
    // A short delay avoids some browsers silently dropping the second of
    // two downloads triggered from the same click.
    setTimeout(() => {
      packedBlob().then((blob) => downloadBlob(`${baseName}_spritesheet.png`, blob));
    }, 150);
  }
}

function roomObjectsIncludingStations(room) {
  const stationObjects = Object.values(room.stations || {}).flatMap((s) => s.objects);
  return room.objects.concat(stationObjects);
}

el('export-btn').addEventListener('click', () => {
  const tempAssets = {};
  const exportedRoom = buildExportRoom(currentRoom(), tempAssets);
  exportWithSpritesheet(exportedRoom.id, exportedRoom, roomObjectsIncludingStations(exportedRoom), tempAssets);
});

el('export-all-btn').addEventListener('click', () => {
  const tempAssets = {};
  const exportedRooms = {};
  Object.values(rooms).forEach((room) => {
    // A real room always has an objects array - skip anything that doesn't
    // instead of crashing the whole export over one corrupted/non-room
    // entry (see applyProjectPayload's own cleanup for how one could get in).
    if (!Array.isArray(room?.objects)) {
      console.warn(`Skipping "${room?.id ?? '?'}" during export - it doesn't look like a real room (no objects array).`);
      return;
    }
    exportedRooms[room.id] = buildExportRoom(room, tempAssets);
  });
  const allObjects = Object.values(exportedRooms).flatMap((room) => roomObjectsIncludingStations(room));
  exportWithSpritesheet('layouts', exportedRooms, allObjects, tempAssets);
});

el('import-btn').addEventListener('click', () => el('import-file-input').click());
el('import-file-input').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      pushUndoSnapshot();
      if (parsed && Array.isArray(parsed.objects) && parsed.id) {
        rooms[parsed.id] = parsed;
        currentRoomId = parsed.id;
      } else {
        // A layouts.json BUNDLE (from "Export All Rooms") looks like
        // {roomId1: {...}, roomId2: {...}, spritesheet: {file, frames}} -
        // that last key is bundle metadata, not a room, and blindly merging
        // it in (the old behavior) left a fake "room" with no objects array
        // that crashed every future export. Only merge entries that
        // actually look like a room.
        const roomEntries = Object.entries(parsed || {}).filter(([, v]) => v && Array.isArray(v.objects));
        Object.assign(rooms, Object.fromEntries(roomEntries));
        currentRoomId = roomEntries[0]?.[0] || currentRoomId;
      }
      renderRoomSelect();
      selectedIds = new Set();
      refreshSelectionUI();
      scheduleSave();
    } catch (err) {
      alert(`Could not parse that file as JSON: ${err.message}`);
    }
  };
  reader.readAsText(file);
  event.target.value = '';
});

// --- Validation ---------------------------------------------------------

el('validate-btn').addEventListener('click', () => {
  const room = currentContainer();
  const issues = [];
  const seenIds = new Set();
  room.objects.forEach((obj) => {
    if (seenIds.has(obj.id)) issues.push(`Duplicate ID: ${obj.id}`);
    seenIds.add(obj.id);
    if (obj.type === 'group') return;
    if (obj.interaction !== 'none' && !obj.binding) {
      issues.push(`"${obj.name}" (${obj.id}) has an interaction but no game binding.`);
    }
    if ((obj.interaction === 'drag_linear' || obj.interaction === 'drag_rotate') && obj.min === obj.max) {
      issues.push(`"${obj.name}" (${obj.id}) has min === max.`);
    }
    if (obj.outputType && obj.outputType !== 'none' && !obj.outputBinding) {
      issues.push(`"${obj.name}" (${obj.id}) has an output type but no output binding.`);
    }
    if (obj.outputType && obj.outputType !== 'none' && obj.outputType !== 'texture' && obj.outputMin === obj.outputMax) {
      issues.push(`"${obj.name}" (${obj.id}) has output value min === max.`);
    }
    if (obj.outputType === 'texture' && !obj.outputAltAssetId) {
      issues.push(`"${obj.name}" (${obj.id}) has a Texture Swap output but no flipped texture chosen.`);
    }
    if (obj.type === 'player_spawn' && obj.spawnType === 'station_link' && !obj.targetStationId) {
      issues.push(`"${obj.name}" (${obj.id}) is a Station Link spawn with no target station chosen.`);
    }
  });
  const summary = issues.length
    ? `${issues.length} issue(s) found:\n\n${issues.join('\n')}`
    : `No issues found. ${room.objects.length} object(s) checked.`;
  alert(summary);
});

// --- Canvas rendering ----------------------------------------------------

function screenToWorld(sx, sy) {
  return { x: (sx - view.offsetX) / view.zoom, y: (sy - view.offsetY) / view.zoom };
}

function getCanvasMousePos(event) {
  const rect = el('editor-canvas').getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

// A drag_h_pattern control's rest position is wherever hPatternActiveNode
// currently points, not obj.x/y itself.
function hPatternRestOffset(obj) {
  if (obj.interaction !== 'drag_h_pattern' || !obj.hPatternNodes) return { x: 0, y: 0 };
  const node = obj.hPatternNodes.find((n) => n.id === obj.hPatternActiveNode);
  return node ? { x: node.x, y: node.y } : { x: 0, y: 0 };
}

// Wherever an interactive control is CURRENTLY drawn, accounting for a live
// or persisted test-drag - drag_h_pattern's active node (or its live rail
// position mid-drag), or drag_linear/drag_rotate's previewInputT, which
// (like a real lever) is deliberately left wherever it was released rather
// than reset. Hit-testing has to look here, not at the object's own default
// pose, or clicking the visibly-moved sprite misses while some other empty
// spot on the canvas still grabs it. Mirrors drawObjectVisualInner exactly -
// keep the two in sync.
function currentVisualOffset(obj) {
  if (obj.interaction === 'drag_h_pattern') {
    const isHPatternDragging = obj.id === testDragObjId && testDragHPatternOffset;
    const rest = isHPatternDragging ? testDragHPatternOffset : hPatternRestOffset(obj);
    return { offsetX: rest.x, offsetY: rest.y, rotation: obj.rotation };
  }
  const override = obj.id === previewOutputObjectId
    ? computeOutputPreview(obj, previewOutputT)
    : obj.id === previewInputObjectId
      ? computeInputPreview(obj, previewInputT)
      : null;
  return {
    offsetX: override ? override.offsetX : 0,
    offsetY: override ? override.offsetY : 0,
    rotation: override ? override.rotation : obj.rotation,
  };
}

function hitTestObject(obj, wx, wy) {
  if (obj.points) {
    const r = obj.radius || 0;
    return obj.points.some((p) => Math.hypot(wx - p.x, wy - p.y) <= r);
  }
  if (obj.type === 'group') {
    const corners = getCorners(obj);
    if (!corners.length) return false;
    const xs = corners.map((c) => c.x);
    const ys = corners.map((c) => c.y);
    return wx >= Math.min(...xs) && wx <= Math.max(...xs) && wy >= Math.min(...ys) && wy <= Math.max(...ys);
  }
  const visual = currentVisualOffset(obj);
  const dx = wx - (obj.x + visual.offsetX);
  const dy = wy - (obj.y + visual.offsetY);
  const rad = (-visual.rotation * Math.PI) / 180;
  const rx = (dx * Math.cos(rad) - dy * Math.sin(rad)) / obj.scaleX;
  const ry = (dx * Math.sin(rad) + dy * Math.cos(rad)) / obj.scaleY;
  const left = -(obj.pivotX ?? 0.5) * obj.width;
  const top = -(obj.pivotY ?? 0.5) * obj.height;
  return rx >= left && rx <= left + obj.width && ry >= top && ry <= top + obj.height;
}

function getBoundsForObjects(objs) {
  if (!objs.length) return null;
  let allCorners = [];
  objs.forEach((o) => {
    allCorners = allCorners.concat(getCorners(o));
  });
  const xs = allCorners.map((c) => c.x);
  const ys = allCorners.map((c) => c.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

function getSelectionBounds() {
  const objs = selectedObjects();
  if (objs.length < 1) return null;
  return getBoundsForObjects(objs);
}

function getResizeHandles(bounds) {
  return [
    { corner: 'nw', x: bounds.minX, y: bounds.minY, anchorX: bounds.maxX, anchorY: bounds.maxY },
    { corner: 'ne', x: bounds.maxX, y: bounds.minY, anchorX: bounds.minX, anchorY: bounds.maxY },
    { corner: 'se', x: bounds.maxX, y: bounds.maxY, anchorX: bounds.minX, anchorY: bounds.minY },
    { corner: 'sw', x: bounds.minX, y: bounds.maxY, anchorX: bounds.maxX, anchorY: bounds.minY },
  ];
}

function hitTestResizeHandle(screenPos) {
  if (selectedIds.size < 1) return null;
  const bounds = getSelectionBounds();
  if (!bounds) return null;
  for (const handle of getResizeHandles(bounds)) {
    const hx = handle.x * view.zoom + view.offsetX;
    const hy = handle.y * view.zoom + view.offsetY;
    if (Math.hypot(screenPos.x - hx, screenPos.y - hy) <= 8) return handle;
  }
  return null;
}

function hitTestPivotHandle(screenPos) {
  if (selectedIds.size !== 1) return null;
  const obj = findObject([...selectedIds][0]);
  if (!obj || obj.type === 'group') return null;
  const handleScreenX = obj.x * view.zoom + view.offsetX;
  const handleScreenY = obj.y * view.zoom + view.offsetY;
  const dist = Math.hypot(screenPos.x - handleScreenX, screenPos.y - handleScreenY);
  return dist <= 8 ? obj : null;
}

function hitTestSnapStopHandle(screenPos) {
  if (selectedIds.size !== 1) return null;
  const obj = findObject([...selectedIds][0]);
  if (!obj || !obj.snapEnabled || !obj.snapStops) return null;
  const geom = getSnapPathGeometry(obj);
  if (!geom) return null;
  for (let i = 0; i < obj.snapStops.length; i += 1) {
    const p = snapStopWorldPos(geom, obj.snapStops[i]);
    const screenX = p.x * view.zoom + view.offsetX;
    const screenY = p.y * view.zoom + view.offsetY;
    if (Math.hypot(screenPos.x - screenX, screenPos.y - screenY) <= 8) {
      return { objId: obj.id, index: i };
    }
  }
  return null;
}

function hitTestHPatternNode(screenPos) {
  if (selectedIds.size !== 1) return null;
  const obj = findObject([...selectedIds][0]);
  if (!obj || obj.interaction !== 'drag_h_pattern' || !obj.hPatternNodes) return null;
  for (const node of obj.hPatternNodes) {
    const screenX = (obj.x + node.x) * view.zoom + view.offsetX;
    const screenY = (obj.y + node.y) * view.zoom + view.offsetY;
    if (Math.hypot(screenPos.x - screenX, screenPos.y - screenY) <= 8) {
      return { objId: obj.id, nodeId: node.id };
    }
  }
  return null;
}

function hitTestTopObject(wx, wy) {
  const room = currentContainer();
  for (let i = room.objects.length - 1; i >= 0; i -= 1) {
    const obj = room.objects[i];
    if (isInteractionBlocked(obj) || !isCanvasVisible(obj)) continue;
    if (hitTestObject(obj, wx, wy)) return obj;
  }
  return null;
}

// Hit-tests using the object's touch hitbox when it has one - real tap
// targets, matching how a player would actually reach it - falling back to
// the visual shape otherwise. Only considers objects with a real
// interaction, since Test Mode has nothing to simulate on anything else.
function hitTestForTestMode(wx, wy) {
  const room = currentContainer();
  for (let i = room.objects.length - 1; i >= 0; i -= 1) {
    const obj = room.objects[i];
    if (isInteractionBlocked(obj) || !isCanvasVisible(obj)) continue;
    if (!obj.interaction || obj.interaction === 'none') continue;
    const visual = currentVisualOffset(obj);
    const baseX = obj.x + visual.offsetX;
    const baseY = obj.y + visual.offsetY;
    if (obj.hitboxWidth) {
      const hw = obj.hitboxWidth / 2;
      const hh = (obj.hitboxHeight ?? obj.hitboxWidth) / 2;
      if (obj.interaction === 'drag_rotate') {
        // Rotates around the sprite's own pivot point right along with it -
        // otherwise the far end of a long lever becomes ungrabbable the
        // moment it swings away from its resting angle.
        const rad = (-visual.rotation * Math.PI) / 180;
        const dx = wx - baseX;
        const dy = wy - baseY;
        const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
        const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
        const hbx = obj.hitboxOffsetX ?? 0;
        const hby = obj.hitboxOffsetY ?? 0;
        if (localX >= hbx - hw && localX <= hbx + hw && localY >= hby - hh && localY <= hby + hh) return obj;
      } else {
        const cx = baseX + (obj.hitboxOffsetX ?? 0);
        const cy = baseY + (obj.hitboxOffsetY ?? 0);
        if (wx >= cx - hw && wx <= cx + hw && wy >= cy - hh && wy <= cy + hh) return obj;
      }
    } else if (hitTestObject(obj, wx, wy)) {
      return obj;
    }
  }
  return null;
}

function getShapeCorners(x, y, width, height, scaleX, scaleY, rotation, pivotX = 0.5, pivotY = 0.5) {
  const left = -pivotX * width * scaleX;
  const top = -pivotY * height * scaleY;
  const right = left + width * scaleX;
  const bottom = top + height * scaleY;
  const rad = (rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ].map(([cx, cy]) => ({ x: x + cx * cos - cy * sin, y: y + cx * sin + cy * cos }));
}

function getCorners(obj) {
  if (obj.points) {
    const r = obj.radius || 0;
    return obj.points.flatMap((p) => [
      { x: p.x - r, y: p.y - r },
      { x: p.x + r, y: p.y + r },
    ]);
  }
  if (obj.type === 'group') {
    const grad = (obj.rotation * Math.PI) / 180;
    const gcos = Math.cos(grad);
    const gsin = Math.sin(grad);
    let corners = [];
    obj.children.forEach((child) => {
      const localCorners = getShapeCorners(
        child.offsetX,
        child.offsetY,
        child.width,
        child.height,
        child.scaleX,
        child.scaleY,
        child.rotation,
        child.pivotX ?? 0.5,
        child.pivotY ?? 0.5,
      );
      corners = corners.concat(
        localCorners.map((c) => {
          const sx = c.x * obj.scaleX;
          const sy = c.y * obj.scaleY;
          return { x: obj.x + sx * gcos - sy * gsin, y: obj.y + sx * gsin + sy * gcos };
        }),
      );
    });
    return corners;
  }
  return getShapeCorners(obj.x, obj.y, obj.width, obj.height, obj.scaleX, obj.scaleY, obj.rotation, obj.pivotX ?? 0.5, obj.pivotY ?? 0.5);
}

// Shifts an object's anchor by (dx, dy) - and, for a painted zone, every
// one of its points too, since a zone's points are stored in absolute
// world space rather than relative to its anchor.
function translateObjectXY(obj, dx, dy) {
  obj.x += dx;
  obj.y += dy;
  if (obj.points) obj.points = obj.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

function getObjectBBox(obj) {
  const corners = getCorners(obj);
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { minX, maxX, minY, maxY, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2 };
}

// --- Align / distribute ------------------------------------------------

function alignSelected(mode) {
  const objs = selectedObjects();
  if (objs.length < 2) return;
  pushUndoSnapshot();

  const boxes = objs.map((o) => ({ obj: o, box: getObjectBBox(o) }));
  const overallMinX = Math.min(...boxes.map((b) => b.box.minX));
  const overallMaxX = Math.max(...boxes.map((b) => b.box.maxX));
  const overallMinY = Math.min(...boxes.map((b) => b.box.minY));
  const overallMaxY = Math.max(...boxes.map((b) => b.box.maxY));
  const overallCenterX = (overallMinX + overallMaxX) / 2;
  const overallCenterY = (overallMinY + overallMaxY) / 2;

  boxes.forEach(({ obj, box }) => {
    if (mode === 'left') translateObjectXY(obj, overallMinX - box.minX, 0);
    else if (mode === 'right') translateObjectXY(obj, overallMaxX - box.maxX, 0);
    else if (mode === 'center-h') translateObjectXY(obj, overallCenterX - box.centerX, 0);
    else if (mode === 'top') translateObjectXY(obj, 0, overallMinY - box.minY);
    else if (mode === 'bottom') translateObjectXY(obj, 0, overallMaxY - box.maxY);
    else if (mode === 'middle-v') translateObjectXY(obj, 0, overallCenterY - box.centerY);
  });

  refreshSelectionUI();
  render();
  scheduleSave();
}

// Keeps the two extreme objects fixed and spaces the rest evenly by center,
// in order along the chosen axis - the standard "distribute" convention.
function distributeSelected(axis) {
  const objs = selectedObjects();
  if (objs.length < 3) return;
  pushUndoSnapshot();

  const key = axis === 'horizontal' ? 'centerX' : 'centerY';
  const boxes = objs.map((o) => ({ obj: o, box: getObjectBBox(o) })).sort((a, b) => a.box[key] - b.box[key]);
  const first = boxes[0].box[key];
  const last = boxes[boxes.length - 1].box[key];
  const step = (last - first) / (boxes.length - 1);

  boxes.forEach(({ obj, box }, i) => {
    if (i === 0 || i === boxes.length - 1) return;
    const delta = first + step * i - box[key];
    if (axis === 'horizontal') translateObjectXY(obj, delta, 0);
    else translateObjectXY(obj, 0, delta);
  });

  refreshSelectionUI();
  render();
  scheduleSave();
}

function drawGrid(ctx) {
  const spacing = 40;
  const startX = -200;
  const endX = ROOM_WIDTH + 200;
  const startY = -200;
  const endY = ROOM_HEIGHT + 200;
  ctx.strokeStyle = '#1c2530';
  ctx.lineWidth = 1 / view.zoom;
  for (let x = startX; x <= endX; x += spacing) {
    ctx.beginPath();
    ctx.moveTo(x, startY);
    ctx.lineTo(x, endY);
    ctx.stroke();
  }
  for (let y = startY; y <= endY; y += spacing) {
    ctx.beginPath();
    ctx.moveTo(startX, y);
    ctx.lineTo(endX, y);
    ctx.stroke();
  }
  ctx.strokeStyle = '#4caf50';
  ctx.lineWidth = 2 / view.zoom;
  ctx.strokeRect(0, 0, ROOM_WIDTH, ROOM_HEIGHT);
}

function drawShapeBody(ctx, shape) {
  const w = shape.width;
  const h = shape.height;
  const left = -(shape.pivotX ?? 0.5) * w;
  const top = -(shape.pivotY ?? 0.5) * h;
  const asset = shape.assetId ? assets[shape.assetId] : null;

  if (asset && asset.image && asset.image.complete && asset.image.naturalWidth) {
    ctx.drawImage(asset.image, left, top, w, h);
  } else if (shape.previewShape === 'circle') {
    ctx.fillStyle = shape.color || '#4caf50';
    ctx.beginPath();
    ctx.ellipse(left + w / 2, top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1 / view.zoom;
    ctx.stroke();
  } else {
    ctx.fillStyle = shape.color || '#4caf50';
    ctx.fillRect(left, top, w, h);
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1 / view.zoom;
    ctx.strokeRect(left, top, w, h);
  }

  if (shape.interaction === 'drag_linear') {
    ctx.strokeStyle = '#ffeb3b';
    ctx.lineWidth = 2 / view.zoom;
    ctx.beginPath();
    if (shape.axis === 'horizontal') {
      ctx.moveTo(-w / 2, 0);
      ctx.lineTo(w / 2, 0);
    } else {
      ctx.moveTo(0, -h / 2);
      ctx.lineTo(0, h / 2);
    }
    ctx.stroke();
  } else if (shape.interaction === 'drag_rotate') {
    ctx.strokeStyle = '#ffeb3b';
    ctx.lineWidth = 2 / view.zoom;
    ctx.setLineDash([4 / view.zoom, 3 / view.zoom]);
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(w, h) / 2 + 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (shape.interaction === 'click') {
    ctx.strokeStyle = '#29b6f6';
    ctx.lineWidth = 2 / view.zoom;
    ctx.strokeRect(left - 4, top - 4, w + 8, h + 8);
  }

  // Output (gauge/wired-display) indicator - a distinct color from the
  // yellow input-interaction indicators above, so controls and gauges read
  // apart at a glance in the room layout.
  if (shape.outputType === 'rotate') {
    ctx.strokeStyle = '#ab47bc';
    ctx.lineWidth = 2 / view.zoom;
    ctx.setLineDash([2 / view.zoom, 2 / view.zoom]);
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(w, h) / 2 + 10, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  } else if (shape.outputType === 'linear') {
    ctx.strokeStyle = '#ab47bc';
    ctx.lineWidth = 2 / view.zoom;
    ctx.setLineDash([2 / view.zoom, 2 / view.zoom]);
    ctx.beginPath();
    if (shape.outputAxis === 'horizontal') {
      ctx.moveTo(-w / 2 - 6, 0);
      ctx.lineTo(w / 2 + 6, 0);
    } else {
      ctx.moveTo(0, -h / 2 - 6);
      ctx.lineTo(0, h / 2 + 6);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

function drawSelectionOutline(obj) {
  const canvas = el('editor-canvas');
  const ctx = canvas.getContext('2d');
  const corners = getCorners(obj);
  if (!corners.length) return;
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5 / view.zoom;
  ctx.setLineDash([5 / view.zoom, 4 / view.zoom]);
  ctx.strokeRect(Math.min(...xs) - 4, Math.min(...ys) - 4, Math.max(...xs) - Math.min(...xs) + 8, Math.max(...ys) - Math.min(...ys) + 8);
  ctx.setLineDash([]);
}

// The travel path (arc or line) and draggable stop points for a selected
// control with snap enabled - editor-only chrome, drawn on top of
// everything else, never part of the exported appearance.
function drawSnapPath(ctx, obj) {
  const geom = getSnapPathGeometry(obj);
  if (!geom) return;

  ctx.strokeStyle = '#ffd54f';
  ctx.lineWidth = 1.5 / view.zoom;
  ctx.setLineDash([4 / view.zoom, 3 / view.zoom]);
  ctx.beginPath();
  if (geom.kind === 'rotate') {
    const startRad = (geom.rotMin * Math.PI) / 180;
    const endRad = (geom.rotMax * Math.PI) / 180;
    ctx.arc(geom.cx, geom.cy, geom.radius, startRad, endRad, geom.rotMax < geom.rotMin);
  } else {
    const p0 = snapStopWorldPos(geom, 0);
    const p1 = snapStopWorldPos(geom, 1);
    ctx.moveTo(p0.x, p0.y);
    ctx.lineTo(p1.x, p1.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  (obj.snapStops || []).forEach((t) => {
    const p = snapStopWorldPos(geom, t);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 5 / view.zoom, 0, Math.PI * 2);
    ctx.fillStyle = '#ffd54f';
    ctx.fill();
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1 / view.zoom;
    ctx.stroke();
  });
}

// The node graph for a drag_h_pattern control - editor-only chrome, drawn
// only while the object is selected. Edges are plain lines between node
// world positions (obj.x/y + each node's offset); the active/rest node is
// filled solid, the rest are hollow.
function drawHPatternGraph(ctx, obj) {
  if (!obj.hPatternNodes) return;
  const worldPos = (node) => ({ x: obj.x + node.x, y: obj.y + node.y });
  const byId = new Map(obj.hPatternNodes.map((n) => [n.id, n]));

  ctx.strokeStyle = '#4dd0e1';
  ctx.lineWidth = 2 / view.zoom;
  (obj.hPatternEdges || []).forEach(([aId, bId]) => {
    const a = byId.get(aId);
    const b = byId.get(bId);
    if (!a || !b) return;
    const pa = worldPos(a);
    const pb = worldPos(b);
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  });

  obj.hPatternNodes.forEach((node) => {
    const p = worldPos(node);
    const isActive = node.id === obj.hPatternActiveNode;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 6 / view.zoom, 0, Math.PI * 2);
    ctx.fillStyle = isActive ? '#4dd0e1' : '#0a0a0a';
    ctx.fill();
    ctx.strokeStyle = '#4dd0e1';
    ctx.lineWidth = 2 / view.zoom;
    ctx.stroke();
  });
}

function computeOutputPreview(obj, t) {
  const clampedT = Math.max(0, Math.min(1, t));
  if (obj.outputType === 'rotate') {
    const rotMin = obj.outputRotationMin ?? -45;
    const rotMax = obj.outputRotationMax ?? 45;
    return { rotation: rotMin + clampedT * (rotMax - rotMin), offsetX: 0, offsetY: 0 };
  }
  if (obj.outputType === 'linear') {
    const travelMin = obj.outputTravelMin ?? 0;
    const travelMax = obj.outputTravelMax ?? 0;
    const travel = travelMin + clampedT * (travelMax - travelMin);
    return {
      rotation: obj.rotation,
      offsetX: obj.outputAxis === 'horizontal' ? travel : 0,
      offsetY: obj.outputAxis === 'horizontal' ? 0 : travel,
    };
  }
  if (obj.outputType === 'texture') {
    return {
      rotation: obj.rotation,
      offsetX: 0,
      offsetY: 0,
      assetId: clampedT >= 0.5 ? (obj.outputAltAssetId || obj.assetId) : obj.assetId,
    };
  }
  return { rotation: obj.rotation, offsetX: 0, offsetY: 0 };
}

// Mirrors computeOutputPreview, but for the input (draggable control) side:
// lets you scrub a control's full range of motion in the editor without
// actually dragging it, using the visual min/max fields declared alongside
// the interaction (separate from the game-value min/max used for binding).
// Evenly spaces `count` stops across [0, 1] inclusive - the starting point
// whenever snap is turned on or its step count changes. Once generated, an
// individual stop can be dragged off this even spacing on the canvas.
function regenerateSnapStops(count) {
  const n = Math.max(2, Math.floor(count) || 2);
  const stops = [];
  for (let i = 0; i < n; i += 1) stops.push(i / (n - 1));
  return stops;
}

function refreshSnapStopsReadout(obj) {
  if (!obj.snapEnabled || !obj.snapStops) {
    el('snap-stops-readout').textContent = '';
    return;
  }
  el('snap-stops-readout').textContent = `Stops: ${obj.snapStops.map((s) => s.toFixed(2)).join(', ')}`;
}

function nearestSnapT(obj, t) {
  if (!obj.snapEnabled || !obj.snapStops || obj.snapStops.length < 2) return t;
  let closest = obj.snapStops[0];
  let bestDist = Math.abs(t - closest);
  obj.snapStops.forEach((s) => {
    const d = Math.abs(t - s);
    if (d < bestDist) {
      bestDist = d;
      closest = s;
    }
  });
  return closest;
}

// Describes the world-space path a drag_rotate/drag_linear control's value
// travels along - an arc for rotation, a straight segment for linear travel
// - so snap stops can be positioned on it and dragged along it. null for
// any other interaction type.
function getSnapPathGeometry(obj) {
  if (obj.interaction === 'drag_rotate') {
    return {
      kind: 'rotate',
      cx: obj.x,
      cy: obj.y,
      radius: Math.max(obj.width, obj.height) / 2 + 16,
      rotMin: obj.dragRotationMin ?? -45,
      rotMax: obj.dragRotationMax ?? 45,
    };
  }
  if (obj.interaction === 'drag_linear') {
    return {
      kind: 'linear',
      cx: obj.x,
      cy: obj.y,
      axis: obj.axis,
      travelMin: obj.dragTravelMin ?? 0,
      travelMax: obj.dragTravelMax ?? 0,
    };
  }
  return null;
}

function snapStopWorldPos(geom, t) {
  if (geom.kind === 'rotate') {
    const rad = ((geom.rotMin + t * (geom.rotMax - geom.rotMin)) * Math.PI) / 180;
    return { x: geom.cx + Math.cos(rad) * geom.radius, y: geom.cy + Math.sin(rad) * geom.radius };
  }
  const travel = geom.travelMin + t * (geom.travelMax - geom.travelMin);
  return geom.axis === 'horizontal' ? { x: geom.cx + travel, y: geom.cy } : { x: geom.cx, y: geom.cy + travel };
}

// Inverse of snapStopWorldPos - projects a world position (e.g. the mouse,
// while dragging a stop) back onto the path to find its t-value.
function projectWorldPosToT(geom, worldPos) {
  if (geom.kind === 'rotate') {
    const range = geom.rotMax - geom.rotMin;
    if (!range) return 0;
    const angleDeg = (Math.atan2(worldPos.y - geom.cy, worldPos.x - geom.cx) * 180) / Math.PI;
    return Math.max(0, Math.min(1, (angleDeg - geom.rotMin) / range));
  }
  const range = geom.travelMax - geom.travelMin;
  if (!range) return 0;
  const travel = geom.axis === 'horizontal' ? worldPos.x - geom.cx : worldPos.y - geom.cy;
  return Math.max(0, Math.min(1, (travel - geom.travelMin) / range));
}

function computeInputPreview(obj, t) {
  let clampedT = Math.max(0, Math.min(1, t));
  clampedT = nearestSnapT(obj, clampedT);
  if (obj.interaction === 'drag_rotate') {
    const rotMin = obj.dragRotationMin ?? -45;
    const rotMax = obj.dragRotationMax ?? 45;
    return { rotation: rotMin + clampedT * (rotMax - rotMin), offsetX: 0, offsetY: 0 };
  }
  if (obj.interaction === 'drag_linear') {
    const travelMin = obj.dragTravelMin ?? 0;
    const travelMax = obj.dragTravelMax ?? 0;
    const travel = travelMin + clampedT * (travelMax - travelMin);
    return {
      rotation: obj.rotation,
      offsetX: obj.axis === 'horizontal' ? travel : 0,
      offsetY: obj.axis === 'horizontal' ? 0 : travel,
    };
  }
  return { rotation: obj.rotation, offsetX: 0, offsetY: 0 };
}

// The largest rect matching the preview device's aspect ratio, centered in
// the room. With no preview active this is just the whole room, so anchor
// resolution is a no-op until a device is actually selected.
function computeDeviceViewportRect() {
  if (!devicePreview) return { x: 0, y: 0, width: ROOM_WIDTH, height: ROOM_HEIGHT };
  const aspect = devicePreview.width / devicePreview.height;
  let w = ROOM_WIDTH;
  let h = ROOM_WIDTH / aspect;
  if (h > ROOM_HEIGHT) {
    h = ROOM_HEIGHT;
    w = ROOM_HEIGHT * aspect;
  }
  return { x: (ROOM_WIDTH - w) / 2, y: (ROOM_HEIGHT - h) / 2, width: w, height: h };
}

// A render-time-only position shift for anchored objects while previewing a
// device - never written back to the object, so it never affects hit
// testing, selection, alignment, or export; it's purely "what would this
// look like on that screen". Physical room objects (anchor: 'none') are
// completely unaffected regardless of preview state.
function getAnchorPreviewOffset(obj) {
  if (!devicePreview || !obj.anchor || obj.anchor === 'none' || !ANCHOR_POINTS[obj.anchor]) {
    return { dx: 0, dy: 0 };
  }
  const rect = computeDeviceViewportRect();
  const [ax, ay] = ANCHOR_POINTS[obj.anchor];
  const targetX = rect.x + ax * rect.width + (obj.anchorOffsetX ?? 0);
  const targetY = rect.y + ay * rect.height + (obj.anchorOffsetY ?? 0);
  return { dx: targetX - obj.x, dy: targetY - obj.y };
}

// Just the pixels of an object (group or plain shape) - no name label, no
// selection markers. Split out from drawObject() so the export-time layer
// flattener can rasterize objects exactly as they render on screen without
// baking in any editor-only chrome.
function drawObjectVisual(ctx, obj) {
  const anchorPreview = getAnchorPreviewOffset(obj);
  if (anchorPreview.dx || anchorPreview.dy) {
    ctx.save();
    ctx.translate(anchorPreview.dx, anchorPreview.dy);
    drawObjectVisualInner(ctx, obj);
    ctx.restore();
  } else {
    drawObjectVisualInner(ctx, obj);
  }
}

function drawObjectVisualInner(ctx, obj) {
  if (obj.type === 'group') {
    ctx.save();
    ctx.translate(obj.x, obj.y);
    ctx.rotate((obj.rotation * Math.PI) / 180);
    ctx.scale(obj.scaleX, obj.scaleY);
    obj.children.forEach((child) => {
      ctx.save();
      ctx.translate(child.offsetX, child.offsetY);
      ctx.rotate((child.rotation * Math.PI) / 180);
      ctx.scale(child.scaleX, child.scaleY);
      drawShapeBody(ctx, child);
      ctx.restore();
    });
    ctx.restore();
  } else if (obj.type === 'player_spawn') {
    ctx.save();
    ctx.translate(obj.x, obj.y);
    ctx.rotate((obj.rotation * Math.PI) / 180);
    ctx.scale(obj.scaleX, obj.scaleY);
    drawPlayerSpawnMarker(ctx, obj);
    ctx.restore();
  } else if (obj.type === 'leak_zone' || obj.type === 'fire_zone') {
    drawZoneObject(ctx, obj);
  } else {
    const activeState = getActiveVisualState(obj);
    if (activeState && activeState.visible === false) return; // this state is invisible - draw nothing

    const override = obj.id === previewOutputObjectId
      ? computeOutputPreview(obj, previewOutputT)
      : obj.id === previewInputObjectId
        ? computeInputPreview(obj, previewInputT)
        : null;
    const assetId = (override && override.assetId) || (activeState && activeState.assetId) || obj.assetId;
    const opacity = activeState && activeState.opacity != null ? activeState.opacity : 1;
    // A state can be a plain color (e.g. an indicator light's empty/loaded/
    // armed colors) instead of requiring a texture asset per state.
    const color = (activeState && activeState.color) || obj.color;
    // Lets a state reuse the object's own sprite turned to a different
    // angle (e.g. a lever's up/down position) instead of needing a second
    // texture - added on top of whatever rotation the object/drag already has.
    const rotationOffset = (activeState && activeState.rotationOffset) || 0;

    // Mirrors currentVisualOffset (used by hit-testing) exactly, so
    // clicking the sprite always works wherever it's actually drawn -
    // whether that's a drag_h_pattern control's active node, a persisted
    // drag_linear/drag_rotate previewInputT, or just its default pose.
    const visual = currentVisualOffset(obj);

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(obj.x + visual.offsetX, obj.y + visual.offsetY);
    ctx.rotate(((visual.rotation + rotationOffset) * Math.PI) / 180);
    ctx.scale(obj.scaleX, obj.scaleY);
    drawShapeBody(ctx, (assetId !== obj.assetId || color !== obj.color) ? { ...obj, assetId, color } : obj);
    ctx.restore();
  }
}

// A player spawn is invisible in the actual game - just a facing-aware
// marker so it's easy to see and aim in the editor. Drawn at the origin
// since the caller has already translated/rotated/scaled to the object.
function drawPlayerSpawnMarker(ctx, obj) {
  const radius = Math.min(obj.width, obj.height) / 2;
  const color = obj.spawnType === 'station_link' ? '#ff9800' : '#29b6f6';
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1.5 / view.zoom;
  ctx.stroke();

  // facing arrow
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(radius * 1.8, 0);
  ctx.lineTo(radius * 1.2, -radius * 0.4);
  ctx.moveTo(radius * 1.8, 0);
  ctx.lineTo(radius * 1.2, radius * 0.4);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 / view.zoom;
  ctx.stroke();
}

// A painted spawn zone: a chain of circles, one per brush dab, unioned into
// a single path so overlapping dabs still read as one flat 20%-opacity
// swatch instead of darkening where strokes cross themselves.
function drawZoneObject(ctx, obj) {
  if (!obj.points || !obj.points.length) return;
  const color = obj.type === 'leak_zone' ? '#2196f3' : '#f44336';
  const r = obj.radius || 20;
  ctx.save();
  ctx.globalAlpha = 0.2;
  ctx.fillStyle = color;
  ctx.beginPath();
  obj.points.forEach((p) => {
    ctx.moveTo(p.x + r, p.y);
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  });
  ctx.fill();
  ctx.restore();
}

function drawObject(ctx, obj) {
  drawObjectVisual(ctx, obj);

  // Device Preview is a look-only mockup of the room - none of the editor's
  // own chrome (labels, selection handles, hitbox/snap overlays) belongs in
  // it, and it would visually mismatch anyway since only the shape itself
  // shifts to its anchor-resolved position, not these obj.x/y-based extras.
  if (devicePreview) return;

  const locked = isObjectLocked(obj);

  ctx.fillStyle = locked ? '#666' : '#ccc';
  ctx.font = `${12 / view.zoom}px monospace`;
  ctx.textAlign = 'center';
  const labelY = Math.max(...getCorners(obj).map((c) => c.y)) + 14 / view.zoom;
  ctx.fillText((locked ? '🔒 ' : '') + obj.name, obj.x, labelY);

  if (selectedIds.has(obj.id) && selectedIds.size === 1 && obj.type !== 'group') {
    ctx.beginPath();
    ctx.arc(obj.x, obj.y, 5 / view.zoom, 0, Math.PI * 2);
    ctx.fillStyle = '#ff5722';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 / view.zoom;
    ctx.stroke();
  }

  if (selectedIds.has(obj.id) && obj.interaction && obj.interaction !== 'none' && obj.hitboxWidth) {
    drawHitboxOutline(obj);
  }

  if (selectedIds.has(obj.id)) drawSelectionOutline(obj);
}

// A touch hitbox is axis-aligned and doesn't rotate with the object, EXCEPT
// for drag_rotate - a rotating lever's grabbable area has to sweep with it,
// or the far end of a long handle becomes ungrabbable as soon as it swings
// away from its resting angle (see hitTestForTestMode/hitTestInteractive,
// which this mirrors exactly). Shown only while selected, since drawing it
// for every object would clutter a room full of controls.
function drawHitboxOutline(obj) {
  const canvas = el('editor-canvas');
  const ctx = canvas.getContext('2d');
  const visual = currentVisualOffset(obj);
  const baseX = obj.x + visual.offsetX;
  const baseY = obj.y + visual.offsetY;
  const w = obj.hitboxWidth;
  const h = obj.hitboxHeight ?? obj.hitboxWidth;
  const hbx = obj.hitboxOffsetX ?? 0;
  const hby = obj.hitboxOffsetY ?? 0;

  ctx.strokeStyle = '#e91e8c';
  ctx.lineWidth = 1.5 / view.zoom;
  ctx.setLineDash([3 / view.zoom, 3 / view.zoom]);

  if (obj.interaction === 'drag_rotate') {
    ctx.save();
    ctx.translate(baseX, baseY);
    ctx.rotate((visual.rotation * Math.PI) / 180);
    ctx.strokeRect(hbx - w / 2, hby - h / 2, w, h);
    ctx.restore();
  } else {
    const cx = baseX + hbx;
    const cy = baseY + hby;
    ctx.strokeRect(cx - w / 2, cy - h / 2, w, h);
  }

  ctx.setLineDash([]);
}

function render() {
  const canvas = el('editor-canvas');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.zoom, view.zoom);

  drawGrid(ctx);
  currentContainer().objects.forEach((obj) => {
    if (!isCanvasVisible(obj)) return;
    if (editingGroup && !editingGroup.childIds.has(obj.id)) {
      ctx.save();
      ctx.globalAlpha = 0.25;
      drawObject(ctx, obj);
      ctx.restore();
    } else {
      drawObject(ctx, obj);
    }
  });

  if (selectedIds.size >= 1) {
    const bounds = getSelectionBounds();
    if (bounds) {
      // A single object already gets its own dashed outline from
      // drawSelectionOutline (per-object, drawn above) - only draw a
      // second bounding-box outline here for a multi-object selection,
      // where that per-object outline doesn't exist. Resize handles apply
      // either way, using the exact same anchor-corner math regardless of
      // how many objects are selected.
      if (selectedIds.size >= 2) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1 / view.zoom;
        ctx.setLineDash([5 / view.zoom, 4 / view.zoom]);
        ctx.strokeRect(bounds.minX, bounds.minY, bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
        ctx.setLineDash([]);
      }
      getResizeHandles(bounds).forEach((handle) => {
        ctx.fillStyle = '#29b6f6';
        ctx.fillRect(handle.x - 5 / view.zoom, handle.y - 5 / view.zoom, 10 / view.zoom, 10 / view.zoom);
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1 / view.zoom;
        ctx.strokeRect(handle.x - 5 / view.zoom, handle.y - 5 / view.zoom, 10 / view.zoom, 10 / view.zoom);
      });
    }
  }

  if (selectedIds.size === 1 && !devicePreview) {
    const obj = findObject([...selectedIds][0]);
    if (obj && obj.snapEnabled) drawSnapPath(ctx, obj);
    if (obj && obj.interaction === 'drag_h_pattern') drawHPatternGraph(ctx, obj);
  }

  if (devicePreview) {
    const rect = computeDeviceViewportRect();
    ctx.strokeStyle = '#e91e63';
    ctx.lineWidth = 2 / view.zoom;
    ctx.setLineDash([6 / view.zoom, 4 / view.zoom]);
    ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
    ctx.setLineDash([]);
  }

  if (boxSelectRect) {
    ctx.strokeStyle = '#29b6f6';
    ctx.lineWidth = 1 / view.zoom;
    ctx.setLineDash([4 / view.zoom, 3 / view.zoom]);
    const x = Math.min(boxSelectRect.x0, boxSelectRect.x1);
    const y = Math.min(boxSelectRect.y0, boxSelectRect.y1);
    const w = Math.abs(boxSelectRect.x1 - boxSelectRect.x0);
    const h = Math.abs(boxSelectRect.y1 - boxSelectRect.y0);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
  }

  if (paintMode && lastMouseWorldPos) {
    ctx.strokeStyle = paintMode === 'leak' ? '#2196f3' : '#f44336';
    ctx.lineWidth = 1.5 / view.zoom;
    ctx.setLineDash([4 / view.zoom, 3 / view.zoom]);
    ctx.beginPath();
    ctx.arc(lastMouseWorldPos.x, lastMouseWorldPos.y, brushSize, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.restore();
}

// --- Canvas interaction ----------------------------------------------------

const canvas = el('editor-canvas');

canvas.addEventListener('dblclick', (event) => {
  const screenPos = getCanvasMousePos(event);
  const worldPos = screenToWorld(screenPos.x, screenPos.y);
  const hit = hitTestTopObject(worldPos.x, worldPos.y);
  if (hit && hit.type === 'group') enterObjectEditMode(hit.id);
});

canvas.addEventListener('mousedown', (event) => {
  const screenPos = getCanvasMousePos(event);
  const worldPos = screenToWorld(screenPos.x, screenPos.y);

  if (spaceHeld) {
    dragMode = 'pan';
    dragMouseStart = screenPos;
    dragViewStart = { offsetX: view.offsetX, offsetY: view.offsetY };
    return;
  }

  if (testMode) {
    const hit = hitTestForTestMode(worldPos.x, worldPos.y);
    if (hit) {
      selectSingle(hit.id);
      if (hit.interaction === 'click') {
        if (hit.statesEnabled && hit.visualStates && hit.visualStates.length) {
          const currentName = hit.id === previewStateObjectId && previewStateName ? previewStateName : hit.defaultVisualState;
          const idx = hit.visualStates.findIndex((s) => s.name === currentName);
          const next = hit.visualStates[(idx + 1) % hit.visualStates.length];
          previewStateObjectId = hit.id;
          previewStateName = next.name;
          render();
        }
      } else if (hit.interaction === 'drag_h_pattern') {
        pushUndoSnapshot();
        dragMode = 'test-drag';
        testDragObjId = hit.id;
        const startNode = (hit.hPatternNodes || []).find((n) => n.id === hit.hPatternActiveNode);
        testDragHPatternOffset = startNode ? { x: startNode.x, y: startNode.y } : { x: 0, y: 0 };
      } else if (hit.interaction === 'drag_linear' || hit.interaction === 'drag_rotate') {
        dragMode = 'test-drag';
        testDragObjId = hit.id;
      }
    }
    return;
  }

  if (paintMode) {
    pushUndoSnapshot();
    const type = paintMode === 'leak' ? 'leak_zone' : 'fire_zone';
    activeZoneObj = {
      id: makeObjectId(paintMode === 'leak' ? 'Leak Zone' : 'Fire Zone'),
      name: paintMode === 'leak' ? 'Leak Zone' : 'Fire Zone',
      type,
      x: worldPos.x,
      y: worldPos.y,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      radius: brushSize,
      points: [{ x: worldPos.x, y: worldPos.y }],
      notes: '',
    };
    currentContainer().objects.push(activeZoneObj);
    if (editingGroup) editingGroup.childIds.add(activeZoneObj.id);
    dragMode = 'paint';
    render();
    return;
  }

  const resizeHandle = hitTestResizeHandle(screenPos);
  if (resizeHandle) {
    pushUndoSnapshot();
    dragMode = 'resize-selection';
    resizeDragStart = {
      corner: { x: resizeHandle.x, y: resizeHandle.y },
      anchor: { x: resizeHandle.anchorX, y: resizeHandle.anchorY },
      objectStarts: new Map(selectedObjects().map((o) => [o.id, { x: o.x, y: o.y, scaleX: o.scaleX, scaleY: o.scaleY }])),
    };
    return;
  }

  const snapStopHit = hitTestSnapStopHandle(screenPos);
  if (snapStopHit) {
    pushUndoSnapshot();
    dragMode = 'snap-stop';
    snapStopDragInfo = snapStopHit;
    return;
  }

  const hPatternHit = hitTestHPatternNode(screenPos);
  if (hPatternHit) {
    const obj = findObject(hPatternHit.objId);
    if (
      event.shiftKey &&
      lastClickedHPatternNodeId &&
      lastClickedHPatternNodeObjId === hPatternHit.objId &&
      lastClickedHPatternNodeId !== hPatternHit.nodeId
    ) {
      // Toggling doesn't move the anchor: shift-clicking the same node
      // again toggles the same edge back off, instead of connecting it to
      // itself. Click a node plainly first to move the anchor elsewhere.
      toggleHPatternEdge(obj, lastClickedHPatternNodeId, hPatternHit.nodeId);
    } else {
      pushUndoSnapshot();
      obj.hPatternActiveNode = hPatternHit.nodeId;
      renderHPatternNodeList(obj);
      render();
      scheduleSave();
      lastClickedHPatternNodeId = hPatternHit.nodeId;
      lastClickedHPatternNodeObjId = hPatternHit.objId;
    }
    dragMode = 'hpattern-node';
    hPatternDragNodeId = hPatternHit.nodeId;
    return;
  }

  const pivotObj = hitTestPivotHandle(screenPos);
  if (pivotObj) {
    pushUndoSnapshot();
    dragMode = 'move-pivot';
    pivotDragStart = { x0: pivotObj.x, y0: pivotObj.y, pivotX0: pivotObj.pivotX ?? 0.5, pivotY0: pivotObj.pivotY ?? 0.5 };
    return;
  }

  const hit = hitTestTopObject(worldPos.x, worldPos.y);
  if (hit) {
    if (event.shiftKey) {
      toggleSelection(hit.id);
      if (!selectedIds.has(hit.id)) return; // just deselected it, don't start a drag
    } else if (!selectedIds.has(hit.id)) {
      selectSingle(hit.id);
    }
    pushUndoSnapshot();
    dragMode = 'move-objects';
    dragMouseStart = worldPos;
    dragObjectStarts = new Map(selectedObjects().map((o) => [o.id, { x: o.x, y: o.y, points: o.points ? o.points.map((p) => ({ ...p })) : null }]));
  } else {
    if (!event.shiftKey) {
      selectedIds = new Set();
      refreshSelectionUI();
    }
    dragMode = 'box-select';
    boxSelectRect = { x0: worldPos.x, y0: worldPos.y, x1: worldPos.x, y1: worldPos.y };
  }
});

window.addEventListener('mousemove', (event) => {
  const screenPos = getCanvasMousePos(event);

  if (paintMode && !dragMode) {
    lastMouseWorldPos = screenToWorld(screenPos.x, screenPos.y);
    render();
  }

  if (!dragMode) return;

  if (dragMode === 'paint') {
    const worldPos = screenToWorld(screenPos.x, screenPos.y);
    lastMouseWorldPos = worldPos;
    const last = activeZoneObj.points[activeZoneObj.points.length - 1];
    if (Math.hypot(worldPos.x - last.x, worldPos.y - last.y) >= activeZoneObj.radius / 3) {
      activeZoneObj.points.push({ x: worldPos.x, y: worldPos.y });
    }
    render();
    return;
  }

  if (dragMode === 'snap-stop') {
    const obj = findObject(snapStopDragInfo.objId);
    const geom = obj && getSnapPathGeometry(obj);
    if (obj && geom) {
      const worldPos = screenToWorld(screenPos.x, screenPos.y);
      obj.snapStops[snapStopDragInfo.index] = projectWorldPosToT(geom, worldPos);
      refreshSnapStopsReadout(obj);
      render();
    }
    return;
  }

  if (dragMode === 'hpattern-node') {
    const objs = selectedObjects();
    const obj = objs.length === 1 ? objs[0] : null;
    const node = obj && obj.hPatternNodes && obj.hPatternNodes.find((n) => n.id === hPatternDragNodeId);
    if (node) {
      const worldPos = screenToWorld(screenPos.x, screenPos.y);
      node.x = worldPos.x - obj.x;
      node.y = worldPos.y - obj.y;
      render();
    }
    return;
  }

  if (dragMode === 'test-drag') {
    const obj = findObject(testDragObjId);
    if (!obj) return;
    const worldPos = screenToWorld(screenPos.x, screenPos.y);
    if (obj.interaction === 'drag_h_pattern') {
      // Confined to its rails: the handle can only slide along the segment
      // connecting the active node to one of its directly-connected
      // neighbors (whichever one the pointer is actually closest to),
      // clamped so it can't overshoot past that neighbor - a real shift
      // lever can't leave its slot. It locks into the neighboring gate once
      // it's slid within 10% of that gate's own distance along the rail.
      const localX = worldPos.x - obj.x;
      const localY = worldPos.y - obj.y;

      const byId = new Map(obj.hPatternNodes.map((n) => [n.id, n]));
      const activeNode = byId.get(obj.hPatternActiveNode);
      if (activeNode) {
        const neighborIds = new Set();
        (obj.hPatternEdges || []).forEach(([a, b]) => {
          if (a === obj.hPatternActiveNode) neighborIds.add(b);
          if (b === obj.hPatternActiveNode) neighborIds.add(a);
        });

        let best = null;
        neighborIds.forEach((id) => {
          const node = byId.get(id);
          if (!node) return;
          const dx = node.x - activeNode.x;
          const dy = node.y - activeNode.y;
          const lenSq = dx * dx + dy * dy;
          let t = lenSq > 0 ? ((localX - activeNode.x) * dx + (localY - activeNode.y) * dy) / lenSq : 0;
          t = Math.max(0, Math.min(1, t));
          const projX = activeNode.x + dx * t;
          const projY = activeNode.y + dy * t;
          const dist = Math.hypot(localX - projX, localY - projY);
          if (!best || dist < best.dist) best = { id, t, x: projX, y: projY, dist };
        });

        if (best) {
          testDragHPatternOffset = { x: best.x, y: best.y };
          if (best.t >= 0.9) obj.hPatternActiveNode = best.id;
        } else {
          // No connected neighbors - nothing to slide along.
          testDragHPatternOffset = { x: activeNode.x, y: activeNode.y };
        }
      }
    } else {
      const geom = getSnapPathGeometry(obj);
      if (geom) {
        previewInputObjectId = obj.id;
        previewInputT = nearestSnapT(obj, projectWorldPosToT(geom, worldPos));
      }
    }
    render();
    return;
  }

  if (dragMode === 'pan') {
    view.offsetX = dragViewStart.offsetX + (screenPos.x - dragMouseStart.x);
    view.offsetY = dragViewStart.offsetY + (screenPos.y - dragMouseStart.y);
    render();
  } else if (dragMode === 'move-objects') {
    const worldPos = screenToWorld(screenPos.x, screenPos.y);
    const dx = worldPos.x - dragMouseStart.x;
    const dy = worldPos.y - dragMouseStart.y;
    dragObjectStarts.forEach((start, id) => {
      const obj = findObject(id);
      if (obj) {
        obj.x = start.x + dx;
        obj.y = start.y + dy;
        if (start.points) obj.points = start.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      }
    });
    if (selectedIds.size === 1) {
      const obj = findObject([...selectedIds][0]);
      if (obj) updateInspectorFromObject(obj);
    }
    render();
  } else if (dragMode === 'box-select') {
    const worldPos = screenToWorld(screenPos.x, screenPos.y);
    boxSelectRect.x1 = worldPos.x;
    boxSelectRect.y1 = worldPos.y;
    render();
  } else if (dragMode === 'move-pivot') {
    const worldPos = screenToWorld(screenPos.x, screenPos.y);
    const obj = findObject([...selectedIds][0]);
    if (obj) {
      const dxWorld = worldPos.x - pivotDragStart.x0;
      const dyWorld = worldPos.y - pivotDragStart.y0;
      const rad = (-obj.rotation * Math.PI) / 180;
      const rx = dxWorld * Math.cos(rad) - dyWorld * Math.sin(rad);
      const ry = dxWorld * Math.sin(rad) + dyWorld * Math.cos(rad);
      obj.pivotX = pivotDragStart.pivotX0 + rx / obj.scaleX / obj.width;
      obj.pivotY = pivotDragStart.pivotY0 + ry / obj.scaleY / obj.height;
      obj.x = worldPos.x;
      obj.y = worldPos.y;
      updateInspectorFromObject(obj);
    }
    render();
  } else if (dragMode === 'resize-selection') {
    const worldPos = screenToWorld(screenPos.x, screenPos.y);
    const { anchor, corner, objectStarts } = resizeDragStart;
    let scaleFactorX = corner.x === anchor.x ? 1 : (worldPos.x - anchor.x) / (corner.x - anchor.x);
    let scaleFactorY = corner.y === anchor.y ? 1 : (worldPos.y - anchor.y) / (corner.y - anchor.y);
    if (uniformResizeEnabled) {
      // Project the mouse onto the anchor->corner diagonal so both axes
      // scale by the same signed factor, instead of independently.
      const dirX = corner.x - anchor.x;
      const dirY = corner.y - anchor.y;
      const dirLen = Math.hypot(dirX, dirY) || 1;
      const projected = ((worldPos.x - anchor.x) * dirX + (worldPos.y - anchor.y) * dirY) / dirLen;
      const factor = projected / dirLen;
      scaleFactorX = factor;
      scaleFactorY = factor;
    }
    objectStarts.forEach((start, id) => {
      const obj = findObject(id);
      if (!obj) return;
      obj.x = anchor.x + (start.x - anchor.x) * scaleFactorX;
      obj.y = anchor.y + (start.y - anchor.y) * scaleFactorY;
      obj.scaleX = start.scaleX * scaleFactorX;
      obj.scaleY = start.scaleY * scaleFactorY;
    });
    render();
  }
});

window.addEventListener('mouseup', () => {
  if (dragMode === 'paint') {
    activeZoneObj = null;
    renderObjectList();
    scheduleSave();
  } else if (dragMode === 'snap-stop') {
    const obj = findObject(snapStopDragInfo.objId);
    if (obj && obj.snapStops) {
      obj.snapStops.sort((a, b) => a - b);
      refreshSnapStopsReadout(obj);
      render();
    }
    snapStopDragInfo = null;
    scheduleSave();
  } else if (dragMode === 'hpattern-node') {
    hPatternDragNodeId = null;
    scheduleSave();
  } else if (dragMode === 'test-drag') {
    // drag_linear/drag_rotate leave previewInputT wherever it was released
    // (like letting go of a real lever) - nothing is written to the object
    // itself, so there's nothing to save there. An h-pattern move DID
    // mutate hPatternActiveNode live, so that gets persisted. Clearing the
    // free-drag offset snaps the sprite back to that node's exact position -
    // its last confirmed gate if the pointer never reached the 10% zone
    // around a neighbor, or the new gate if it did.
    const obj = findObject(testDragObjId);
    if (obj && obj.interaction === 'drag_h_pattern') scheduleSave();
    testDragObjId = null;
    testDragHPatternOffset = null;
    render();
  } else if (dragMode === 'move-objects' || dragMode === 'move-pivot' || dragMode === 'resize-selection') {
    scheduleSave();
  } else if (dragMode === 'box-select' && boxSelectRect) {
    const x0 = Math.min(boxSelectRect.x0, boxSelectRect.x1);
    const x1 = Math.max(boxSelectRect.x0, boxSelectRect.x1);
    const y0 = Math.min(boxSelectRect.y0, boxSelectRect.y1);
    const y1 = Math.max(boxSelectRect.y0, boxSelectRect.y1);
    const room = currentContainer();
    const inBox = room.objects.filter((o) => !isInteractionBlocked(o) && isCanvasVisible(o) && o.x >= x0 && o.x <= x1 && o.y >= y0 && o.y <= y1);
    if (inBox.length) {
      inBox.forEach((o) => selectedIds.add(o.id));
      refreshSelectionUI();
    }
    boxSelectRect = null;
    render();
  }
  dragMode = null;
});

canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    const screenPos = getCanvasMousePos(event);
    const worldBefore = screenToWorld(screenPos.x, screenPos.y);
    const factor = event.deltaY < 0 ? 1.1 : 0.9;
    view.zoom = Math.max(0.2, Math.min(4, view.zoom * factor));
    view.offsetX = screenPos.x - worldBefore.x * view.zoom;
    view.offsetY = screenPos.y - worldBefore.y * view.zoom;
    render();
  },
  { passive: false },
);

window.addEventListener('keydown', (event) => {
  const tag = event.target && event.target.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  if (event.code === 'Space' && !typing) {
    spaceHeld = true;
    canvas.style.cursor = 'grab';
    event.preventDefault();
    return;
  }

  if (typing) return;

  if (event.key === 'Escape' && paintMode) {
    setPaintMode(paintMode);
    return;
  }

  if (event.key === 'Escape' && testMode) {
    setTestMode(false);
    return;
  }

  if (event.key.toLowerCase() === 'g' && event.ctrlKey) {
    event.preventDefault();
    groupSelected();
    return;
  }

  if (event.key.toLowerCase() === 'z' && event.ctrlKey && event.shiftKey) {
    event.preventDefault();
    redo();
    return;
  }
  if (event.key.toLowerCase() === 'z' && event.ctrlKey) {
    event.preventDefault();
    undo();
    return;
  }
  if (event.key.toLowerCase() === 'y' && event.ctrlKey) {
    event.preventDefault();
    redo();
    return;
  }

  if (selectedIds.size === 0) return;

  if (event.key === 'Delete' || event.key === 'Backspace') {
    deleteObjects([...selectedIds]);
    return;
  }
  if (event.key.toLowerCase() === 'd' && event.ctrlKey) {
    event.preventDefault();
    duplicateObjects([...selectedIds]);
    return;
  }

  if (selectedIds.size !== 1) return;
  const obj = findObject([...selectedIds][0]);
  if (!obj) return;

  const isArrow = event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowRight';
  if (!isArrow) return;
  if (!event.repeat) pushUndoSnapshot();

  const step = event.shiftKey ? 10 : 1;
  let dx = 0;
  let dy = 0;
  if (event.key === 'ArrowUp') dy = -step;
  else if (event.key === 'ArrowDown') dy = step;
  else if (event.key === 'ArrowLeft') dx = -step;
  else if (event.key === 'ArrowRight') dx = step;
  obj.x += dx;
  obj.y += dy;
  if (obj.points) obj.points = obj.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
  event.preventDefault();
  updateInspectorFromObject(obj);
  render();
  scheduleSave();
});

window.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    spaceHeld = false;
    canvas.style.cursor = '';
  }
});

// --- Init ------------------------------------------------------------------

loadFromLocalStorage();
renderRoomSelect();
renderViewSelect();
renderAssetList();
renderPrefabList();
renderObjectList();
refreshSelectionUI();
refreshUndoRedoButtons();
render();
initAssetsFolder();
initExportFolder();
populateBindingDatalists();
