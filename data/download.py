import os

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
ACCESS_FACTOR = {"yes": 1, "unknown": 1.5, "no": 4, "steps": BLOCKED}   # accessible routing only


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
    G = ox.project_graph(ox.graph_from_bbox((w, s, e, n), network_type="walk"))
    edges = ox.graph_to_gdfs(G, nodes=False).reset_index()

    edges["light"] = light_score(edges, lights.to_crs(edges.crs))
    edges["callbox"] = callbox_score(edges, callboxes.to_crs(edges.crs))
    edges["access"], edges["closed"] = sidewalk_access(edges, sidewalks.to_crs(edges.crs))

    risk = W_DARK * (1 - edges["light"]) + W_NO_CALLBOX * (1 - edges["callbox"])
    closed = edges["closed"].map({True: BLOCKED, False: 1})
    edges["cost"] = edges["length"] * (1 + risk) * closed                       # everyone
    edges["cost_access"] = edges["cost"] * edges["access"].map(ACCESS_FACTOR)   # ♿ accessible routing

    attrs = edges.set_index(["u", "v", "key"])
    for col in ["light", "callbox", "access", "closed", "cost", "cost_access"]:
        nx.set_edge_attributes(G, attrs[col].to_dict(), col)
    return G


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
    sw = sidewalks[["ADACOMPLY", "Status", "geometry"]].explode(index_parts=False).reset_index(drop=True)
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
    closed = (near["Status"] == "Close").groupby(near["edge"]).sum().reindex(edges.index, fill_value=0) / per_edge

    # any real stretch of stairs or non-compliant sidewalk flags the whole edge
    access = np.select([frac["steps"] >= 0.3, frac["no"] >= 0.3, frac["yes"] >= 0.5], ["steps", "no", "yes"], "unknown")
    return pd.Series(access, index=edges.index), closed >= 0.5


def main():
    #download()
    G = check()
    print(G.number_of_edges(), "edges scored")


if __name__ == "__main__":
    main()
