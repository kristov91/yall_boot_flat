// Room Renderer - the "receiving end" of the Sub Editor export pipeline.
//
// Loads a room's exported JSON (layouts/<room_id>.json) plus its packed
// spritesheet PNG, and draws either the compartment view's own objects or
// one station's dedicated object list onto a canvas, in z-order, at the
// design resolution the Sub Editor authors against (960x540).
//
// Draws exactly what the layout says (position/rotation/scale/sprite/pivot,
// the same way the Sub Editor's own canvas renders it), and can additionally:
//   - drive outputs (gauge needles, linear slides, texture swaps, visual
//     states) from a live game-state object, via each object's own
//     outputBinding/stateBinding dot-path;
//   - answer hit-tests and value-from-drag math for interactive objects
//     (click/drag_linear/drag_rotate/drag_h_pattern), using each object's
//     own hitbox/min/max/reverse/snap/node-graph data - the same math the
//     Sub Editor's own canvas uses to preview a control, just driven by a
//     real pointer instead of a slider;
//   - draw two fully server-driven displays with no per-object binding of
//     their own, hardcoded to specific game-state shapes rather than a
//     generic dot-path: outputType "sonar_scope" (the sweep line, contact
//     pulse rings and bearing blip, reading sonar_dial/sonar) and
//     "nav_map" (own-ship heading marker and revealed contacts, reading
//     map) - see drawSonarScope/drawNavMap.
// It still never touches a WebSocket or knows what a "station" means beyond
// "a named sub-list of objects" - client.js owns all of that, and just
// hands this module plain data (a game-state object, a pointer position) to
// interpret. Kept separate so each half is easy to verify on its own: if a
// room built in the Sub Editor doesn't look or behave right here, the bug
// is almost certainly in this file, not tangled up with networking code.

const RoomRenderer = (() => {
  const cache = {}; // room id -> { data, image, frames } | Promise<same>
  let bundlePromise = null; // lazily-loaded layouts/layouts.json, shared by every room inside it

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load image: ${src}`));
      img.src = src;
    });
  }

  // Shared VFX sprites (weld spots/sparks/water drops/cracks) - NOT part of
  // any one room's own spritesheet, served instead from the project-root
  // graphics/effects/ folder (see dev_server.js's /graphics/ route). Loaded
  // once, fire-and-forget, at module load; EFFECT_SPRITES[name] is simply
  // undefined until its image resolves, and every draw call below already
  // guards for that so a slow/failed load just means that frame skips it
  // rather than throwing.
  const EFFECT_SPRITES = {};
  ['spark', 'waterDrop', 'waterDrop2', 'WeldSpot', 'WeldSpotHot', 'Crack1'].forEach((name) => {
    loadImage(`graphics/effects/${name}.png`)
      .then((img) => { EFFECT_SPRITES[name] = img; })
      .catch((err) => console.warn(`Room Renderer: ${err.message}`));
  });

  // "Export Room" writes layouts/<room_id>.json with its own spritesheet;
  // "Export All Rooms" instead writes one layouts/layouts.json bundle -
  // {<room_id>: {...}, ..., spritesheet: {...}} - shared across every room
  // in it. Loaded once and reused for every room id that isn't found as its
  // own single-room export.
  async function loadBundle() {
    if (!bundlePromise) {
      bundlePromise = (async () => {
        const res = await fetch('layouts/layouts.json');
        if (!res.ok) throw new Error(`No layouts/layouts.json bundle found either (HTTP ${res.status})`);
        const bundle = await res.json();
        const image = bundle.spritesheet && bundle.spritesheet.file
          ? await loadImage(`layouts/${bundle.spritesheet.file}`)
          : null;
        return { bundle, image };
      })();
    }
    return bundlePromise;
  }

  // Fetches and caches a room's layout + spritesheet, trying its own
  // single-room export first and falling back to the combined bundle. Safe
  // to call repeatedly - concurrent/duplicate calls for the same room id
  // share one in-flight request rather than double-fetching.
  async function load(roomId) {
    if (cache[roomId]) return cache[roomId];
    const promise = (async () => {
      const singleRes = await fetch(`layouts/${roomId}.json`).catch(() => null);
      if (singleRes && singleRes.ok) {
        const data = await singleRes.json();
        const image = data.spritesheet && data.spritesheet.file
          ? await loadImage(`layouts/${data.spritesheet.file}`)
          : null;
        return { data, image, frames: (data.spritesheet && data.spritesheet.frames) || {} };
      }

      const { bundle, image } = await loadBundle();
      const data = bundle[roomId];
      if (!data) {
        throw new Error(`Room "${roomId}" not found as layouts/${roomId}.json or inside the layouts/layouts.json bundle`);
      }
      return { data, image, frames: (bundle.spritesheet && bundle.spritesheet.frames) || {} };
    })();
    cache[roomId] = promise;
    try {
      return await promise;
    } catch (err) {
      delete cache[roomId]; // don't poison the cache with a failed load - allow retrying
      throw err;
    }
  }

  function frameFor(entry, assetId) {
    if (!assetId) return null;
    return entry.frames[assetId] || null;
  }

  // Returns the compartment's own objects (stationId omitted/null) or one
  // station's dedicated object list, in the layout's own z-order.
  function objectsFor(entry, stationId) {
    if (!entry) return [];
    if (!stationId) return entry.data.objects || [];
    const station = entry.data.stations && entry.data.stations[stationId];
    return station ? station.objects : [];
  }

  // Reads a dot-path ("engine.rpm") out of a plain live-game-state object,
  // the same shape client.js's applyState() already parses off the server's
  // broadcast. undefined if any segment is missing, never throws.
  function resolvePath(state, path) {
    if (!state || !path) return undefined;
    return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), state);
  }

  // --- Interaction math (ported from the Sub Editor's own canvas, which
  // uses this exact math to preview a control without a live server) -----

  // Describes the world-space path a drag_rotate/drag_linear control's
  // value visually travels along - an arc for rotation, a straight segment
  // for linear travel - purely for the ON-SCREEN sweep, independent of the
  // actual game value range (obj.min/max) sent to the server.
  function getSnapPathGeometry(obj) {
    if (obj.interaction === 'drag_rotate') {
      return {
        kind: 'rotate',
        cx: obj.x,
        cy: obj.y,
        radius: Math.max(obj.width || 0, obj.height || 0) / 2 + 16,
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

  // Inverse of the path geometry - projects a world position (the pointer,
  // while dragging) onto the path to find its t-value in [0, 1].
  function projectWorldPosToT(geom, worldX, worldY) {
    if (geom.kind === 'rotate') {
      const range = geom.rotMax - geom.rotMin;
      if (!range) return 0;
      const angleDeg = (Math.atan2(worldY - geom.cy, worldX - geom.cx) * 180) / Math.PI;
      return Math.max(0, Math.min(1, (angleDeg - geom.rotMin) / range));
    }
    const range = geom.travelMax - geom.travelMin;
    if (!range) return 0;
    const travel = geom.axis === 'horizontal' ? worldX - geom.cx : worldY - geom.cy;
    return Math.max(0, Math.min(1, (travel - geom.travelMin) / range));
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

  // --- drag_h_pattern math (ported from the Sub Editor's own Live Test Mode,
  // which uses this exact math) ---------------------------------------------

  // Which node a drag_h_pattern control is currently resting at, if nothing
  // has moved it this session yet - its own authored active node (or just
  // the first node as a last resort if that's somehow missing).
  function inferHPatternRestingNode(obj) {
    if (!obj.hPatternNodes || !obj.hPatternNodes.length) return null;
    return obj.hPatternNodes.find((n) => n.id === obj.hPatternActiveNode) || obj.hPatternNodes[0];
  }

  // Confines the handle to whichever rail (the segment from the active node
  // to one of its directly-connected neighbors) the given local-space point
  // is actually closest to, clamped so it can't overshoot past that
  // neighbor - a real shift lever can't leave its slot. Returns the
  // projected {x, y} to render at, plus snappedNodeId set once the point has
  // slid within 10% of a neighbor's own distance along that rail (null
  // otherwise, meaning stay on the current active node).
  function projectHPatternRail(obj, activeNodeId, localX, localY) {
    const byId = new Map(obj.hPatternNodes.map((n) => [n.id, n]));
    const activeNode = byId.get(activeNodeId);
    if (!activeNode) return null;

    const neighborIds = new Set();
    (obj.hPatternEdges || []).forEach(([a, b]) => {
      if (a === activeNodeId) neighborIds.add(b);
      if (b === activeNodeId) neighborIds.add(a);
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

    if (!best) return { x: activeNode.x, y: activeNode.y, snappedNodeId: null };
    return { x: best.x, y: best.y, snappedNodeId: best.t >= 0.9 ? best.id : null };
  }

  // Where a control's t-value sits when nothing has dragged it yet, inferred
  // from its own authored resting pose rather than assumed to be 0 - so the
  // very first grab starts from wherever the control actually looks like it
  // is, instead of snapping it to whatever position the raw click point
  // happens to project onto.
  function inferRestingT(obj) {
    const geom = getSnapPathGeometry(obj);
    if (!geom) return 0.5;
    if (geom.kind === 'rotate') {
      const range = geom.rotMax - geom.rotMin;
      if (!range) return 0;
      return Math.max(0, Math.min(1, ((obj.rotation || 0) - geom.rotMin) / range));
    }
    const range = geom.travelMax - geom.travelMin;
    if (!range) return 0;
    return Math.max(0, Math.min(1, (0 - geom.travelMin) / range));
  }

  // A dragRotate control's t is normally clamped to [0,1] like every other
  // drag control - a lever has end stops. dragInfinite marks the rare
  // exception (a compass-style dial with none): t is left unbounded so it
  // can spin through any number of full turns, and wraps via modulo instead
  // of clamping wherever it maps to an actual angle/value. Snapping doesn't
  // apply to an infinite control (there's no fixed [0,1] range for stops to
  // live in), so it's skipped entirely for one.
  function normalizeT(obj, t) {
    if (obj.interaction === 'drag_rotate' && obj.dragInfinite) {
      return ((t % 1) + 1) % 1;
    }
    const clampedT = Math.max(0, Math.min(1, t));
    // dragDeadzone: the middle N% of the handle's own [0,1] travel snaps to
    // exactly the center (t=0.5, the midpoint of Min/Max - 0 for a
    // symmetric -1..1 range like a steering wheel) - lets a spring-loaded
    // control reliably land on a clean zero instead of a tiny stray value
    // from not quite releasing dead-center. Checked before snap-to-stops
    // since a deadzone and discrete snap stops aren't meant to combine.
    if (obj.dragDeadzone && Math.abs(clampedT - 0.5) < obj.dragDeadzone / 2) {
      return 0.5;
    }
    return nearestSnapT(obj, clampedT);
  }

  // Visual-only feedback while dragging: how far the sprite itself should
  // rotate/slide on screen, using the authored visual sweep - NOT the game
  // value range. Mirrors computeInputPreview in the Sub Editor exactly.
  function computeInputVisual(obj, t) {
    if (obj.interaction === 'drag_rotate') {
      const rotMin = obj.dragRotationMin ?? -45;
      const rotMax = obj.dragRotationMax ?? 45;
      // Unclamped t here (not normalizeT's wrapped version) - the sprite
      // itself should keep visually spinning through multiple turns rather
      // than snapping back to the start of the sweep every time it wraps.
      const spinT = obj.dragInfinite ? t : normalizeT(obj, t);
      return { rotation: rotMin + spinT * (rotMax - rotMin), offsetX: 0, offsetY: 0 };
    }
    if (obj.interaction === 'drag_linear') {
      const clampedT = normalizeT(obj, t);
      const travelMin = obj.dragTravelMin ?? 0;
      const travelMax = obj.dragTravelMax ?? 0;
      const travel = travelMin + clampedT * (travelMax - travelMin);
      return {
        rotation: obj.rotation || 0,
        offsetX: obj.axis === 'horizontal' ? travel : 0,
        offsetY: obj.axis === 'horizontal' ? 0 : travel,
      };
    }
    return { rotation: obj.rotation || 0, offsetX: 0, offsetY: 0 };
  }

  // The actual game value to send to the server: obj.min/max (and reverse),
  // not the visual sweep above - a control's on-screen travel and its
  // real value range are deliberately independent.
  function computeGameValue(obj, t) {
    const clampedT = normalizeT(obj, t);
    const eased = obj.reverse ? 1 - clampedT : clampedT;
    const min = obj.min ?? 0;
    const max = obj.max ?? 1;
    return min + eased * (max - min);
  }

  // --- Output binding (live game state -> visual) -------------------------

  // Damps a rotate output's underlying value so the needle eases toward a
  // new reading instead of snapping to it every broadcast - a real analog
  // needle has inertia. Keyed by object id, persisted across calls in this
  // module's own closure (the same idea as the Sub Editor's undo stack or
  // this file's own load() cache - state that outlives a single render).
  // Wobble is added AFTER smoothing, not smoothed itself, so the shiver
  // stays crisp and only the value it shivers around eases in.
  const smoothedRotations = {};

  function smoothRotationTarget(obj, target) {
    const smoothingSeconds = obj.outputSmoothingSeconds ?? 0.25;
    if (smoothingSeconds <= 0) return target;
    const now = Date.now();
    const prev = smoothedRotations[obj.id];
    if (!prev) {
      smoothedRotations[obj.id] = { value: target, ts: now };
      return target;
    }
    const dt = Math.max(0, (now - prev.ts) / 1000);
    const alpha = 1 - Math.exp(-dt / smoothingSeconds);
    const value = prev.value + (target - prev.value) * alpha;
    smoothedRotations[obj.id] = { value, ts: now };
    return value;
  }

  function computeOutputVisual(obj, gameState) {
    if (!obj.outputType || obj.outputType === 'none' || !gameState) return null;
    const raw = resolvePath(gameState, obj.outputBinding);
    if (raw === undefined) return null;

    if (obj.outputType === 'texture') {
      return { assetId: raw ? (obj.outputAltAssetId || obj.assetId) : obj.assetId };
    }

    const min = obj.outputMin ?? 0;
    const max = obj.outputMax ?? 1;
    const range = max - min;
    const t = range === 0 ? 0 : Math.max(0, Math.min(1, (raw - min) / range));

    if (obj.outputType === 'rotate') {
      const rotMin = obj.outputRotationMin ?? -45;
      const rotMax = obj.outputRotationMax ?? 45;
      let rotation = smoothRotationTarget(obj, rotMin + t * (rotMax - rotMin));
      // A second, independent binding (e.g. sonar.pulse_hz) wobbles the
      // needle around wherever the primary value already has it pointing -
      // one gauge reading both an amplitude (the pointed-at position) and
      // a frequency (how fast it shivers) at once, the way a real analog
      // meter picking up an AC signal would. outputWobbleSpeedScale
      // deliberately shrinks the real Hz value for the animation - the
      // sonar's own 0.5-3 Hz range would otherwise flicker too fast for a
      // human eye to read as a rate at all.
      if (obj.outputWobbleBinding) {
        const wobbleHz = resolvePath(gameState, obj.outputWobbleBinding);
        if (wobbleHz) {
          const visualHz = wobbleHz * (obj.outputWobbleSpeedScale ?? 0.25);
          const amplitude = obj.outputWobbleAmplitude ?? 8;
          rotation += Math.sin(Date.now() / 1000 * visualHz * Math.PI * 2) * amplitude;
        }
      }
      return { rotation };
    }
    if (obj.outputType === 'linear') {
      const travelMin = obj.outputTravelMin ?? 0;
      const travelMax = obj.outputTravelMax ?? 0;
      const travel = travelMin + t * (travelMax - travelMin);
      return {
        offsetX: obj.axis === 'horizontal' ? travel : 0,
        offsetY: obj.axis === 'horizontal' ? 0 : travel,
      };
    }
    return null;
  }

  // State names are always authored as strings ("forward", "true", "2"),
  // but a state binding can resolve to any JSON type the server broadcasts
  // - a bool for something like engine.running, a number, or a string enum
  // like gear. Comparing with String() lets a boolean/number binding match
  // a state literally named "true"/"false"/"2", instead of every non-string
  // binding silently falling through to defaultVisualState forever.
  //
  // lastKnownToggle is the fallback for a Toggle Switch with no real
  // server-tracked value to read back (State Binding left blank, or pointed
  // at something that doesn't resolve) - a purely decorative switch with no
  // backing simulation state. Without this, such a switch's sprite could
  // never actually flip: resolveVisualState would fall through to
  // defaultVisualState on every render, forever, even though clicking it
  // does send an action. client.js remembers the last click locally here,
  // the same "client's own memory" fallback lastKnownT gives a drag control
  // with no output binding.
  function resolveVisualState(obj, gameState, lastKnownToggle) {
    if (!obj.statesEnabled || !obj.visualStates || !obj.visualStates.length) return null;
    const raw = gameState ? resolvePath(gameState, obj.stateBinding) : undefined;
    let name;
    if (raw != null && obj.visualStates.some((s) => s.name === String(raw))) {
      name = String(raw);
    } else if (lastKnownToggle && lastKnownToggle[obj.id] != null) {
      name = String(lastKnownToggle[obj.id]);
    } else {
      name = obj.defaultVisualState;
    }
    return obj.visualStates.find((s) => s.name === name) || obj.visualStates[0];
  }

  // --- Current visual position (shared by drawing AND hit-testing) --------
  //
  // Wherever a control is CURRENTLY drawn, accounting for a live or
  // persisted drag - drag_linear/drag_rotate's dragOverride/lastKnownT (see
  // drawObject's own comment), or drag_h_pattern's active node (from
  // lastKnownNode, or its authored resting node if never dragged this
  // session) / live rail position mid-drag (hPatternDragOverride). Hit-
  // testing has to look here too, not at the object's own default pose, or
  // clicking the visibly-moved sprite/handle misses while some other empty
  // spot on the canvas still grabs it - this was exactly the "hitbox isn't
  // moving with it" bug already found and fixed once in the Sub Editor's own
  // canvas; this is the same fix for the actual game client.
  function currentVisualOffset(obj, gameState, dragOverride, lastKnownT, hPatternDragOverride, lastKnownNode) {
    if (obj.interaction === 'drag_h_pattern') {
      if (!obj.hPatternNodes || !obj.hPatternNodes.length) return { offsetX: 0, offsetY: 0, rotation: obj.rotation || 0 };
      if (hPatternDragOverride && hPatternDragOverride.objId === obj.id) {
        return { offsetX: hPatternDragOverride.x, offsetY: hPatternDragOverride.y, rotation: obj.rotation || 0 };
      }
      const nodeId = (lastKnownNode && lastKnownNode[obj.id]) || obj.hPatternActiveNode;
      const node = obj.hPatternNodes.find((n) => n.id === nodeId) || obj.hPatternNodes[0];
      return { offsetX: node.x, offsetY: node.y, rotation: obj.rotation || 0 };
    }

    const isDragging = dragOverride && dragOverride.objId === obj.id;
    const inputOverride = isDragging ? computeInputVisual(obj, dragOverride.t) : null;
    const outputOverride = !inputOverride ? computeOutputVisual(obj, gameState) : null;
    const rememberedT = lastKnownT && lastKnownT[obj.id];
    const rememberedOverride = (!inputOverride && !outputOverride && rememberedT != null)
      ? computeInputVisual(obj, rememberedT)
      : null;
    const override = inputOverride || outputOverride || rememberedOverride;
    return {
      offsetX: (override && override.offsetX) || 0,
      offsetY: (override && override.offsetY) || 0,
      rotation: (override && override.rotation != null ? override.rotation : obj.rotation) || 0,
      assetId: override && override.assetId,
    };
  }

  // --- Hit-testing (pointer -> interactive object) -------------------------

  // A scope object has no interaction of its own (it's a display, not a
  // control), so it never shows up in hitTestInteractive - this is the
  // separate hit-test client.js uses to find which scope a wheel/pinch/pan
  // gesture landed on, checking the object's own previewShape (circle vs
  // rectangle) rather than an authored touch hitbox.
  function hitTestScope(entry, stationId, worldX, worldY) {
    const objects = objectsFor(entry, stationId);
    for (let i = objects.length - 1; i >= 0; i -= 1) {
      const obj = objects[i];
      if (obj.type !== 'scope') continue;
      const w = obj.width * (obj.scaleX ?? 1);
      const h = obj.height * (obj.scaleY ?? 1);
      if (obj.previewShape === 'rectangle') {
        if (worldX >= obj.x - w / 2 && worldX <= obj.x + w / 2 && worldY >= obj.y - h / 2 && worldY <= obj.y + h / 2) return obj;
      } else {
        const nx = (worldX - obj.x) / (w / 2);
        const ny = (worldY - obj.y) / (h / 2);
        if (nx * nx + ny * ny <= 1) return obj;
      }
    }
    return null;
  }

  // Uses the object's touch hitbox when it has one - the real tap target,
  // matching how a player would actually reach it - falling back to a
  // simple (rotation-naive) bounding box on its visual size otherwise. A
  // drag_rotate control's hitbox rotates around the sprite's own pivot
  // point right along with it - unlike drag_linear/drag_h_pattern (which
  // only ever translate), a rotating lever's grabbable area has to sweep
  // with it or the far end of a long handle becomes ungrabbable as soon as
  // it swings away from its resting angle.
  // gameState/dragOverride/lastKnownT/hPatternDragOverride/lastKnownNode are
  // all optional - omit them to hit-test objects at their default pose.
  function hitTestInteractive(entry, stationId, worldX, worldY, gameState, dragOverride, lastKnownT, hPatternDragOverride, lastKnownNode) {
    const objects = objectsFor(entry, stationId);
    for (let i = objects.length - 1; i >= 0; i -= 1) {
      const obj = objects[i];
      if (!obj.interaction || obj.interaction === 'none') continue;
      const visual = currentVisualOffset(obj, gameState, dragOverride, lastKnownT, hPatternDragOverride, lastKnownNode);
      const baseX = obj.x + visual.offsetX;
      const baseY = obj.y + visual.offsetY;
      if (obj.hitboxWidth) {
        const hw = obj.hitboxWidth / 2;
        const hh = (obj.hitboxHeight ?? obj.hitboxWidth) / 2;
        if (obj.interaction === 'drag_rotate') {
          const rad = (-visual.rotation * Math.PI) / 180;
          const dx = worldX - baseX;
          const dy = worldY - baseY;
          const localX = dx * Math.cos(rad) - dy * Math.sin(rad);
          const localY = dx * Math.sin(rad) + dy * Math.cos(rad);
          const hbx = obj.hitboxOffsetX ?? 0;
          const hby = obj.hitboxOffsetY ?? 0;
          if (localX >= hbx - hw && localX <= hbx + hw && localY >= hby - hh && localY <= hby + hh) return obj;
        } else {
          const cx = baseX + (obj.hitboxOffsetX ?? 0);
          const cy = baseY + (obj.hitboxOffsetY ?? 0);
          if (worldX >= cx - hw && worldX <= cx + hw && worldY >= cy - hh && worldY <= cy + hh) return obj;
        }
      } else {
        const hw = ((obj.width || 0) / 2) * (obj.scaleX ?? 1);
        const hh = ((obj.height || 0) / 2) * (obj.scaleY ?? 1);
        if (worldX >= baseX - hw && worldX <= baseX + hw && worldY >= baseY - hh && worldY <= baseY + hh) return obj;
      }
    }
    return null;
  }

  // Draws one shape (a plain object, or one child of a group) already
  // positioned at the canvas origin by the caller's transform.
  function drawShape(ctx, entry, shape, assetIdOverride, colorOverride) {
    const w = shape.width || 0;
    const h = shape.height || 0;
    const left = -(shape.pivotX ?? 0.5) * w;
    const top = -(shape.pivotY ?? 0.5) * h;
    const frame = frameFor(entry, assetIdOverride || shape.assetId);
    if (frame && entry.image) {
      ctx.drawImage(entry.image, frame.x, frame.y, frame.width, frame.height, left, top, w, h);
    } else if (shape.previewShape === 'circle') {
      // Mirrors the Sub Editor's own drawShapeBody() circle fallback, so a
      // texture-less round object (e.g. an indicator light showing a plain
      // color per state) reads the same in-game as it does in the editor,
      // instead of silently falling back to a rectangle here.
      ctx.fillStyle = colorOverride || shape.color || '#4caf50';
      ctx.beginPath();
      ctx.ellipse(left + w / 2, top + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = colorOverride || shape.color || '#4caf50';
      ctx.fillRect(left, top, w, h);
    }
  }

  // Types that exist purely for editor authoring / server logic and render
  // nothing in the actual game: player spawns are invisible position
  // markers, leak/fire zones are spawn-probability regions the server
  // samples from, never drawn to players.
  const INVISIBLE_TYPES = new Set(['player_spawn', 'leak_zone', 'fire_zone']);

  // --- Scope objects (sonar / nav map / future-view placeholders) ---------
  //
  // A "scope" object (type: 'scope') is a blank shape in the Sub Editor -
  // like a green screen - that a live, fully server-driven display gets
  // projected onto in-game, filling that same shape/bounds. Its
  // displayChannel picks which one; previewShape (shared with the ordinary
  // placeholder-object preview fallback) also clips the live content to a
  // circle or rectangle. None of this reads a per-object outputBinding dot-
  // path the way rotate/linear/texture outputs do - each channel is
  // hardcoded to its own slice of game state (sonar_dial/sonar, map, or
  // nothing at all for the two not built yet). Drawn centered on the
  // object's own position, sized off its own width/height/scale, entirely
  // independent of the object's own rotation (a compass bearing is always
  // screen-absolute).

  function scopeClip(ctx, obj) {
    const w = obj.width * (obj.scaleX ?? 1);
    const h = obj.height * (obj.scaleY ?? 1);
    ctx.beginPath();
    if (obj.previewShape === 'rectangle') {
      ctx.rect(obj.x - w / 2, obj.y - h / 2, w, h);
    } else {
      ctx.ellipse(obj.x, obj.y, w / 2, h / 2, 0, 0, Math.PI * 2);
    }
    ctx.clip();
  }

  // The simulation's own angle convention is 0deg = world +X, increasing
  // clockwise (position += Vector2(cos(heading_rad), sin(heading_rad)),
  // true_bearing := to_enemy.angle()) - but both displays read north-up, so
  // world 0deg has to land on screen "up", not screen "right": a -90deg
  // rotation from the raw simulation angle to the screen angle, same
  // rotation drawNavMap's ship marker applies to its own heading.
  function headingToScreenDir(deg) {
    const rad = (deg * Math.PI) / 180;
    return { x: Math.sin(rad), y: -Math.cos(rad) };
  }

  // A rotating compass card, like the sonar scope's own sweep line and
  // contact blip: tick positions are fixed at clean ABSOLUTE bearings (every
  // 10 degrees, labeled every 30, N/E/S/W at the cardinals) and each one's
  // SCREEN position is derived from heading via the same headingToScreenDir
  // conversion the sweep/blip already use - so the ring visually rotates as
  // the sub turns while the numbers/letters on it always stay clean, round,
  // true-compass values, the same way a real gyrocompass repeater card
  // works (the lubber line at top stays fixed; the card underneath turns).
  function drawSonarCompassRing(ctx, cx, cy, radius, heading) {
    const cardinals = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
    ctx.save();
    ctx.font = `${Math.max(9, radius * 0.09)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let absDeg = 0; absDeg < 360; absDeg += 10) {
      const dir = headingToScreenDir(absDeg - heading);
      const isCardinal = absDeg % 90 === 0;
      const isMajor = absDeg % 30 === 0;
      const tickOuter = radius * 0.98;
      const tickInner = radius * (isMajor ? 0.86 : 0.92);
      ctx.strokeStyle = isCardinal ? '#8cffb0' : '#2c4a5c';
      ctx.lineWidth = isMajor ? 1.5 : 1;
      ctx.beginPath();
      ctx.moveTo(cx + dir.x * tickInner, cy + dir.y * tickInner);
      ctx.lineTo(cx + dir.x * tickOuter, cy + dir.y * tickOuter);
      ctx.stroke();
      if (isMajor) {
        const labelRadius = radius * 0.76;
        ctx.fillStyle = isCardinal ? '#8cffb0' : '#4caf50';
        ctx.fillText(cardinals[absDeg] ?? String(absDeg), cx + dir.x * labelRadius, cy + dir.y * labelRadius);
      }
    }
    ctx.restore();
  }

  function drawSonarScope(ctx, obj, gameState) {
    if (!gameState) return;
    const radius = (Math.max(obj.width * (obj.scaleX ?? 1), obj.height * (obj.scaleY ?? 1)) / 2)
      * (obj.scopeFillFraction ?? 0.95);
    const cx = obj.x;
    const cy = obj.y;
    const dialDeg = resolvePath(gameState, 'sonar_dial') ?? 0;
    // Relative-bearing display: "up" is always dead ahead of the sub's
    // CURRENT heading, not compass north, so a contact sitting left/right of
    // up directly tells you which way to turn to face it - the same reason
    // the server already computes sonar.bearing_relative alongside
    // bearing_true. sonar_dial itself is still an absolute/compass value
    // (compared against true_bearing server-side), so its own screen
    // position has to subtract heading the same way to land in the same
    // relative frame as the blip below.
    const heading = resolvePath(gameState, 'heading') ?? 0;

    ctx.save();

    // Same dark backdrop + distance reference rings as the debug panel's
    // own nav map (#06121a fill, #1c3040 lines) - a scope clips to its own
    // shape but draws nothing behind itself by default, so without this
    // it just shows whatever's behind it on the room canvas instead of
    // reading as its own instrument.
    ctx.fillStyle = '#06121a';
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();
    const rangeRingCount = 3;
    ctx.strokeStyle = '#1c3040';
    ctx.lineWidth = 1;
    for (let i = 1; i <= rangeRingCount; i += 1) {
      ctx.beginPath();
      ctx.arc(cx, cy, (radius * i) / rangeRingCount, 0, Math.PI * 2);
      ctx.stroke();
    }

    drawSonarCompassRing(ctx, cx, cy, radius, heading);

    const sweep = headingToScreenDir(dialDeg - heading);
    ctx.strokeStyle = 'rgba(255, 130, 0, 0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + sweep.x * radius, cy + sweep.y * radius);
    ctx.stroke();

    const sonar = gameState.sonar;
    if (sonar && sonar.contact) {
      // A few concentric rings staggered in phase, continuously expanding
      // from center and fading out - reads as a steady pulse (the design
      // doc's "propeller pulses") rather than one lone ring popping in and
      // out. Phase comes from wall-clock time, not server ticks, so it
      // stays smooth regardless of broadcast rate. Rate itself comes from
      // sonar.pulse_hz (the contact's actual speed) - a faster contact
      // pulses quicker, by feel, the same cue a dB gauge/future audio
      // render of this same value would give. Scaled down the same way a
      // wobble gauge's Wobble Speed Scale would (sonarPulseSpeedScale,
      // same 0.25 default) - the raw 0.5-3 Hz range reads better slowed
      // down for a human eye, and this keeps the scope's own pulse feel
      // consistent with a gauge wired to the same value.
      const periodMs = 1000 / ((sonar.pulse_hz || 1) * (obj.sonarPulseSpeedScale ?? 0.25));
      const ringCount = 3;
      const now = Date.now();
      // Amplitude cue: a louder (closer) contact's rings show more
      // strongly, on top of the blip already sitting nearer center.
      const amplitude = Math.max(0.25, Math.min(1, (sonar.db ?? 60) / 100));
      for (let i = 0; i < ringCount; i += 1) {
        const phase = ((now / periodMs + i / ringCount) % 1);
        ctx.beginPath();
        ctx.arc(cx, cy, phase * radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0, 255, 140, ${(1 - phase) * 0.8 * amplitude})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Plotted closer to center the nearer the contact actually is,
      // relative to sonarRange (match this to the server's sonar_max_range)
      // - clamped to the rim rather than assumed to sit there regardless
      // of real distance.
      const sonarRange = obj.sonarRange ?? 200;
      const blipRadius = radius * (sonar.distance != null ? Math.min(1, sonar.distance / sonarRange) : 1);
      const bearingDir = headingToScreenDir(sonar.bearing_relative ?? (dialDeg - heading));
      ctx.beginPath();
      ctx.arc(cx + bearingDir.x * blipRadius, cy + bearingDir.y * blipRadius, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#00ff8c';
      ctx.fill();
    }

    ctx.restore();
  }

  // A ship-relative (not compass) plot, "up" = dead ahead - a half-disc, not
  // a full circle, since the gyro is capped at +/-90 degrees off the bow and
  // nothing ever plots into the bottom half. The sub sits at the shape's own
  // center (obj.x/obj.y), same as drawSonarScope's own cx/cy, with only the
  // upper semicircle actually drawn. Mirrors the debug panel's own
  // #tdc-scope canvas (client.js) exactly, but reads its physics constants
  // (Range/Speed/Turn Rate/Gyro Activation Distance) from the object's own
  // authored fields instead of the server's one-time "welcome" broadcast,
  // since a room object has no equivalent channel for that - keep these in
  // sync with the server's own torpedo_speed/torpedo_turn_rate/
  // torpedo_gyro_activation_distance/torpedo_max_lifetime_ticks exports.
  // A torpedo is aimed by its GYRO, not a target heading it turns to and
  // stops at - once the gyro engages (past activationDistance), it holds a
  // fixed continuous turn (like a rudder held at a set angle) for the rest
  // of the flight, proportional to how far offsetDegrees sits within
  // +/-gyroLimit. It never straightens out on its own - mirrors the
  // server's own _step_torpedoes() exactly.
  function drawTdcTrack(ctx, originX, originY, scale, maxRange, offsetDegrees, turnRate, speed, activationDistance, gyroLimit, armed) {
    const turnFraction = Math.max(-1, Math.min(1, offsetDegrees / gyroLimit));

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
        headingDeg += turnFraction * turnRate * stepTime;
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

  function drawTdcScope(ctx, obj, gameState) {
    if (!gameState) return;
    // Full circle (the object's own circular footprint, filled entirely -
    // see scopeFillFraction) - but the sub sits near the BOTTOM of it rather
    // than dead center, so the plotted range can use almost the full
    // diameter instead of just one radius. Same layout as the debug panel's
    // own #tdc-scope canvas: circle center at (circleX, circleY), sub
    // inset from the bottom rim, range rings centered on the SUB (not the
    // circle's own center) and clipped to the circle so they don't spill
    // past it now that the two centers don't coincide.
    const circleX = obj.x;
    const circleY = obj.y;
    const outerRadius = (Math.max(obj.width * (obj.scaleX ?? 1), obj.height * (obj.scaleY ?? 1)) / 2)
      * (obj.scopeFillFraction ?? 0.95);
    const inset = outerRadius * 0.06; // keeps the ship icon itself off the rim
    const originX = circleX;
    const originY = circleY + outerRadius - inset;

    const maxRange = obj.tdcRange ?? 1000;
    const speed = obj.tdcSpeed ?? 20;
    const turnRate = obj.tdcTurnRate ?? 45;
    const activationDistance = obj.tdcActivationDistance ?? 50;
    const gyroLimit = obj.tdcGyroLimit ?? 90;
    const plotRadius = originY - (circleY - outerRadius); // sub-to-far-rim distance = the full plotted range
    const scale = plotRadius / maxRange;

    ctx.save();

    ctx.fillStyle = '#06121a';
    ctx.beginPath();
    ctx.arc(circleX, circleY, outerRadius, 0, Math.PI * 2);
    ctx.fill();

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

    const tdc = gameState.tdc;
    const tubes = gameState.torpedo_tubes;
    if (tdc && tubes && tubes.length) {
      const tubeCount = tubes.length;
      tubes.forEach((tube, i) => {
        const offset = tdc.gyro_angle + tdc.spread_angle * (i - (tubeCount - 1) / 2);
        drawTdcTrack(ctx, originX, originY, scale, maxRange, offset, turnRate, speed, activationDistance, gyroLimit, tube.armed);
      });
    }

    // Actually fired torpedoes, live - same ship-relative bearing/distance
    // shape the top-level "torpedoes" broadcast already uses (no world
    // position/heading needed here, since this scope is bow-relative, not
    // compass-relative, same as drawSonarScope's own contact blip).
    const liveTorpedoes = gameState.torpedoes;
    if (liveTorpedoes && liveTorpedoes.length) {
      const dotRadius = Math.max(2, outerRadius * 0.02);
      liveTorpedoes.forEach((t) => {
        if (t.distance == null || t.distance > maxRange) return;
        const dir = headingToScreenDir(t.bearing_relative);
        const px = originX + dir.x * t.distance * scale;
        const py = originY + dir.y * t.distance * scale;
        ctx.fillStyle = '#ffca28';
        ctx.beginPath();
        ctx.arc(px, py, dotRadius, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    ctx.restore();

    const shipLen = outerRadius * 0.06;
    ctx.fillStyle = '#4caf50';
    ctx.beginPath();
    ctx.moveTo(originX, originY - shipLen);
    ctx.lineTo(originX - shipLen * 0.75, originY + shipLen * 0.75);
    ctx.lineTo(originX + shipLen * 0.75, originY + shipLen * 0.75);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  // zoom (>1 = zoomed in, shrinks the effective range) and pan ({x,y} world
  // units added to the fixed frame's default world-origin center) are both
  // player-driven, per-object, client-only view state - see client.js's
  // scope wheel/pinch/drag handling. Neither is ever sent to the server;
  // they only change what this client's own map is currently looking at.
  // The same north-up rotation headingToScreenDir applies to a direction
  // also has to apply to actual world positions plotted on the nav map
  // (ship, enemy) - otherwise a ship correctly rotated to face north-up
  // would nonetheless drift sideways on screen as it moves "north" in the
  // world, since its dot's own screen position would still be using the
  // simulation's raw (unrotated) world axes. Derived the same way: world
  // +X (sim angle 0) has to land on screen "up" (-Y), so world +Y (sim
  // angle 90) lands on screen "right" (+X) - i.e. screenX=worldY,
  // screenY=-worldX.
  function worldToScreenOffset(worldX, worldY, originX, originY, scale) {
    return { x: (worldY - originY) * scale, y: -(worldX - originX) * scale };
  }

  function drawNavMap(ctx, obj, gameState, zoom, pan) {
    if (!gameState || !gameState.map) return;
    const fillFraction = obj.scopeFillFraction ?? 0.95;
    const halfW = (obj.width * (obj.scaleX ?? 1) / 2) * fillFraction;
    const halfH = (obj.height * (obj.scaleY ?? 1) / 2) * fillFraction;
    const cx = obj.x;
    const cy = obj.y;
    const range = (obj.navMapRange ?? 300) / (zoom || 1);
    const originX = pan ? pan.x : 0;
    const originY = pan ? pan.y : 0;
    const map = gameState.map;
    const heading = map.heading || 0;

    ctx.save();

    // A fixed chart, not a "you are here"-centered one: the frame is
    // anchored to a world point (world origin by default, or wherever the
    // player has panned to) and doesn't move on its own, so the grid is
    // static and the ship blip is what moves around on it instead of the
    // whole map scrolling under a stationary ship. Same dark backdrop as
    // the debug panel's own nav map (#06121a fill, #1c3040 lines,
    // 25-world-unit spacing).
    ctx.fillStyle = '#06121a';
    ctx.fillRect(cx - halfW, cy - halfH, halfW * 2, halfH * 2);
    // One scale derived from width, used for both axes - a non-square
    // scope box would otherwise need a different pixels-per-world-unit
    // factor per axis to make "range" fit exactly both ways, stretching
    // the grid/ship/contacts non-uniformly. Fitting to width instead just
    // shows more or less vertical range depending on the box's own aspect
    // ratio, never a distorted one.
    const gridSpacingWorld = 25;
    const scale = halfW / range;
    const gridPx = gridSpacingWorld * scale;
    ctx.strokeStyle = '#1c3040';
    ctx.lineWidth = 1;
    if (gridPx > 1) {
      // The grid pattern itself is unaffected by the north-up rotation (a
      // square grid is rotationally symmetric), but which pan axis shifts
      // which set of lines swaps along with it: a screen-vertical line is
      // a constant-world-Y line under worldToScreenOffset, so it shifts
      // with originY, not originX.
      const offsetX = (((originY * scale) % gridPx) + gridPx) % gridPx;
      for (let x = cx - halfW - offsetX; x <= cx + halfW; x += gridPx) {
        ctx.beginPath();
        ctx.moveTo(x, cy - halfH);
        ctx.lineTo(x, cy + halfH);
        ctx.stroke();
      }
      const offsetY = (((originX * scale) % gridPx) + gridPx) % gridPx;
      for (let y = cy - halfH - offsetY; y <= cy + halfH; y += gridPx) {
        ctx.beginPath();
        ctx.moveTo(cx - halfW, y);
        ctx.lineTo(cx + halfW, y);
        ctx.stroke();
      }
    }

    // Home port - a dashed ring at its docking radius, clipped to the scope
    // box and drawn under the ships so it reads as charted coastline, not a
    // contact. Always shown (no debug gate): the crew knows where home is.
    (map.ports || []).forEach((port) => {
      const portOffset = worldToScreenOffset(port.x, port.y, originX, originY, scale);
      ctx.save();
      ctx.beginPath();
      ctx.rect(cx - halfW, cy - halfH, halfW * 2, halfH * 2);
      ctx.clip();
      ctx.strokeStyle = '#4fc3f7';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.arc(cx + portOffset.x, cy + portOffset.y, Math.max(3, port.radius * scale), 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    });

    // Own ship - plotted at its actual position in the fixed frame (and
    // skipped once it's moved outside the depicted range, same as any
    // other contact), oriented to heading. The triangle is authored
    // pointing "up" (0,-shipLen), which already matches world heading 0
    // under this display's north-up convention (see headingToScreenDir) -
    // so ctx.rotate(heading) alone lines it up correctly, no extra offset.
    const shipLen = Math.min(halfW, halfH) * 0.018;
    const shipOffset = worldToScreenOffset(map.position.x, map.position.y, originX, originY, scale);
    const shipX = cx + shipOffset.x;
    const shipY = cy + shipOffset.y;
    if (Math.abs(shipX - cx) <= halfW && Math.abs(shipY - cy) <= halfH) {
      ctx.save();
      ctx.translate(shipX, shipY);
      ctx.rotate((heading * Math.PI) / 180);
      ctx.beginPath();
      ctx.moveTo(0, -shipLen);
      ctx.lineTo(shipLen * 0.55, shipLen * 0.7);
      ctx.lineTo(-shipLen * 0.55, shipLen * 0.7);
      ctx.closePath();
      ctx.fillStyle = '#00ff8c';
      ctx.fill();
      ctx.restore();
    }

    // Every convoy ship, revealed only while debug_show_enemy is on - there's
    // no real sonar-fed contact plotting on the nav map yet, so this stays a
    // testing cheat rather than real gameplay. Skipped once outside the
    // depicted range. Destroyers and cargo ships get distinct colors so a
    // whole convoy reads at a glance.
    (map.ships || []).forEach((ship) => {
      const shipOffset = worldToScreenOffset(ship.x, ship.y, originX, originY, scale);
      const sx = cx + shipOffset.x;
      const sy = cy + shipOffset.y;
      if (Math.abs(sx - cx) <= halfW && Math.abs(sy - cy) <= halfH) {
        ctx.beginPath();
        ctx.arc(sx, sy, 4, 0, Math.PI * 2);
        ctx.fillStyle = ship.type === 'destroyer' ? '#ff3b30' : '#ffb300';
        ctx.fill();
      }
    });

    // The sub's own fired torpedoes - always shown (no debug_show_enemy
    // gate, unlike the contact above), a short heading tick with a dot at
    // its leading edge so it doesn't get mistaken for the ship/enemy blips.
    (map.torpedoes || []).forEach((t) => {
      const offset = worldToScreenOffset(t.x, t.y, originX, originY, scale);
      const tx = cx + offset.x;
      const ty = cy + offset.y;
      if (Math.abs(tx - cx) > halfW || Math.abs(ty - cy) > halfH) return;
      const dir = headingToScreenDir(t.heading);
      const tickLen = shipLen * 0.8;
      ctx.save();
      ctx.strokeStyle = '#ffca28';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(tx - dir.x * tickLen, ty - dir.y * tickLen);
      ctx.lineTo(tx + dir.x * tickLen * 0.5, ty + dir.y * tickLen * 0.5);
      ctx.stroke();
      ctx.fillStyle = '#ffca28';
      ctx.beginPath();
      ctx.arc(tx + dir.x * tickLen * 0.5, ty + dir.y * tickLen * 0.5, 1.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });

    ctx.restore();
  }

  // A flat horizon-strip stand-in for the eventual 3D periscope view -
  // deliberately built so the server protocol it reads (periscope.available/
  // bearing, plus a contacts[] array of plain physical facts - type/
  // bearing_true/bearing_relative/distance, no precomputed screen position or
  // "in FOV" flag) is exactly what a future 3D camera-based renderer would
  // also need: a camera pointed at periscope.bearing, and one contact model
  // per entry placed by bearing_true/distance. Only this function would need
  // replacing later, never the protocol above it.
  // zoom (>1 = magnified/narrower view, <1 = wide view) is the SAME per-object
  // client-only camera state the nav map's own pinch/wheel gesture already
  // populates (see client.js's onScopeWheel/onScopePointerDown, which hit-
  // test ANY scope object, not just nav_map) - a periscope just has to read
  // it too, no new gesture-handling code needed. Narrowing the field of view
  // is real angular magnification, so contact silhouettes are scaled up by
  // the same factor, not just spread across a narrower slice of screen.
  // shipId -> wall-clock ms the explosion flash started - client-local only
  // (never sent to/read from the server), keyed by the contact id the
  // server's periscope.contacts now carries. Persists across draws so the
  // flash fades out over PERISCOPE_EXPLOSION_MS regardless of frame rate,
  // the same wall-clock-timed pattern the sonar scope's own pulse rings use.
  const periscopeExplosions = {};
  const PERISCOPE_EXPLOSION_MS = 1200;

  function drawPeriscopeScope(ctx, obj, gameState, zoom) {
    const w = obj.width * (obj.scaleX ?? 1);
    const h = obj.height * (obj.scaleY ?? 1);
    const left = obj.x - w / 2;
    const top = obj.y - h / 2;
    const midY = obj.y;
    const periscope = gameState && gameState.periscope;
    const effectiveZoom = zoom || 1;

    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, w, h);
    ctx.clip();

    if (!periscope || !periscope.available) {
      // Too deep for the scope to reach the surface - nothing to see.
      ctx.fillStyle = '#04070a';
      ctx.fillRect(left, top, w, h);
      ctx.fillStyle = '#274050';
      ctx.font = `${Math.max(10, h * 0.08)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('TOO DEEP TO RAISE SCOPE', obj.x, obj.y);
      ctx.restore();
      return;
    }

    const sky = ctx.createLinearGradient(0, top, 0, midY);
    sky.addColorStop(0, '#0d2338');
    sky.addColorStop(1, '#1c3b52');
    ctx.fillStyle = sky;
    ctx.fillRect(left, top, w, midY - top);

    const sea = ctx.createLinearGradient(0, midY, 0, top + h);
    sea.addColorStop(0, '#0a2430');
    sea.addColorStop(1, '#041016');
    ctx.fillStyle = sea;
    ctx.fillRect(left, midY, w, top + h - midY);

    ctx.strokeStyle = '#3a5a68';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left, midY);
    ctx.lineTo(left + w, midY);
    ctx.stroke();

    const fov = (obj.periscopeFov ?? 20) / effectiveZoom;
    const contacts = periscope.contacts || [];
    // Farthest first, so a closer ship's silhouette draws on top of (rather
    // than behind) anything farther away it happens to overlap on screen.
    const sortedContacts = contacts.slice().sort((a, b) => (b.distance ?? 0) - (a.distance ?? 0));
    sortedContacts.forEach((contact) => {
      // Wrapped to (-180, 180] around the scope's current look direction, so
      // a contact just outside the FOV on either side reads as "off to one
      // side" rather than wrapping around the long way.
      const offset = (((contact.bearing_true - periscope.bearing + 540) % 360) + 360) % 360 - 180;
      if (Math.abs(offset) > fov / 2) return;
      const screenX = obj.x + (offset / (fov / 2)) * (w / 2);
      const referenceDistance = obj.periscopeReferenceDistance ?? 500;
      const distance = Math.max(1, contact.distance ?? referenceDistance);
      const baseHeight = h * 0.12;
      const silhouetteHeight = Math.max(
        h * 0.02,
        Math.min(h * 0.6, baseHeight * (referenceDistance / distance) * effectiveZoom),
      );
      const silhouetteWidth = silhouetteHeight * (contact.type === 'destroyer' ? 2.6 : 3.2);

      // A ship starts sinking (server-driven, see simulation.gd's
      // _step_sinking_ships()) the instant it's hit and stays in contacts,
      // dead in the water, for ship_sink_duration seconds - sink_progress
      // (0..1, synced to every viewer) drives a slow tilt-and-settle rather
      // than an instant vanish. The explosion itself is purely a client-
      // local one-shot: the FIRST time this contact's id shows up sinking,
      // start a short fading flash timed off wall-clock, same pattern as
      // the sonar scope's own pulse rings.
      if (contact.sinking && periscopeExplosions[contact.id] == null) {
        periscopeExplosions[contact.id] = Date.now();
      }
      const sinkProgress = contact.sinking ? (contact.sink_progress ?? 0) : 0;
      // Tilts over the first 60% of the animation, then just keeps settling
      // lower at that same angle for the remainder - a capsizing ship
      // doesn't keep rolling all the way to the end, it stabilizes on its
      // side before finally going under.
      const tiltAngle = Math.min(1, sinkProgress / 0.6) * (Math.PI / 6);
      const sinkOffset = sinkProgress * silhouetteHeight * 1.4;
      const opacity = contact.sinking ? Math.max(0, 1 - sinkProgress) : 1;
      const pivotY = midY + sinkOffset;

      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.translate(screenX, pivotY);
      ctx.rotate(tiltAngle);
      ctx.fillStyle = contact.type === 'destroyer' ? '#241416' : '#141c1a';
      ctx.fillRect(-silhouetteWidth / 2, -silhouetteHeight, silhouetteWidth, silhouetteHeight);
      ctx.fillRect(-silhouetteWidth * 0.12, -silhouetteHeight * 1.6, silhouetteWidth * 0.24, silhouetteHeight * 0.6);
      ctx.restore();

      const explosionStart = periscopeExplosions[contact.id];
      if (explosionStart != null) {
        const elapsed = Date.now() - explosionStart;
        if (elapsed > PERISCOPE_EXPLOSION_MS) {
          delete periscopeExplosions[contact.id];
        } else {
          const t = elapsed / PERISCOPE_EXPLOSION_MS;
          const flashY = midY - silhouetteHeight * 0.5;
          const flashRadius = silhouetteHeight * (0.6 + t * 2.5);
          const flash = ctx.createRadialGradient(screenX, flashY, 0, screenX, flashY, Math.max(1, flashRadius));
          flash.addColorStop(0, '#fff6d0');
          flash.addColorStop(0.3, '#ffb020');
          flash.addColorStop(1, 'rgba(255, 60, 0, 0)');
          ctx.save();
          ctx.globalAlpha = Math.max(0, 1 - t);
          ctx.fillStyle = flash;
          ctx.beginPath();
          ctx.arc(screenX, flashY, flashRadius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }
    });

    ctx.strokeStyle = '#4caf50';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(obj.x - w * 0.04, midY);
    ctx.lineTo(obj.x + w * 0.04, midY);
    ctx.moveTo(obj.x, midY - h * 0.04);
    ctx.lineTo(obj.x, midY + h * 0.04);
    ctx.stroke();

    // The scope is a circular port, not a rectangle - obj.width/height is
    // its bounding box, but anything placed near a rectangular edge/corner
    // (like the old top-left BRG readout used to be) falls outside the
    // actual visible ellipse and never renders at all. Both readouts below
    // sit on the vertical centerline instead, where the ellipse is at its
    // full width, and stay inside its top/bottom edge (0.7 of the radius,
    // not 1.0) rather than hugging the rim.
    const r = Math.min(w, h) / 2;
    ctx.fillStyle = '#4caf50';
    ctx.font = `${Math.max(11, h * 0.08)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    // Absolute (compass) bearing, top center - degrees plus the nearest of
    // the 8 compass points (e.g. "302NW"), not a scrolling tick strip: this
    // is what the scope is pointed at in real compass terms.
    const absBearing = Math.round(((periscope.bearing % 360) + 360) % 360);
    ctx.fillText(`${String(absBearing).padStart(3, '0')}${compassPoint8(absBearing)}`, obj.x, midY - r * 0.7);

    // Relative bearing, bottom center - degrees off the sub's OWN bow plus
    // which quadrant of it (SB starboard bow, SA starboard aft, PA port aft,
    // PB port bow), the traditional nautical relative-bearing convention -
    // lets a player read "how far round from the bow am I looking" without
    // doing the heading subtraction themselves.
    const heading = resolvePath(gameState, 'heading') ?? 0;
    const relBearing = Math.round((((periscope.bearing - heading) % 360) + 360) % 360);
    ctx.fillText(`${String(relBearing).padStart(3, '0')}${relativeBearingQuadrant(relBearing)}`, obj.x, midY + r * 0.7);

    ctx.restore();
  }

  const COMPASS_POINTS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  function compassPoint8(absoluteDeg) {
    const norm = ((absoluteDeg % 360) + 360) % 360;
    return COMPASS_POINTS_8[Math.round(norm / 45) % 8];
  }

  // Traditional relative-bearing quadrants (each a full 90 degrees, not a
  // "nearest point" like the compass rose above) - bow quadrants run from
  // dead ahead to the beam on each side, aft quadrants from the beam to
  // dead astern.
  const RELATIVE_BEARING_QUADRANTS = ['SB', 'SA', 'PA', 'PB'];
  function relativeBearingQuadrant(relativeDeg) {
    const norm = ((relativeDeg % 360) + 360) % 360;
    return RELATIVE_BEARING_QUADRANTS[Math.min(3, Math.floor(norm / 90))];
  }

  // Reserves the screen space and clearly marks it as not built yet, so a
  // station's layout can be authored now against a real placeholder instead
  // of guessing where the eventual live view will sit.
  function drawFutureViewPlaceholder(ctx, obj) {
    const w = obj.width * (obj.scaleX ?? 1);
    const h = obj.height * (obj.scaleY ?? 1);
    const label = 'WEATHER DECK - NOT YET IMPLEMENTED';

    ctx.save();
    ctx.translate(obj.x, obj.y);
    ctx.fillStyle = 'rgba(10, 20, 15, 0.85)';
    ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.strokeStyle = '#2f5';
    ctx.setLineDash([6, 6]);
    ctx.lineWidth = 2;
    ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = '#2f5';
    ctx.font = '14px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }

  // dragOverride: { objId, t } for the one object (if any) the local player
  // is actively dragging right now - its visual follows the pointer
  // immediately rather than waiting on the server round-trip. Takes
  // priority over the object's own output binding while active, the same
  // way the old hand-built levers never let live state fight an in-progress
  // drag; releasing falls back to the output binding if it has one (that's
  // the authoritative, server-synced value - what another player would see
  // too), and only then to lastKnownT - this client's own memory of where
  // it last put an input-only control with no output binding to read back
  // from. Without that fallback, any lever lacking its own gauge output
  // would visually spring back to its authored resting pose the instant you
  // let go, even though the server (and other players) still have it at the
  // value you set - see room_renderer "controls snap back" bug.
  function drawObject(ctx, entry, obj, gameState, dragOverride, lastKnownT, hPatternDragOverride, lastKnownNode, scopeView, lastKnownToggle) {
    if (INVISIBLE_TYPES.has(obj.type)) return;

    if (obj.type === 'scope') {
      ctx.save();
      scopeClip(ctx, obj);
      if (obj.displayChannel === 'sonar') {
        drawSonarScope(ctx, obj, gameState);
      } else if (obj.displayChannel === 'nav_map') {
        const zoom = scopeView && scopeView.zoom ? scopeView.zoom[obj.id] : null;
        const pan = scopeView && scopeView.pan ? scopeView.pan[obj.id] : null;
        drawNavMap(ctx, obj, gameState, zoom, pan);
      } else if (obj.displayChannel === 'tdc') {
        drawTdcScope(ctx, obj, gameState);
      } else if (obj.displayChannel === 'periscope') {
        const zoom = scopeView && scopeView.zoom ? scopeView.zoom[obj.id] : null;
        drawPeriscopeScope(ctx, obj, gameState, zoom);
      } else if (obj.displayChannel === 'weatherdeck') {
        drawFutureViewPlaceholder(ctx, obj);
      }
      ctx.restore();
      return;
    }

    const state = resolveVisualState(obj, gameState, lastKnownToggle);
    if (state && state.visible === false) return;

    const visual = currentVisualOffset(obj, gameState, dragOverride, lastKnownT, hPatternDragOverride, lastKnownNode);
    const assetId = visual.assetId || (state && state.assetId) || obj.assetId;
    const opacity = state && state.opacity != null ? state.opacity : 1;
    // Lets a state be a plain color (e.g. an indicator light's empty/loaded/
    // armed colors) instead of requiring a texture asset per state - falls
    // back to drawShape's own default fill when neither is set.
    const color = (state && state.color) || obj.color;
    // Lets a state reuse the object's own sprite turned to a different
    // angle (e.g. a lever's up/down position) instead of needing a second
    // texture - added on top of whatever rotation the object/drag already has.
    const rotationOffset = (state && state.rotationOffset) || 0;

    ctx.save();
    ctx.globalAlpha = opacity;
    ctx.translate(obj.x + visual.offsetX, obj.y + visual.offsetY);
    ctx.rotate(((visual.rotation + rotationOffset) * Math.PI) / 180);
    ctx.scale(obj.scaleX ?? 1, obj.scaleY ?? 1);

    if (obj.type === 'group' && obj.children) {
      obj.children.forEach((child) => {
        ctx.save();
        ctx.translate(child.offsetX || 0, child.offsetY || 0);
        ctx.rotate(((child.rotation || 0) * Math.PI) / 180);
        ctx.scale(child.scaleX ?? 1, child.scaleY ?? 1);
        drawShape(ctx, entry, child);
        ctx.restore();
      });
    } else {
      drawShape(ctx, entry, obj, assetId !== obj.assetId ? assetId : null, color !== obj.color ? color : null);
    }

    ctx.restore();
  }

  // --- Leaks & welding (compartment view only) ------------------------------
  //
  // Leak positions are server-authoritative (gameState.leaks, normalized 0..1
  // per compartment - see simulation.gd's ROOM_WIDTH/ROOM_HEIGHT) so every
  // player sees the same crack in the same spot. Weld sparks/decals, by
  // contrast, are purely this client's own local VFX for ITS OWN torch
  // strokes - never sent to or read from the server, never seen by other
  // players (a shared/synced version is a reasonable future step, not this
  // first pass) - client.js calls weldAt() with a room-canvas-pixel position
  // (the same 960x540 space canvasToWorld() already produces) on every
  // pointerdown/pointermove while the welder tool is held down and on.
  let weldSparks = []; // {x, y, vx, vy, spawnMs}
  let weldDecals = []; // {x, y, spawnMs}
  let lastWeldDecalMs = 0;
  const WELD_DECAL_MIN_INTERVAL_MS = 90;
  const WELD_DECAL_FADE_MS = 4000;
  const WELD_SPARK_LIFE_MS = 400;
  const MAX_WELD_DECALS = 400;
  const MAX_WELD_SPARKS = 150;
  // White -> yellow -> orange -> red -> grey, same progression a cooling
  // weld bead actually goes through.
  const WELD_COLOR_STOPS = [
    { t: 0, rgb: [255, 255, 255] },
    { t: 0.12, rgb: [255, 235, 130] },
    { t: 0.35, rgb: [255, 170, 40] },
    { t: 0.65, rgb: [200, 50, 30] },
    { t: 1, rgb: [95, 95, 95] },
  ];

  function weldColorAt(fraction) {
    const f = Math.max(0, Math.min(1, fraction));
    for (let i = 1; i < WELD_COLOR_STOPS.length; i += 1) {
      const a = WELD_COLOR_STOPS[i - 1];
      const b = WELD_COLOR_STOPS[i];
      if (f <= b.t) {
        const localT = (f - a.t) / (b.t - a.t || 1);
        const r = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * localT);
        const g = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * localT);
        const bl = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * localT);
        return `rgb(${r}, ${g}, ${bl})`;
      }
    }
    return 'rgb(95, 95, 95)';
  }

  // Draws `img`'s own alpha shape recolored solid `color` - source-atop only
  // paints where the sprite already has coverage, so this reads as the same
  // silhouette in a different color rather than a plain colored square.
  function drawTintedSprite(ctx, img, x, y, size, color, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x - size / 2, y - size / 2);
    ctx.drawImage(img, 0, 0, size, size);
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, size, size);
    ctx.restore();
  }

  // Called by client.js on every pointerdown/pointermove while the welder
  // tool is on and the torch is down - (x, y) already in room-canvas pixel
  // space (canvasToWorld()'s own output, the same space every leak position
  // below is converted into). roomId tags each spark/decal to the
  // compartment it was made in, so switching rooms shows that room's own
  // marks (a fresh, empty "canvas" the first time you weld somewhere new)
  // rather than every room sharing one global trail. Always spawns a few
  // sparks; decals are throttled by time so a slow drag doesn't paint
  // hundreds of overlapping stamps a second.
  function weldAt(x, y, roomId) {
    for (let i = 0; i < 3; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * 40 + 10;
      weldSparks.push({
        x, y, roomId,
        vx: (Math.cos(angle) * dist) / (WELD_SPARK_LIFE_MS / 1000),
        vy: (Math.sin(angle) * dist) / (WELD_SPARK_LIFE_MS / 1000) - 30,
        spawnMs: Date.now(),
      });
    }
    if (weldSparks.length > MAX_WELD_SPARKS) weldSparks.splice(0, weldSparks.length - MAX_WELD_SPARKS);

    const now = Date.now();
    if (now - lastWeldDecalMs >= WELD_DECAL_MIN_INTERVAL_MS) {
      lastWeldDecalMs = now;
      weldDecals.push({ x, y, roomId, spawnMs: now });
      if (weldDecals.length > MAX_WELD_DECALS) weldDecals.shift();
    }
  }

  // Clears every local weld mark in every room - called on a game reset (see
  // client.js), since a fresh run shouldn't show scorch marks from the
  // scuttled boat before it.
  function clearWelds() {
    weldSparks = [];
    weldDecals = [];
    // A reset restarts the server's own leak id counter from 0 too, so
    // without this, leaks after a reset would reuse ids already marked
    // "known" from the previous run and never get their first-appearance
    // burst.
    knownLeakIds.clear();
  }

  function drawWeldSparks(ctx, roomId) {
    const now = Date.now();
    weldSparks = weldSparks.filter((s) => now - s.spawnMs <= WELD_SPARK_LIFE_MS);
    weldSparks.filter((s) => s.roomId === roomId).forEach((s) => {
      const age = (now - s.spawnMs) / 1000;
      const life = (now - s.spawnMs) / WELD_SPARK_LIFE_MS;
      const x = s.x + s.vx * age;
      const y = s.y + s.vy * age + 60 * age * age; // a light gravity arc
      const color = weldColorAt(life * 0.5); // sparks stay in the white/yellow/orange range, never cool all the way to grey
      if (EFFECT_SPRITES.spark) {
        drawTintedSprite(ctx, EFFECT_SPRITES.spark, x, y, 6, color, 1 - life);
      } else {
        ctx.fillStyle = color;
        ctx.globalAlpha = 1 - life;
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        ctx.globalAlpha = 1;
      }
    });
  }

  const WELD_DECAL_RADIUS = 5;

  // A plain filled circle, not the WeldSpot/WeldSpotHot sprites - at their
  // native size (a handful of pixels) and drawn with imageSmoothingEnabled
  // off (so every other pixel-art sprite in this game stays crisp), nearest-
  // neighbor scaling them up read as a hard-edged square/blob rather than a
  // circle. ctx.arc() is round at any size regardless of source resolution.
  function drawWeldDecals(ctx, roomId) {
    const now = Date.now();
    weldDecals.filter((d) => d.roomId === roomId).forEach((d) => {
      const fraction = Math.min(1, (now - d.spawnMs) / WELD_DECAL_FADE_MS);
      ctx.fillStyle = weldColorAt(fraction);
      ctx.beginPath();
      ctx.arc(d.x, d.y, WELD_DECAL_RADIUS, 0, Math.PI * 2);
      ctx.fill();
      // A brief bright flash right at the moment it's laid down, on top of
      // the tinted circle above - fades out over the first ~8% of the decal's
      // own life.
      if (fraction < 0.08) {
        ctx.fillStyle = `rgba(255, 255, 255, ${1 - fraction / 0.08})`;
        ctx.beginPath();
        ctx.arc(d.x, d.y, WELD_DECAL_RADIUS * 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
    });
  }

  // Water spray, built exactly like the weld sparks above (a real spawned-
  // particle array with velocity/gravity, drawn via the same drawTintedSprite
  // + plain-shape-fallback path) rather than the original stateless "position
  // as a function of wall-clock time" approach - that one had no fallback
  // when a sprite failed to load (it just silently skipped drawing anything),
  // which is exactly why it went invisible while the sparks/decals still
  // showed something even before the sprite 404s were fixed.
  let leakDrops = []; // {x, y, vx, vy, spawnMs, roomId}
  const lastLeakDropSpawnMs = {}; // leak id -> ms, throttles spawn rate per leak
  const LEAK_DROP_SPAWN_INTERVAL_MS = 70;
  const LEAK_DROPS_PER_SPAWN = 3;
  const LEAK_DROP_LIFE_MS = 700;
  const MAX_LEAK_DROPS = 400;
  const LEAK_DROP_COLOR = 'rgb(150, 210, 255)';

  function spawnLeakDrop(leak, x, y) {
    const now = Date.now();
    if (now - (lastLeakDropSpawnMs[leak.id] || 0) < LEAK_DROP_SPAWN_INTERVAL_MS) return;
    lastLeakDropSpawnMs[leak.id] = now;
    for (let i = 0; i < LEAK_DROPS_PER_SPAWN; i += 1) {
      leakDrops.push({
        x, y, roomId: leak.compartment,
        vx: (Math.random() * 2 - 1) * 35,
        vy: Math.random() * 25 + 35,
        spawnMs: now,
      });
    }
    if (leakDrops.length > MAX_LEAK_DROPS) leakDrops.splice(0, leakDrops.length - MAX_LEAK_DROPS);
  }

  function drawLeakDrops(ctx, roomId) {
    const now = Date.now();
    leakDrops = leakDrops.filter((d) => now - d.spawnMs <= LEAK_DROP_LIFE_MS);
    const sprite = EFFECT_SPRITES.waterDrop || EFFECT_SPRITES.waterDrop2;
    leakDrops.filter((d) => d.roomId === roomId).forEach((d) => {
      const age = (now - d.spawnMs) / 1000;
      const life = (now - d.spawnMs) / LEAK_DROP_LIFE_MS;
      const x = d.x + d.vx * age;
      const y = d.y + d.vy * age + 90 * age * age; // gravity
      if (sprite) {
        drawTintedSprite(ctx, sprite, x, y, 5, LEAK_DROP_COLOR, 1 - life);
      } else {
        ctx.fillStyle = LEAK_DROP_COLOR;
        ctx.globalAlpha = 1 - life;
        ctx.fillRect(x - 1.5, y - 1.5, 3, 3);
        ctx.globalAlpha = 1;
      }
    });
  }

  // Every leak id ever observed, across every compartment - not just the one
  // currently on screen, so a leak that sprang in a room you're not looking
  // at doesn't fire a belated burst the next time you happen to walk in.
  // Only ever added to, never pruned - a leak id is never reused (the
  // server's own next_leak_id only counts up), so this can't grow unbounded
  // in any way that matters for a real play session.
  const knownLeakIds = new Set();

  // A bigger, one-shot version of the weld spark burst above (same array,
  // same rendering - just more sparks and more spread) for "something just
  // broke" impact, fired the instant a leak id is first seen.
  function spawnLeakBurst(x, y, roomId) {
    for (let i = 0; i < 14; i += 1) {
      const angle = Math.random() * Math.PI * 2;
      const dist = Math.random() * 70 + 25;
      weldSparks.push({
        x, y, roomId,
        vx: (Math.cos(angle) * dist) / (WELD_SPARK_LIFE_MS / 1000),
        vy: (Math.sin(angle) * dist) / (WELD_SPARK_LIFE_MS / 1000) - 50,
        spawnMs: Date.now(),
      });
    }
    if (weldSparks.length > MAX_WELD_SPARKS) weldSparks.splice(0, weldSparks.length - MAX_WELD_SPARKS);
  }

  // Leaks themselves are drawn straight from server state, never local
  // prediction - a crack marker (with a plain fallback square, same idea as
  // every other effect here, if the sprite hasn't loaded) plus continuously
  // spawning spray, plus a one-shot spark burst the moment each one first
  // appears.
  function drawLeaks(ctx, canvas, gameState, roomId) {
    const leaks = (gameState && gameState.leaks) || [];
    // Checked against the FULL leak list, not just this room's - a leak's
    // "known" status has to be tracked globally (see knownLeakIds above)
    // even though the burst itself only ever draws for the room being shown.
    leaks.forEach((leak) => {
      if (knownLeakIds.has(leak.id)) return;
      knownLeakIds.add(leak.id);
      if (leak.compartment === roomId) {
        spawnLeakBurst(leak.x * canvas.width, leak.y * canvas.height, roomId);
      }
    });

    leaks.filter((l) => l.compartment === roomId).forEach((leak) => {
      const lx = leak.x * canvas.width;
      const ly = leak.y * canvas.height;

      if (EFFECT_SPRITES.Crack1) {
        ctx.drawImage(EFFECT_SPRITES.Crack1, lx - 8, ly - 8, 16, 16);
      } else {
        ctx.fillStyle = '#1c3040';
        ctx.fillRect(lx - 3, ly - 3, 6, 6);
      }

      spawnLeakDrop(leak, lx, ly);
    });
    drawLeakDrops(ctx, roomId);
  }

  // flooding (0-100) is a single sub-wide stat, not per-compartment - unlike
  // the leak/weld layer above, this has to show in EVERY room and EVERY
  // station view, not just the compartment view, since rising water is a
  // whole-boat danger regardless of where you're currently standing. Drawn
  // dead last so it visually submerges whatever's beneath the waterline
  // (objects, leak sparks, weld marks, all of it) rather than sitting
  // underneath them.
  function drawFloodingOverlay(ctx, canvas, gameState) {
    const flooding = (gameState && gameState.flooding) || 0;
    if (flooding <= 0) return;
    const fraction = Math.min(1, flooding / 100);
    const waterTop = canvas.height * (1 - fraction);

    const now = Date.now();
    const waveLength = 90;
    const waveAmplitude = 2 + fraction * 4; // choppier as it gets worse, not just higher
    const waveOffset = now * 0.0018;
    const waveY = (x) => waterTop + Math.sin(x / waveLength + waveOffset) * waveAmplitude;

    ctx.save();
    ctx.beginPath();
    ctx.moveTo(0, canvas.height);
    ctx.lineTo(0, waveY(0));
    for (let x = 0; x <= canvas.width; x += 12) {
      ctx.lineTo(x, waveY(x));
    }
    ctx.lineTo(canvas.width, canvas.height);
    ctx.closePath();

    // Darker toward the bottom - reads as depth of water, not a flat tint.
    const gradient = ctx.createLinearGradient(0, waterTop, 0, canvas.height);
    gradient.addColorStop(0, 'rgba(40, 110, 150, 0.32)');
    gradient.addColorStop(1, 'rgba(6, 30, 45, 0.78)');
    ctx.fillStyle = gradient;
    ctx.fill();

    // A bright waterline so the surface itself reads clearly against
    // whatever's behind it, light or dark.
    ctx.strokeStyle = 'rgba(190, 235, 255, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, waveY(0));
    for (let x = 0; x <= canvas.width; x += 12) {
      ctx.lineTo(x, waveY(x));
    }
    ctx.stroke();
    ctx.restore();
  }

  // Renders the compartment's own objects (stationId omitted/null) or one
  // station's dedicated object list onto canvas, in the layout's own
  // z-order. No-ops quietly if the room or station has no data yet, rather
  // than throwing mid-render. Everything past stationId is optional - omit
  // it all for a purely static render of the authored layout. roomId (the
  // compartment id `entry` was loaded for) is only used to scope leaks/welds
  // to this specific room, and only while stationId is null - the leak/weld
  // layer is a compartment-view-only feature. The flooding overlay, unlike
  // leaks/welds, draws regardless of stationId - see drawFloodingOverlay.
  function draw(canvas, entry, stationId, gameState, dragOverride, lastKnownT, hPatternDragOverride, lastKnownNode, scopeView, lastKnownToggle, roomId) {
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!entry) return;
    objectsFor(entry, stationId).forEach((obj) => (
      drawObject(ctx, entry, obj, gameState, dragOverride, lastKnownT, hPatternDragOverride, lastKnownNode, scopeView, lastKnownToggle)
    ));
    if (!stationId) {
      drawLeaks(ctx, canvas, gameState, roomId);
      drawWeldSparks(ctx, roomId);
      drawWeldDecals(ctx, roomId);
    }
    drawFloodingOverlay(ctx, canvas, gameState);
  }

  return {
    load,
    draw,
    objectsFor,
    hitTestInteractive,
    hitTestScope,
    getSnapPathGeometry,
    projectWorldPosToT,
    nearestSnapT,
    inferRestingT,
    inferHPatternRestingNode,
    projectHPatternRail,
    computeGameValue,
    resolvePath,
    weldAt,
    clearWelds,
  };
})();
