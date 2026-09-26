const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ===================================================================
// REAL MAP DATA
// These three coordinate arrays are real walking-street geometry,
// fetched once from the public OSRM routing API (router.project-osrm.org)
// between Klaus Advanced Computing Building and North Ave on GT campus.
// They are hardcoded here so the page has no runtime dependency on a
// routing API — only on map tiles, which a real map always needs.
// Swap these for your own routing backend's output when it's ready.
// ===================================================================
const ORIGIN = [-84.39575, 33.77762];
const DEST   = [-84.39493, 33.7735];

const ROUTES = {
  fastest: { dist: 879,
    coords: [[-84.39575,33.77762],[-84.39572,33.77757],[-84.3957,33.77754],[-84.39566,33.77748],[-84.39545,33.77716],[-84.39541,33.77711],[-84.39538,33.77708],[-84.39535,33.77705],[-84.39527,33.77701],[-84.39514,33.77696],[-84.39511,33.77696],[-84.39504,33.77695],[-84.39479,33.77694],[-84.3943,33.77694],[-84.39418,33.77694],[-84.39406,33.77693],[-84.39386,33.77693],[-84.39372,33.77693],[-84.39364,33.77693],[-84.39364,33.77685],[-84.39364,33.77667],[-84.39364,33.77647],[-84.39364,33.77645],[-84.39365,33.77602],[-84.39365,33.77593],[-84.39375,33.77593],[-84.39384,33.77593],[-84.39397,33.77592],[-84.39407,33.77591],[-84.39423,33.77589],[-84.39429,33.77588],[-84.39427,33.77582],[-84.39426,33.77578],[-84.39417,33.77544],[-84.39415,33.7754],[-84.39414,33.77536],[-84.39395,33.77475],[-84.39379,33.7742],[-84.39372,33.77397],[-84.39373,33.77391],[-84.39387,33.77391],[-84.39413,33.77391],[-84.39421,33.77391],[-84.39421,33.77387],[-84.39422,33.77368],[-84.39422,33.77349],[-84.39422,33.77348],[-84.39423,33.77335],[-84.39423,33.77307],[-84.39428,33.77308],[-84.39495,33.7731],[-84.39493,33.77345],[-84.39493,33.7735]]
  },
  safe: { dist: 933,
    coords: [[-84.39575,33.77762],[-84.39572,33.77757],[-84.3957,33.77754],[-84.39566,33.77748],[-84.39545,33.77716],[-84.39541,33.77711],[-84.39538,33.77708],[-84.39535,33.77705],[-84.39527,33.77701],[-84.39514,33.77696],[-84.39511,33.77696],[-84.39504,33.77695],[-84.39479,33.77694],[-84.3943,33.77694],[-84.39418,33.77694],[-84.39406,33.77693],[-84.39386,33.77693],[-84.39372,33.77693],[-84.39364,33.77693],[-84.39364,33.77685],[-84.39364,33.77667],[-84.39364,33.77647],[-84.39364,33.77645],[-84.39365,33.77602],[-84.39365,33.77593],[-84.39348,33.77591],[-84.3933,33.77587],[-84.39332,33.77581],[-84.39331,33.77579],[-84.39329,33.77572],[-84.39324,33.77558],[-84.3932,33.7755],[-84.39313,33.77521],[-84.39311,33.77506],[-84.3931,33.77478],[-84.39308,33.7746],[-84.39302,33.77442],[-84.39287,33.77406],[-84.39285,33.77399],[-84.39285,33.77397],[-84.39286,33.7739],[-84.39292,33.7739],[-84.39368,33.77391],[-84.39373,33.77391],[-84.39387,33.77391],[-84.39413,33.77391],[-84.39421,33.77391],[-84.39421,33.77387],[-84.39422,33.77368],[-84.39422,33.77349],[-84.39422,33.77348],[-84.39423,33.77335],[-84.39423,33.77307],[-84.39428,33.77308],[-84.39495,33.7731],[-84.39493,33.77345],[-84.39493,33.7735]]
  },
  flat: { dist: 1120,
    coords: [[-84.39575,33.77762],[-84.39572,33.77757],[-84.3957,33.77754],[-84.39566,33.77748],[-84.39545,33.77716],[-84.39541,33.77711],[-84.39538,33.77708],[-84.39535,33.77705],[-84.39527,33.77701],[-84.39514,33.77696],[-84.39511,33.77696],[-84.39504,33.77695],[-84.39479,33.77694],[-84.3943,33.77694],[-84.39418,33.77694],[-84.39406,33.77693],[-84.39386,33.77693],[-84.39372,33.77693],[-84.39364,33.77693],[-84.39357,33.77693],[-84.39304,33.77692],[-84.39298,33.77692],[-84.39282,33.77691],[-84.3925,33.77691],[-84.39218,33.7769],[-84.3921,33.7769],[-84.3921,33.77682],[-84.3921,33.77673],[-84.39209,33.77663],[-84.39206,33.77645],[-84.39205,33.77629],[-84.39199,33.77585],[-84.39199,33.77579],[-84.39198,33.77557],[-84.39198,33.7755],[-84.39198,33.77544],[-84.39198,33.77541],[-84.39197,33.77526],[-84.39198,33.77514],[-84.39197,33.77506],[-84.39197,33.77499],[-84.39198,33.77486],[-84.39198,33.7747],[-84.39198,33.7744],[-84.39199,33.774],[-84.39199,33.77397],[-84.39199,33.77391],[-84.39208,33.77391],[-84.39257,33.77391],[-84.39274,33.7739],[-84.3928,33.7739],[-84.39286,33.7739],[-84.39292,33.7739],[-84.39368,33.77391],[-84.39373,33.77391],[-84.39387,33.77391],[-84.39413,33.77391],[-84.39421,33.77391],[-84.39421,33.77387],[-84.39422,33.77368],[-84.39422,33.77349],[-84.39422,33.77348],[-84.39423,33.77335],[-84.39423,33.77307],[-84.39428,33.77308],[-84.39495,33.7731],[-84.39493,33.77345],[-84.39493,33.7735]]
  }
};

// OSRM returns a vertex every few meters, including runs of near-duplicate points at turns.
// At this card's zoom level those become sub-pixel segments, which WebGL line rendering
// draws as visible gaps. Dropping points closer than ~3m together fixes that cleanly.
(function simplifyRoutes() {
  const minDeg = 0.00003;
  Object.values(ROUTES).forEach(r => {
    const out = [r.coords[0]];
    for (let i = 1; i < r.coords.length; i++) {
      const prev = out[out.length - 1], c = r.coords[i];
      const d = Math.hypot(c[0] - prev[0], c[1] - prev[1]);
      if (d > minDeg || i === r.coords.length - 1) out.push(c);
    }
    r.coords = out;
  });
})();

const WALK_M_PER_MIN = 80; // ~4.8 km/h, used to turn real distances into honest minute estimates
function minutesFor(meters) { return Math.round(meters / WALK_M_PER_MIN); }
function milesFor(meters) { return (meters * 0.000621371).toFixed(1); }

const SCENARIOS = {
  night:  { recommended: "safe", whyClauses: ["better lighting", "passes 2 emergency call boxes"],
            icons: [{ type: "lamp", at: .12 }, { type: "lamp", at: .3 }, { type: "callbox", at: .45 }, { type: "lamp", at: .62 }, { type: "callbox", at: .8 }] },
  injury: { recommended: "flat", whyClauses: ["fewer curbs", "gentler grade", "ends at an accessible entrance"],
            icons: [{ type: "ada", at: .95 }] },
  stairs: { recommended: "flat", whyClauses: ["avoids stairs entirely", "step free the whole way"],
            icons: [{ type: "ada", at: .95 }] }
};

let recommendedKey = "safe"; // which ROUTES entry is currently rendered as the green "recommended" layer
const markers = []; // overlay icon markers, cleared and rebuilt per scenario
let originMarker, destMarker, labelFastest, labelRecommended;

function lineFeature(coords) {
  return { type: "Feature", geometry: { type: "LineString", coordinates: coords } };
}
function pointAt(coords, t) {
  return coords[Math.max(0, Math.min(coords.length - 1, Math.round(t * (coords.length - 1))))];
}
function makeIconEl(type) {
  const el = document.createElement("div");
  el.className = "map-icon " + type;
  if (type === "ada") el.textContent = "♿";
  if (type === "report") el.textContent = "!";
  return el;
}
function pinSvg() {
  return '<svg viewBox="0 0 26 34" width="26" height="34">' +
    '<path d="M13 33C13 33 25 19.5 25 13C25 5.8 19.6 1 13 1C6.4 1 1 5.8 1 13C1 19.5 13 33 13 33Z" fill="var(--blaze)" stroke="#fff" stroke-width="1.5"/>' +
    '<circle cx="13" cy="13" r="5" fill="#fff"/></svg>';
}

const map = new maplibregl.Map({
  container: "map-frame",
  style: {
    version: 8,
    sources: {
      "esri-base": {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256, maxzoom: 16,
        attribution: 'Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
      },
      "esri-ref": {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256, maxzoom: 16
      }
    },
    layers: [
      { id: "base", type: "raster", source: "esri-base", paint: { "raster-saturation": -0.2, "raster-brightness-min": .08 } },
      { id: "ref", type: "raster", source: "esri-ref" }
    ]
  },
  center: ORIGIN,
  zoom: 15.8,
  attributionControl: false,
  cooperativeGestures: true
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

map.on("load", () => {
  map.addSource("fastest-src", { type: "geojson", data: lineFeature(ROUTES.fastest.coords) });
  map.addSource("recommended-src", { type: "geojson", data: lineFeature(ROUTES.safe.coords) });
  map.addSource("halo-src", { type: "geojson", data: lineFeature(ROUTES.safe.coords) });

  map.addLayer({ id: "halo", type: "line", source: "halo-src",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffffff", "line-width": 9, "line-opacity": 0 } });
  map.addLayer({ id: "fastest-line", type: "line", source: "fastest-src",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#2C5AA0", "line-width": 4, "line-opacity": .75 } });
  map.addLayer({ id: "recommended-glow", type: "line", source: "recommended-src",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#2F7D5B", "line-width": 11, "line-opacity": reduced ? .18 : 0, "line-blur": 2 } });
  map.addLayer({ id: "recommended-line", type: "line", source: "recommended-src",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#2F7D5B", "line-width": 5, "line-opacity": reduced ? 1 : 0 } });

  if (!reduced) {
    map.setPaintProperty("recommended-line", "line-opacity-transition", { duration: 700 });
    map.setPaintProperty("recommended-glow", "line-opacity-transition", { duration: 700 });
    requestAnimationFrame(() => {
      map.setPaintProperty("recommended-line", "line-opacity", 1);
      map.setPaintProperty("recommended-glow", "line-opacity", .18);
    });
  }

  // start beacon + destination pin
  const originEl = document.createElement("div");
  originEl.className = "map-origin";
  originEl.innerHTML = '<span class="ring"></span><span class="dot"></span>';
  originMarker = new maplibregl.Marker({ element: originEl, anchor: "center" }).setLngLat(ORIGIN).addTo(map);

  const destEl = document.createElement("div");
  destEl.className = "map-pin";
  destEl.innerHTML = pinSvg();
  destMarker = new maplibregl.Marker({ element: destEl, anchor: "bottom" }).setLngLat(DEST).addTo(map);

  // duration labels — placeholder position until applyScenario() sets the real one
  labelFastest = new maplibregl.Marker({ element: makeLabelEl("fastest"), anchor: "center" }).setLngLat(ORIGIN).addTo(map);
  labelRecommended = new maplibregl.Marker({ element: makeLabelEl("recommended"), anchor: "center" }).setLngLat(ORIGIN).addTo(map);

  // fit the map to whichever route is widest, so both always sit comfortably in frame
  const bounds = new maplibregl.LngLatBounds();
  [ROUTES.fastest.coords, ROUTES.safe.coords, ROUTES.flat.coords].forEach(c => c.forEach(pt => bounds.extend(pt)));
  map.fitBounds(bounds, { padding: 34, duration: 0 });

  // clicking either line selects it: brings it to front with a white halo underneath
  const layerForKey = key => key === "fastest" ? "fastest-line" : "recommended-line";
  map.on("click", "recommended-line", () => selectRoute(recommendedKey));
  map.on("click", "fastest-line", () => selectRoute("fastest"));
  ["fastest-line", "recommended-line"].forEach(layerId => {
    map.on("mouseenter", layerId, () => map.getCanvas().style.cursor = "pointer");
    map.on("mouseleave", layerId, () => map.getCanvas().style.cursor = "");
  });

  applyScenario("night");

  function selectRoute(key) {
    map.getSource("halo-src").setData(lineFeature(ROUTES[key].coords));
    map.setPaintProperty("halo", "line-opacity", .5);
    map.moveLayer(layerForKey(key));
  }
});

function makeLabelEl(role) {
  const el = document.createElement("div");
  el.className = "route-label " + role;
  return el;
}

function applyScenario(name) {
  const s = SCENARIOS[name];
  recommendedKey = s.recommended;

  map.getSource("recommended-src").setData(lineFeature(ROUTES[recommendedKey].coords));
  map.getSource("halo-src").setData(lineFeature(ROUTES[recommendedKey].coords));
  map.setPaintProperty("halo", "line-opacity", 0);

  const fastestMin = minutesFor(ROUTES.fastest.dist);
  const recommendedMin = minutesFor(ROUTES[recommendedKey].dist);
  const scaleMax = Math.max(fastestMin, recommendedMin, 10) + 2;

  labelFastest.setLngLat(pointAt(ROUTES.fastest.coords, .5)).getElement().textContent = fastestMin + " min";
  labelRecommended.setLngLat(pointAt(ROUTES[recommendedKey].coords, .58)).getElement().textContent = recommendedMin + " min";

  document.getElementById("fastFill").style.width = (fastestMin / scaleMax * 100) + "%";
  document.getElementById("yourFill").style.width = (recommendedMin / scaleMax * 100) + "%";
  document.getElementById("fastTime").innerHTML = fastestMin + " min<span class=\"cdist\">· " + milesFor(ROUTES.fastest.dist) + " mi</span>";
  document.getElementById("yourTime").innerHTML = recommendedMin + " min<span class=\"cdist\">· " + milesFor(ROUTES[recommendedKey].dist) + " mi</span>";

  const delta = recommendedMin - fastestMin;
  const deltaText = delta > 0 ? delta + " min longer" : (delta < 0 ? Math.abs(delta) + " min shorter" : "same time");
  document.getElementById("why").textContent = [deltaText, ...s.whyClauses].join(" · ");

  // overlay icons: clear old, place new ones sampled along whichever route each icon calls for
  markers.forEach(m => m.remove());
  markers.length = 0;
  s.icons.forEach(icon => {
    const routeCoords = icon.route === "fastest" ? ROUTES.fastest.coords : ROUTES[recommendedKey].coords;
    const marker = new maplibregl.Marker({ element: makeIconEl(icon.type), anchor: "center" })
      .setLngLat(pointAt(routeCoords, icon.at)).addTo(map);
    markers.push(marker);
  });
}

document.querySelectorAll(".scenario").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".scenario").forEach(b => b.setAttribute("aria-pressed", b === btn));
    applyScenario(btn.dataset.s);
  });
});

// Mobile nav toggle
const navToggle = document.querySelector(".nav-toggle");
const navLinks = document.getElementById("nav-links");
navToggle.addEventListener("click", () => {
  const open = navToggle.getAttribute("aria-expanded") === "true";
  navToggle.setAttribute("aria-expanded", String(!open));
  navLinks.classList.toggle("open", !open);
});
navLinks.querySelectorAll("a").forEach(a => a.addEventListener("click", () => {
  navToggle.setAttribute("aria-expanded", "false");
  navLinks.classList.remove("open");
}));

// Scroll progress bar + nav shadow
const progress = document.getElementById("progress");
window.addEventListener("scroll", () => {
  const h = document.documentElement;
  const scrolled = h.scrollTop;
  const height = h.scrollHeight - h.clientHeight;
  progress.style.width = (height > 0 ? (scrolled / height) * 100 : 0) + "%";
  document.body.classList.toggle("scrolled", scrolled > 80);
}, { passive: true });

// Scroll reveal — skipped entirely under reduced motion, so content never depends on JS to be visible
if (!reduced) {
  const fadeEls = document.querySelectorAll(".step, .benefit-card");
  const io = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("in-view");
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: "0px 0px -40px 0px" });
  fadeEls.forEach(el => { el.classList.add("pre-reveal"); io.observe(el); });

  // Headings use clip-path, which some renderers report a stuck 0 intersection
  // ratio for — so this one uses threshold: 0 (fires on any overlap) instead.
  const wipeEls = document.querySelectorAll(".wipe, .steps-track");
  const wipeIO = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add("in-view");
        wipeIO.unobserve(entry.target);
      }
    });
  }, { threshold: 0 });
  wipeEls.forEach(el => wipeIO.observe(el));
}

// ===== Scroll-linked campus route + bus =====
// Path is built in real pixel coordinates from each section's measured
// position, so it stays aligned without hardcoded breakpoints. Desktop only
// (hidden under 860px via CSS) and skipped entirely under reduced motion.
(function routeScroll() {
  const scene = document.querySelector(".route-scene");
  const layer = document.getElementById("route-layer");
  const svg = document.getElementById("route-svg");
  const path = document.getElementById("route-path");
  const bus = document.getElementById("route-bus");
  const stops = Array.from(document.querySelectorAll(".route-stop"));
  if (!scene || !path || reduced) return;

  const STOP_SELECTORS = [".hero", "#features", "#how", ".center-block"];
  const ANCHOR_X = [0.2, 0.8, 0.18, 0.74]; // gentle weave, ending well to the right of the CTA

  let totalLength = 0;
  let busW = 0, busH = 0;
  let displayedT = 0; // eased position actually rendered, always chasing targetT()
  let active = false;
  let readyOnce = false;

  function layout() {
    const w = scene.clientWidth;
    const h = scene.offsetHeight;
    if (w < 1 || h < 1) return;
    const sceneRect = scene.getBoundingClientRect();

    layer.style.height = h + "px";
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);

    // Measure each section's real content box (not the section's own padded
    // box), so stops can sit in the actual measured gap between one section's
    // content and the next — robust to whatever that gap really is, rather than
    // assuming a padding value.
    const contentBands = STOP_SELECTORS.map(sel => {
      const c = document.querySelector(sel + " > .wrap");
      const r = c.getBoundingClientRect();
      return { top: r.top - sceneRect.top, bottom: r.bottom - sceneRect.top };
    });

    const anchors = contentBands.map((band, i) => {
      const next = contentBands[i + 1];
      const cy = next ? (band.bottom + next.top) / 2 : band.bottom + 90;
      return { x: w * ANCHOR_X[i], y: Math.max(24, Math.min(h - 24, cy)) };
    });

    // The first stop used to sit in the gap after the whole hero section —
    // well below the fold, so the bus was invisible until you'd scrolled
    // past the entire hero. Start it right by the hero's CTA buttons instead,
    // so it's there from the first scroll.
    const heroCtas = document.querySelector(".hero-ctas");
    if (heroCtas) {
      const cr = heroCtas.getBoundingClientRect();
      anchors[0] = {
        x: Math.max(24, (cr.left - sceneRect.left) - 10),
        y: Math.min(h - 24, (cr.bottom - sceneRect.top) + 74)
      };
    }

    let d = "M " + anchors[0].x + " " + anchors[0].y;
    for (let i = 1; i < anchors.length; i++) {
      const p0 = anchors[i - 1], p1 = anchors[i];
      const midY = (p0.y + p1.y) / 2;
      d += " C " + p0.x + " " + midY + ", " + p1.x + " " + midY + ", " + p1.x + " " + p1.y;
    }
    path.setAttribute("d", d);
    totalLength = path.getTotalLength();

    stops.forEach((el, i) => {
      el.setAttribute("cx", anchors[i].x);
      el.setAttribute("cy", anchors[i].y);
    });

    const busRect = bus.getBoundingClientRect();
    busW = busRect.width; busH = busRect.height;

    active = window.innerWidth > 860 && totalLength > 0;
    if (active && !readyOnce) { readyOnce = true; bus.classList.add("ready"); }
  }

  function targetT() {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 0;
  }

  function render(t) {
    const len = t * totalLength;
    const p = path.getPointAtLength(len);
    const ahead = path.getPointAtLength(Math.min(totalLength, len + 20));
    // The route travels mostly downward (it follows page scroll), so a side-profile
    // bus should stay upright and just bank left/right into the curve, not spin to
    // match the tangent the way a top-down map marker would.
    const dx = ahead.x - p.x, dy = Math.max(ahead.y - p.y, 1);
    // A base forward-facing tilt so the bus reads as driving forward at a
    // natural angle, rather than sitting perfectly flat like a side-view sticker.
    const BASE_TILT = -28;
    const bank = BASE_TILT + Math.max(-12, Math.min(12, Math.atan2(dx, dy) * (180 / Math.PI) * 0.5));

    // Grow the bus as it arrives at the final stop, so it's unmistakably the
    // GT Stinger bus right when it comes to rest at the end.
    const arrival = Math.max(0, Math.min(1, (t - 0.85) / 0.15));
    const scale = 1 + arrival * 0.75;

    bus.style.transform =
      "translate3d(" + (p.x - busW / 2) + "px, " + (p.y - busH / 2) + "px, 0) rotate(" + bank + "deg) scale(" + scale + ")";

    stops.forEach((el, i) => {
      const stopLen = (i / (stops.length - 1)) * totalLength;
      el.classList.toggle("reached", len >= stopLen - 4);
    });
  }

  function tick() {
    if (active) {
      // Ease toward the scroll-driven target instead of snapping straight to it —
      // reads as the bus gliding along with the page rather than teleporting per frame.
      const target = targetT();
      displayedT += (target - displayedT) * 0.16;
      if (Math.abs(target - displayedT) < 0.0004) displayedT = target;
      render(displayedT);
    }
    requestAnimationFrame(tick);
  }

  layout();
  requestAnimationFrame(tick);
  window.addEventListener("load", layout);
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(layout, 150);
  });
})();
