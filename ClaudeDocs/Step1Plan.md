Start **as small as physically possible**. For Slice 0, don't build the submarine, compartments, stations, UI framework, or physics yet.

The only goal is:

> **One Godot server ↔ one browser client, with the server owning a tiny piece of state. Then scale that to 5 browsers.**

### Step 1 — Make a clean project

I'd make this a **separate Godot project** from your existing submarine game.

Something like:

```text
submarine-multiplayer/
├── project.godot
├── server/
├── shared/
└── client/
```

For Slice 0, however, you only need:

```text
server/
    main.gd
    network_server.gd
    simulation.gd

client/
    index.html
    client.js
    style.css
```

The browser client should be plain **HTML/JavaScript initially**.

That lets us prove the actual architecture before introducing Godot UI complexity.

---

# Step 2 — Build the Godot WebSocket server

Create a Godot project and make the first scene essentially:

```text
Main
└── NetworkServer
```

The server should:

1. Listen on a LAN port, e.g. `9000`
2. Accept WebSocket connections
3. Give each connection a unique player ID
4. Maintain a tiny shared game state

For example:

```gdscript
var game_state = {
    "tick": 0,
    "engine_order": 0.0,
    "depth": 0.0,
    "speed": 0.0
}
```

Nothing submarine-specific needs to exist yet.

---

# Step 3 — Make the server tick

Have the server run a fixed simulation loop.

Something like:

```text
60 times/sec

tick
 ↓
process inputs
 ↓
update simulation
 ↓
increment tick
```

Initially the simulation can literally do:

```text
speed += (engine_order - speed) * 0.01
depth += 0
```

The point isn't realism.

The point is proving:

> **There is one authoritative state that exists independently of every client.**

---

# Step 4 — Make the browser client

Make an extremely ugly webpage.

Seriously.

Something like:

```text
SUBMARINE TEST

Connection: CONNECTED
Player ID: player_2

Server Tick: 1842

Engine Order: 0.50
Speed: 3.72
Depth: 14.20

[ ENGINE + ]
[ ENGINE - ]
```

Don't spend time making it pretty.

The client connects to:

```text
ws://LAPTOP-IP:9000
```

and displays whatever the server sends.

---

# Step 5 — Establish the protocol

This is the important part.

Don't have the browser send:

```json
{
    "mouse_x": 381,
    "mouse_y": 492
}
```

Instead, send **intent**:

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

Server receives it:

```text
CLIENT
  │
  │ SET_ENGINE_ORDER 0.5
  ▼
SERVER
  │
  │ validate
  │
  │ game_state.engine_order = 0.5
  ▼
STATE
```

Then the server broadcasts:

```json
{
    "type": "state",
    "tick": 1842,
    "data": {
        "engine_order": 0.5,
        "speed": 3.72,
        "depth": 14.2
    }
}
```

Every connected browser receives that same state.

---

# Step 6 — Test with two browsers

This is your first real milestone.

Open:

```text
Browser A
Browser B
```

Both connect to the same laptop.

You should see:

```text
A:
Player ID: player_1
Engine: 0.0
Speed: 0.0

B:
Player ID: player_2
Engine: 0.0
Speed: 0.0
```

Then press:

**ENGINE + on A**

A changes.

But more importantly:

**B changes too.**

That proves you have:

```text
       ┌─────────────┐
       │    SERVER   │
       │             │
       │ Engine = .5 │
       └──────┬──────┘
              │
        ┌─────┴─────┐
        ▼           ▼
     Browser A   Browser B
```

---

# Step 7 — Test five clients

Don't build anything else yet.

Open five browser windows/devices:

```text
                 SERVER
              player state
                   │
       ┌───────────┼───────────┐
       ▼           ▼           ▼
    Client 1    Client 2    Client 3
       │
       ├──────── Client 4
       │
       └──────── Client 5
```

Each should get:

```text
player_1
player_2
player_3
player_4
player_5
```

and all should see identical:

```text
server tick
engine order
speed
depth
```

---

# Step 8 — Test the things that will actually matter later

Once five clients work, deliberately break things.

### Disconnect

Kill Client 3.

Server should notice:

```text
player_3 disconnected
```

without affecting the other four.

### Reconnect

Reconnect it.

It should receive a new/current state.

### Simultaneous input

Have:

```text
Player 1 → Engine 0.2
Player 2 → Engine 0.8
```

at nearly the same time.

The **server** decides which state wins based on received/processed inputs.

The clients don't decide.

### Rapid input

Drag/click engine control rapidly.

Make sure the server doesn't explode from hundreds/thousands of messages.

### LAN

Don't test only:

```text
localhost
```

Test:

```text
Laptop server
    ↓ Wi-Fi
phone/tablet/laptop
```

That's the actual architecture you're trying to prove.

---

# The first thing I'd actually do with Claude

Before asking Claude to build anything substantial, give it a very constrained task:

> **Create Slice 0 of the submarine multiplayer project.**
>
> Build a minimal Godot 4.7 server that accepts WebSocket connections from plain HTML/JavaScript browser clients over LAN.
>
> Do not implement the submarine, physics, compartments, stations, gameplay, graphics, or authentication.
>
> The server must:
>
> * listen on a configurable port
> * assign each connection a unique player ID
> * maintain authoritative state containing `tick`, `engine_order`, `speed`, and `depth`
> * run a fixed simulation tick
> * accept semantic input messages
> * support `SET_ENGINE_ORDER`
> * broadcast authoritative state to all connected clients
> * handle disconnects cleanly
>
> Create a minimal browser client that:
>
> * connects by WebSocket
> * displays connection status
> * displays player ID
> * displays server tick
> * displays engine order, speed, and depth
> * has simple controls for changing engine order
> * updates entirely from authoritative server state
>
> Use JSON messages with a consistent envelope.
>
> Keep the implementation intentionally small and easy to inspect.
>
> Do not add frameworks or abstractions that aren't necessary for Slice 0.
>
> After implementation, explain exactly how to run the Godot server and connect five browser clients over LAN.

**And I would make Claude stop there.**

Don't let it immediately "prepare the architecture for all future systems." That's how Slice 0 turns into 3,000 lines of framework code.

The success criterion is brutally simple:

> **Five browser windows on five devices connect to one laptop, each gets a unique ID, one player changes engine order, and all five see the same authoritative state.**

Once that works reliably, **then** we move to Slice 1 and make the engine-order control actually feel good.
