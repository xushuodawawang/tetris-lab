"""Independent Python AI provider for the JavaScript game's WebSocket bridge.

Run: python ai/python_bot.py --url ws://127.0.0.1:5173/bot
Requires websocket-client (see requirements.txt). Only public state is used.
"""
import argparse
from collections import deque
import json
import time

import websocket

W, H, FULL = 10, 20, 1023
MATRICES = {
    "I": [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
    "O": [[1, 1], [1, 1]], "T": [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
    "S": [[0, 1, 1], [1, 1, 0], [0, 0, 0]], "Z": [[1, 1, 0], [0, 1, 1], [0, 0, 0]],
    "J": [[1, 0, 0], [1, 1, 1], [0, 0, 0]], "L": [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
}
WEIGHTS = {"height": -.51, "lines": .76, "holes": -1.8, "bumpiness": -.184, "maxHeight": -.1, "wells": -.05}
SHAPES = {}
for kind, initial in MATRICES.items():
    matrix = initial
    rotations = []
    for rotation in range(4):
        cells = [(x, y) for y, row in enumerate(matrix) for x, value in enumerate(row) if value]
        variants = {}
        for origin_x in range(-min(x for x, _ in cells), W - max(x for x, _ in cells)):
            masks = [0] * len(matrix)
            for x, y in cells:
                masks[y] |= 1 << (origin_x + x)
            variants[origin_x] = masks
        rotations.append((cells, variants))
        matrix = [list(row) for row in zip(*matrix[::-1])]
    SHAPES[kind] = rotations


def fits(rows, masks, y):
    return all(not mask or (y + dy < H and (y + dy < 0 or not rows[y + dy] & mask)) for dy, mask in enumerate(masks))


def features(rows):
    heights = [0] * W
    holes = seen = 0
    for y, row in enumerate(rows):
        fresh = row & ~seen
        for x in range(W):
            if fresh & (1 << x):
                heights[x] = H - y
        seen |= row
        holes += (seen & ~row & FULL).bit_count()
    wells = 0
    for x in range(W):
        depth = min(heights[x - 1] if x else H, heights[x + 1] if x < W - 1 else H) - heights[x]
        if depth > 0:
            wells += depth * (depth + 1) / 2
    return {"height": sum(heights), "holes": holes, "bumpiness": sum(abs(a - b) for a, b in zip(heights, heights[1:])), "maxHeight": max(heights), "wells": wells}


def placements(rows, kind, current=None):
    current = current or {"rotation": 0, "x": (W - len(MATRICES[kind])) // 2, "y": 0}
    y, rotation, x = current["y"], current["rotation"], current["x"]
    rotations = SHAPES[kind]
    first = rotations[rotation][1].get(x)
    if first is None or not fits(rows, first, y):
        return []
    queue = deque([(rotation, x, [])])
    visited = {(rotation, x)}
    landings = set()
    candidates = []
    while queue:
        rotation, x, actions = queue.popleft()
        cells, variants = rotations[rotation]
        masks = variants[x]
        landing_y = y
        while fits(rows, masks, landing_y + 1):
            landing_y += 1
        key = tuple(sorted((x + dx, landing_y + dy) for dx, dy in cells))
        if key not in landings and all(py >= 0 for _, py in key):
            landings.add(key)
            after = list(rows)
            for dy, mask in enumerate(masks):
                if mask:
                    after[landing_y + dy] |= mask
            remaining = [row for row in after if row != FULL]
            lines = H - len(remaining)
            after = [0] * lines + remaining
            candidates.append({"rows": after, "lines": lines, "actions": actions + ["drop"], "target": {"rotation": rotation, "x": x, "y": landing_y}})
        neighbors = []
        for dx, action in [(-1, "left"), (1, "right")]:
            next_masks = variants.get(x + dx)
            if next_masks is not None and fits(rows, next_masks, y):
                neighbors.append((rotation, x + dx, action))
        if kind != "O":
            next_rotation = (rotation + 1) % 4
            for dx in [0, -1, 1, -2, 2]:
                next_masks = rotations[next_rotation][1].get(x + dx)
                if next_masks is not None and fits(rows, next_masks, y):
                    neighbors.append((next_rotation, x + dx, "rotate"))
                    break
        for r, nx, action in neighbors:
            if (r, nx) not in visited:
                visited.add((r, nx))
                queue.append((r, nx, actions + [action]))
    return candidates


def choose(state, options):
    weights = {**WEIGHTS, **options.get("weights", {})}
    depth, beam = options.get("depth", 2), options.get("beam", 8)
    started = time.perf_counter()
    rows = [sum(1 << x for x, value in enumerate(row) if value) for row in state["board"]]
    evaluated = 0

    def ranked(board, kind, current=None):
        nonlocal evaluated
        candidates = placements(board, kind, current)
        for candidate in candidates:
            values = features(candidate["rows"])
            candidate["value"] = sum(weights[key] * value for key, value in values.items()) + weights["lines"] * candidate["lines"]
        evaluated += len(candidates)
        return sorted(candidates, key=lambda candidate: candidate["value"], reverse=True)

    def future(board, index, remaining):
        candidates = ranked(board, state["next"][index])
        if not candidates:
            return -1e6
        if remaining <= 1 or index + 1 >= len(state["next"]):
            return candidates[0]["value"]
        return max(weights["lines"] * c["lines"] + future(c["rows"], index + 1, remaining - 1) for c in candidates[:min(beam, 4)])

    candidates = ranked(rows, state["current"]["type"], state["current"])
    if not candidates:
        return None
    best, value = None, float("-inf")
    for candidate in candidates[:beam if depth > 1 else 1]:
        score = weights["lines"] * candidate["lines"] + future(candidate["rows"], 0, depth - 1) if depth > 1 and state["next"] else candidate["value"]
        if score > value:
            best, value = candidate, score
    return {"actions": best["actions"], "target": best["target"], "analysis": {"value": value, "depth": depth, "candidates": len(candidates), "evaluated": evaluated, "computeMs": (time.perf_counter() - started) * 1000, "features": features(best["rows"]), "policy": "python-linear-preview-v1"}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="ws://127.0.0.1:5173/bot")
    args = parser.parse_args()
    socket = websocket.create_connection(args.url, timeout=30, http_proxy_host=None)
    print("Python AI connected: " + args.url, flush=True)
    try:
        while True:
            data = socket.recv()
            if not data:
                break
            request = json.loads(data)
            if request.get("type") == "hello":
                continue
            if request.get("type") != "decide":
                continue
            response = {"protocolVersion": 1, "gameId": request["gameId"], "requestId": request["requestId"], "stateVersion": request["state"]["stateVersion"], "brokerId": request["brokerId"]}
            try:
                move = choose(request["state"], request.get("options", {}))
                response.update({"type": "action", **move} if move else {"type": "error", "code": "NO_MOVE", "message": "No legal move"})
            except Exception as error:
                response.update({"type": "error", "code": "SEARCH_ERROR", "message": str(error)})
            socket.send(json.dumps(response))
    except KeyboardInterrupt:
        pass
    finally:
        socket.close()


if __name__ == "__main__":
    main()
