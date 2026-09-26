"""Georgia Tech Stinger buses, from the RideSystems service behind bus.gatech.edu.

Undocumented and read-only: the same calls and public key GT's own live map uses.
Fine for a demo; ask GT Parking & Transportation before relying on it.
"""
import time

import numpy as np
import requests
from shapely.geometry import LineString
from shapely.ops import substring

RELAY = "https://bus.gatech.edu/Services/JSONPRelay.svc"
API_KEY = "8882812681"

ROUTES_TTL = 24 * 3600   # route shapes and stops barely change
RUNNING_TTL = 60         # which routes are running right now
VEHICLES_TTL = 3         # bus positions: GT's feed moves each bus about every 4 s
ARRIVALS_TTL = 30        # arrival predictions, for planning bus trips
SAMPLE_M = 5             # route lines are sampled every 5 m to place stops along them
STOP_NEAR_M = 20         # a stop sits on the line where the bus passes within this distance

_cache = {}


def _get(method, ttl, **params):
    """Call the relay, caching each response for `ttl` seconds."""
    key = (method, tuple(sorted(params.items())))
    hit = _cache.get(key)
    if hit and time.time() - hit[0] < ttl:
        return hit[1]
    data = requests.get(f"{RELAY}/{method}", params={"apiKey": API_KEY, **params}, timeout=15).json()
    _cache[key] = (time.time(), data)
    return data


def decode_polyline(s):
    """Google encoded polyline → [(lat, lng), ...]."""
    pts, i, lat, lng = [], 0, 0, 0
    while i < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            delta = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += delta
            else:
                lng += delta
        pts.append((lat / 1e5, lng / 1e5))
    return pts


class Routes:
    """Route loops projected into the walking graph's CRS, with each stop placed along its loop."""

    def __init__(self, to_graph, to_wgs84):
        self.to_graph, self.to_wgs84 = to_graph, to_wgs84
        self.loaded_at = 0
        self.routes = []

    def get(self):
        try:
            raw = _get("GetRoutesForMapWithScheduleWithEncodedLine", RUNNING_TTL, isDispatch="false")
        except (requests.RequestException, ValueError):
            if self.routes:
                return self.routes   # the feed hiccupped: keep what we knew a minute ago
            raise
        if time.time() - self.loaded_at > ROUTES_TTL:
            self.routes = [self._build(r) for r in raw if r.get("Stops") and r.get("EncodedPolyline")]
            self.loaded_at = time.time()
        running = {r["RouteID"]: bool(r.get("IsRunning")) for r in raw}   # rechecked every minute, not once a day
        for r in self.routes:
            r["running"] = running.get(r["id"], False)
        return self.routes

    def _build(self, r):
        latlng = decode_polyline(r["EncodedPolyline"])
        line = LineString([self.to_graph.transform(lng, lat) for lat, lng in latlng])
        stops = sorted(r["Stops"], key=lambda s: s["Order"])

        # sample the loop, then place each stop at the first close pass *after* the previous stop,
        # so a stop on a street the bus uses both ways lands on the right side
        along = np.arange(0, line.length, SAMPLE_M)
        xy = np.array([line.interpolate(d).coords[0] for d in along])
        n = len(along)

        def dist_to(stop):
            sx, sy = self.to_graph.transform(stop["Longitude"], stop["Latitude"])
            return np.hypot(xy[:, 0] - sx, xy[:, 1] - sy)

        first = dist_to(stops[0])
        idx = [int(first.argmin())]
        for stop in stops[1:]:
            d = dist_to(stop)
            order = (idx[-1] + 1 + np.arange(n)) % n            # walk forward around the loop
            close = np.nonzero(d[order] < STOP_NEAR_M)[0]
            k = close[0] if len(close) else int(d[order].argmin())
            while k + 1 < n and d[order[k + 1]] < d[order[k]]:  # settle on the closest point of that pass
                k += 1
            idx.append(int(order[k]))

        return {
            "id": r["RouteID"],
            "name": r["Description"].strip(),
            "color": r["MapLineColor"],
            "line": line,
            "latlng": latlng,
            "stops": [{
                "route_stop_id": s["RouteStopID"],
                "name": s["Description"].strip(),
                "lat": s["Latitude"],
                "lng": s["Longitude"],
                "xy": self.to_graph.transform(s["Longitude"], s["Latitude"]),
                "along": float(along[i]),
                "to_next_s": s["SecondsToNextStop"],
                "at_stop_s": s["SecondsAtStop"],
            } for s, i in zip(stops, idx)],
        }


def vehicles():
    return _get("GetMapVehiclePoints", VEHICLES_TTL, isPublicMap="true")


def arrivals(route_ids):
    """{route_stop_id: [seconds until each upcoming bus, ...]} from the live predictions."""
    data = _get("GetStopArrivalTimes", ARRIVALS_TTL, routeIds=",".join(map(str, sorted(route_ids))), version="2")
    out = {}
    for entry in data:
        secs = sorted(t["Seconds"] for t in entry.get("Times") or [] if t.get("Seconds") is not None)
        out[entry["RouteStopId"]] = secs
    return out


def ride_seconds(route, board, alight):
    """Scheduled seconds riding from stop index `board` to `alight`, going round the loop."""
    stops, n = route["stops"], len(route["stops"])
    secs, i = 0, board
    while i != alight:
        secs += stops[i]["to_next_s"] + (stops[i]["at_stop_s"] if i != board else 0)
        i = (i + 1) % n
    return secs


def ride_line(route, board, alight):
    """The stretch of the loop (projected LineString) the bus drives from `board` to `alight`."""
    line, a, b = route["line"], route["stops"][board]["along"], route["stops"][alight]["along"]
    if b > a:
        return LineString(_slice(line, a, b))
    return LineString(_slice(line, a, line.length) + _slice(line, 0, b)[1:])   # wraps past the loop's start


def _slice(line, start, end):
    part = substring(line, start, end)
    return list(part.coords) if part.geom_type == "LineString" else [part.coords[0], part.coords[0]]
