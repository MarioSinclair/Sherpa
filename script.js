// ---- Map setup ----
const CAMPUS_CENTER = { lat: 33.7756, lng: -84.3963 };
const CAMPUS = { south: 33.7689, west: -84.4073, north: 33.7834, east: -84.3859 };

const map = new maplibregl.Map({
    container: "map",
    style: "https://tiles.openfreemap.org/styles/liberty",   // free vector tiles with 3D buildings
    center: toLngLat(CAMPUS_CENTER),
    zoom: 16,
    maxBounds: [[CAMPUS.west - 0.03, CAMPUS.south - 0.03], [CAMPUS.east + 0.03, CAMPUS.north + 0.03]],
    attributionControl: { compact: true },
});
const mapReady = new Promise((resolve) => map.on("load", resolve));

// ---- Navigation settings ----
const OFF_ROUTE_M = 30;        // this far from the route counts as off route...
const OFF_ROUTE_FIXES = 3;     // ...for this many GPS fixes in a row → reroute
const REROUTE_GAP_MS = 10000;  // wait at least this long between reroutes
const ARRIVED_M = 15;          // this close to the end counts as arrived
const MAX_ACCURACY_M = 50;     // ignore fuzzier GPS fixes for off-route checks
const ANNOUNCE_M = 40;         // speak the next turn this far ahead
const WALK_SPEED = 1.34;       // m/s (3 mph), for time estimates
const ACCESSIBLE_SPEED = 1.12; // m/s (2.5 mph) in accessible mode
const NAV_ZOOM = 18;
const NAV_PITCH = 60;

// ---- State ----
const $ = (id) => document.getElementById(id);
const statusEl = $("status");

let mode = "idle";        // idle → preview → nav → arrived
let here = null;          // latest GPS position {lat, lng}
let accuracy = Infinity;  // metres
let heading = 0;          // degrees clockwise from north
let youMarker = null;

let start = null;         // manual start marker, only used without GPS
let dest = null;          // destination marker
let destName = null;      // building name when the destination is an ADA entrance
let routes = null;        // last /route response
let selected = "safe";    // which option in the preview card: "safe", "shortest" or "bus"
let preferred = "safe";   // what to pre-select when routes arrive; the AI can ask for "fastest" or "bus"

let nav = null;           // { line, cum, total, steps, avgLight, spoken } while navigating
let following = true;
let offRouteCount = 0;
let lastReroute = 0;
let routing = false;
let voiceOn = true;

let accessible = false;                        // ♿ route around stairs and non-compliant sidewalks
const walkSpeed = () => (accessible ? ACCESSIBLE_SPEED : WALK_SPEED);
const layerOn = { lights: false, buses: false, callboxes: true, ada: false };
const LAYER_IDS = { lights: ["lights-glow", "lights"], buses: ["bus-routes", "bus-stops"], callboxes: ["callboxes"], ada: ["ada"] };
const LAZY_DATA = { lights: "/data/gt_lights.geojson", buses: "/bus/routes" };   // fetched the first time the chip is turned on
const loaded = new Set();

// the route groups drawn for each preview option
const OPTION_LAYERS = { safe: ["safe-casing", "safe"], shortest: ["shortest"], bus: ["bus-walk", "bus-ride-casing", "bus-ride"] };
const BUS_REFRESH_MS = 30000;   // live buses: every 30 s is plenty for the demo
const busMarkers = new Map();

function setMode(next) {
    mode = next;
    document.body.dataset.mode = next;
    $("recenter").hidden = true;
}

const gpsUsable = () =>
    here &&
    here.lat > CAMPUS.south - 0.005 && here.lat < CAMPUS.north + 0.005 &&
    here.lng > CAMPUS.west - 0.005 && here.lng < CAMPUS.east + 0.005;

const tripStart = () => (gpsUsable() ? here : lngLatToPoint(start.getLngLat()));

function idleHint() {
    if (!gpsUsable()) return "Tap the map to set a start point";
    return layerOn.ada ? "Search, or tap the map or a purple entrance" : "Search for a building or tap the map";
}

// ---- Map layers ----
const EMPTY = { type: "FeatureCollection", features: [] };
// route colour by light: 0 = dark (red) → 1 = well lit (green)
const LIGHT_COLOR = ["interpolate", ["linear"], ["get", "light"], 0, "#d93025", 0.5, "#f9ab00", 1, "#2e9d4f"];
// GT "Close" statuses edited longer ago than this are stale and ignored, as in data/download.py
const CLOSED_RECENT_DAYS = 30;

mapReady.then(() => {
    // draw routes above the 3D buildings (so they aren't hidden when tilted) but under the labels
    const layers = map.getStyle().layers;
    const buildings = layers.findIndex((l) => l.type === "fill-extrusion");
    const firstLabel = layers.find((l, i) => l.type === "symbol" && i > buildings)?.id;
    const line = { "line-cap": "round", "line-join": "round" };

    // GT Facilities data, served straight from data/
    map.addSource("lights", { type: "geojson", data: EMPTY });   // filled when the Lights chip is first turned on
    map.addSource("sidewalks", { type: "geojson", data: "/data/gt_sidewalks.geojson" });
    map.addSource("callboxes", { type: "geojson", data: "/data/gt_callboxes.geojson" });
    map.addSource("ada", { type: "geojson", data: "/data/gt_ada_entrances.geojson" });

    map.addSource("buses", { type: "geojson", data: EMPTY });    // filled when the Buses chip is first turned on

    map.addSource("shortest", { type: "geojson", data: EMPTY });
    map.addSource("safe", { type: "geojson", data: EMPTY });
    map.addSource("bus-walk", { type: "geojson", data: EMPTY });
    map.addSource("bus-ride", { type: "geojson", data: EMPTY });
    map.addSource("walked", { type: "geojson", data: EMPTY });

    // Streetlights, under everything else: a soft glow around working lamps, grey dots for broken ones
    // (the same Poor / Very Poor lamps the route score leaves out)
    const working = ["!", ["in", ["get", "CONDITION"], ["literal", ["Poor", "Very Poor"]]]];
    map.addLayer({
        id: "lights-glow", type: "circle", source: "lights", filter: working, layout: { visibility: "none" },
        paint: { "circle-radius": byZoom(4, 16), "circle-color": "#fbbc04", "circle-opacity": 0.25, "circle-blur": 1 },
    }, firstLabel);
    map.addLayer({
        id: "lights", type: "circle", source: "lights", layout: { visibility: "none" },
        paint: {
            "circle-radius": byZoom(1.5, 3.5),
            "circle-color": ["case", working, "#f9ab00", "#9aa0a6"],
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": byZoom(0, 1),
        },
    }, firstLabel);

    // Stinger bus network (Buses chip): running routes in their own colours, stops as white dots
    const running = ["==", ["get", "running"], true];
    map.addLayer({
        id: "bus-routes", type: "line", source: "buses", layout: { ...line, visibility: "none" },
        filter: ["all", running, ["==", ["get", "kind"], "route"]],
        paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.55 },
    }, firstLabel);
    map.addLayer({
        id: "bus-stops", type: "circle", source: "buses", minzoom: 15, layout: { visibility: "none" },
        filter: ["all", running, ["==", ["get", "kind"], "stop"]],
        paint: { "circle-radius": byZoom(2.5, 4.5), "circle-color": "#ffffff", "circle-stroke-color": ["get", "color"], "circle-stroke-width": 2 },
    }, firstLabel);

    // Sidewalk problems, shown in accessible mode: stairs, not ADA compliant, closed
    const closedNow = ["all", ["==", ["get", "Status"], "Close"],
        [">=", ["to-number", ["get", "EditDate"]], Date.now() - CLOSED_RECENT_DAYS * 86400000]];
    map.addLayer({
        id: "sidewalk-issues", type: "line", source: "sidewalks", layout: { ...line, visibility: "none" },
        filter: ["any", ["in", ["get", "ADACOMPLY"], ["literal", ["No", "Steps"]]], closedNow],
        paint: {
            "line-width": 4,
            "line-opacity": 0.85,
            "line-color": ["case",
                closedNow, "#3c4043",
                ["==", ["get", "ADACOMPLY"], "Steps"], "#d93025",
                "#f29900"],
        },
    }, firstLabel);

    map.addLayer({
        id: "shortest", type: "line", source: "shortest", layout: line,
        paint: { "line-color": "#80868b", "line-width": 5, "line-opacity": 0.8, "line-dasharray": [1, 1.5] },
    }, firstLabel);
    map.addLayer({
        id: "safe-casing", type: "line", source: "safe", layout: line,
        paint: { "line-color": "#ffffff", "line-width": 11 },
    }, firstLabel);
    map.addLayer({
        id: "safe", type: "line", source: "safe", layout: line,
        paint: {
            "line-width": 7,
            "line-color": LIGHT_COLOR,
        },
    }, firstLabel);

    // Bus option: dotted walking legs (coloured by light) and the ride in the route's colour
    map.addLayer({
        id: "bus-walk", type: "line", source: "bus-walk", layout: line,
        paint: { "line-width": 6, "line-color": LIGHT_COLOR, "line-dasharray": [0.6, 1.4] },
    }, firstLabel);
    map.addLayer({
        id: "bus-ride-casing", type: "line", source: "bus-ride", layout: line,
        paint: { "line-color": "#ffffff", "line-width": 11 },
    }, firstLabel);
    map.addLayer({
        id: "bus-ride", type: "line", source: "bus-ride", layout: line,
        paint: { "line-color": ["get", "color"], "line-width": 7 },
    }, firstLabel);

    map.addLayer({
        id: "walked", type: "line", source: "walked", layout: line,
        paint: { "line-color": "#9aa0a6", "line-width": 8 },
    }, firstLabel);

    // Points go on top of everything so they stay tappable
    map.addLayer({
        id: "ada", type: "circle", source: "ada", minzoom: 14.5, layout: { visibility: "none" },
        // the layer also holds a "Stairs" point and an "ADA Route" note; only show real entrances
        filter: ["in", "entrance", ["downcase", ["concat", ["coalesce", ["get", "Name"], ""], " ", ["coalesce", ["get", "Description"], ""]]]],
        paint: { "circle-radius": byZoom(2.5, 5.5), "circle-color": "#8e24aa", "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5 },
    });
    map.addLayer({
        id: "callboxes", type: "circle", source: "callboxes", minzoom: 14,
        paint: { "circle-radius": byZoom(3, 6), "circle-color": "#00a3e0", "circle-stroke-color": "#003057", "circle-stroke-width": byZoom(1, 2) },
    });
    // call boxes along the current route, drawn bigger
    map.addLayer({
        id: "callboxes-route", type: "circle", source: "callboxes", filter: routeCallboxes([]),
        paint: { "circle-radius": byZoom(6, 9), "circle-color": "#00a3e0", "circle-stroke-color": "#ffffff", "circle-stroke-width": 3 },
    });
});

function setSource(id, data) {
    map.getSource(id)?.setData(data);
}

function routeCallboxes(ids) {
    return ["in", ["get", "objectid"], ["literal", ids]];
}

// small when zoomed out to the whole campus, full size at street level
function byZoom(atCampus, atStreet) {
    return ["interpolate", ["linear"], ["zoom"], 14.5, atCampus, 17, atStreet];
}

// ---- Layer chips ----
$("chip-lights").addEventListener("click", () => toggleLayer("lights"));
$("chip-buses").addEventListener("click", () => toggleLayer("buses"));
$("chip-callboxes").addEventListener("click", () => toggleLayer("callboxes"));
$("chip-ada").addEventListener("click", () => toggleLayer("ada"));
$("chip-access").addEventListener("click", () => setAccessible(!accessible));

function toggleLayer(id, on = !layerOn[id]) {
    layerOn[id] = on;
    $(`chip-${id}`).setAttribute("aria-pressed", on);
    document.body.dataset[id] = on;   // shows the matching legend keys
    mapReady.then(() => {
        if (on && LAZY_DATA[id] && !loaded.has(id)) {
            setSource(id, LAZY_DATA[id]);
            loaded.add(id);
        }
        LAYER_IDS[id].forEach((layer) => map.setLayoutProperty(layer, "visibility", on ? "visible" : "none"));
    });
    if (id === "buses") refreshBuses();
    if (mode === "idle" && !start) statusEl.textContent = idleHint();
}

// ---- Live buses ----
// Shown when the Buses chip is on, or while a bus trip is on screen. Refreshed every 30 s.
const busesWanted = () => layerOn.buses || (routes?.bus && (mode === "preview" || (mode === "nav" && selected === "bus")));

async function refreshBuses() {
    if (!busesWanted()) {
        busMarkers.forEach((m) => m.remove());
        busMarkers.clear();
        return;
    }
    let vehicles;
    try {
        vehicles = await (await fetch("/bus/vehicles")).json();
    } catch {
        return;   // keep the last positions; try again next time
    }

    const seen = new Set();
    for (const v of vehicles) {
        seen.add(v.id);
        let marker = busMarkers.get(v.id);
        if (!marker) {
            const el = document.createElement("div");
            el.className = "bus-marker";
            el.textContent = "🚌";
            el.title = `${v.route} route`;
            marker = new maplibregl.Marker({ element: el }).setLngLat([v.lng, v.lat]).addTo(map);
            busMarkers.set(v.id, marker);
        }
        marker.getElement().style.borderColor = v.color;
        marker.setLngLat([v.lng, v.lat]);
    }
    for (const [id, marker] of busMarkers) {
        if (!seen.has(id)) {
            marker.remove();
            busMarkers.delete(id);
        }
    }
}

setInterval(refreshBuses, BUS_REFRESH_MS);

function setAccessible(on) {
    if (routing) return;
    accessible = on;
    document.body.dataset.accessible = on;
    $("chip-access").setAttribute("aria-pressed", on);
    toggleLayer("ada", on);   // entrances come with accessible mode
    mapReady.then(() => map.setLayoutProperty("sidewalk-issues", "visibility", on ? "visible" : "none"));

    // re-plan the route on screen for the new mode
    if (mode === "preview") getRoute(tripStart(), lngLatToPoint(dest.getLngLat()));
}

// ---- Live location ----
if ("geolocation" in navigator) {
    statusEl.textContent = "Finding your location…";
    navigator.geolocation.watchPosition(onFix, onFixError, {
        enableHighAccuracy: true,
        maximumAge: 2000,
        timeout: 15000,
    });
} else {
    statusEl.textContent = "No location on this device. Tap the map to set a start point";
}

function onFix(pos) {
    const prev = here;
    here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    accuracy = pos.coords.accuracy;

    // Direction of travel: GPS heading if the device gives one, otherwise from movement.
    // While on route, updateProgress() uses the route's direction instead (steadier).
    if (Number.isFinite(pos.coords.heading) && pos.coords.speed > 0.5) heading = pos.coords.heading;
    else if (prev && distance(prev, here) > 3) heading = bearing(prev, here);

    if (!youMarker) {
        const el = document.createElement("div");
        el.className = "you";
        el.innerHTML = '<div class="cone"></div><div class="dot"></div>';
        youMarker = new maplibregl.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "map" })
            .setLngLat(toLngLat(here))
            .addTo(map);

        if (mode === "idle" && !start) {
            if (gpsUsable()) {
                statusEl.textContent = idleHint();
                map.jumpTo({ center: toLngLat(here), zoom: 17 });
            } else {
                statusEl.textContent = "You're off campus. Tap the map to set a start point";
            }
        }
    }
    youMarker.setLngLat(toLngLat(here));

    if (mode === "nav") updateProgress();
}

function onFixError(err) {
    if (!here && mode === "idle") {
        statusEl.textContent = `Location unavailable (${err.message}). Tap the map to set a start point`;
    }
}

// ---- Tapping the map ----
map.on("click", (e) => {
    const box = [[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]];
    const tapped = (ids) => map.queryRenderedFeatures(box, { layers: ids.filter((id) => map.getLayer(id)) })[0];

    const callbox = tapped(["callboxes-route", "callboxes"]);
    if (callbox) return showCallbox(callbox);

    if (mode !== "idle" || routing) return;

    // tapping an ADA entrance routes to that exact door
    const entrance = tapped(["ada"]);
    const lngLat = entrance ? entrance.geometry.coordinates : [e.lngLat.lng, e.lngLat.lat];

    if (!gpsUsable() && !start) {
        start = new maplibregl.Marker({ color: "#5f6368" }).setLngLat(lngLat).addTo(map);
        statusEl.textContent = "Now search or tap your destination";
        return;
    }

    setDestination(lngLat, entrance ? entranceName(entrance.properties) : null);
});

// lngLat: [lng, lat]; name: the building, when there is one
function setDestination(lngLat, name) {
    closeSearch();
    destName = name;
    dest = new maplibregl.Marker({ color: "#d93025" }).setLngLat(lngLat).addTo(map);
    statusEl.textContent = destName ? `Finding a route to ${destName}…` : "Finding the safest route…";
    getRoute(tripStart(), { lat: lngLat[1], lng: lngLat[0] });
}

function showCallbox(feature) {
    const p = feature.properties;
    const el = document.createElement("div");
    const title = document.createElement("strong");
    const info = document.createElement("div");
    title.textContent = p.phone_name || "Call box";
    info.textContent = ["Blue-light emergency phone",
        p.camera === "Yes" && "camera",
        p.blue_light_condition === "light_no" && "light not working"].filter(Boolean).join(" · ");
    el.append(title, info);

    new maplibregl.Popup({ offset: 12, closeButton: false })
        .setLngLat(feature.geometry.coordinates)
        .setDOMContent(el)
        .addTo(map);
}

const entranceName = (p) => buildingName(p) || "Accessible entrance";

// "153 - ADA Building Entrance - Klaus Advanced Computing" → "Klaus Advanced Computing" ("" if there's no name)
function buildingName(p) {
    return (p.Description || p.Name || "")
        .replace(/&amp;/g, "&")
        .split(/\s+-\s*|\s*-\s+/)                                  // " - " separators, but keep "Bunger-Henry"
        .map((part) => part.replace(/\bADA\b|\b(Building\s+)?Entrance\b|\bElevator Access\b|=/gi, "").replace(/\s+/g, " ").trim())
        .filter((part) => part && !/^\d+[A-Z]?$/i.test(part))    // building numbers like "153" or "60A"
        .join(" - ");
}

// ---- Building search ----
// Every building with an accessible entrance in GT's data; picking one routes to its entrance nearest the start
const buildings = new Map();   // name → [[lng, lat], ...]
const isEntrance = (p) => `${p.Name ?? ""} ${p.Description ?? ""}`.toLowerCase().includes("entrance");   // as the map's ADA layer
const searchInput = $("search-input");
const suggestionsEl = $("suggestions");

fetch("/data/gt_ada_entrances.geojson")
    .then((res) => res.json())
    .then((data) => {
        for (const f of data.features) {
            const name = isEntrance(f.properties) && buildingName(f.properties);
            if (name) buildings.set(name, [...(buildings.get(name) ?? []), f.geometry.coordinates]);
        }
        // "Klaus Advanced Computing Building" is the same place as "Klaus Advanced Computing"
        for (const [name, doors] of buildings) {
            const short = name.replace(/ Building$/, "");
            if (short !== name && buildings.has(short)) {
                buildings.get(short).push(...doors);
                buildings.delete(name);
            }
        }
    });

// Every word typed must appear in the name; names that start with the first word come first
function searchBuildings(text) {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const matches = [];
    for (const name of buildings.keys()) {
        const lower = name.toLowerCase();
        if (!words.every((w) => lower.includes(w))) continue;
        const at = lower.indexOf(words[0]);
        matches.push({ name, rank: at === 0 ? 0 : /\w/.test(lower[at - 1]) ? 2 : 1 });   // name start, word start, mid-word
    }
    return matches.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).slice(0, 6).map((m) => m.name);
}

searchInput.addEventListener("input", () => showSuggestions(searchBuildings(searchInput.value)));

function showSuggestions(names) {
    suggestionsEl.replaceChildren(...names.map((name) => {
        const item = document.createElement("li");
        item.textContent = name;
        item.setAttribute("role", "option");
        item.addEventListener("click", () => goToBuilding(name));
        return item;
    }));
    suggestionsEl.hidden = !names.length;
}

// Enter picks the top suggestion; anything that isn't a building name goes to the AI
$("search").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = searchInput.value.trim();
    const [top] = searchBuildings(text);
    if (top) goToBuilding(top);
    else if (text) askAI(text);
});

// "tech tower, I use a wheelchair" → Evans Administration, accessible mode on
async function askAI(text) {
    if (mode !== "idle" || routing) return;
    suggestionsEl.hidden = true;
    statusEl.textContent = "Thinking…";
    try {
        const res = await api("/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
        const settings = await res.json();
        if (!res.ok) throw new Error(settings.error);
        if (!settings.destination) {
            statusEl.textContent = `Couldn't find a building in “${text}”`;
            return;
        }
        if (settings.accessible && !accessible) setAccessible(true);   // never switches it off for you
        goToBuilding(settings.destination, settings.mode);
    } catch (err) {
        statusEl.textContent = err.message;
    }
}

function goToBuilding(name, pick = "safe") {
    if (mode !== "idle" || routing) return;
    if (!gpsUsable() && !start) {
        statusEl.textContent = "Tap the map to set your start point first";
        return;
    }
    preferred = pick;
    const from = tripStart();
    const away = ([lng, lat]) => distance(from, { lat, lng });
    setDestination(buildings.get(name).reduce((a, b) => (away(a) <= away(b) ? a : b)), name);
}

function closeSearch() {
    searchInput.value = "";
    suggestionsEl.hidden = true;
    searchInput.blur();   // drops the phone keyboard
}

// ---- Preview: compare the two routes ----
async function getRoute(from, to, { reroute = false } = {}) {
    routing = true;
    try {
        const res = await api(`/route?from=${from.lat},${from.lng}&to=${to.lat},${to.lng}&accessible=${accessible ? 1 : 0}`);
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (!dest) return;   // user cancelled while we were waiting
        await mapReady;

        routes = data;
        setSource("safe", data.safe.geojson);
        setSource("walked", EMPTY);
        map.setFilter("callboxes-route", routeCallboxes(data.safe.callboxes));

        if (reroute) {
            showOnly("safe");   // reroutes always follow the safest walk
            startNav(data.safe);
            speak("Rerouting");
            return;
        }

        const same = data.safe.length_m === data.shortest.length_m;
        setSource("shortest", same ? EMPTY : data.shortest.geojson);
        setSource("bus-walk", data.bus ? data.bus.walk_geojson : EMPTY);
        setSource("bus-ride", data.bus ? data.bus.ride_geojson : EMPTY);
        showPreview(data, same);
    } catch (err) {
        statusEl.textContent = `Couldn't get a route: ${err.message}`;
        if (!reroute) clearTrip({ keepStatus: true });
    } finally {
        routing = false;
    }
}

function showPreview(data, same) {
    setMode("preview");
    map.setLayoutProperty("shortest", "visibility", "visible");
    statusEl.textContent = destName ? `To ${destName}` : same ? "The shortest route is also the safest" : "Compare routes, then start";

    fillOption("safe", data.safe);
    fillOption("short", data.shortest);
    $("safe-tag").textContent = accessible ? "♿ Safest" : "Safest";
    document.querySelector(".route-option.shortest").style.display = same ? "none" : "";

    document.querySelector(".route-option.bus").style.display = data.bus ? "" : "none";
    if (data.bus) fillBusOption(data.bus);
    const option = preferredOption(data, same);
    selectOption(option);
    if (preferred === "bus" && option !== "bus") statusEl.textContent = "No bus right now, so here's the safest walk";
    refreshBuses();

    // fit both routes into the space between the top chips and the bottom card
    const height = map.getContainer().clientHeight;
    let top = $("top-stack").getBoundingClientRect().bottom + 16;
    let bottom = height - $("preview-card").getBoundingClientRect().top + 16;
    const room = height - 120;
    if (top + bottom > room) [top, bottom] = [top * room / (top + bottom), bottom * room / (top + bottom)];

    const bounds = new maplibregl.LngLatBounds();
    [...data.safe.line, ...data.shortest.line, ...(data.bus?.line ?? [])].forEach(([lat, lng]) => bounds.extend([lng, lat]));
    const right = $("safety").offsetWidth + 24;   // keep the route clear of the safety buttons
    map.fitBounds(bounds, { padding: { top, bottom, left: 24, right }, pitch: 0, bearing: 0, duration: 800 });
}

// The option to pre-select: "fastest" is whichever of the shortest walk and the bus arrives first
function preferredOption(data, same) {
    if (preferred === "bus" && data.bus) return "bus";
    if (preferred !== "fastest") return "safe";
    if (data.bus && data.bus.total_s < data.shortest.length_m / walkSpeed()) return "bus";
    return same ? "safe" : "shortest";
}

function fillOption(prefix, route) {
    const n = route.callboxes.length;
    $(`${prefix}-time`).textContent = formatMins(route.length_m);
    $(`${prefix}-detail`).textContent = details(formatDist(route.length_m), `${pct(route.avg_light)} lit`, `${n} call box${n === 1 ? "" : "es"}`);

    const warning = routeWarning(route);
    $(`${prefix}-warning`).textContent = warning;
    $(`${prefix}-warning`).classList.toggle("ok", !warning.startsWith("⚠"));
}

function fillBusOption(bus) {
    const n = bus.callboxes.length;
    $("bus-swatch").style.background = bus.route.color;
    $("bus-time").textContent = formatSecs(bus.total_s);
    $("bus-detail").textContent = details(bus.route.name, `bus in ${formatSecs(bus.bus_in_s)}`, `${bus.stops} stop${bus.stops === 1 ? "" : "s"}`,
        `${formatDist(bus.walk_m)} walking`, `${n} call box${n === 1 ? "" : "es"}`);
    const warning = routeWarning(bus);
    $("bus-warning").textContent = warning || `Board at ${bus.board.name}`;
    $("bus-warning").classList.toggle("ok", !warning.startsWith("⚠"));
}

// the route object behind each preview option
const optionRoute = (name) => (name === "bus" ? routes.bus : routes[name]);

// Tap an option in the preview card to pick it: it's drawn solid, the others faded
document.querySelectorAll(".route-option").forEach((row) =>
    row.addEventListener("click", () => mode === "preview" && selectOption(row.dataset.option)));

function selectOption(name) {
    selected = name;
    document.querySelectorAll(".route-option").forEach((row) => row.classList.toggle("selected", row.dataset.option === name));
    for (const [option, ids] of Object.entries(OPTION_LAYERS)) {
        ids.forEach((id) => {
            map.setLayoutProperty(id, "visibility", "visible");
            map.setPaintProperty(id, "line-opacity", option === name ? 1 : 0.35);
        });
    }
    map.setFilter("callboxes-route", routeCallboxes(optionRoute(name).callboxes));
}

function routeWarning(route) {
    const { steps, no } = route.access_m;
    if (route.closed_m > 0) return "⚠ Uses a closed sidewalk";
    if (!accessible) return "";
    if (steps > 0) return "⚠ Includes stairs";
    if (no >= 10) return `⚠ ${formatDist(no)} of sidewalk not ADA compliant`;
    return "No known barriers";
}

$("cancel").addEventListener("click", () => clearTrip());
$("end").addEventListener("click", () => clearTrip());

function clearTrip({ keepStatus = false } = {}) {
    [start, dest].forEach((m) => m && m.remove());
    start = dest = destName = routes = nav = null;
    selected = preferred = "safe";
    offRouteCount = 0;
    ["shortest", "safe", "bus-walk", "bus-ride", "walked"].forEach((id) => setSource(id, EMPTY));
    if (map.getLayer("callboxes-route")) map.setFilter("callboxes-route", routeCallboxes([]));
    window.speechSynthesis?.cancel();

    setMode("idle");
    refreshBuses();
    if (!keepStatus) statusEl.textContent = idleHint();
    map.easeTo({ center: toLngLat(gpsUsable() ? here : CAMPUS_CENTER), zoom: 16.5, pitch: 0, bearing: 0, padding: 0, duration: 800 });
}

// ---- Navigation ----
// While navigating, draw only the option being followed
function showOnly(name) {
    selected = name;
    for (const [option, ids] of Object.entries(OPTION_LAYERS)) {
        ids.forEach((id) => {
            map.setLayoutProperty(id, "visibility", option === name ? "visible" : "none");
            map.setPaintProperty(id, "line-opacity", 1);
        });
    }
}

$("start").addEventListener("click", () => {
    showOnly(selected);
    setMode("nav");
    following = true;
    const route = optionRoute(selected);
    startNav(route);
    speak(route.steps[0].instruction);
    refreshBuses();
});

function startNav(route) {
    const line = route.line.map(([lat, lng]) => ({ lat, lng }));
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + distance(line[i - 1], line[i]));

    // Re-measure each step along this line: the server's distances follow path edges and skip
    // the short hops between a path and a bus stop, which would put "Board" a few metres early
    let from = 0;
    const steps = route.steps.map((s, k) => {
        if (k === 0) return { ...s, along: 0 };
        const limit = cum[from] + (s.along - route.steps[k - 1].along) * 1.3 + 60;   // search just ahead
        let end = cum.findIndex((c) => c > limit);
        if (end < 0) end = line.length - 1;
        const snap = snapToLine({ lat: s.point[0], lng: s.point[1] }, line.slice(from, end + 1), cum.slice(from, end + 1));
        from += snap.index;
        return { ...s, along: snap.along };
    });

    nav = { line, cum, total: cum[cum.length - 1], steps, avgLight: route.avg_light, spoken: new Set([0]) };
    if (route.route) {
        // a bus trip: remember where the ride starts and ends, and when the bus is due
        nav.bus = {
            name: route.route.name,
            boardAt: steps.find((s) => s.type === "board").along,
            alightAt: steps.find((s) => s.type === "alight").along,
            dueAt: route.planned_at * 1000 + route.bus_in_s * 1000,
            rideS: route.ride_s,
        };
    }
    offRouteCount = 0;
    $("end").textContent = "End";

    if (here) {
        updateProgress();
    } else {
        // No GPS (manual start): show the first step from the start point
        heading = bearing(line[0], line[1]);
        showStep(steps[1], nav.cum[0], nav.total);
        moveCamera(line[0]);
    }
}

function updateProgress() {
    if (!gpsUsable()) {
        // A wild GPS jump (or leaving campus): don't reroute from it, wait for a sane fix
        $("nav-detail").textContent = "Waiting for a good GPS signal…";
        return;
    }
    const snap = snapToLine(here, nav.line, nav.cum);
    const remaining = nav.total - snap.along;
    nav.along = snap.along;   // for the "I feel unsafe" message

    setSource("walked", lineFeature([...nav.line.slice(0, snap.index + 1), snap.point]));

    if (remaining < ARRIVED_M || distance(here, lngLatToPoint(dest.getLngLat())) < ARRIVED_M) {
        return arrive();
    }

    // Off route? Only trust reasonably accurate fixes, and require a few in a row.
    if (snap.dist > OFF_ROUTE_M && accuracy < MAX_ACCURACY_M) offRouteCount++;
    else offRouteCount = 0;

    // (no automatic rerouting on bus trips: a walking reroute would drop the bus)
    if (!nav.bus && offRouteCount >= OFF_ROUTE_FIXES && !routing && Date.now() - lastReroute > REROUTE_GAP_MS) {
        lastReroute = Date.now();
        offRouteCount = 0;
        $("turn-arrow").textContent = "↻";
        $("turn-distance").textContent = "Rerouting…";
        $("turn-text").textContent = "Finding a new safe route";
        getRoute(here, lngLatToPoint(dest.getLngLat()), { reroute: true });
        return;
    }

    // Point the map along the route while we're on it
    if (snap.dist < OFF_ROUTE_M) {
        const i = Math.min(snap.index, nav.line.length - 2);
        heading = bearing(nav.line[i], nav.line[i + 1]);
    }

    const nextIndex = nav.steps.findIndex((s) => s.along > snap.along + 3);
    const next = nav.steps[nextIndex];
    const toNext = next.along - snap.along;
    showStep(next, snap.along, remaining);

    if (toNext <= ANNOUNCE_M && !nav.spoken.has(nextIndex)) {
        nav.spoken.add(nextIndex);
        speak(next.type === "arrive" ? "Your destination is ahead" : next.instruction);
    }

    moveCamera(here);
}

function showStep(step, along, remaining) {
    const arrive = step.type === "arrive";
    $("turn-arrow").textContent = { arrive: "🏁", board: "🚌", alight: "🚏" }[step.type] ?? ARROWS[step.modifier] ?? "↑";
    $("turn-distance").textContent = formatDist(step.along - along);
    $("turn-text").textContent = arrive ? destName ?? "Destination" : step.instruction;
    if (step.type === "board") {
        const wait = (nav.bus.dueAt - Date.now()) / 1000;
        $("turn-text").textContent += wait > 30 ? ` · bus in ${formatSecs(wait)}` : " · bus due now";
    }

    const secs = secondsLeft(along, remaining);
    const eta = new Date(Date.now() + secs * 1000);
    $("nav-time").textContent = formatSecs(secs);
    $("nav-detail").textContent = details(formatDist(remaining), eta.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
        `${pct(nav.avgLight)} lit`, offRouteCount && "off route?");
}

// Time left: walking pace, plus on a bus trip the wait for the bus and the scheduled ride
function secondsLeft(along, remaining) {
    const bus = nav.bus;
    if (!bus || along >= bus.alightAt) return remaining / walkSpeed();
    const walkAfter = (nav.total - bus.alightAt) / walkSpeed();
    if (along >= bus.boardAt) {
        return bus.rideS * (bus.alightAt - along) / (bus.alightAt - bus.boardAt) + walkAfter;
    }
    const toBus = Math.max((bus.dueAt - Date.now()) / 1000, (bus.boardAt - along) / walkSpeed());
    return toBus + bus.rideS + walkAfter;
}

function arrive() {
    setMode("arrived");
    nav = null;
    $("turn-arrow").textContent = "🏁";
    $("turn-distance").textContent = "You've arrived";
    $("turn-text").textContent = destName ? `${destName} · accessible entrance` : "Stay safe!";
    $("nav-time").textContent = "Arrived";
    $("nav-detail").textContent = "";
    $("end").textContent = "Done";
    speak("You have arrived");
    map.easeTo({ pitch: 30, zoom: 17.5, duration: 1000 });
}

// Camera: zoomed in, tilted, map rotated so the direction of travel points up,
// with you in the lower part of the screen so you can see what's ahead.
function moveCamera(at) {
    youMarker?.setRotation(heading);
    if (!following) return;
    map.easeTo({
        center: toLngLat(at),
        bearing: heading,
        pitch: NAV_PITCH,
        zoom: NAV_ZOOM,
        padding: { top: map.getContainer().clientHeight * 0.35, bottom: 0, left: 0, right: 0 },
        duration: 1000,
        easing: (t) => t,
    });
}

// Stop following when the user drags the map; Recenter turns it back on.
map.on("dragstart", () => {
    if (mode !== "nav") return;
    following = false;
    $("recenter").hidden = false;
});

$("recenter").addEventListener("click", () => {
    following = true;
    $("recenter").hidden = true;
    if (here) moveCamera(here);
});

// ---- Voice ----
$("voice").addEventListener("click", () => {
    voiceOn = !voiceOn;
    $("voice").textContent = voiceOn ? "🔊" : "🔇";
    if (!voiceOn) window.speechSynthesis?.cancel();
});

function speak(text) {
    if (!voiceOn || !window.speechSynthesis) return;
    speechSynthesis.cancel();
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
}

// ---- Sign-in (Supabase): campus email, then a code emailed to it ----
let sb = null;     // Supabase client; stays null when the server has no Supabase settings (local testing)
let user = null;   // the signed-in user

fetch("/config")
    .then((res) => res.json())
    .then((cfg) => {
        if (!cfg.supabaseUrl) return;
        sb = supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
        sb.auth.onAuthStateChange((event, session) => {
            const next = session?.user ?? null;
            if (next?.id !== user?.id) {
                contact = null;
                if (next) setTimeout(loadContact);   // Supabase says not to await its calls inside this callback
            }
            user = next;
            $("signin").hidden = !!user;
        });
    });

// Our server wants the sign-in token; a 401 means the session ended, so ask to sign in again
async function api(url, options = {}) {
    const session = sb && (await sb.auth.getSession()).data.session;
    const headers = { ...options.headers, ...(session && { Authorization: `Bearer ${session.access_token}` }) };
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401 && sb) $("signin").hidden = false;
    return res;
}

const signinError = (text) => ($("signin-error").textContent = text);

function showSigninStep(step) {
    $("signin-email").hidden = step !== "email";
    $("signin-code").hidden = step !== "code";
}

$("signin-email").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("email").value.trim().toLowerCase();
    if (!email.endsWith(".edu")) return signinError("Please use your campus (.edu) email");
    signinError("");
    const button = e.target.querySelector("[type=submit]");
    button.disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email });
    button.disabled = false;
    if (error) return signinError(error.message);
    $("signin-sent-to").textContent = email;
    showSigninStep("code");
    $("code").focus();
});

$("signin-code").addEventListener("submit", async (e) => {
    e.preventDefault();
    const button = e.target.querySelector("[type=submit]");
    button.disabled = true;
    const { error } = await sb.auth.verifyOtp({ email: $("email").value.trim().toLowerCase(), token: $("code").value.trim(), type: "email" });
    button.disabled = false;
    if (error) return signinError(error.message);
    signinError("");   // the sign-in listener hides the screen; reset it for next time
    $("code").value = "";
    showSigninStep("email");
});

$("signin-back").addEventListener("click", () => {
    signinError("");
    showSigninStep("email");
});

// ---- Safety: "I feel unsafe" and GTPD ----
// We don't send anything ourselves: the phone's own texting app and dialer do, so the contact sees your number
let contact = null;          // your emergency contact: loaded from your account, kept here so the button acts instantly
let textAfterSave = false;   // the contact form was opened by "I feel unsafe", so text once it's saved

async function loadContact() {
    const { data, error } = await sb.from("contacts").select("name, phone").maybeSingle();
    if (!error) contact = data;
}

function saveContact(next) {
    contact = next;
    if (!sb) return;   // no sign-in (local testing): remembered until the page reloads
    sb.from("contacts")
        .upsert({ user_id: user.id, ...next, updated_at: new Date().toISOString() })
        .then(({ error }) => error && (statusEl.textContent = `Couldn't save your contact: ${error.message}`));
}

$("unsafe").addEventListener("click", () => (contact ? textContact(contact) : editContact({ thenText: true })));

function editContact({ thenText = false } = {}) {
    $("contact-name").value = contact?.name ?? "";
    $("contact-phone").value = contact?.phone ?? "";
    $("account").hidden = !user;
    $("account-email").textContent = user?.email ?? "";
    textAfterSave = thenText;
    $("contact-dialog").showModal();
}

$("contact-cancel").addEventListener("click", () => $("contact-dialog").close());
$("contact-form").addEventListener("submit", () => {   // method="dialog": the form closes itself
    saveContact({ name: $("contact-name").value.trim(), phone: $("contact-phone").value.trim() });
    if (textAfterSave) textContact(contact);
});
$("signout").addEventListener("click", () => {
    $("contact-dialog").close();
    sb.auth.signOut();
});

function textContact(to) {
    const phone = to.phone.replace(/[^\d+]/g, "");
    openLink(`sms:${phone}?&body=${encodeURIComponent(alertMessage())}`);   // "?&body=" works on iPhone and Android
    $("unsafe-title").textContent = `Texting ${to.name}`;
    if (!$("unsafe-dialog").open) $("unsafe-dialog").showModal();
}

// Where you are, your trip and how far along it, and the time
function alertMessage() {
    const time = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const lines = [`I feel unsafe and want you to know where I am (${time}, sent from Sherpa).`];
    lines.push(here ? `I'm here: ${mapLink(here)}` : "My phone couldn't get my location.");
    if (dest && (mode === "nav" || mode === "preview")) {
        const to = `${destName ?? "a spot on the map"} ${mapLink(lngLatToPoint(dest.getLngLat()))}`;
        const from = mapLink(mode === "nav" ? nav.line[0] : tripStart());
        lines.push(mode === "nav" ? `I'm walking to ${to}` : `I'm about to walk to ${to}`, `I started at ${from}`);
        if (mode === "nav" && nav.along != null) {
            lines.push(`I'm ${Math.round((100 * nav.along) / nav.total)}% of the way there, ${formatDist(nav.total - nav.along)} to go.`);
        }
    }
    return lines.join("\n");
}

const mapLink = (p) => `https://maps.google.com/?q=${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;

function openLink(url) {
    window.location.href = url;
}

$("unsafe-again").addEventListener("click", () => textContact(contact));
$("unsafe-done").addEventListener("click", () => $("unsafe-dialog").close());
$("unsafe-edit").addEventListener("click", () => {
    $("unsafe-dialog").close();
    editContact();
});
$("unsafe-gtpd").addEventListener("click", () => {
    $("unsafe-dialog").close();
    $("gtpd-dialog").showModal();
});

// GTPD: one confirmation, then the "Call now" link opens the dialer
$("gtpd").addEventListener("click", () => $("gtpd-dialog").showModal());
$("gtpd-cancel").addEventListener("click", () => $("gtpd-dialog").close());
$("gtpd-call").addEventListener("click", () => $("gtpd-dialog").close());

// ---- Geometry helpers ----
const ARROWS = {
    "straight": "↑",
    "slight left": "↖", "left": "↰", "sharp left": "↺",
    "slight right": "↗", "right": "↱", "sharp right": "↻",
};

function toLngLat(p) {
    return [p.lng, p.lat];
}

function lngLatToPoint(ll) {
    return { lat: ll.lat, lng: ll.lng };
}

function lineFeature(points) {
    return { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: points.map(toLngLat) } };
}

function distance(a, b) {
    const R = 6371000, r = Math.PI / 180;
    const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
}

function bearing(a, b) {
    const r = Math.PI / 180;
    const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
    const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
}

// Nearest point on the route to `p`: how far away it is, and how far along the route.
function snapToLine(p, line, cum) {
    // Flat x/y in metres around p. Fine at campus scale.
    const kx = 111320 * Math.cos((p.lat * Math.PI) / 180);
    const ky = 110540;
    const xy = (q) => [(q.lng - p.lng) * kx, (q.lat - p.lat) * ky];

    let best = { dist: Infinity, index: 0, point: line[0], along: 0 };
    for (let i = 0; i < line.length - 1; i++) {
        const [ax, ay] = xy(line[i]);
        const [bx, by] = xy(line[i + 1]);
        const dx = bx - ax, dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        const cx = ax + t * dx, cy = ay + t * dy;
        const dist = Math.hypot(cx, cy);

        if (dist < best.dist) {
            best = {
                dist,
                index: i,
                point: { lat: p.lat + cy / ky, lng: p.lng + cx / kx },
                along: cum[i] + t * (cum[i + 1] - cum[i]),
            };
        }
    }
    return best;
}

// ---- Formatting ----
// "1000 m · 93% lit · 10 call boxes": on a narrow phone it wraps between the parts, never inside one
const details = (...parts) => parts.filter(Boolean).map((part) => part.replaceAll(" ", "\u00a0")).join(" · ");

function formatDist(m) {
    return m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`;
}

function formatMins(m) {
    return formatSecs(m / walkSpeed());
}

function formatSecs(s) {
    return `${Math.max(1, Math.round(s / 60))} min`;
}

function pct(x) {
    return `${Math.round(x * 100)}%`;
}
