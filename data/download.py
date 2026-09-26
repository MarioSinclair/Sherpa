import os
import time

DATA_DIR = os.path.dirname(os.path.abspath(__file__))
ARCGIS = "https://services5.arcgis.com/7WaXTZEsI88qiQGw/arcgis/rest/services"

# GT Facilities layers, saved as data/gt_<name>.geojson
LAYERS = {
    "lights": "Outside_Lights_Public_View/FeatureServer/2",
    "sidewalks": "Sidewalk_Lines_view_only/FeatureServer/0",
    "ada_entrances": "ADA_Entrances/FeatureServer/0",
    "callboxes": "Call_Box_Location_View_Layer/FeatureServer/0",
}
PAGE = 1000   # the sidewalk layer pages at 1,000 features, the others at 2,000

# ---- Scoring settings ----
W_DARK = 3             # a fully dark edge costs up to 4x its length...
W_NO_CALLBOX = 1       # ...plus up to 1x more with no call box nearby
CALLBOX_FULL_M = 75    # call box within this distance → full credit
CALLBOX_NONE_M = 250   # farther than this → no credit
BLOCKED = 1000         # cost multiplier for edges to avoid unless there's no other way
CLOSED_RECENT_DAYS = 30   # GT "Close" statuses older than this are stale (today's are from Sept 2025)
# accessible routing only: GT's "not ADA compliant" is often stairs (62% has OSM stairs within 10 m), so it's avoided like stairs
ACCESS_FACTOR = {"yes": 1, "unknown": 1.5, "no": BLOCKED, "steps": BLOCKED}


def path(name):
    return os.path.join(DATA_DIR, f"gt_{name}.geojson")


def download():
    import requests, json

    for name, layer in LAYERS.items():
        features, offset = [], 0

        while True:

            req = requests.get(f"{ARCGIS}/{layer}/query", params={"where": "1=1", "outFields": "*", "outSR": 4326, "f": "geojson",
                                        "resultOffset": offset, "resultRecordCount": PAGE}, timeout=30).json()

            if "features" not in req:
                raise RuntimeError(f"ArcGIS error for {name}: {req.get('error', req)}")

            features += req["features"]

            if len(req["features"]) < PAGE:
                break

            offset += PAGE

        with open(path(name), "w") as f:
            json.dump({"type": "FeatureCollection", "features": features}, f)

        print(len(features), name)


def load_layers():
    import geopandas as gpd
    return {name: gpd.read_file(path(name)) for name in LAYERS}


# ---- Buildings: every campus building with its doors, saved as data/gt_buildings.geojson ----
BUILDINGS = "Campus_Building_Types/FeatureServer/0"   # GT's fullest building list, with readable names
BUILDINGS_2026 = "GT_Campus2026/FeatureServer/1"      # adds the few buildings only the 2026 campus map has
ADA_NEAR_M = 30        # an ADA entrance whose building number matches nothing joins the nearest footprint this close
DOOR_ON_WALL_M = 5     # an OpenStreetMap door this close to a footprint belongs to it
SAME_DOOR_M = 5        # an OpenStreetMap door this close to a GT ADA entrance is that entrance


def text(x):
    return x if isinstance(x, str) else ""


def entrance_building(name, desc):
    """"153 - ADA Building Entrance - Klaus Advanced Computing" → "Klaus Advanced Computing", like buildingName() in script.js."""
    import re

    parts = re.split(r"\s+-\s*|\s*-\s+", (text(desc) or text(name)).replace("&amp;", "&"))
    parts = [re.sub(r"\s+", " ", re.sub(r"\bADA\b|\b(Building\s+)?Entrance\b|\bElevator Access\b|=", "", p, flags=re.I)).strip()
             for p in parts]
    return " - ".join(p for p in parts if p and not re.fullmatch(r"\d+[A-Z]?", p, re.I))


def download_buildings():
    """Every building on GT's campus maps, with its doors: GT's ADA entrances (step-free) and OpenStreetMap entrances."""
    import json, re, requests
    import geopandas as gpd, osmnx as ox, pandas as pd

    def layer(url, fields):
        res = requests.get(f"{ARCGIS}/{url}/query", params={"where": "1=1", "outFields": fields, "outSR": 4326, "f": "geojson"},
                           timeout=30).json()
        if "features" not in res or res.get("properties", {}).get("exceededTransferLimit"):
            raise RuntimeError(f"ArcGIS error for {url}: {res.get('error', 'more than one page')}")
        return gpd.GeoDataFrame.from_features(res["features"], crs=4326)

    number = lambda s: text(s).strip().upper().lstrip("0")
    tidy = lambda s: re.sub(r"\s+", " ", text(s)).strip()

    main = layer(BUILDINGS, "BLDG_NUM,BLDG_NAME")
    main = gpd.GeoDataFrame({"num": main["BLDG_NUM"].map(number), "name": main["BLDG_NAME"].map(tidy)}, geometry=main.geometry)
    new = layer(BUILDINGS_2026, "BUILDINGID,SHORTNAME,LONGNAME")
    new = new[new["BUILDINGID"].map(number).ne("") & ~new["BUILDINGID"].map(number).isin(main["num"])]
    new = gpd.GeoDataFrame({"num": new["BUILDINGID"].map(number),   # long names read "Smith, John M. Residence Hall"
                            "name": [tidy(s if "," in text(l) else l or s) for l, s in zip(new["LONGNAME"], new["SHORTNAME"])]},
                           geometry=new.geometry)
    b = gpd.GeoDataFrame(pd.concat([main, new]), crs=4326)
    b = b[b["name"] != ""].dissolve(by="name", aggfunc=lambda nums: sorted(set(nums) - {""})).reset_index()
    utm = b.estimate_utm_crs()
    walls = b.to_crs(utm)
    places = {name: {"aka": set(), "doors": [], "nums": nums} for name, nums in zip(b["name"], b["num"])}

    # GT's ADA entrances, matched by the building number they start with ("153 - ADA Building Entrance - Klaus")
    ada = gpd.read_file(path("ada_entrances"))
    ada = ada[["entrance" in f"{text(n)} {text(d)}".lower() for n, d in zip(ada["Name"], ada["Description"])]]   # not stairs or notes
    by_num = {n: name for name, p in places.items() for n in p["nums"]}
    near = gpd.sjoin_nearest(ada.to_crs(utm)[["geometry"]], walls[["name", "geometry"]], max_distance=ADA_NEAR_M, how="left")
    near = near[~near.index.duplicated()]["name"]
    for i, n, d, point in zip(ada.index, ada["Name"], ada["Description"], ada.geometry):
        own = entrance_building(n, d)
        num = re.match(r"\s*(\d+[A-Z]?)\b", text(d) or text(n))
        name = by_num.get(num and number(num.group(1))) or (near[i] if isinstance(near[i], str) else None) or own
        if not name:
            continue
        place = places.setdefault(name, {"aka": set(), "doors": [], "nums": []})   # no footprint: just its doors
        place["doors"].append([round(point.x, 6), round(point.y, 6), True])
        if own and own != name:
            place["aka"].add(own)   # keeps "Klaus Advanced Computing" findable as well as "Klaus Building"

    # OpenStreetMap entrances on a footprint's wall (not exit-only doors); wheelchair=yes counts as step-free
    w, s, e, n = b.total_bounds
    osm = ox.features_from_bbox((w, s, e, n), {"entrance": True})
    osm = osm[(osm.geom_type == "Point") & ~osm["entrance"].isin(["exit", "emergency", "no"])]
    osm = gpd.sjoin_nearest(osm.to_crs(utm)[["geometry"]].assign(ada=osm.get("wheelchair", pd.Series(index=osm.index)).eq("yes")),
                            walls[["name", "geometry"]], max_distance=DOOR_ON_WALL_M)
    osm = osm[~osm.index.duplicated()]
    to_wgs84 = osm.to_crs(4326).geometry
    for (name, ada_door, point), ll in zip(zip(osm["name"], osm["ada"], osm.geometry), to_wgs84):
        known = gpd.GeoSeries.from_xy([d[0] for d in places[name]["doors"]], [d[1] for d in places[name]["doors"]], crs=4326).to_crs(utm)
        if not len(known) or known.distance(point).min() > SAME_DOOR_M:
            places[name]["doors"].append([round(ll.x, 6), round(ll.y, 6), bool(ada_door)])

    shapes = dict(zip(b["name"], b.geometry))
    features = [{"type": "Feature",
                 "properties": {"name": name, "aka": sorted(p["aka"]), "doors": p["doors"]},
                 "geometry": shapes[name].__geo_interface__ if name in shapes else None}
                for name, p in sorted(places.items())]
    with open(path("buildings"), "w") as f:
        json.dump({"type": "FeatureCollection", "features": features}, f)
    with_doors = sum(1 for f in features if f["properties"]["doors"])
    print(len(features), "buildings,", with_doors, "with doors,", sum(len(f["properties"]["doors"]) for f in features), "doors")


def load_buildings():
    """name → {"aka": [...], "doors": [[lng, lat, step_free], ...], "outline": shapely footprint or None}."""
    import json
    from shapely.geometry import shape

    with open(path("buildings")) as f:
        features = json.load(f)["features"]
    return {f["properties"]["name"]: {**f["properties"], "outline": f["geometry"] and shape(f["geometry"])} for f in features}


def check():
    import osmnx as ox

    layers = load_layers()
    for name, gdf in layers.items():
        print(name, len(gdf), gdf.total_bounds.round(4))

    columns = {"lights": ["CONDITION", "WATTAGE", "BULBTYPE"],
               "sidewalks": ["ADACOMPLY", "Status", "SURFTYPE"],
               "callboxes": ["phone_status", "location_code", "blue_light_condition"]}
    for name, cols in columns.items():
        for col in cols:
            print(f"{name}.{col}", layers[name][col].value_counts(dropna=False).to_dict())

    G = mapping(layers["lights"], layers["sidewalks"], layers["callboxes"])

    edges = ox.graph_to_gdfs(G, nodes=False)
    print("edge access:", edges["access"].value_counts().to_dict(), "| closed:", int(edges["closed"].sum()),
          "| mean light:", round(edges["light"].mean(), 2), "| mean callbox:", round(edges["callbox"].mean(), 2))
    return G


def mapping(lights, sidewalks, callboxes):

    import osmnx as ox, networkx as nx

    w, s, e, n = lights.total_bounds                       # only where we have light data
    # osmnx's walk network leaves out every cycleway, but most campus ones are shared paths marked for walking
    # too (foot=designated), like the path down Clough's west side and Skiles Walkway: add those back
    walk = [ox._overpass._get_network_filter("walk"), '["highway"="cycleway"]["foot"!~"no"]']
    ox.settings.useful_tags_way = sorted({*ox.settings.useful_tags_way, "ramp", "ramp:wheelchair"})   # stairs with a ramp
    G = ox.graph_from_bbox((w, s, e, n), network_type="walk", custom_filter=walk, simplify=False)
    G = ox.project_graph(ox.simplify_graph(G, edge_attrs_differ=["highway"]))   # stairs stay separate from the paths they join
    edges = ox.graph_to_gdfs(G, nodes=False).reset_index()

    edges["light"] = light_score(edges, lights.to_crs(edges.crs))
    edges["callbox"] = callbox_score(edges, callboxes.to_crs(edges.crs))
    edges["access"], edges["closed"] = sidewalk_access(edges, sidewalks.to_crs(edges.crs))
    edges["stairs"] = osm_stairs(edges)
    edges.loc[edges["stairs"], "access"] = "steps"   # GT only rates the sidewalks it surveyed; OSM has most campus stairs

    risk = W_DARK * (1 - edges["light"]) + W_NO_CALLBOX * (1 - edges["callbox"])
    closed = edges["closed"].map({True: BLOCKED, False: 1})
    edges["cost"] = edges["length"] * (1 + risk) * closed                       # everyone
    edges["cost_access"] = edges["cost"] * edges["access"].map(ACCESS_FACTOR)   # ♿ accessible routing
    edges["short_access"] = edges["length"] * closed * edges["access"].map(ACCESS_FACTOR)   # step-free, lighting not wanted

    attrs = edges.set_index(["u", "v", "key"])
    for col in ["light", "callbox", "access", "closed", "stairs", "cost", "cost_access", "short_access"]:
        nx.set_edge_attributes(G, attrs[col].to_dict(), col)
    return G


def osm_stairs(edges):
    """OpenStreetMap staircases, except ones OSM says have a ramp."""
    import pandas as pd

    def has(value, wanted):   # merged paths hold a list of values
        return wanted in (value if isinstance(value, list) else [value])

    none = pd.Series(None, index=edges.index)
    ramp = [has(r, "yes") or has(rw, "yes") for r, rw in zip(edges.get("ramp", none), edges.get("ramp:wheelchair", none))]
    return edges["highway"].map(lambda h: has(h, "steps")) & ~pd.Series(ramp, index=edges.index)


def light_score(edges, lights):
    """1 = well lit … 0 = dark, from working lamps within 25 m per 100 m of edge."""
    import geopandas as gpd

    lamps = lights[~lights["CONDITION"].isin(["Poor", "Very Poor"])]

    zones = gpd.GeoDataFrame(geometry=edges.buffer(25), crs=edges.crs)
    hits = gpd.sjoin(lamps, zones, predicate="within")
    count = hits.groupby("index_right").size().reindex(edges.index, fill_value=0)

    per100m = count / edges["length"].clip(lower=50) * 100  # floor stops short edges maxing out
    return (per100m / 15).clip(upper=1)


def callbox_score(edges, callboxes):
    """1 = blue-light phone within 75 m … 0 = none within 250 m."""
    import geopandas as gpd

    near = gpd.sjoin_nearest(edges[["geometry"]], callboxes[["geometry"]], distance_col="dist")
    dist = near.groupby(level=0)["dist"].min().reindex(edges.index)
    return (1 - (dist - CALLBOX_FULL_M) / (CALLBOX_NONE_M - CALLBOX_FULL_M)).clip(0, 1)


def sidewalk_access(edges, sidewalks, spacing=5, max_dist=10, max_angle=30):
    """Match GT sidewalk lines onto the OSM walking edges.

    Samples a point every `spacing` m along each edge and takes the nearest GT sidewalk within
    `max_dist` m that runs the same direction, so a path crossing a sidewalk doesn't inherit it.
    Returns each edge's access class ("yes", "no", "steps" or "unknown") and whether it's closed.
    """
    import numpy as np, pandas as pd, geopandas as gpd, shapely

    def direction(lines, at):
        a = shapely.line_interpolate_point(lines, np.maximum(at - 1, 0))
        b = shapely.line_interpolate_point(lines, at + 1)
        return np.degrees(np.arctan2(shapely.get_x(b) - shapely.get_x(a), shapely.get_y(b) - shapely.get_y(a)))

    # sample points along every edge
    geoms = np.asarray(edges.geometry.values)
    lengths = shapely.length(geoms)
    n = np.maximum(1, (lengths // spacing).astype(int))
    edge_i = np.repeat(np.arange(len(edges)), n)
    at = (np.concatenate([np.arange(k) for k in n]) + 0.5) * np.repeat(lengths / n, n)
    samples = gpd.GeoDataFrame({"edge": edge_i, "dir": direction(geoms[edge_i], at)},
                               geometry=shapely.line_interpolate_point(geoms[edge_i], at), crs=edges.crs)

    # nearest sidewalk to each sample, kept only if it runs the same way (either direction)
    sw = sidewalks[["ADACOMPLY", "Status", "EditDate", "geometry"]].explode(index_parts=False).reset_index(drop=True)
    near = gpd.sjoin_nearest(samples, sw, max_distance=max_dist)
    near = near[~near.index.duplicated()]
    lines = np.asarray(sw.geometry.values)[near["index_right"].to_numpy()]
    sw_dir = direction(lines, shapely.line_locate_point(lines, np.asarray(near.geometry.values)))
    near = near[np.abs((near["dir"].to_numpy() - sw_dir + 90) % 180 - 90) < max_angle]

    # share of each edge's samples on each kind of sidewalk
    per_edge = pd.Series(n, index=edges.index)
    cls = near["ADACOMPLY"].map({"Yes": "yes", "No": "no", "Steps": "steps"})
    frac = (pd.crosstab(near["edge"], cls)
            .reindex(index=edges.index, columns=["yes", "no", "steps"], fill_value=0)
            .div(per_edge, axis=0))
    recent = near["EditDate"] >= (time.time() - CLOSED_RECENT_DAYS * 86400) * 1000   # EditDate is epoch ms
    closed = ((near["Status"] == "Close") & recent).groupby(near["edge"]).sum().reindex(edges.index, fill_value=0) / per_edge

    # any real stretch of stairs or non-compliant sidewalk flags the whole edge
    access = np.select([frac["steps"] >= 0.3, frac["no"] >= 0.3, frac["yes"] >= 0.5], ["steps", "no", "yes"], "unknown")
    return pd.Series(access, index=edges.index), closed >= 0.5


def main():
    #download()
    #download_buildings()
    G = check()
    print(G.number_of_edges(), "edges scored")


if __name__ == "__main__":
    main()
