extends Node
class_name NetworkServer

## Raw WebSocket server: accepts plain WebSocket connections from any
## browser/JS client and speaks a small JSON envelope. Does not use Godot's
## high-level MultiplayerAPI, since clients are not Godot peers.

signal input_received(player_id: int, action: String, data: Dictionary)
signal player_connected(player_id: int)
signal player_disconnected(player_id: int)

@export var port: int = 9000

var _tcp_server := TCPServer.new()
var _pending_peers: Array[WebSocketPeer] = []
var _peers: Dictionary = {} # player_id: int -> WebSocketPeer
var _next_player_id: int = 1
## A stalled peer (a crashed/backgrounded tab, or a dropped connection that
## never got a clean close) stops draining its outbound queue, so every
## broadcast to it fails forever - without this, that's 60 failed sends/sec
## logged as ERR_OUT_OF_MEMORY, indefinitely. Counts consecutive failures per
## player so broadcast() can give up on one and close it after a few, instead
## of retrying forever.
var _consecutive_send_failures: Dictionary = {} # player_id: int -> int

func _ready() -> void:
	var err := _tcp_server.listen(port)
	if err != OK:
		push_error("NetworkServer: failed to listen on port %d (%s)" % [port, error_string(err)])
	else:
		print("NetworkServer: listening on port %d" % port)

func poll() -> void:
	_accept_new_connections()
	_poll_pending_peers()
	_poll_active_peers()

func send_to(player_id: int, message: Dictionary) -> void:
	if not _peers.has(player_id):
		return
	var ws: WebSocketPeer = _peers[player_id]
	ws.send_text(JSON.stringify(message))

const MAX_CONSECUTIVE_SEND_FAILURES := 5

func broadcast(message: Dictionary) -> void:
	var payload := JSON.stringify(message)
	for player_id: int in _peers.keys():
		var ws: WebSocketPeer = _peers[player_id]
		if ws.get_ready_state() != WebSocketPeer.STATE_OPEN:
			continue
		if ws.send_text(payload) == OK:
			_consecutive_send_failures.erase(player_id)
			continue
		# A handful of consecutive failures means this peer's outbound queue
		# is stuck full, not just momentarily busy - closing it lets
		# _poll_active_peers() clean it up the same way as any other
		# disconnect, instead of this same send failing (and logging) again
		# every physics tick forever.
		var failures: int = _consecutive_send_failures.get(player_id, 0) + 1
		_consecutive_send_failures[player_id] = failures
		if failures >= MAX_CONSECUTIVE_SEND_FAILURES:
			push_warning("NetworkServer: player_%d's outbound queue stayed full for %d consecutive broadcasts - closing it" % [player_id, failures])
			ws.close()
			_consecutive_send_failures.erase(player_id)

func player_ids() -> Array:
	return _peers.keys()

func _accept_new_connections() -> void:
	while _tcp_server.is_connection_available():
		var tcp := _tcp_server.take_connection()
		var ws := WebSocketPeer.new()
		ws.accept_stream(tcp)
		_pending_peers.append(ws)

func _poll_pending_peers() -> void:
	var still_pending: Array[WebSocketPeer] = []
	for ws in _pending_peers:
		ws.poll()
		var state := ws.get_ready_state()
		if state == WebSocketPeer.STATE_OPEN:
			var player_id := _next_player_id
			_next_player_id += 1
			_peers[player_id] = ws
			print("NetworkServer: player_%d connected" % player_id)
			player_connected.emit(player_id)
		elif state == WebSocketPeer.STATE_CLOSED:
			pass # handshake failed or connection dropped before opening
		else:
			still_pending.append(ws)
	_pending_peers = still_pending

func _poll_active_peers() -> void:
	var disconnected: Array[int] = []
	for player_id: int in _peers.keys():
		var ws: WebSocketPeer = _peers[player_id]
		ws.poll()
		if ws.get_ready_state() != WebSocketPeer.STATE_OPEN:
			disconnected.append(player_id)
			continue
		while ws.get_available_packet_count() > 0:
			_handle_packet(player_id, ws.get_packet())
	for player_id in disconnected:
		_peers.erase(player_id)
		_consecutive_send_failures.erase(player_id)
		print("NetworkServer: player_%d disconnected" % player_id)
		player_disconnected.emit(player_id)

func _handle_packet(player_id: int, packet: PackedByteArray) -> void:
	var json := JSON.new()
	if json.parse(packet.get_string_from_utf8()) != OK:
		push_warning("NetworkServer: malformed JSON from player_%d" % player_id)
		return
	var message = json.get_data()
	if typeof(message) != TYPE_DICTIONARY or message.get("type") != "input":
		return
	var action: String = message.get("action", "")
	var data: Dictionary = message.get("data", {})
	input_received.emit(player_id, action, data)
