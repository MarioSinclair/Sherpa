import math
import os
import time

import networkx as nx
import osmnx as ox
import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_from_directory
from pyproj import Transformer
from shapely.geometry import LineString, Point

import buses
import assistant
from data.download import BLOCKED, building_names, load_layers, mapping

load_dotenv()   # API keys from .env when running locally
if not os.environ.get(assistant.key_name()):
    print(f"WARNING: {assistant.key_name()} isn't set, so AI search is off (building search still works)", flush=True)
SUPABASE_URL = os.environ.get("SUPABASE_URL")   # unset = no sign-in (local testing)
SUPABASE_KEY = os.environ.get("SUPABASE_KEY")   # the publishable key: safe to hand to the browser
app = Flask(__name__, static_folder=".", static_url_path="")

print("Building scored walking graph (first run downloads OSM data)...")
layers = load_layers()
G = mapping(layers["lights"], layers["sidewalks"], layers["callboxes"])
callboxes = layers["callboxes"].to_crs(G.graph["crs"])
to_graph = Transformer.from_crs("EPSG:4326", G.graph["crs"], always_xy=True)
to_wgs84 = Transformer.from_crs(G.graph["crs"], "EPSG:4326", always_xy=True)
print(G.number_of_edges(), "edges ready")
buildings = building_names(layers["ada_entrances"])   # for the AI; the browser builds the same list for search
edge_lines = ox.graph_to_gdfs(G, nodes=False)[["geometry"]]   # for finding the paths near reported spots
edge_lines.sindex   # build the spatial index now, not on the first request


bus_routes = buses.Routes(to_graph, to_wgs84)
stop_nodes = {}         # route id → walking-graph node for each stop


MAX_SNAP_M = 300        # refuse start/end points farther than this from any walkable path
CALLBOX_ALONG_M = 40    # call boxes this close to the route count as "along" it

# ---- Bus alternative ----
WALK_SPEED = 1.34       # m/s (3 mph)
ACCESSIBLE_SPEED = 1.12 # m/s (2.5 mph), in accessible mode
MIN_TRIP_M = 500       # don't suggest a bus for walks shorter than this
MAX_STOP_WALK_M = 600   # walk at most this far to or from a stop
STOP_SNAP_M = 50        # stops farther than this from any path (e.g. off campus) can't be walked to
CATCH_BUFFER_S = 60     # reach the stop at least a minute before the bus
MAX_RIDE_S = 30 * 60
BUS_WALK_SHARE = 0.6    # only offer the bus if it cuts walking to 60% or less


# ---- Crowd reports: confirmed blocked paths and safety concerns are routed around ----
AVOID_MAX = 20          # at most this many reported spots per request
AVOID_RADIUS_MAX_M = 100


def parse_avoid(text):
    """Edges near the reported spots in "lat,lng,radius_m;..." (the browser decides which reports count)."""
    avoid = set()
    for part in (text or "").split(";")[:AVOID_MAX]:
        try:
            lat, lng, radius = map(float, part.split(","))
        except ValueError:
            continue
        x, y = to_graph.transform(lng, lat)
        near = edge_lines.sindex.query(Point(x, y).buffer(min(radius, AVOID_RADIUS_MAX_M)), predicate="intersects")
        avoid.update(edge_lines.index[near])
    return frozenset(avoid)


def cost(weight, avoid):
    """Routing cost: the usual edge weight, made BLOCKED times higher near reported spots."""
    if not avoid:
        return weight
    return lambda u, v, edges: min(d[weight] * (BLOCKED if (u, v, k) in avoid else 1) for k, d in edges.items())


def parse_point(text):
    lat, lng = map(float, text.split(","))
    return to_graph.transform(lng, lat)          # (x, y) in the graph's projected CRS


def oriented_coords(edges):
    """Each route edge's (x, y) coords in the projected CRS, pointing in the direction walked."""
    out = []
    for (u, _, _), geom in zip(edges.index, edges.geometry):
        coords = list(geom.coords)
        ux, uy = G.nodes[u]["x"], G.nodes[u]["y"]
        if math.dist(coords[-1], (ux, uy)) < math.dist(coords[0], (ux, uy)):   # stored backwards
            coords.reverse()
        out.append(coords)
    return out


def to_latlng(xy):
    lng, lat = to_wgs84.transform(*xy)
    return [lat, lng]


def route_line(coords):
    """Join the route's edges into one ordered [[lat, lng], ...] list for the browser."""
    line = [to_latlng(coords[0][0])]
    for edge in coords:
        line += [to_latlng(p) for p in edge[1:]]
    return line


# ---- Turn-by-turn ----
COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
MERGE_WITHIN_M = 12    # turns this close together (e.g. across a crosswalk) become one step


def bearing(p, q):
    return math.degrees(math.atan2(q[0] - p[0], q[1] - p[1])) % 360


ABBREVIATIONS = {"Street": "St", "Avenue": "Ave", "Drive": "Dr", "Road": "Rd", "Boulevard": "Blvd",
                 "Northwest": "NW", "Northeast": "NE", "Southwest": "SW", "Southeast": "SE"}


def street_name(name):
    if isinstance(name, list):
        name = name[0]
    if not isinstance(name, str):
        return None
    return " ".join(ABBREVIATIONS.get(word, word) for word in name.split())


def classify(turn):
    """Signed turn angle (+ = right) → modifier like 'left', 'slight right', 'straight'."""
    a, side = abs(turn), ("right" if turn > 0 else "left")
    if a < 30:
        return "straight"
    if a < 60:
        return f"slight {side}"
    if a < 140:
        return side
    return f"sharp {side}"


def instruction(modifier, name):
    onto = f" onto {name}" if name else ""
    if modifier == "straight":
        return f"Continue{onto}"
    if modifier.startswith("slight"):
        return f"Bear {modifier.split()[1]}{onto}"
    if modifier.startswith("sharp"):
        return f"Sharp {modifier.split()[1]}{onto}"
    return f"Turn {modifier}{onto}"


def route_steps(edges, coords):
    names = [street_name(n) for n in edges.get("name", [None] * len(edges))]
    lengths = list(edges["length"])

    b0 = bearing(coords[0][0], coords[0][1])
    head = f"Head {COMPASS[round(b0 / 45) % 8]}" + (f" on {names[0]}" if names[0] else "")
    steps = [{"type": "depart", "modifier": "straight", "instruction": head,
              "along": 0, "point": to_latlng(coords[0][0])}]

    along = 0
    for i in range(1, len(coords)):
        along += lengths[i - 1]
        b_in = bearing(coords[i - 1][-2], coords[i - 1][-1])
        b_out = bearing(coords[i][0], coords[i][1])

        prev = steps[-1]
        if prev["type"] == "turn" and along - prev["along"] < MERGE_WITHIN_M:
            # fold into the previous turn: net angle from before it to after this junction
            turn = (b_out - prev["b_in"] + 540) % 360 - 180
            prev["modifier"] = classify(turn)
            prev["instruction"] = instruction(prev["modifier"], names[i] or prev["name"])
            continue

        turn = (b_out - b_in + 540) % 360 - 180
        modifier = classify(turn)
        renamed = names[i] and names[i] != names[i - 1]
        if modifier != "straight" or renamed:
            steps.append({"type": "turn", "modifier": modifier, "name": names[i],
                          "instruction": instruction(modifier, names[i]),
                          "along": round(along, 1), "point": to_latlng(coords[i][0]), "b_in": b_in})

    steps = [s for s in steps if s["modifier"] != "straight" or s["type"] != "turn" or s.get("name")]
    steps.append({"type": "arrive", "modifier": "straight", "instruction": "Arrive at your destination",
                  "along": round(sum(lengths), 1), "point": to_latlng(coords[-1][-1])})
    for s in steps:
        s.pop("b_in", None)
        s.pop("name", None)
    return steps


def route_summary(nodes, weight, avoid=frozenset()):
    edges = ox.routing.route_to_gdf(G, nodes, weight=weight)
    coords = oriented_coords(edges)
    length = edges["length"].sum()

    near = callboxes[callboxes.distance(LineString([p for edge in coords for p in edge])) <= CALLBOX_ALONG_M]
    by_access = edges.groupby("access")["length"].sum()

    return {
        "length_m": round(length),
        "avg_light": round((edges["light"] * edges["length"]).sum() / length, 2),
        "callboxes": near["objectid"].tolist(),
        "access_m": {k: int(round(by_access.get(k, 0))) for k in ("no", "steps", "unknown")},
        "closed_m": int(round(edges.loc[edges["closed"].astype(bool), "length"].sum())),
        "reported_m": int(round(edges.loc[[i in avoid for i in edges.index], "length"].sum())),   # no way around
        "geojson": edges[["light", "length", "geometry"]].to_crs(4326).__geo_interface__,
        "line": route_line(coords),
        "steps": route_steps(edges, coords),
    }


def walk_leg(a, b, weight, avoid):
    """Walking summary between two graph nodes, or None if they're the same node."""
    if a == b:
        return None
    nodes = ox.shortest_path(G, a, b, weight=cost(weight, avoid))
    return route_summary(nodes, weight, avoid) if nodes else None


def nodes_for_stops(route):
    """Walking-graph node for each stop on a route (None for stops off the walking network)."""
    if route["id"] not in stop_nodes:
        xs, ys = zip(*(s["xy"] for s in route["stops"]))
        nodes, dists = ox.distance.nearest_nodes(G, list(xs), list(ys), return_dist=True)
        stop_nodes[route["id"]] = [n if d <= STOP_SNAP_M else None for n, d in zip(nodes, dists)]
    return stop_nodes[route["id"]]


def plan_bus(orig, dest, weight, walk_m, speed, avoid):
    """Fastest single-bus trip (walk → ride → walk) using live arrival predictions, or None."""
    if walk_m < MIN_TRIP_M:
        return None
    routes = [r for r in bus_routes.get() if r["running"]]
    if not routes:
        return None

    near_start = nx.single_source_dijkstra_path_length(G, orig, cutoff=MAX_STOP_WALK_M, weight="length")
    near_end = nx.single_source_dijkstra_path_length(G.reverse(copy=False), dest, cutoff=MAX_STOP_WALK_M, weight="length")
    live = buses.arrivals([r["id"] for r in routes])

    best = None
    for r in routes:
        nodes = nodes_for_stops(r)
        boards = [(i, near_start[n]) for i, n in enumerate(nodes) if n in near_start]
        alights = [(j, near_end[n]) for j, n in enumerate(nodes) if n in near_end]
        for i, walk1 in boards:
            # the first bus we can walk to in time
            reach_s = walk1 / speed + CATCH_BUFFER_S
            bus_in = next((s for s in live.get(r["stops"][i]["route_stop_id"], []) if s >= reach_s), None)
            if bus_in is None:
                continue
            for j, walk2 in alights:
                if j == i:
                    continue
                ride_s = buses.ride_seconds(r, i, j)
                total = bus_in + ride_s + walk2 / speed
                if ride_s <= MAX_RIDE_S and (best is None or total < best[0]):
                    best = (total, r, i, j, walk1, walk2, bus_in, ride_s)

    if best is None:
        return None
    _, r, i, j, walk1, walk2, bus_in, ride_s = best
    if walk1 + walk2 > BUS_WALK_SHARE * walk_m:
        return None
    return bus_trip(r, i, j, orig, dest, weight, bus_in, ride_s, speed, avoid)


def bus_trip(r, i, j, orig, dest, weight, bus_in, ride_s, speed, avoid):
    """Walk + ride + walk as one line with turn-by-turn steps, in the same shape as a walking route."""
    board, alight = r["stops"][i], r["stops"][j]
    nodes = nodes_for_stops(r)
    leg1, leg2 = walk_leg(orig, nodes[i], weight, avoid), walk_leg(nodes[j], dest, weight, avoid)
    ride_geom = buses.ride_line(r, i, j)
    ride = [to_latlng(p) for p in ride_geom.coords]

    line, steps, along = [], [], 0.0
    if leg1:
        line += leg1["line"]
        steps += [s for s in leg1["steps"] if s["type"] != "arrive"]
        along = leg1["steps"][-1]["along"]
    steps.append({"type": "board", "modifier": "straight", "instruction": f"Board the {r['name']} bus at {board['name']}",
                  "along": round(along, 1), "point": [board["lat"], board["lng"]]})
    line += ride
    along += ride_geom.length
    steps.append({"type": "alight", "modifier": "straight", "instruction": f"Get off at {alight['name']}",
                  "along": round(along, 1), "point": [alight["lat"], alight["lng"]]})
    if leg2:
        line += leg2["line"]
        steps += [{**s, "along": round(along + s["along"], 1)} for s in leg2["steps"]]
    else:
        steps.append({"type": "arrive", "modifier": "straight", "instruction": "Arrive at your destination",
                      "along": round(along, 1), "point": [alight["lat"], alight["lng"]]})

    legs = [leg for leg in (leg1, leg2) if leg]
    walk_m = sum(leg["length_m"] for leg in legs)
    return {
        "route": {"id": r["id"], "name": r["name"], "color": r["color"]},
        "board": {"name": board["name"], "lat": board["lat"], "lng": board["lng"]},
        "alight": {"name": alight["name"], "lat": alight["lat"], "lng": alight["lng"]},
        "bus_in_s": int(bus_in),
        "ride_s": int(ride_s),
        "stops": (j - i) % len(r["stops"]),
        "total_s": int(bus_in + ride_s + (leg2["length_m"] if leg2 else 0) / speed),
        "planned_at": time.time(),
        "walk_m": walk_m,
        "avg_light": round(sum(leg["avg_light"] * leg["length_m"] for leg in legs) / walk_m, 2) if walk_m else 1.0,
        "callboxes": sorted({c for leg in legs for c in leg["callboxes"]}),
        "access_m": {k: sum(leg["access_m"][k] for leg in legs) for k in ("no", "steps", "unknown")},
        "closed_m": sum(leg["closed_m"] for leg in legs),
        "reported_m": sum(leg["reported_m"] for leg in legs),
        "walk_geojson": {"type": "FeatureCollection", "features": [f for leg in legs for f in leg["geojson"]["features"]]},
        "ride_geojson": {"type": "Feature", "properties": {"color": r["color"]},
                         "geometry": {"type": "LineString", "coordinates": [[lng, lat] for lat, lng in ride]}},
        "line": line,
        "steps": steps,
    }


# ---- Sign-in ----
TOKEN_RECHECK_S = 300   # ask Supabase about a token at most every 5 minutes
checked_tokens = {}     # access token → when Supabase last said it was valid


def signed_in():
    """Whether the request carries a valid Supabase session token (always true without Supabase settings)."""
    if not SUPABASE_URL:
        return True
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token:
        return False
    if time.time() - checked_tokens.get(token, 0) < TOKEN_RECHECK_S:
        return True
    try:
        res = requests.get(f"{SUPABASE_URL}/auth/v1/user", timeout=10,
                           headers={"apikey": SUPABASE_KEY, "Authorization": f"Bearer {token}"})
    except requests.RequestException:
        return False
    if len(checked_tokens) > 5000:   # tokens expire hourly; don't let the cache grow forever
        checked_tokens.clear()
    if res.ok:
        checked_tokens[token] = time.time()
    return res.ok


@app.get("/")
def index():
    return send_from_directory(".", "index.html")


@app.get("/config")
def config():
    """Public settings for the browser (null Supabase settings mean no sign-in)."""
    return jsonify(supabaseUrl=SUPABASE_URL, supabaseKey=SUPABASE_KEY)


@app.get("/bus/routes")
def bus_route_shapes():
    """Route loops and stops as GeoJSON for the map."""
    features = []
    for r in bus_routes.get():
        props = {"id": r["id"], "name": r["name"], "color": r["color"], "running": r["running"]}
        features.append({"type": "Feature", "properties": {**props, "kind": "route"},
                         "geometry": {"type": "LineString", "coordinates": [[lng, lat] for lat, lng in r["latlng"]]}})
        features += [{"type": "Feature", "properties": {**props, "kind": "stop", "stop": s["name"]},
                      "geometry": {"type": "Point", "coordinates": [s["lng"], s["lat"]]}} for s in r["stops"]]
    return jsonify(type="FeatureCollection", features=features)


@app.get("/bus/vehicles")
def bus_vehicles():
    """Live bus positions (cached for 30 s)."""
    routes = {r["id"]: r for r in bus_routes.get()}
    return jsonify([{
        "id": v["VehicleID"],
        "route": routes[v["RouteID"]]["name"] if v["RouteID"] in routes else "Bus",
        "color": routes[v["RouteID"]]["color"] if v["RouteID"] in routes else "#5f6368",
        "lat": v["Latitude"],
        "lng": v["Longitude"],
        "heading": v["Heading"],
    } for v in buses.vehicles()])


@app.post("/ask")
def ask():
    """Typed request → route settings from the AI (the search box's fallback when no building name matches)."""
    if not signed_in():
        return jsonify(error="Please sign in"), 401
    text = str((request.get_json(silent=True) or {}).get("text") or "").strip()
    if not text:
        return jsonify(error="Type where you want to go"), 400
    try:
        return jsonify(assistant.route_settings(text, buildings))
    except Exception as err:   # the AI is a bonus: building search works without it
        print("AI failed:", repr(err), flush=True)
        return jsonify(error="Couldn't understand that. Try a building name"), 502


@app.get("/route")
def route():
    if not signed_in():
        return jsonify(error="Please sign in"), 401
    try:
        (x1, y1), (x2, y2) = parse_point(request.args["from"]), parse_point(request.args["to"])
    except (KeyError, ValueError):
        return jsonify(error="Use /route?from=lat,lng&to=lat,lng"), 400

    (orig, dest), dists = ox.distance.nearest_nodes(G, [x1, x2], [y1, y2], return_dist=True)
    if max(dists) > MAX_SNAP_M:
        return jsonify(error="That point is too far from campus paths"), 400
    if orig == dest:
        return jsonify(error="Start and end are too close together"), 400

    accessible = request.args.get("accessible") == "1"
    weight = "cost_access" if accessible else "cost"
    speed = ACCESSIBLE_SPEED if accessible else WALK_SPEED

    avoid = parse_avoid(request.args.get("avoid"))
    safe = ox.shortest_path(G, orig, dest, weight=cost(weight, avoid))
    short = ox.shortest_path(G, orig, dest, weight=cost("length", avoid))
    if safe is None:
        return jsonify(error="No walking route between those points"), 404

    safe_route = route_summary(safe, weight, avoid)
    try:
        bus = plan_bus(orig, dest, weight, safe_route["length_m"], speed, avoid)
    except Exception as err:   # the bus feed is a bonus: never let it break walking directions
        print("bus planning skipped:", repr(err))
        bus = None

    return jsonify(safe=safe_route, shortest=route_summary(short, "length", avoid), bus=bus, accessible=accessible)


if __name__ == "__main__":
    app.run(port=8000, debug=False)
