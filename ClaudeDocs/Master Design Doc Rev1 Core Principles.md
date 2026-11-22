# Master Game Design Document

## Cooperative Submarine — Core Design Specification

**Purpose:** This document defines the core design of the game. It is the source of truth for the submarine's gameplay, player interaction, spatial structure, multiplayer behavior, damage/repair systems, and presentation philosophy.

It intentionally describes **what the game is and how it should behave**, not implementation details or editor tooling.

---

# 1. Game Concept

A cooperative submarine game for **five players sharing one submarine**.

The players operate the submarine together through a collection of physical-feeling workstations and submarine compartments. There are no fixed player classes or assigned jobs. Players naturally divide work and take whatever task needs attention.

The intended experience is:

> **Five people sitting around a table eating pizza while operating a submarine together.**

The game should alternate between:

**Routine → Information → Investigation → Action → Crisis → Recovery → Routine**

Most of the time the submarine should be busy but manageable. Combat and failures create moments of urgency, but the game should not feel like five people constantly fighting fires.

---

# 2. Core Design Principles

### Cooperative, not role-based

* All players are interchangeable.
* No permanent classes or jobs.
* Any player can use any station.
* Players decide for themselves what needs doing.
* Players naturally divide responsibilities.

### Chaotic but chill

* Failures create problems rather than instant game-ending disasters.
* There should be meaningful downtime.
* Players should have time to talk, joke, maintain equipment, and prepare.
* Combat can become chaotic without making the entire game permanently stressful.

### Tactile over abstract

Whenever possible, players should **physically manipulate something** rather than select an abstract command.

Examples:

* Turn a valve.
* Rotate a dial.
* Move a helm.
* Load a torpedo.
* Replace a fuse.
* Weld a leak.
* Tighten a bolt.
* Strike a bent linkage with a hammer.
* Drag duct tape over damage.
* Rotate a sonar tuning line.
* Manipulate a cipher.
* Move a flashlight around the compartment.

Avoid generic:

* "Repair" buttons
* Repair progress bars
* Yes/no repair dialogs
* Abstract repair abilities
* Menus where a physical interaction would make more sense

---

# 3. Platform and Presentation

The intended player client is a **browser running on a phone, tablet, laptop, or similar inexpensive device**.

One host machine runs the submarine simulation and server.

The client is primarily a **2D submarine interface**.

The major 3D exceptions are:

* **Periscope**
* **Weather deck / exterior**

The game should therefore feel like a physical submarine rather than a conventional videogame HUD.

The interface should represent the submarine's actual spaces, equipment, people, and problems.

---

# 4. Multiplayer Model

The server is authoritative.

```text
Player Input
     ↓
Server Simulation
     ↓
Authoritative State
     ↓
Clients
     ↓
Visual Presentation
```

Players send **intent/input**, not authoritative state.

The server owns:

* networking
* submarine state
* player state
* station occupancy
* simulation
* AI
* damage
* flooding
* weapons
* system condition
* rules

Clients own:

* interaction handling
* visual presentation
* UI
* animation
* sound
* local effects
* character presentation

Visual effects should not be networked when the underlying gameplay state/event is sufficient.

---

# 5. The Submarine Spatial Model

The submarine is a **physical spatial structure**, not a collection of unrelated screens.

Its hierarchy is:

```text
SUBMARINE
 ├── Compartments
 │    ├── Stations
 │    │    └── Physical objects / controls
 │    └── Physical objects
 └── Connections / transitions
```

There is an important distinction between a **compartment** and a **station**.

### Compartment

A **physical area of the submarine** and the player's current viewing location.

A compartment view lets the player look around that area of the submarine.

The player's avatar is normally standing in a representative position in the compartment. The player does **not** freely walk around inside it.

From the compartment view, the player can:

* look around
* see other players
* see stations
* see tools
* search for leaks
* inspect the environment
* select stations
* use appropriate tools

### Station

A **specific workstation inside a compartment**.

It answers:

> **What workstation is the player currently operating?**

Examples:

* Helm
* Dive controls
* Radio
* Sonar
* Diesel engine controls
* Fuse panel
* Navigation map

A station is not a player role and is not owned by a player.

---

# 6. Player Location and Station Occupancy

A player's state contains both:

```text
Compartment = where the player is
Station     = what the player is currently operating
```

For example:

```text
Player 3
Compartment: Engineering
Station: NONE
```

The player is looking around Engineering and their avatar is standing in the compartment.

When they select the Diesel Engine station:

```text
Player 3
Compartment: Engineering
Station: Diesel Engine
```

The **station UI opens**, and the player's avatar **teleports to the physical location of that station** in the compartment presentation.

The avatar then remains there in an appropriate idle/working animation so other players can see that:

* the player is there
* the station is occupied
* someone is currently operating it

This is a visual representation of station occupancy, not free physical movement.

The normal interaction flow is:

```text
COMPARTMENT VIEW
      ↓
Tap / click station
      ↓
Station becomes occupied
      ↓
Avatar appears at station
      ↓
Station UI opens
      ↓
Player operates station
      ↓
Leave station
      ↓
Return to compartment view
```

**Station occupancy is temporary, not ownership.**

Normally only one player occupies a station at a time.

**Exception:** the Navigation Map supports multiple players simultaneously.

---

# 7. Compartment View vs Station View

These are different presentation scopes.

### Compartment View

The player is looking at a physical area of the submarine.

The avatar is represented in the compartment.

Used for:

* looking around
* seeing other players
* finding leaks
* finding tools
* seeing machinery
* seeing stations
* selecting a station
* using tools such as the welder
* inspecting the physical environment

The player does **not** freely walk around the room.

### Station View

The player has selected a specific workstation.

The station UI opens and the avatar is visually positioned at that workstation for everyone else to see.

Used for:

* controls
* gauges
* machinery
* detailed maintenance
* opening panels
* operating equipment
* manipulating components

The station UI is therefore **a detailed interaction with something physically located inside the compartment**, not an unrelated menu screen.

---

# 8. Tools and Compartment Interaction

Tools are an important exception to the station-based interaction model.

A player can remain in the compartment view and select a tool such as:

* welding torch
* hammer
* duct tape
* screwdriver
* flashlight

The player's avatar then visually represents the tool activity at the appropriate location.

For example:

```text
Compartment View
      ↓
Player selects welder
      ↓
Welder becomes active
      ↓
Player searches/looks around compartment
      ↓
Player uses welder on visible leak
```

The player is not physically walking their avatar around the room. The interaction represents the player's attention and activity within that compartment.

---

# 9. Submarine Layout

The normal submarine flow is:

```text
FORWARD TORPEDO
       ↓
INFORMATION
       ↓
CONTROL ROOM
       ↓
ENGINEERING
       ↓
AFT TORPEDO
```

The **Attack Room / Conning Tower** is a vertical branch above the Control Room.

```text
                 WEATHER DECK
                      ↑
                    Ladder
                      │
               ┌─────────────┐
               │ ATTACK ROOM │
               │             │
               │ TDC         │
               │ Periscope   │
               └──────┬──────┘
                      │
                      ↓
                 CONTROL ROOM
```

The Weather Deck is accessible only while surfaced.

The Periscope can be accessed from:

* the Attack Room
* a pull-down handle at the top of the Navigation station

---

# 10. Core Compartments and Stations

## Forward Torpedo Room

Contains:

* four forward torpedo tubes
* torpedo storage/racks
* loading equipment
* torpedo controls

Players physically handle torpedoes and loading operations.

---

## Information Compartment

Contains:

### Radio

Receives:

* friendly communications
* enemy communications
* warnings
* approximate headings
* zones
* convoy information
* danger areas

Enemy transmissions may require a simple cipher interaction.

Radio information should lead to other gameplay rather than simply displaying an objective.

Example:

```text
Radio clue
   ↓
Navigation Map
   ↓
Sonar
   ↓
TDC
   ↓
Attack / Avoid
```

### Sonar

Uses a hydrophone-style interface.

Contacts are represented through:

* expanding circles
* audio
* propeller rhythm
* directional tuning

The player rotates a tuning line through 360°.

When aligned with a contact's bearing, the player receives stronger auditory information.

Sonar should encourage **recognition and intuition**, rather than simply displaying exact enemy locations.

---

# 11. Control Room

Contains:

### Navigation

* course information
* engine-order telegraph
* navigation map
* map drawing tools
* periscope shortcut

### Helm

* steering
* rudder control

### Dive

* ballast controls
* bow planes
* stern planes
* dive/blow controls
* depth management

### Navigation Map

The map is a special collaborative station.

Players can:

* draw freely
* draw lines
* draw circles
* measure
* use a compass
* mark locations
* use colored laser pointers

Multiple players can work on the map simultaneously.

The map is intentionally an exception to the normal one-player-per-station rule.

---

# 12. Attack Room / Conning Tower

Contains:

* Torpedo Data Computer / fire control
* Periscope
* ladder to weather deck

This is the submarine's attack/navigation observation area.

The Periscope transitions into a 3D presentation.

The TDC should eventually connect information gathered from:

* navigation
* radio
* sonar
* periscope

rather than functioning as an isolated weapon menu.

---

# 13. Engineering

Contains:

### Diesel Engines

Important information includes:

* RPM
* temperature
* oil pressure
* fuel
* efficiency
* condition

Engine components can gradually drift out of adjustment.

Normal maintenance causes only mild degradation.

Poor alignment reduces:

* speed
* fuel efficiency
* performance

It should never normally become a catastrophic failure simply because players neglected routine tuning.

### Electric Motors

Controls/information include:

* motor output
* battery state
* electrical load
* motor condition

### Fuse Panel

Players physically replace blown fuses.

### Tool Rack

Shared physical tools are stored here and elsewhere throughout the submarine.

---

# 14. Aft Torpedo Room

Contains:

* aft torpedo tube
* torpedo storage/loading
* auxiliary supplies

The aft tube provides a different tactical option from the forward tubes.

---

# 15. Player Presence

Players should visibly exist inside the submarine.

The avatar communicates:

* who is in each compartment
* who is using a station
* where someone is working
* which stations are occupied
* who is dealing with a problem

When no station is selected, the avatar remains in the compartment's representative position.

When a station is selected, the avatar moves/teleports to that station's physical location and remains visible there in an idle/working animation.

This allows players to understand the state of the crew without requiring a separate player list to explain everything.

---

# 16. Interaction and Gesture System

The player normally interacts through two broad types of action:

### Local interaction

Manipulates something at the current location.

Examples:

* welding
* flashlight
* turning a control
* opening a panel
* operating a station
* using a tool

### Compartment navigation

Changes the player's viewed compartment.

This is performed through a **large swipe**.

There is no general free walking system.

Global priority:

```text
Pointer Down
     ↓
Inside interactive object?
     ↓ YES
Object captures interaction
     ↓ NO
Large enough swipe?
     ↓ YES
Change compartment view
     ↓ NO
Nothing
```

Direct interaction always takes priority over compartment navigation.

---

# 17. Damage Philosophy

Damage should create **problems to solve**, not simply turn systems off.

Station/system condition generally moves through states such as:

```text
100 → 80 → 60 → 40 → 20%
```

As condition decreases:

* controls become sluggish
* machinery becomes inefficient
* gauges become less reliable
* interactions become more difficult
* performance degrades

The system should generally remain usable.

---

# 18. Damage Has Multiple Spatial Scales

### Compartment-level damage

Examples:

* leaks
* flooding
* environmental effects
* objects damaged in the room

Leaks are physically located throughout compartments.

Players must **look around the compartment to find them**.

### Station/component-level damage

Examples:

* loose bolt
* damaged wire
* broken linkage
* pipe failure
* misalignment
* damaged insulation
* blown fuse

These are discovered through station interaction and inspection.

---

# 19. Flooding

Leaks cause flooding.

All players should see a consistent global flooding state regardless of what interface they are viewing.

Flooding presentation includes:

* rising water
* wavy waterline
* bubbles
* increasing visual obstruction

Water continues rising while leaks remain.

If flooding reaches the top:

**The submarine sinks / game over.**

---

# 20. Repair Philosophy

Repair follows:

```text
Something behaves strangely
        ↓
Investigate
        ↓
Inspect
        ↓
Open / expose component
        ↓
Consult manual
        ↓
Identify actual problem
        ↓
Select correct tool
        ↓
Physically repair
        ↓
Test
        ↓
System returns to normal
```

Repair should require understanding the problem.

The game should not ask:

> "Repair damaged engine?"

Instead it should communicate enough physical evidence for the player to determine what is wrong.

---

# 21. Maintenance Manual

The manual is the **ground truth** for repairs.

It contains:

* error codes
* symptoms
* normal gauge ranges
* troubleshooting procedures
* wiring diagrams
* pipe diagrams
* component diagrams
* correct screw/bolt positions
* fuse layouts
* normal configurations

The manual explains **what correct looks like**.

---

# 22. Physical Repair

Panels can be opened using a screwdriver.

Example:

```text
Tap panel
 ↓
Four corner screws exposed
 ↓
Unscrew each
 ↓
Panel opens
 ↓
Wires / pipes / bolts / linkages visible
```

Example:

```text
Manual:
Green wire → Terminal 3

Panel:
Green wire → Terminal 5

Problem identified.
```

Another:

```text
Correct bolt position: 42°
Actual position: 63°

Use wrench.
```

Repairs should produce obvious feedback:

* gauge normalizes
* sound changes
* warning disappears
* efficiency improves
* component visually returns to correct state

---

# 23. Failure Types

Reusable physical failure families include:

| Failure                     | Symptoms                  | Tool          |
| --------------------------- | ------------------------- | ------------- |
| Loose bolt                  | wobble/rattle             | Wrench        |
| Cracked pipe                | hiss/steam/fluid          | Welder        |
| Bent linkage                | crooked/catching/clunk    | Hammer        |
| Damaged insulation          | exposed/frayed            | Duct tape     |
| Loose electrical connection | flicker/arc/intermittent  | Screwdriver   |
| Misalignment                | reference marks disagree  | Wrench        |
| Detached component          | visibly separated         | Wrench/Welder |
| Small fluid leak            | visible leak              | Tape/Welder   |
| Blown fuse                  | dead/intermittent circuit | Spare fuse    |

Wrong tools should generally produce **no meaningful result**, not arbitrary punishment.

---

# 24. Randomized Damage

Damage should be unpredictable in **what physically failed**, but predictable in how the failure behaves.

The player should learn:

> "This symptom means I need to investigate this kind of component."

rather than:

> "The game randomly selected a repair minigame."

A torpedo hit may create several related failures.

Gauges, sounds, visual clues, and physical symptoms should help diagnose the damage.

---

# 25. Emergency Repairs

Emergency repairs are intentionally weaker than proper repairs.

### Duct Tape

* immediately restores a damaged station to approximately 60%
* lasts approximately 60 seconds
* underlying damage remains
* can be reapplied

### Hammer

* may restore approximately 1–10% condition
* successful improvement persists until another damaging event

### Proper repair

* requires diagnosis
* physically fixes the underlying problem
* permanently restores the component/station to 100%

This creates a useful choice:

> Patch it now and keep fighting, or spend time fixing it properly?

---

# 26. Tools

Tools are physical objects in the submarine.

Personal toolbelt/hotbar can contain:

* flashlight
* welding torch
* hammer
* duct tape
* screwdriver
* wrench
* spare fuses
* future specialized tools

There are also shared tool racks.

Tools have physical location/state:

```text
On rack
Held by Player 2
Dropped in Engineering
Being used
```

Limited tool availability is intentional.

Players should remember:

> "The other welder is still in the aft room."

---

# 27. Flashlight

Each player has their own flashlight.

It:

* can be activated from the toolbelt
* appears centered around the player
* illuminates part of the visible area
* can be dragged/aimed
* is visually represented

It is especially useful for:

* searching for leaks
* inspecting dark areas
* examining damage
* finding tools
* looking inside opened panels

---

# 28. Tactile Interaction Philosophy

The game should make routine physical actions satisfying.

Examples:

**Welding**

* drag torch across leak

**Engine tuning**

* tap bolt
* wrench appears
* extend wrench
* rotate around pivot
* physical feedback indicates adjustment

**Fuse**

* pull old fuse
* insert replacement

**Hammer**

* physically strike component

**Duct tape**

* drag tape across damaged area

**Valve**

* rotate

**Dial**

* rotate

**Torpedo**

* physically manipulate/loading sequence

**Radio**

* manipulate cipher

**Sonar**

* rotate tuning line

**Flashlight**

* drag to aim

---

# 29. Systems Should Interconnect

Systems should rarely exist as isolated minigames.

Information and actions should feed into one another.

For example:

```text
Radio
 ↓
Enemy convoy clue
 ↓
Navigation Map
 ↓
Course planning
 ↓
Sonar
 ↓
Bearing confirmation
 ↓
TDC
 ↓
Periscope
 ↓
Torpedo attack
```

Likewise:

```text
Torpedo hit
 ↓
Damage
 ↓
Symptoms
 ↓
Investigation
 ↓
Manual
 ↓
Repair
 ↓
Improved submarine performance
```

The submarine should feel like **one interconnected machine**.

---

# 30. Information and Communication

The game should require players to turn incomplete information into decisions.

Information sources include:

* Radio
* Sonar
* Navigation
* Periscope
* Gauges
* Engine sounds
* Physical symptoms
* Manuals
* Other players

Information should often be:

* incomplete
* indirect
* delayed
* approximate

This encourages players to communicate rather than simply following objective markers.

---

# 31. Core Gameplay Loop

```text
TRAVEL
  ↓
OBSERVE / LISTEN
  ↓
GATHER INFORMATION
  ↓
INTERPRET
  ↓
NAVIGATE / PREPARE
  ↓
ENGAGE OR AVOID
  ↓
TAKE DAMAGE / CREATE PROBLEMS
  ↓
INVESTIGATE
  ↓
REPAIR
  ↓
MAINTAIN / PREPARE
  ↓
TRAVEL
```

The game should naturally create periods where players are:

* maintaining equipment
* tuning engines
* drawing maps
* listening to radio
* monitoring sonar
* inspecting compartments
* talking

before the next major event.

---

# 32. Combat

Combat should emerge from the submarine systems rather than being a separate combat mode.

Players may need to:

* identify targets
* locate them
* determine bearing
* estimate movement
* maneuver
* prepare torpedoes
* use the TDC
* use the periscope
* fire
* evade detection
* deal with resulting damage

Enemy behavior should support the game's cooperative pacing.

Conceptually:

* **Cargo ships are prey** — they flee.
* **Warships are guard dogs** — they patrol, detect, pursue, and attack.
* Warships have stronger detection behavior.
* Risk depends on factors such as depth, periscope use, and whether the submarine is surfaced.

---

# 33. Periscope and Weather Deck

The submarine interior is primarily 2D.

The Periscope and Weather Deck are intentional transitions into 3D.

They should feel like physically leaving the normal interface rather than simply opening another menu.

### Periscope

Used for:

* visual observation
* target identification
* attack preparation
* navigation

### Weather Deck

Accessible while surfaced.

Used for:

* exterior observation
* atmosphere/weather
* deck equipment
* visual encounters with distant ships

The ocean should be one of the game's strongest visual elements.

---

# 34. Water and Weather

Water should have:

* large-scale waves
* shared movement across clients
* weather-dependent turbulence
* visually strong surface motion

The submarine itself should remain controllable and believable rather than constantly behaving like a physics toy.

---

# 35. Global Effects

Some states affect the entire submarine and therefore every player's presentation.

Examples:

### Flooding

Every player sees the same general flooding progression.

### Blackout

If implemented, the submarine's lighting/presentation changes globally.

### Major damage

Players should see/hear appropriate consequences even when viewing different stations.

### Weather

Exterior presentation changes consistently for everyone.

The underlying state is authoritative; each client presents that state locally.

---

# 36. Continuous Interior View — Optional Wishlist

The game may eventually experiment with a continuous horizontal interior instead of discrete compartment views.

In this version, the player's avatar could move side-to-side through the continuous interior.

This is **not part of the core movement model** and is only a future presentation experiment.

The underlying spatial model remains:

```text
Submarine
 → Compartments
 → Connections
 → Stations
 → Objects
```

If the continuous presentation performs poorly, it can be abandoned without changing the underlying game design.

---

# 37. Performance Philosophy

The game is intended to run on inexpensive client devices.

Therefore:

* gameplay simulation should remain lightweight
* most client visuals should be inexpensive
* static backgrounds are preferred where appropriate
* dynamic elements should be limited to meaningful things
* ambient animations can update at lower frequencies
* gameplay does not need to run at rendering framerate
* visual effects should not be treated as network state

The goal is not maximum visual complexity.

The goal is:

> **Spend computation on things players can actually perceive or interact with.**

---

# 38. Desired Player Experience

The finished game should make players feel like they are **inside one shared machine**.

A good moment might look like:

> One player is steering.
> Another is plotting a course.
> Someone is listening to sonar.
> Someone else is tuning an engine.
> A leak appears somewhere aft.
> The player looking around that compartment spots it, grabs a welder, and starts working.
> Someone calls out a bearing.
> Everyone prepares for an attack.
> Torpedoes fire.
> The submarine takes a hit.
> The crew spends several minutes repairing things while talking about what happened.
> Eventually everything is back under control.

Then the submarine settles back into routine.

That rhythm—not constant combat, constant minigames, or constant crisis—is the core experience.

---

# 39. Non-Negotiable Design Rules

1. **Five players share one submarine.**
2. **No fixed player roles.**
3. **Any player can use any station.**
4. **A compartment is a physical area and viewing context, not a walkable space.**
5. **Players normally look around a compartment rather than physically walking through it.**
6. **A station is a workstation physically located inside a compartment.**
7. **Compartment and station are separate player states.**
8. **Selecting a station opens its UI and visually places/teleports the player's avatar to that station.**
9. **Other players can see station occupancy through the avatar's position and animation.**
10. **Station occupancy is temporary, not ownership.**
11. **Most stations allow one player; Navigation Map allows multiple.**
12. **Large swipes change compartment view; they do not represent ordinary walking.**
13. **Direct interaction always takes priority over compartment navigation.**
14. **Tools can be used from the compartment context without requiring a station.**
15. **The submarine is a physical spatial structure, not a collection of unrelated screens.**
16. **Direct manipulation should replace abstract interaction whenever practical.**
17. **Damage should create problems to diagnose, not simply disable systems.**
18. **Repair should require investigation and physical action.**
19. **The manual defines what correct looks like.**
20. **Tools and equipment have physical presence and location.**
21. **Systems should interact with one another.**
22. **Information should often be incomplete enough to require cooperation.**
23. **The game should alternate between routine and crisis.**
24. **Failures should create stories rather than arbitrary punishment.**
25. **The server owns gameplay truth.**
26. **Clients present that truth rather than inventing it.**
27. **2D is the normal submarine presentation; 3D is primarily for periscope/exterior.**
28. **Global physical events should be reflected consistently for all players.**
29. **The game should feel like five people operating one machine, not five people playing five separate minigames.**
30. **New systems should reinforce the submarine fantasy rather than introducing generic videogame abstractions.**

---

# Core Mental Model

The entire game can be understood as:

```text
                    ONE SUBMARINE
                         │
          ┌──────────────┴──────────────┐
          │                             │
    Physical Space                 Simulation
          │                             │
     Compartments                    Systems
          │                             │
       Stations                 Damage / AI / etc.
          │
        Objects
          │
    Player Attention
          │
     Direct Action
          │
     Cooperation
```

And from the player's perspective:

```text
WHERE AM I LOOKING?
       ↓
WHAT IS AROUND ME?
       ↓
WHAT NEEDS ATTENTION?
       ↓
DO I NEED A STATION OR A TOOL?
       ↓
WHAT IS ACTUALLY WRONG?
       ↓
WHAT SHOULD I DO?
       ↓
PHYSICALLY DO IT
       ↓
DID IT WORK?
       ↓
GET BACK TO RUNNING THE SUBMARINE
```

**The important distinction is that players are not little characters freely walking around a 2D room. They are players looking into a physical compartment, selecting physical workstations or using tools, while their avatar visually communicates where their attention/work is happening.**
