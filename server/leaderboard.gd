extends RefCounted

## Top-N patrol scores, kept in a local JSON file on the server machine
## (user:// is Godot's per-user data folder, so it survives restarts and
## stays out of git). Only patrols that made it back to port are recorded -
## a sunk patrol banks nothing.

const DEFAULT_PATH := "user://leaderboard.json"

var path: String
var max_entries: int
var entries: Array = [] # each {id, name, score, cargo_sunk, destroyers_sunk, damage_penalty, duration_seconds, date}, best first
var next_id: int = 0

func _init(file_path: String = DEFAULT_PATH, size: int = 10) -> void:
	path = file_path
	max_entries = size
	load_file()

func load_file() -> void:
	entries = []
	next_id = 0
	if not FileAccess.file_exists(path):
		return
	var parsed = JSON.parse_string(FileAccess.get_file_as_string(path))
	if parsed is Dictionary:
		entries = parsed.get("entries", [])
		# JSON numbers come back as floats - put the whole-number fields
		# back to ints so ids/scores compare and display cleanly.
		for e in entries:
			for k in ["id", "score", "cargo_sunk", "destroyers_sunk"]:
				e[k] = int(e.get(k, 0))
		next_id = int(parsed.get("next_id", entries.size()))

func save_file() -> void:
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		push_error("Leaderboard: can't write %s" % path)
		return
	file.store_string(JSON.stringify({"next_id": next_id, "entries": entries}, "\t"))

## Adds a finished patrol and returns its id, or -1 if it didn't make the
## top max_entries. Ties go to the older entry.
func submit(entry: Dictionary) -> int:
	var id := next_id
	next_id += 1
	entry["id"] = id
	entries.append(entry)
	entries.sort_custom(func(a, b): return int(a.score) > int(b.score) or (int(a.score) == int(b.score) and int(a.id) < int(b.id)))
	if entries.size() > max_entries:
		entries.resize(max_entries)
	save_file()
	return id if entries.any(func(e): return int(e.id) == id) else -1

## Renames an existing entry (the crew-name field on the end screen).
func rename(id: int, new_name: String) -> void:
	for e in entries:
		if int(e.id) == id:
			e.name = new_name
			save_file()
			return

func rank_of(id: int) -> int:
	for i in entries.size():
		if int(entries[i].id) == id:
			return i
	return -1

func best_score() -> int:
	return int(entries[0].score) if entries.size() > 0 else 0
