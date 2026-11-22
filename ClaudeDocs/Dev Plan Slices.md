Yes. I’d make the first three slices much more technical than the main design doc, because these are really about **proving the architecture** before we spend time making the game pretty.

The key is to build them as one continuous foundation rather than three unrelated prototypes.

# Cooperative Submarine

## Technical Implementation Plan — Slices 0–3

### Purpose

This document defines the technical approach for the first four development milestones:

* **Slice 0 — Networking Foundation**
* **Slice 1 — One Shared Physical Control**
* **Slice 2 — Compartments & Navigation**
* **Slice 3 — Miniature Playable Submarine**

The objective is not to build a lot of gameplay.

The objective is to establish an architecture that can comfortably support:

* 5 simultaneous players
* browser clients
* one authoritative Godot server
* many interactive stations
* shared submarine state
* touch/mouse interaction
* later damage/repair systems
* later 3D periscope/weather deck
* LAN play

The architecture should therefore be designed around **state synchronization and player intents**, rather than around individual UI screens.

---

# 1. Overall Architecture

The basic architecture should be:

```text
                     GODOT SERVER
                ┌─────────────────────┐
                │                     │
                │  Simulation         │
                │  Submarine State    │
                │  World State        │
                │  Players            │
                │  Enemies            │
                │  Validation         │
                │                     │
                └──────────┬──────────┘
                           │
                    WebSocket / JSON
                           │
          ┌────────────────┼────────────────┐
          │                │                │
       Browser          Browser          Browser
       Client 1         Client 2         Client 3
          │
       Browser
       Client 4
          │
       Browser
       Client 5
```

The **server is authoritative**.

Clients do not tell the server:

> "The submarine is now moving at 4 m/s."

They tell it:

> "I changed the engine order to HALF."

The server determines what actually happens.

---

# 2. Three-Layer Software Architecture

Keep the game divided into three major layers from the beginning.

```text
┌──────────────────────────┐
│       PRESENTATION       │
│                          │
│ Browser UI               │
│ Controls                 │
│ Animation                │
│ Sound                    │
│ Touch interaction        │
└────────────┬─────────────┘
             │
             ↓
┌──────────────────────────┐
│       GAME PROTOCOL      │
│                          │
│ Player intents           │
│ State synchronization    │
│ Validation responses     │
│ Player/session identity  │
└────────────┬─────────────┘
             │
             ↓
┌──────────────────────────┐
│       SIMULATION         │
│                          │
│ Submarine                │
│ Engines                  │
│ Physics                  │
│ World                    │
│ Damage                   │
│ AI                       │
└──────────────────────────┘
```

This separation is extremely important.

A browser button should never directly modify submarine simulation state.

---

# 3. Slice 0 — Networking Foundation

## Goal

Before making a submarine, prove:

> **Five browsers can connect to one Godot server and exchange authoritative state reliably.**

Nothing else matters yet.

---

# 4. Server Project

Use Godot as the authoritative server.

The server should eventually be capable of running headless.

Conceptually:

```text
Server
├── NetworkServer
├── SessionManager
├── PlayerManager
├── Simulation
└── StateReplicator
```

Don't start with dozens of classes.

The first implementation can be very small.

---

# 5. Connection Lifecycle

A connection should have a simple lifecycle:

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
SEND STATE
   ↓
DISCONNECT
```

Each client gets a server-generated ID.

Example:

```text
player_id = 1
player_id = 2
player_id = 3
...
```

Never let the browser decide its authoritative player ID.

---

# 6. Message Structure

Use a consistent envelope for all network messages.

For example:

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

Server → client:

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

The exact format can change, but establish the principle now:

**messages have types and structured payloads.**

Don't start with dozens of custom WebSocket messages with unrelated formats.

---

# 7. Inputs Are Intents

The client sends actions.

Examples:

```text
SET_ENGINE_ORDER
SET_RUDDER
SET_DIVE_PLANES
TURN_SONAR
FIRE_TORPEDO
OPEN_PANEL
USE_TOOL
```

The server interprets them.

For Slice 0, only one dummy action is needed.

For example:

```text
SET_TEST_VALUE
```

The server changes a test variable.

---

# 8. State Synchronization

The server owns state.

For the first prototype:

```text
SubmarineState
├── engine_order
├── speed
├── depth
└── test_value
```

Every connected client receives state updates.

Don't optimize networking prematurely.

At five players, the amount of UI state is tiny compared with what a modern LAN can handle.

The important thing now is establishing **correctness**.

---

# 9. Tick Model

The server should have a fixed simulation tick.

Something like:

```text
Simulation
    ↓
process inputs
    ↓
advance simulation
    ↓
produce authoritative state
    ↓
replicate state
```

For example, eventually:

**30–60 simulation ticks/sec**

but the browser does not necessarily need to receive 30–60 complete state packets/sec.

Separate:

### Simulation frequency

How often the server updates the world.

### Network replication frequency

How often clients receive relevant state.

### Rendering frequency

How often the browser draws frames.

These should not be coupled.

---

# 10. First Important Optimization Rule

**Do not synchronize the entire game state every time anything happens.**

Eventually state should be organized into logical areas:

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

For now, however, a simple complete state packet is perfectly reasonable.

The optimization comes after the architecture works.

---

# 11. Slice 0 Test

Create a simple browser screen:

```text
CONNECTED
Player ID: 3

Server Tick: 1842

Engine Order: 0.50
Depth: 14.2
Speed: 3.7

[ SET TEST VALUE ]
```

Open five browsers.

Verify:

* all five connect
* each receives a unique ID
* all receive identical server state
* any client can send an input
* server changes the state
* all five clients see the change
* disconnecting one client does not kill the others
* reconnecting works

### This is the first "done."

Do not build submarine graphics yet.

---

# 12. Slice 1 — One Shared Physical Control

Now we introduce the fundamental gameplay architecture.

The first real station should be **Navigation → Engine Order**.

Do not build an entire Navigation station.

Build **one excellent control**.

For example:

```text
        ENGINE ORDER

        ┌─────────┐
        │         │
        │  LEVER  │
        │    ●    │
        │         │
        └─────────┘

        STOP
        SLOW
        HALF
        FULL
```

The exact visual design can evolve.

The technical objective is:

> A player manipulates a control and five clients see the same authoritative result.

---

# 13. Client Interaction

The browser owns:

* pointer/touch detection
* drag gesture
* visual control movement
* local animation

But it does **not** own the actual engine order.

The interaction becomes:

```text
PLAYER DRAGS LEVER
       ↓
CLIENT CALCULATES INTENT
       ↓
SET_ENGINE_ORDER
       ↓
WEBSOCKET
       ↓
SERVER
       ↓
VALIDATE
       ↓
UPDATE SUBMARINE STATE
       ↓
BROADCAST
       ↓
ALL CLIENTS UPDATE
```

---

# 14. Don't Send Mouse Coordinates as Authority

Avoid:

```text
"lever_x = 472"
```

Instead send semantic information:

```text
SET_ENGINE_ORDER
value = 0.73
```

The client says:

> "The player wants this engine order."

The server decides whether that request is valid.

This becomes very important later when controls are more complicated.

---

# 15. Server-Side Station Model

Start introducing the concept of a station.

Something like:

```text
Station
├── station_id
├── station_type
├── occupant
└── state
```

For example:

```text
station_id: navigation_engine
station_type: engine_order
occupant: player_2
```

However, don't over-engineer this.

A station should primarily be a **stateful interaction point**, not a giant inheritance hierarchy.

---

# 16. Occupancy

Most stations allow one player.

The server should therefore know:

```text
navigation_engine.occupant = player_2
```

When Player 3 tries to use it:

```text
REQUEST_USE_STATION
        ↓
SERVER
        ↓
occupied?
        ↓
YES
        ↓
reject
```

The client should not be trusted to enforce this.

---

# 17. Why Occupancy Belongs on the Server

Two players could press a control at nearly the same time.

The server decides:

```text
Player 2 → accepted
Player 3 → rejected
```

This prevents inconsistent clients.

The server should be the source of truth for:

* who occupies a station
* what tool is being used
* what controls are being manipulated
* whether an interaction is valid

---

# 18. Optimistic UI

There is one important exception.

Controls should **feel immediate**.

If every touch waits for:

```text
touch
→ network
→ server
→ network
→ screen
```

the game will feel sluggish.

Therefore:

### Client

Immediately animates the control toward the requested position.

### Server

Authoritatively accepts/corrects it.

### Client

Smoothly reconciles if necessary.

```text
PLAYER INPUT
    ↓
LOCAL VISUAL RESPONSE
    ↓
SERVER VALIDATION
    ↓
AUTHORITATIVE RESULT
    ↓
CORRECTION IF NECESSARY
```

This is particularly important on touch devices.

---

# 19. Slice 1 Test

Use two or more browsers.

Player 1 moves engine order.

Player 2 sees it.

Player 2 changes it.

Player 1 sees it.

Then connect five players.

Test:

* simultaneous inputs
* rapid dragging
* disconnecting the controller
* reconnecting
* station occupancy
* network delay simulation if possible

### Done when

The control feels **local and responsive**, while remaining server authoritative.

---

# 20. Slice 2 — Compartments

Now build the actual submarine interface framework.

Don't immediately create all five compartments.

Start with:

```text
FORWARD TORPEDO
       ↓
CONTROL
       ↓
ENGINEERING
```

---

# 21. Compartment Data Model

A compartment should be data-driven.

Conceptually:

```text
Compartment
├── id
├── name
├── connections[]
├── stations[]
├── tools[]
└── visual_scene
```

Example:

```text
control_room
connections:
    forward
    engineering
    attack_room
```

This becomes important later because the submarine isn't actually a simple list.

The Attack Room is a branch.

---

# 22. Don't Implement Navigation as "Screen 1, 2, 3"

Avoid:

```text
current_screen += 1
```

Instead, the player has a location:

```text
current_compartment = "control_room"
```

The compartment has explicit connections:

```text
control_room:
    forward → information
    aft → engineering
    up → attack_room
```

This naturally supports the eventual layout.

---

# 23. Compartment Navigation

The large-screen swipe should be handled by a **global navigation controller**.

Conceptually:

```text
Pointer Down
     ↓
Was this inside an active interactive object?
     │
   YES ─────→ Object owns gesture
     │
    NO
     ↓
Was gesture large enough?
     │
   YES
     ↓
Determine navigation direction
     ↓
Check compartment connection
     ↓
Transition
```

This is one of the places where the architecture should be correct early.

---

# 24. Gesture Threshold

Don't make compartment navigation trigger on arbitrary movement.

For example, conceptually:

```text
minimum_distance = large fraction of screen width
minimum_velocity = threshold
```

The exact values should be tuned on real phones/tablets.

The important thing is:

> **A compartment transition should feel intentional.**

A small swipe on a lever should never accidentally move the player.

---

# 25. Interaction Priority

Implement a generic interaction system rather than special cases.

Something like:

```text
Pointer
   ↓
Interactive object under pointer?
   ↓
YES → object captures pointer
   ↓
NO → navigation gesture detector
```

Once an object captures the pointer, it keeps it until the interaction ends.

This solves:

* flashlight over switches
* wrench over bolts
* welding torch over leaks
* dragging wires
* rotating knobs
* engine levers

without having to invent a special exception for each.

---

# 26. Player Avatars

Each player should have a simple visual representation.

For example:

```text
Control Room

       [Player 2]
          👤
       Navigation

 [Player 4]
     👤
    Helm
```

The avatar doesn't need sophisticated movement.

It mainly communicates:

> **Someone is currently here/using this.**

The server owns the player's current compartment and station.

---

# 27. Station State vs Player Location

Keep these separate.

A player has:

```text
PlayerState
├── player_id
├── compartment
├── station
└── equipped_tool
```

The submarine has:

```text
StationState
├── station_id
├── occupant
└── station-specific state
```

This distinction becomes useful later.

A player can be:

```text
compartment = engineering
station = null
```

They are walking around Engineering.

Or:

```text
compartment = engineering
station = diesel_engine
```

They are operating the engine.

---

# 28. Slice 2 Tool Interaction

Don't implement actual tools yet.

Create a placeholder tool rack.

For example:

```text
ENGINEERING

[ Diesel ]
[ Fuse Panel ]

TOOL RACK

🔧
🔨
🔦
```

Players can test:

* picking up a tool
* dropping it
* seeing it on the rack
* seeing another player's tool

The actual tool mechanics come later.

---

# 29. Slice 2 Test

Five clients should be able to:

* connect
* move between compartments
* see one another
* occupy stations
* see station occupancy
* manipulate the engine control
* move away
* have another player use it
* navigate rapidly without accidental transitions

Test especially:

### Control drag

Should **not** navigate.

### Short swipe

Should **not** navigate.

### Large swipe

Should navigate.

### Two simultaneous players

Should behave consistently.

---

# 30. Slice 3 — Miniature Playable Submarine

This is the first slice where we actually build a **game**.

Keep it extremely small.

The submarine only needs:

### Control Room

* Engine order
* Helm
* Depth

### Engineering

* Basic engine state

### Information

* Simplified sonar

### Torpedo Room

* One torpedo

### World

* One enemy

That's enough.

---

# 31. Minimal Simulation

The server should now simulate:

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

Start with intentionally simple physics.

Do **not** port the complicated 3D submarine physics from the existing project.

This browser game doesn't need realistic rigid-body simulation.

It needs:

> predictable, responsive, believable submarine behavior.

---

# 32. Server Simulation

Conceptually:

```text
every simulation tick:

    process_inputs()

    calculate_engine_output()

    calculate_turning()

    calculate_depth()

    update_position()

    update_torpedoes()

    update_enemy()

    generate_state()
```

This should happen exclusively on the server.

---

# 33. Simplified Submarine Physics

For the first slice:

### Speed

Engine order produces target speed.

```text
engine_order
    ↓
target_speed
    ↓
acceleration
    ↓
speed
```

### Heading

Rudder produces turning rate.

```text
rudder
    ↓
turn_rate
    ↓
heading
```

### Depth

Dive controls produce vertical movement.

```text
ballast + planes
       ↓
vertical_rate
       ↓
depth
```

Don't attempt a detailed hydrodynamic model yet.

---

# 34. Client Rendering

Clients receive:

```text
position
heading
depth
speed
```

and render the submarine UI accordingly.

The client should interpolate visual state.

For example:

```text
Server:
position = 100

Next:
position = 103

Client:
100 → smoothly → 103
```

This prevents network updates from appearing as discrete jumps.

---

# 35. Why Interpolation Matters

This directly addresses the stutter problem you've encountered in the larger project.

Don't make rendering depend on packets arriving at perfectly regular intervals.

The browser should maintain:

```text
previous authoritative state
current authoritative state
render time
```

and interpolate between them.

The server simulation can remain deterministic and authoritative while the client presentation remains smooth.

---

# 36. Simplified Enemy

Only one enemy is needed.

It can initially:

```text
enemy
 ↓
detect submarine
 ↓
approach
 ↓
attack
```

Don't build sophisticated AI yet.

The objective is to test the gameplay chain.

---

# 37. First Torpedo

One torpedo is enough.

Client sends:

```text
FIRE_TORPEDO
```

Server validates:

* tube available
* torpedo loaded
* firing conditions valid

Server creates torpedo.

All clients receive its state.

The torpedo moves according to server simulation.

---

# 38. First Combat Scenario

The entire Slice 3 game can be:

```text
START
 ↓
Cruise
 ↓
Find enemy
 ↓
Turn submarine
 ↓
Load/fire torpedo
 ↓
Enemy reacts
 ↓
Enemy attacks
 ↓
Submarine takes damage
 ↓
Survive / destroy enemy
```

There does not need to be a campaign.

There does not need to be progression.

There does not need to be weather.

There does not need to be procedural damage.

It is simply a **five-player submarine combat sandbox**.

---

# 39. Slice 3 Player Roles

Don't assign roles.

Instead, let the UI naturally create jobs.

Five players might spontaneously become:

```text
Player 1 → Helm
Player 2 → Depth
Player 3 → Sonar
Player 4 → Engineering
Player 5 → Torpedo
```

But they should be free to move.

That behavior is something we should test early.

---

# 40. Slice 3 Multiplayer Test

Have five people actually sit around the same table if possible.

Give them five devices.

Start the scenario.

Don't explain optimal roles.

Watch what they do.

The questions to answer are:

### Does everyone naturally find something to do?

### Do players communicate?

### Does someone become bored?

### Do players fight over stations?

### Is switching stations intuitive?

### Does the submarine feel like one shared machine?

### Does a player looking at one station understand enough to communicate with the others?

Those observations are arguably more valuable than benchmark numbers at this stage.

---

# 41. Performance Targets

Don't optimize prematurely, but establish targets.

For five players:

### Server

Target:

**60 Hz simulation if practical**

or reduce to **30 Hz** if the simulation doesn't benefit from 60.

### Browser

Target:

**60 FPS rendering**

on the intended low-end client hardware.

### Network

LAN latency should generally be low enough that interaction feels immediate.

More importantly:

> **No full-screen UI operation should block on network confirmation.**

---

# 42. State Replication Strategy

By Slice 3, begin separating state into categories.

### High-frequency

```text
position
heading
speed
depth
rudder
engine output
```

### Medium-frequency

```text
station occupancy
engine condition
battery
sonar contacts
```

### Event-based

```text
torpedo fired
torpedo hit
tool picked up
tool dropped
player entered compartment
damage occurred
message received
```

This will eventually reduce network traffic dramatically.

---

# 43. Don't Synchronize Visual Effects

The server should say:

```text
TORPEDO_HIT
```

It should not synchronize:

```text
spark_particle_17.x = ...
spark_particle_17.rotation = ...
```

Clients independently create:

* sparks
* sounds
* animations
* UI transitions
* screen shake
* bubbles

This keeps bandwidth and server complexity low.

---

# 44. IDs Everywhere

Start using stable IDs early.

Examples:

```text
player_3
station_navigation
tool_welder_02
torpedo_07
enemy_01
compartment_engineering
```

Don't rely on array indexes as identity.

This becomes very useful once objects can be created/destroyed/reordered.

---

# 45. Deterministic Randomness

Later damage, enemy AI, weather and events will require randomness.

Eventually the server should own the random number generation.

Clients should **never independently decide**:

> "I think that fuse blew."

The server decides.

Clients display the result.

---

# 46. What NOT to Build Yet

During Slices 0–3, explicitly avoid:

* procedural damage
* repair manual
* welding
* duct tape
* hammer repairs
* detailed electrical system
* realistic engine simulation
* advanced AI
* weather
* multiplayer matchmaking
* internet servers
* accounts
* persistence
* campaign progression
* detailed 3D periscope
* detailed weather deck
* sophisticated graphics
* dozens of stations

Those systems are valuable later.

Right now they are distractions from proving the foundation.

---

# 47. Recommended Project Structure

A starting structure could look roughly like:

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

The exact organization can change based on whether the browser client is implemented with Godot Web export or conventional HTML/JS, but the conceptual separation should remain.

---

# 48. One Important Architectural Decision

I would **not** make every station a Godot scene that contains its own networking logic.

Avoid:

```text
EngineStation
 ├── websocket
 ├── server state
 ├── player state
 └── simulation
```

Instead:

```text
Network
   ↓
Game State
   ↓
Station State
   ↓
UI
```

A station is fundamentally a **view and interaction surface over state**.

That makes it much easier later to create:

* damage
* multiple versions of stations
* shared controls
* accessibility modes
* touch + mouse
* mobile layouts
* AI crew
* spectator views

---

# 49. The Most Important Technical Principle

The entire project should revolve around this distinction:

### Intent

> "Player 3 wants to turn the engine order to HALF."

### Authority

> "The server accepts that action and changes the submarine state."

### State

> "Engine order is now HALF."

### Presentation

> "Move the lever, update the gauge, play the click."

That's the fundamental pattern.

Almost everything later fits into it.

Even repair:

```text
INTENT
Player uses wrench on bolt 17.

AUTHORITY
Server verifies player has wrench and bolt is interactable.

STATE
Bolt 17 changes from 63° → 42°.

PRESENTATION
Bolt rotates, wrench moves, click sounds, gauge improves.
```

And welding:

```text
INTENT
Player welds at position X,Y.

AUTHORITY
Server verifies leak + welder + player.

STATE
Leak coverage increases.

PRESENTATION
Sparks + weld animation + sound.
```

That means the complicated systems you're planning later aren't architectural exceptions. They're just increasingly interesting implementations of the same fundamental model.

---

# 50. Recommended Build Order

I would give Claude/Codex a very strict sequence:

```text
PHASE A
WebSocket server
        ↓
1 browser
        ↓
5 browsers
        ↓
connection robustness

PHASE B
Shared state
        ↓
one engine-order control
        ↓
server authority
        ↓
multi-client interaction
        ↓
occupancy

PHASE C
compartment data model
        ↓
three compartments
        ↓
global gesture system
        ↓
station interaction priority
        ↓
player avatars

PHASE D
basic submarine simulation
        ↓
movement
        ↓
heading
        ↓
depth
        ↓
engine
        ↓
sonar
        ↓
torpedo
        ↓
one enemy

PHASE E
five-person playtest
        ↓
measure what feels bad
        ↓
fix architecture/performance
        ↓
ONLY THEN expand
```

## The critical milestone

At the end of **Slice 3**, you should be able to hand five people five cheap devices and say:

> **"You are all inside the same submarine. Find the enemy and sink it."**

If that experience is already fun **before** damage, repair, radios, detailed maintenance, weather, etc., then we know we have the right foundation.

If it isn't fun, that's fantastic too — because we'll have discovered it after building a tiny prototype rather than after building 50 stations and a procedural repair system.

And from there, **Slice 4 (engine maintenance)** becomes the first test of whether the game's tactile "mundane tasks are fun" philosophy works on top of the multiplayer foundation.
