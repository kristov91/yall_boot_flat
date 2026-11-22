extends Node

const TICK_RATE := 60

@onready var network: NetworkServer = $NetworkServer
@onready var simulation: Simulation = $Simulation

func _ready() -> void:
	Engine.physics_ticks_per_second = TICK_RATE
	network.input_received.connect(_on_input_received)
	network.player_connected.connect(_on_player_connected)
	network.player_disconnected.connect(_on_player_disconnected)
	print("Server ready on port %d. Waiting for connections..." % network.port)

func _physics_process(_delta: float) -> void:
	network.poll()
	simulation.step()
	network.broadcast({
		"type": "state",
		"tick": simulation.tick,
		"data": simulation.get_state(),
	})

func _on_input_received(player_id: int, action: String, data: Dictionary) -> void:
	simulation.apply_input(player_id, action, data)

func _on_player_connected(player_id: int) -> void:
	simulation.add_player(player_id)
	var welcome := {
		"type": "welcome",
		"player_id": "player_%d" % player_id,
	}
	welcome.merge(simulation.get_world_info())
	network.send_to(player_id, welcome)

func _on_player_disconnected(player_id: int) -> void:
	simulation.remove_player(player_id)
