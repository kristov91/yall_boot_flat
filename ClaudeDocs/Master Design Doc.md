# Cooperative Submarine Game — Master Design Document

### Working Design Specification

**Current development target: Slice 0 — Networking Foundation**

---

# 1. Game Concept

A cooperative submarine game designed for **5 players sharing one submarine**.

The intended experience is less like a conventional action game and more like:

> **Five people sitting around a table eating pizza while operating a submarine together.**

Players constantly have small, tactile jobs to perform:

* Monitor gauges
* Tune engines
* Listen to sonar
* Decode radio messages
* Draw on the navigation map
* Steer
* Manage depth
* Load torpedoes
* Operate electrical systems
* Repair damage
* Search compartments for leaks
* Look through the periscope
* Communicate with one another

The game should alternate naturally between:

**Relaxed → Interesting → Tense → Chaotic → Solved → Relaxed**

The goal is cooperative activity rather than constant combat.

---

# 2. Core Design Principles

## 2.1 One Submarine, One Shared State

All players are operating the **same physical submarine**.

There are no separate player submarines.

The server owns the submarine and world simulation.

Clients send player intentions and display the resulting state.

```text
PLAYER
  ↓
Intent
  ↓
SERVER
  ↓
Authoritative State
  ↓
ALL PLAYERS
```

---

## 2.2 No Fixed Player Roles

Players do not select classes such as:

* Engineer
* Captain
* Sonarman
* Gunner

Instead, everyone can operate stations.

A group might naturally divide responsibilities:

> "I'll stay on sonar."

> "I'm tuning the engines."

> "I've got the map."

But players are free to move around and help elsewhere.

---

# 3. Platform / Technical Vision

## Primary Target

* LAN multiplayer
* 5 players
* One reasonably capable laptop running the simulation/server
* Cheap client devices
* Browser-based clients
* Phones
* Tablets
* Laptops
* Potentially Raspberry Pi-class devices

The host laptop may also use a browser as one of the clients.

## Networking

Initial target:

**WebSockets over LAN**

Potential future:

* Internet multiplayer
* Dedicated servers
* Hosted games

The protocol should remain clean enough that these can be added later.

---

# 4. Server-Authoritative Architecture

The server owns all meaningful game state.

### Server owns

* Submarine physics/state
* Position
* Heading
* Speed
* Depth
* Engines
* Electrical system
* Batteries
* Ballast
* Dive planes
* Rudder
* Damage
* Leaks
* Flooding
* Torpedoes
* Enemies
* Enemy AI
* Sonar contacts
* Radio events
* Repair states
* Random events
* Player/session state
* Tool ownership
* Station occupancy
* Randomized damage states

### Clients own

* Touch/mouse interaction
* UI
* Animation
* Sound
* Visual effects
* Local character presentation
* Input interpretation

Clients **do not own game state**.

---

# 5. Fundamental Architecture Pattern

Everything should follow:

```text
INTENT
   ↓
AUTHORITY
   ↓
STATE
   ↓
PRESENTATION
```

Example:

### Repairing a bolt

```text
Player uses wrench on Bolt 17
          ↓
CLIENT
          ↓
USE_WRENCH / ADJUST_BOLT
          ↓
SERVER
          ↓
Validate action
          ↓
Bolt 17 = 63° → 42°
          ↓
STATE UPDATE
          ↓
ALL RELEVANT CLIENTS
          ↓
Bolt visibly rotates
Wrench moves
Sound plays
Gauge improves
```

This same architecture should eventually handle:

* Welding
* Engine tuning
* Fuse replacement
* Valve operation
* Torpedo loading
* Steering
* Sonar
* Radio
* Repair
* Tools
* Compartments

---

# 6. Development Strategy

Build the game as **vertical slices**, not as a collection of disconnected systems.

Each slice should prove an important part of the architecture before the next layer is added.

---

# SLICE 0 — NETWORKING FOUNDATION

## Goal

Prove:

> **One Godot server can host five browser clients on a LAN and maintain one shared authoritative state.**

Nothing else is required.

---

## Slice 0 Scope

### Server

Minimal Godot server containing:

```text
Server
├── NetworkServer
├── SessionManager
└── Simulation
```

Server maintains:

```text
SubmarineState
├── tick
├── engine_order
├── speed
└── depth
```

No actual submarine simulation is necessary yet.

---

## Server Tick

Use a fixed simulation loop.

Conceptually:

```text
60 Hz

PROCESS INPUTS
      ↓
UPDATE SIMULATION
      ↓
INCREMENT TICK
```

The exact frequency can be changed later.

Important distinction:

```text
Simulation frequency
≠
Network frequency
≠
Rendering frequency
```

These should eventually be independently configurable.

---

# 7. Slice 0 Protocol

Use a simple JSON message format.

### Client → Server

Example:

```json
{
  "type": "input",
  "sequence": 42,
  "action": "SET_ENGINE_ORDER",
  "data": {
    "value": 0.5
  }
}
```

The client sends **semantic intent**, not raw mouse/touch information.

Good:

```text
SET_ENGINE_ORDER = 0.5
```

Bad:

```text
mouse_x = 384
mouse_y = 527
```

The server should never need to know where someone's finger is on the screen.

---

## Server → Client

Example:

```json
{
  "type": "state",
  "tick": 1842,
  "data": {
    "engine_order": 0.5,
    "speed": 3.7,
    "depth": 14.2
  }
}
```

The exact protocol can evolve, but message structure should remain consistent.

---

# 8. Slice 0 Browser Client

The first browser UI should be intentionally ugly.

Example:

```text
COOPERATIVE SUBMARINE TEST

Connection: CONNECTED

Player ID:
player_3

Server Tick:
1842

Engine Order:
0.50

Speed:
3.72

Depth:
14.20

[ ENGINE - ]   [ ENGINE + ]
```

Do not build the visual submarine yet.

Do not build polished controls yet.

The purpose is testing networking.

---

# 9. Slice 0 Connection Lifecycle

```text
CONNECT
   ↓
ASSIGN PLAYER ID
   ↓
SEND INITIAL STATE
   ↓
ACTIVE
   ↓
RECEIVE INPUTS
   ↓
UPDATE STATE
   ↓
BROADCAST STATE
   ↓
DISCONNECT
```

Player IDs are generated by the server.

Example:

```text
player_1
player_2
player_3
player_4
player_5
```

The browser does not determine its authoritative identity.

---

# 10. Slice 0 Testing

Do not consider Slice 0 complete until these tests work.

### Test 1 — One client

```text
Godot server
      ↓
Browser
```

Client connects and sees server state.

### Test 2 — Two clients

```text
             SERVER
             /    \
            /      \
       Browser A  Browser B
```

Changing engine order on A changes what B sees.

### Test 3 — Five clients

All five receive the same state.

### Test 4 — Disconnect

One client disconnects.

The other four continue operating.

### Test 5 — Reconnect

A disconnected client reconnects and receives current authoritative state.

### Test 6 — Simultaneous input

Two clients manipulate the same value simultaneously.

The server determines the resulting state.

### Test 7 — LAN

Use actual separate devices:

```text
             Wi-Fi
               │
            LAPTOP
          GODOT SERVER
               │
       ┌───────┼───────┐
       ↓       ↓       ↓
     Phone   Tablet   Laptop
       ↓
     Device
       ↓
     Device
```

---

# 11. Slice 0 Success Criterion

The milestone is:

> **Five browser windows/devices connect to one laptop, each receives a unique player ID, one player changes engine order, and all five see the same authoritative state.**

Nothing more is needed for Slice 0.

---

# SLICE 1 — ONE REAL PHYSICAL CONTROL

Once Slice 0 works, build **one excellent control**.

First control:

## Navigation → Engine Order

Flow:

```text
PLAYER DRAGS LEVER
        ↓
CLIENT
        ↓
SET_ENGINE_ORDER
        ↓
SERVER
        ↓
VALIDATE
        ↓
SUBMARINE STATE
        ↓
BROADCAST
        ↓
ALL CLIENTS UPDATE
```

---

# 12. Station Model

Introduce stations:

```text
Station
├── station_id
├── station_type
├── occupant
└── state
```

Example:

```text
station_navigation
station_helm
station_dive
station_sonar
station_radio
```

The server controls occupancy.

Normally:

> **One player per station.**

Navigation/map is an exception and can support multiple players.

---

# 13. Optimistic UI

Controls should feel immediate.

When a player drags a lever:

```text
TOUCH
 ↓
LOCAL VISUAL RESPONSE
 ↓
INPUT SENT
 ↓
SERVER VALIDATES
 ↓
AUTHORITATIVE STATE
 ↓
CORRECTION IF NECESSARY
```

Do not make every control feel like:

> Touch → wait for network → control moves.

LAN should feel local.

---

# 14. Slice 1 Testing

Test:

* Multiple players manipulating controls
* Simultaneous input
* Rapid input
* Station occupancy
* Disconnect/reconnect
* Network delay
* Invalid input
* Conflicting inputs

Success means the control feels responsive while remaining server authoritative.

---

# SLICE 2 — COMPARTMENTS

Add the submarine's spatial structure.

Initial prototype:

```text
FORWARD TORPEDO
       ↓
CONTROL
       ↓
ENGINEERING
```

Do not build the entire submarine yet.

---

# 15. Compartment Architecture

A compartment is a data structure, not merely a screen.

```text
Compartment
├── id
├── name
├── connections[]
├── stations[]
├── tools[]
└── visual_scene
```

Examples:

```text
forward_torpedo
information
control
engineering
aft_torpedo
attack_room
weather_deck
```

The game should think:

```text
Compartment
    ↓
Connections
    ↓
Stations
    ↓
Objects
```

Not:

```text
Screen 1
Screen 2
Screen 3
```

This is important for future continuous movement.

---

# 16. Player State

Player location is independent of station occupancy.

```text
PlayerState
├── player_id
├── compartment
├── station
└── equipped_tool
```

A player can therefore be:

```text
Engineering
    ↓
No station
```

or:

```text
Engineering
    ↓
Diesel Engine Station
```

---

# 17. Gesture / Navigation System

This is a **global interaction rule**.

### Large swipe

Moves between compartments.

```text
←——————————————→
Large screen-spanning swipe
        ↓
Change compartment
```

### Small/local interaction

Operates equipment.

```text
Small drag
    ↓
Control owns gesture
```

### Priority

```text
Pointer Down
     ↓
Inside interactive object?
     │
 YES ─────→ Object captures gesture
     │
 NO
     ↓
Large enough swipe?
     │
 YES ─────→ Compartment navigation
     │
 NO
     ↓
Nothing
```

An interactive control always takes input priority over navigation.

This prevents accidentally leaving a compartment while:

* Turning a valve
* Adjusting a gauge
* Rotating a wrench
* Welding
* Moving a flashlight

---

# 18. Slice 2 Testing

Five clients should be able to:

* Enter compartments
* See other players
* Occupy stations
* Leave stations
* Use the engine control
* Move around independently
* Use large swipe navigation
* Use local control gestures
* Avoid accidental navigation while manipulating controls

---

# FUTURE CONTINUOUS SUB-VIEW

**Wishlist / experimental. Not core.**

Eventually, compartment mode may become a continuous horizontal space.

Instead of:

```text
[ENGINEERING]
      ↓
[CONTROL]
```

the player could horizontally scroll:

```text
←────────────────────────→
    SUBMARINE INTERIOR
```

like a social-media feed.

The player's character moves with the scrolling view.

Stations become objects in the physical space.

To use one:

> Walk until it is visible → tap it.

The same could apply to:

* Stations
* Ladders
* Periscope
* Tool racks

Walking animations can be added later.

---

## Performance Strategy

If implemented, keep it lightweight:

* Mostly static background art
* Dynamic overlays/sprites
* Low-rate ambient animations
* Gameplay state: ~20–30 Hz where possible
* Rendering: ~60 FPS
* Ambient animation: ~4–15 FPS

Horizontal scrolling itself should be cheap.

Potential performance problems:

* Huge transparent layers
* Full-screen shaders
* Dynamic lighting
* Excessive particles
* Large animated machinery
* Expensive water effects

---

## Performance Stress Test

Before committing to continuous movement, intentionally test:

* 5 players
* Character movement
* ~20 animated machinery elements
* 10 leaks
* Sparks
* Gauges
* Rotating components
* Tools
* Flashlights
* Water overlay

Use the worst expected client hardware.

If it is smooth, keep the feature.

If not, abandon it without affecting the underlying compartment architecture.

---

# SLICE 3 — MINIATURE PLAYABLE SUBMARINE

First genuinely playable version.

Include:

### Control Room

* Engine order
* Helm
* Depth

### Engineering

* Basic engine

### Information

* Simplified sonar

### Torpedo Room

* One torpedo

### World

* One enemy

---

# 19. Basic Server Simulation

```text
Submarine
├── position
├── heading
├── depth
├── speed
├── engine_order
├── rudder
├── dive_planes
└── torpedo
```

Basic model:

```text
Engine order
     ↓
Target speed
     ↓
Acceleration
     ↓
Speed
```

```text
Rudder
  ↓
Turn rate
  ↓
Heading
```

```text
Ballast + planes
       ↓
Vertical rate
       ↓
Depth
```

Don't immediately port complex 3D submarine physics into this version.

The first simulation should be predictable and inexpensive.

---

# 20. Client Interpolation

The server should remain authoritative.

Clients should interpolate received state for smooth visual movement.

```text
SERVER
20–60 updates/sec
       ↓
CLIENT
interpolation
       ↓
60 FPS presentation
```

This is especially important for avoiding visible packet-arrival stutter.

---

# 21. First Enemy

Keep AI extremely simple.

```text
Detect
  ↓
Approach
  ↓
Attack
```

No sophisticated behavior tree initially.

---

# 22. First Torpedo

Client sends:

```text
FIRE_TORPEDO
```

Server validates:

* Tube exists
* Torpedo loaded
* Torpedo available
* Conditions allow firing

Server creates and simulates the torpedo.

Clients only display the result.

---

# 23. First Combat Scenario

```text
START
 ↓
CRUISE
 ↓
FIND ENEMY
 ↓
TURN
 ↓
LOAD / FIRE
 ↓
ENEMY REACTS
 ↓
ENEMY ATTACKS
 ↓
DAMAGE
 ↓
SURVIVE / DESTROY
```

The first five-person playtest should answer:

> **Is operating one submarine with five people fun?**

If yes, expand the game.

---

# SLICE 4+ — FULL SUBMARINE SYSTEMS

Once Slice 3 proves the core multiplayer loop, expand into the complete submarine.

---

# 24. Compartment Layout

Normal flow:

```text
FORWARD TORPEDO
       ↓
INFORMATION
       ↓
CONTROL
       ↓
ENGINEERING
       ↓
AFT TORPEDO
```

There is one major vertical exception:

```text
                    WEATHER DECK
                         ↑
                       Ladder
                         │
              ┌──────────┴──────────┐
              │     ATTACK ROOM     │
              │    CONNING TOWER    │
              │                     │
              │   TDC / FIRE CTRL   │
              │     PERISCOPE       │
              └──────────┬──────────┘
                         │
                         ↓
                   CONTROL ROOM
```

---

# 25. Forward Torpedo Room

Contains:

* Four forward torpedo tubes
* Torpedo racks
* Loading equipment
* Torpedo selection
* Physical loading workspace

---

# 26. Information Compartment

Contains:

* Radio
* Sonar

These form the submarine's information center.

---

# 27. Radio Station

Radio provides imperfect information.

Possible messages:

* Friendly directions
* Headings
* Search areas
* Warnings
* Approximate enemy locations
* Convoy information

Enemy transmissions can be intercepted.

The player uses a simple cipher/decoding interaction.

Successful decoding can reveal:

* Convoy location
* Heading
* Approximate position
* Heavy enemy presence
* Dangerous areas

Information loop:

```text
RADIO
 ↓
INTELLIGENCE
 ↓
NAVIGATION MAP
 ↓
SONAR
 ↓
TDC
 ↓
ATTACK / AVOID
```

---

# 28. Sonar

Large circular hydrophone-style display.

It should work visually and aurally.

Contacts create:

* Bearing information
* Expanding circles
* Propeller pulses
* Rough distance cues

Example:

```text
Slow propeller
≈ 1 pulse/sec

Fast propeller
≈ 3 pulses/sec
```

A 360° tuning control rotates a radial line.

When aligned with a contact:

> Propeller noise becomes detectable.

The sonar experience should rely on:

* Pattern recognition
* Sound
* Visual intuition
* Timing

rather than perfect numerical information.

---

# 29. Control Room

Contains:

* Navigation
* Helm
* Dive

### Navigation

* Course
* Engine order
* Map
* Navigation information
* Periscope shortcut

The map supports:

* Free drawing
* Lines
* Circles
* Measuring
* Compass
* Laser pointer
* Colored markers

Multiple players can use the map simultaneously.

---

# 30. Helm

Steering controls.

Rudder should be a physical/tactile control rather than a menu.

---

# 31. Dive Station

Controls:

* Ballast
* Bow planes
* Stern planes
* Dive/blow systems
* Depth

The submarine should respond naturally to:

* Ballast state
* Speed
* Plane angle
* Trim

---

# 32. Attack Room

Located in the conning tower above Control.

Contains:

* Torpedo Data Computer
* Fire control
* Periscope
* Weather-deck ladder

This is the transition between:

```text
TRACKING
   ↓
TARGET SOLUTION
   ↓
ATTACK
```

---

# 33. Periscope

Available in two ways:

### Attack Room

Physical periscope station.

### Control Room

A small periscope handle attached to the Navigation station.

Pulling it provides access without requiring the player to physically navigate upstairs.

The periscope view is one of the primary 3D elements.

---

# 34. Weather Deck

Accessible only while surfaced.

Provides a 3D exterior view.

Unlike the periscope:

> No circular periscope mask.

Potential uses:

* Looking around
* Weather
* Nearby ships
* Surface navigation
* Deck activities
* Deck gun in future versions

---

# 35. Engineering Compartment

Contains:

* Diesel engines
* Electric motors
* Fuse panel
* Tool rack

---

# 36. Diesel Engine

Potential state:

* RPM
* Temperature
* Oil pressure
* Fuel
* Efficiency
* Condition
* Alignment

Engine tuning is a recurring maintenance task.

---

# 37. Engine Tuning

Multiple tuning screws slowly drift out of alignment.

Important:

> Normal drift should never become a catastrophic failure.

Misalignment creates:

* Reduced efficiency
* Reduced speed
* Increased fuel consumption

It should be noticeable but manageable.

Players can tune engines during downtime.

---

## Tuning Interaction

1. Tap screw/bolt.
2. Wrench appears.
3. Drag outward to extend wrench.
4. Longer wrench = greater precision.
5. Shorter wrench = faster adjustment.
6. Drag around pivot.
7. Screw rotates.
8. Physical/audio feedback changes near optimal position.

Feedback:

* Ratcheting
* Resistance
* Gauge changes
* RPM changes
* Engine sound changes

No progress bar.

---

# 38. Electric Motor

Tracks:

* Motor output
* Battery state
* Electrical load
* Motor condition

---

# 39. Fuse Panel

Blown fuses can occur.

Players must:

* Find correct fuse
* Remove it
* Replace it

No dedicated Engineer role is required.

---

# 40. Aft Torpedo Room

Contains:

* Aft torpedo tube
* Storage
* Loading equipment
* Auxiliary supplies

---

# DAMAGE SYSTEM

# 41. Leaks

Leaks can appear randomly throughout the submarine.

Crucially:

> **Leaks appear on compartment-level views, not inside station control panels.**

Players must physically search compartments.

---

# 42. Welding

Every station has access to a small welding torch icon.

Tap it:

```text
TORCH
 ↓
Attach to finger/cursor
 ↓
DRAW ACROSS LEAK
 ↓
WELD
```

Welding is not a progress bar.

The player must physically cover the leak.

Visual weld progression:

```text
WHITE
 ↓
YELLOW
 ↓
RED
 ↓
GRAY
```

Sparks and weld marks provide feedback.

Multiple players can weld simultaneously.

---

# 43. Flooding

All players see a global flooding indication.

Overlay:

* Semi-transparent water
* Wavy waterline
* Bubbles
* Rising water

Water rises while leaks remain.

If water reaches the top:

> Submarine sinks / game over.

---

# 44. Station Damage

External damage should **not normally disable stations completely**.

Instead:

```text
100%
 ↓
80%
 ↓
60%
 ↓
40%
 ↓
20%
```

As condition worsens:

* Controls become sluggish
* Systems become less efficient
* Gauges become less reliable
* Mechanical actions become harder
* Performance deteriorates

But the crew should generally still be able to operate the system.

This lets players survive combat and repair afterward.

---

# 45. Damage Philosophy

Damage should create:

> **Physical problems, searching, communication, diagnosis and cooperation.**

Not:

> "System disabled. Open menu. Click repair."

---

# 46. Repair Philosophy

Repair loop:

```text
Something behaves strangely
          ↓
Investigate
          ↓
Open / inspect
          ↓
Consult manual
          ↓
Identify discrepancy
          ↓
Choose appropriate tool
          ↓
Physically repair
          ↓
Test
          ↓
100%
```

---

# 47. Repair & Maintenance Manual

A physical-style manual acts as the ground truth.

It contains:

* Error codes
* Symptoms
* Troubleshooting
* Correct screw positions
* Correct bolt positions
* Wiring diagrams
* Pipe routing
* Fuse layouts
* Normal gauge ranges
* Component diagrams
* Correct internal configurations

The manual should tell the player:

> **What correct looks like.**

It should not simply say:

> **Click wrench here.**

The player compares the actual mechanism against the reference.

---

# 48. Opening Panels

A screwdriver can open damaged control panels.

Each panel has four screws.

Player:

```text
Tap screw
 ↓
Rotate screwdriver
 ↓
Remove screw
```

After all four are removed:

```text
PANEL OPENS
```

Inside may be:

* Wires
* Terminals
* Pipes
* Bolts
* Linkages
* Components

---

# 49. Example Diagnostic

Manual:

```text
ERROR 27
Hydraulic control irregularity

Check governor linkage.

Correct adjustment:
Bolt A = 42°
```

Player opens panel.

Actual:

```text
Bolt A = 63°
```

Player recognizes discrepancy.

Uses wrench.

```text
63° → 42°
```

System improves.

---

# 50. Electrical Example

Manual:

```text
GREEN WIRE → TERMINAL 3
```

Player opens panel.

Finds green wire disconnected.

Drags it onto Terminal 3.

System recovers.

---

# 51. Reusable Failure Types

Damage should be generated from reusable physical failure families.

### Loose bolt

Symptoms:

* Wobble
* Rattle
* Visible backing out

Tool:

* Wrench

### Cracked pipe

Symptoms:

* Hissing
* Steam
* Fluid
* Visible crack

Tool:

* Welder

### Bent linkage

Symptoms:

* Crooked movement
* Catching
* Clunking

Tool:

* Hammer

### Damaged insulation

Symptoms:

* Exposed wire
* Frayed insulation

Tool:

* Duct tape

### Electrical connection

Symptoms:

* Flicker
* Sparks
* Intermittent behavior

Repair:

* Physical reconnection/fixing

### Misalignment

Symptoms:

* Reference marks don't match
* Poor performance

Repair:

* Adjustment

---

# 52. Tool Selection Philosophy

The correct tool should be inferred from symptoms.

The game should teach a physical language:

```text
LOOSE
→ wobble / rattle

CRACKED
→ leak / hiss / steam

BENT
→ crooked / stuck / clunk

ELECTRICAL
→ sparks / flicker

MISALIGNED
→ reference marks don't match
```

Wrong tools should generally produce no meaningful result rather than catastrophically punishing the player.

---

# 53. Randomized Damage

Randomize the **physical cause**, not arbitrary minigames.

Each component has:

```text
NORMAL STATE
+
VALID DAMAGED STATES
```

Example:

```text
Normal:
Wire A → Terminal 1
Wire B → Terminal 2
Wire C → Terminal 3

Bolt A = 42°
Bolt B = 17°
```

Possible damage:

```text
Wire B disconnected
Bolt A = 65°
```

or:

```text
Wire C → wrong terminal
Bolt B = 0°
```

or:

```text
Pipe joint leaking
Bolt A = 60°
```

Damage combinations should remain physically plausible.

---

# 54. Damage Events

A single hit can create several related failures.

Example:

```text
TORPEDO IMPACT
      ↓
Loose engine mount
      +
Cracked coolant pipe
      +
Damaged electrical connection
```

The player discovers the consequences rather than receiving a checklist.

---

# 55. Gauges as Diagnostics

Existing gauges should provide clues.

Examples:

* RPM
* Oil pressure
* Temperature
* Fuel
* Electrical load
* Battery
* Depth
* Speed

Players should learn to recognize abnormal relationships.

There is no dedicated "diagnostic mode."

---

# 56. Repair Confirmation

Successful repair should be obvious.

Examples:

* Gauge returns toward normal
* Machine moves correctly
* Sound changes
* Error disappears
* Efficiency improves
* Steam stops
* Sparks disappear

The goal is a strong:

> **"There. I fixed it."**

moment.

---

# 57. Temporary Emergency Repairs

Three levels of repair:

## Duct Tape — Emergency

Applying duct tape immediately raises a damaged station to:

**60% condition**

Duration:

**60 seconds**

Afterward it returns to its underlying damaged condition.

Can be reapplied.

Purpose:

> Keep equipment functioning during combat.

---

## Hammer — Improvised

Hitting a damaged component has a small chance to improve it by:

**1–10%**

Successful improvements persist until another damaging event.

Purpose:

> "Hit it until it works."

Unreliable but useful during emergencies.

---

## Proper Repair — Permanent

Requires:

* Inspection
* Manual
* Diagnosis
* Correct tool
* Physical repair
* Testing

Restores:

**100% condition**

until another damage event.

---

# 58. Emergency Repair Loop

```text
DAMAGE
  ↓
DUCT TAPE / HAMMER
  ↓
SURVIVE
  ↓
RECOVER
  ↓
DIAGNOSE
  ↓
PROPER REPAIR
  ↓
100%
  ↓
ROUTINE
```

---

# TOOLS

# 59. Personal Tool Belt

Each player has a small personal tool belt/hotbar.

Possible tools:

* Flashlight
* Welding torch
* Hammer
* Duct tape
* Screwdriver
* Wrench
* Spare fuses
* Specialized tools later

Exact slot count remains TBD.

Tools should be physical objects, not abstract abilities.

---

# 60. Shared Tool Racks

Compartments contain physical tool racks.

Players can:

* Pick up tools
* Drop tools
* Leave tools behind
* Take tools elsewhere

Example:

> "Where's the welder?"

> "I left it in Control."

The physical location of tools should become part of player memory.

---

# 61. Limited Tool Availability

Important tools should have limited physical copies.

Example:

**Two welders**

means only two people can weld simultaneously.

There should be no magical unlimited inventory.

---

# 62. Flashlight

Every player has their own flashlight.

When submarine lights fail:

```text
Tap flashlight
 ↓
Flashlight appears
 ↓
Drag around screen
 ↓
Illuminate approximately 25% of visible area
```

The flashlight itself is visible.

If the flashlight overlaps a control:

> **Flashlight gets input priority.**

This follows the general direct-manipulation rule.

---

# 63. Tactile Interaction Philosophy

Mundane actions should feel satisfying.

Examples:

### Welding

Drag torch across leak.

### Engine tuning

Extend wrench and rotate bolt.

### Fuse

Pull and insert fuse.

### Hammer

Physically strike component.

### Duct tape

Drag tape across damaged area.

### Valve

Rotate valve.

### Dial

Rotate dial.

### Torpedo

Physically manipulate loading mechanism.

### Radio

Manipulate cipher controls.

### Sonar

Rotate tuning control.

### Flashlight

Drag flashlight.

Avoid:

* Yes/no repair dialogs
* Generic progress bars
* "Press button to repair"
* Abstract repair abilities

---

# GAMEPLAY LOOP

# 64. Routine

Players can:

* Monitor gauges
* Tune engines
* Listen to sonar
* Decode radio
* Mark the map
* Navigate
* Load torpedoes
* Check electrical systems
* Manage batteries
* Adjust ballast
* Operate planes
* Use periscope
* Perform maintenance

---

# 65. Information

```text
RADIO MESSAGE
      +
SONAR CONTACT
      ↓
NAVIGATION
      ↓
SEARCH / TRACK
```

---

# 66. Investigation

Players:

* Interpret intelligence
* Mark map
* Search sonar
* Adjust course
* Prepare weapons

---

# 67. Action

Players:

* Attack
* Avoid
* Dive
* Surface
* Maneuver
* Fire torpedoes

---

# 68. Crisis

Possible events:

* Leaks
* Flooding
* Blown fuses
* Mechanical damage
* Electrical problems
* Engine damage
* Control damage

---

# 69. Recovery

Players:

* Search
* Diagnose
* Temporarily repair
* Properly repair
* Return to routine

---

# 70. Intended Pacing

```text
RELAXED
   ↓
INTERESTING
   ↓
TENSE
   ↓
CHAOTIC
   ↓
SOLVED
   ↓
RELAXED
   ↺
```

The game should contain built-in downtime.

Players should have moments where they can:

> Eat pizza, talk, tune something, listen to sonar and casually navigate.

---

# CHARACTER CUSTOMIZATION

## 71. Wishlist — Low Priority

Simple pixel-art customization inspired by games such as Stardew Valley.

Options:

### Skin

Small palette.

### Hair

Handful of hairstyles.

### Body

```text
M
F
N
```

### Clothing

Small submarine-appropriate selection.

### Clothing color

Palette/color selection.

Avoid:

* Detailed face creator
* Complex 3D customization
* Huge clothing catalog

---

# 72. Multiplayer Appearance State

Eventually:

```text
PlayerAppearance
├── skin
├── hair
├── body
├── clothing
└── clothing_color
```

This becomes part of player/session data.

Do not implement until the core multiplayer/compartment framework is stable.

---

# NETWORK STATE MODEL

# 73. State Replication

Eventually divide state into logical groups:

```text
SUBMARINE
PLAYER
ENGINE
ELECTRICAL
NAVIGATION
SONAR
TORPEDO
DAMAGE
WORLD
```

Not everything needs to be transmitted at the same frequency.

---

# 74. High-Frequency State

Examples:

* Position
* Heading
* Speed
* Depth
* Rudder
* Engine output

---

# 75. Medium-Frequency State

Examples:

* Station occupancy
* Engine condition
* Battery
* Sonar state
* Equipment condition

---

# 76. Event-Based State

Examples:

* Torpedo fired
* Torpedo hit
* Player enters compartment
* Tool picked up
* Tool dropped
* Damage occurs
* Fuse replaced
* Radio message received

Don't repeatedly synchronize something that only changed once.

---

# 77. Visual Effects

Do not network:

```text
spark_particle_17
weld_animation_frame_8
engine_sound_volume
```

Network:

```text
ENGINE_DAMAGE
WELD_COMPLETED
TORPEDO_FIRED
FUSE_REPLACED
```

Clients generate appropriate presentation locally.

This saves bandwidth and reduces complexity.

---

# PROJECT STRUCTURE

Conceptual structure:

```text
project/
│
├── server/
│   ├── network/
│   │   ├── network_server.gd
│   │   ├── session_manager.gd
│   │   └── protocol.gd
│   │
│   ├── simulation/
│   │   ├── simulation.gd
│   │   ├── submarine_state.gd
│   │   ├── player_state.gd
│   │   └── world_state.gd
│   │
│   └── main.gd
│
├── client/
│   ├── network/
│   │   ├── network_client.gd
│   │   └── protocol.gd
│   │
│   ├── ui/
│   │   ├── interaction_manager.gd
│   │   ├── navigation_manager.gd
│   │   └── station_controller.gd
│   │
│   └── main.gd
│
├── shared/
│   ├── protocol/
│   ├── constants/
│   └── data/
│
└── web/
    ├── index.html
    ├── js/
    └── assets/
```

Exact structure can change depending on whether the browser client remains conventional HTML/JS or eventually becomes a Godot web export.

The conceptual separation should remain.

---

# 78. Avoid Station-Specific Networking

Do **not** create:

```text
Sonar.gd
  └── its own networking

Engine.gd
  └── its own networking

Helm.gd
  └── its own networking
```

Instead:

```text
NETWORK
   ↓
GAME STATE
   ↓
STATION STATE
   ↓
UI
```

A station is a presentation/interaction surface over authoritative state.

---

# PERFORMANCE TARGETS

## Server

Target:

**60 Hz**

Fallback:

**30 Hz**

depending on simulation complexity.

---

## Browser

Target:

**60 FPS**

on intended low-end client hardware.

---

## Network

LAN interactions should feel immediate.

Avoid designs that require round-trip confirmation before basic UI movement.

---

# 79. Performance Priorities

When optimizing:

### First

Simulation cost.

### Second

Network traffic.

### Third

Browser rendering.

### Fourth

Visual effects.

The low-end clients should mostly be drawing UI and lightweight 2D art.

---

# 80. Critical Optimization Principle

Do not synchronize visuals.

Synchronize:

> **Meaning.**

For example:

```text
SERVER:
bolt_17.angle = 42°
```

not:

```text
SERVER:
bolt_17 animation frame 1
bolt_17 animation frame 2
bolt_17 animation frame 3
...
```

---

# FINAL DEVELOPMENT ROADMAP

```text
                    PHASE A
              NETWORK FOUNDATION
                       │
                       ▼
                 Slice 0
                       │
        Godot server + browser client
                       │
                       ▼
                  5 clients
                       │
                       ▼
                    PHASE B
                SHARED CONTROL
                       │
                       ▼
              Engine Order Control
                       │
                       ▼
              Server Authority
                       │
                       ▼
                 Occupancy
                       │
                       ▼
                    PHASE C
                 COMPARTMENTS
                       │
                       ▼
              Navigation System
                       │
                       ▼
               Gesture Priority
                       │
                       ▼
                  Player Avatars
                       │
                       ▼
                    PHASE D
              PLAYABLE SUBMARINE
                       │
                       ▼
               Movement / Depth
                       │
                       ▼
                   Sonar
                       │
                       ▼
                  Torpedo
                       │
                       ▼
                  One Enemy
                       │
                       ▼
                FIVE-PERSON TEST
                       │
                       ▼
              "IS THIS FUN?"
                       │
             ┌─────────┴─────────┐
             │                   │
            YES                  NO
             │                   │
             ▼                   ▼
       EXPAND SYSTEMS       FIX CORE LOOP
             │
             ▼
                    PHASE E
              FULL SUBMARINE
             │
     ┌───────┼────────┐
     ▼       ▼        ▼
  Damage  Engineering  Combat
     │       │        │
     ▼       ▼        ▼
 Repairs  Electricity  AI
     │       │        │
     └───────┼────────┘
             ▼
        Full Game Loop
```

---

# CURRENT PRIORITY

## **SLICE 0 ONLY**

The immediate task is **not** to build the submarine.

The immediate task is:

```text
Godot Server
      │
      │ WebSocket
      ▼
Browser Client
      │
      │
      ▼
Shared Authoritative State
```

Then:

```text
                    GODOT SERVER
                         │
          ┌──────────────┼──────────────┐
          ▼              ▼              ▼
       Browser        Browser        Browser
       Player 1       Player 2       Player 3
          │
          ├──────── Browser Player 4
          │
          └──────── Browser Player 5
```

**First milestone: five devices connected to one laptop, sharing one tiny authoritative state.**

Everything else comes after that.
