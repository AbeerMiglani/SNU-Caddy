#!/usr/bin/env python3
"""Build campus map data for SNU Caddy from OpenStreetMap.

Writes two ES modules that the web app imports:

  js/data/campus.js       campus fence polygon, its bounding box, landmarks
  js/data/demo-routes.js  road-following loops for the demo / pitch mode

The demo routes are real shortest paths on the campus road graph, so the
virtual caddies drive on actual SNU roads (with an occasional footpath, the
same way real caddies do).

Usage (standard library only, no pip install needed):

  python3 tools/build_campus_data.py                   # download fresh OSM data
  python3 tools/build_campus_data.py --osm-file map.osm  # use a saved download

Map data (c) OpenStreetMap contributors, available under the ODbL 1.0.
"""

from __future__ import annotations

import argparse
import heapq
import json
import math
import pathlib
import sys
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict

ROOT = pathlib.Path(__file__).resolve().parent.parent

# OSM way that holds the SNU fence line (amenity=university).
CAMPUS_WAY_ID = "369248213"

# Download box: the campus plus a small margin (min_lon, min_lat, max_lon, max_lat).
DOWNLOAD_BBOX = (77.5640, 28.5165, 77.5855, 28.5352)

USER_AGENT = "snu-caddy-data-builder/1.0 (campus caddy tracker)"

# Cost multiplier per road type. Caddies prefer roads; footpaths are allowed
# but cost more, so a route uses one only when it saves a long detour.
ROAD_COST = {
    "service": 1.0,
    "residential": 1.0,
    "unclassified": 1.0,
    "tertiary": 1.0,
    "living_street": 1.0,
    "track": 1.4,
    "pedestrian": 1.6,
    "footway": 3.0,
    "path": 3.0,
}

# Landmarks shown as "Near <name>" in the app: OSM name -> display name.
# Display names follow what students say on campus (A Block, DH1, Main Gate).
# Only well-known places are listed so labels stay useful.
LANDMARKS = {
    "SNU Gate No. 1": "Main Gate",
    "SNU Gate No. 2": "Gate 2",
    "Shiv Nadar University Post Office": "Post Office",
    "Block A": "A Block",
    "Block B": "B Block",
    "Block C": "C Block",
    "Block D": "D Block",
    "Central Library": "Central Library",
    "Management Block": "Management Block",
    "Research Annexe": "Research Annexe",
    "Hostel 1A": "Hostel 1A",
    "Hostel 1B": "Hostel 1B",
    "Hostel 1C": "Hostel 1C",
    "Hostel 2A": "Hostel 2A",
    "Hostel 2B": "Hostel 2B",
    "Hostel 2C": "Hostel 2C",
    "Hostel 3A": "Hostel 3A",
    "Hostel 3B": "Hostel 3B",
    "Hostel 3C": "Hostel 3C",
    "Dining Hall 1": "DH1",
    "Dining Hall 2": "DH2",
    "Dining Hall 3": "DH3",
    "Health and wellness centre, SNU": "Health Centre",
    "Auctus Supermarket": "Auctus Supermarket",
    "Mini Mart": "Mini Mart",  # the shop arcade at Hostel 3C, between DH1 and DH2
    "Indoor Sports Complex": "Indoor Sports Complex",
    "Football Ground": "Football Ground",
    "Cricket Ground": "Cricket Ground",
    "Lake SNU": "SNU Lake",
    "Parking 1": "Parking 1",
    "Amphitheatre": "Amphitheatre",
    "Faculty Residence": "Faculty Residence",
    "SNU Biodiversity Park": "Biodiversity Park",
}

# OSM has two buildings named "Dining Hall 3":
#  - way 1473676593 (mapped 2026, detailed outline) stands in the hostel
#    cluster, with six dormitory buildings within 125 m. This is DH3.
#  - way 729630264 (mapped 2019, simple box) stands alone next to Faculty
#    Residence, 800+ m from DH1, DH2 and the Indoor Sports Complex. What it
#    really is still needs checking on campus, so it gets no label.
SKIP_WAY_IDS = {"729630264"}

# Demo loops. Each caddy drives stop to stop and then back to the first stop.
DEMO_ROUTES = [
    {
        "id": "caddy-01",
        "name": "Caddy 01",
        "line": "Gate shuttle",
        "stops": ["Main Gate", "Management Block", "Central Library", "A Block",
                  "Research Annexe", "Gate 2"],
    },
    {
        "id": "caddy-02",
        "name": "Caddy 02",
        "line": "Hostel loop",
        "stops": ["Hostel 3A", "DH2", "DH3", "Indoor Sports Complex",
                  "Hostel 2B", "DH1", "Central Library", "Health Centre"],
    },
    {
        "id": "caddy-03",
        "name": "Caddy 03",
        "line": "Academic loop",
        "stops": ["D Block", "Central Library", "Hostel 1A",
                  "Auctus Supermarket", "Management Block", "C Block"],
    },
]

# A caddy that is parked and off shift in the demo.
DEMO_PARKED = {"id": "caddy-04", "name": "Caddy 04", "at": "Parking 1"}

# A caddy that is plugged in and charging in the demo. It sits on the landmark
# itself, so pick one that is off every demo route (demo_charging checks this).
DEMO_CHARGING = {"id": "caddy-05", "name": "Caddy 05", "at": "Faculty Residence"}

# The charging caddy must stay this far (metres) from every demo route line
# (vertices and the stretches between them), so its marker never sits under a
# moving caddy.
DEMO_CHARGING_MIN_M = 80


# --------------------------------------------------------------------------- #
# Geometry helpers
# --------------------------------------------------------------------------- #

def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Distance in metres between two (lat, lng) points."""
    lat1, lng1 = map(math.radians, a)
    lat2, lng2 = map(math.radians, b)
    h = (math.sin((lat2 - lat1) / 2) ** 2
         + math.cos(lat1) * math.cos(lat2) * math.sin((lng2 - lng1) / 2) ** 2)
    return 2 * 6_371_000 * math.asin(math.sqrt(h))


def segment_distance_m(p: tuple[float, float], a: tuple[float, float],
                       b: tuple[float, float]) -> float:
    """Distance in metres from point p to the segment a-b (flat map, fine for campus sizes)."""
    m_per_deg = math.radians(1) * 6_371_000
    k = math.cos(math.radians(p[0]))

    def xy(q: tuple[float, float]) -> tuple[float, float]:
        return (q[1] - p[1]) * k * m_per_deg, (q[0] - p[0]) * m_per_deg  # east, north of p

    (ax, ay), (bx, by) = xy(a), xy(b)
    dx, dy = bx - ax, by - ay
    len2 = dx * dx + dy * dy
    t = max(0.0, min(1.0, -(ax * dx + ay * dy) / len2)) if len2 else 0.0
    return math.hypot(ax + t * dx, ay + t * dy)


def point_in_polygon(p: tuple[float, float], poly: list[tuple[float, float]]) -> bool:
    """Ray-casting test. Good enough for a campus-sized polygon."""
    y, x = p
    inside = False
    for i in range(len(poly)):
        y1, x1 = poly[i]
        y2, x2 = poly[i - 1]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            inside = not inside
    return inside


def r6(v: float) -> float:
    """Round to 6 decimals (about 0.1 m), which keeps the JS files small."""
    return round(v, 6)


def demo_charging(landmarks: dict[str, tuple[float, float]], routes: list[dict]) -> dict:
    """The charging caddy record: at its landmark, and well away from every route."""
    name = DEMO_CHARGING["at"]
    if name not in landmarks:
        sys.exit(f"Unknown landmark for the demo charging caddy: {name!r}")
    at = (r6(landmarks[name][0]), r6(landmarks[name][1]))
    # Routes are loops, so the last point joins the first.
    nearest = min(segment_distance_m(at, a, b) for route in routes
                  for a, b in zip(route["path"], route["path"][1:] + route["path"][:1]))
    if nearest < DEMO_CHARGING_MIN_M:
        sys.exit(f"The demo charging caddy at {name!r} is only {nearest:.0f} m from a demo route "
                 f"(at least {DEMO_CHARGING_MIN_M} m needed). Pick a landmark farther away.")
    charging = {k: v for k, v in DEMO_CHARGING.items() if k != "at"}
    charging["position"] = list(at)
    charging["near"] = name
    return charging


# --------------------------------------------------------------------------- #
# OSM loading
# --------------------------------------------------------------------------- #

def load_osm(osm_file: str | None) -> ET.Element:
    if osm_file:
        return ET.parse(osm_file).getroot()
    url = ("https://api.openstreetmap.org/api/0.6/map?bbox="
           + ",".join(str(v) for v in DOWNLOAD_BBOX))
    print(f"Downloading {url}", file=sys.stderr)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return ET.fromstring(resp.read())


def parse(root: ET.Element):
    nodes: dict[str, tuple[float, float]] = {}
    node_tags: dict[str, dict[str, str]] = {}
    for n in root.iter("node"):
        nid = n.get("id")
        nodes[nid] = (float(n.get("lat")), float(n.get("lon")))
        tags = {t.get("k"): t.get("v") for t in n.iter("tag")}
        if tags:
            node_tags[nid] = tags
    ways: dict[str, tuple[dict[str, str], list[str]]] = {}
    for w in root.iter("way"):
        tags = {t.get("k"): t.get("v") for t in w.iter("tag")}
        refs = [nd.get("ref") for nd in w.iter("nd")]
        ways[w.get("id")] = (tags, refs)
    return nodes, node_tags, ways


# --------------------------------------------------------------------------- #
# Road graph
# --------------------------------------------------------------------------- #

def build_graph(nodes, ways, poly):
    """Graph of campus roads: node -> [(neighbour, cost, metres)]."""
    graph: dict[str, list[tuple[str, float, float]]] = defaultdict(list)
    road_nodes: set[str] = set()
    for tags, refs in ways.values():
        kind = tags.get("highway")
        if kind not in ROAD_COST:
            continue
        refs = [r for r in refs if r in nodes]
        if not any(point_in_polygon(nodes[r], poly) for r in refs):
            continue
        for a, b in zip(refs, refs[1:]):
            d = haversine_m(nodes[a], nodes[b])
            graph[a].append((b, d * ROAD_COST[kind], d))
            graph[b].append((a, d * ROAD_COST[kind], d))
            if ROAD_COST[kind] <= 1.0:
                road_nodes.update((a, b))
    return graph, road_nodes


def largest_component(graph) -> set[str]:
    best: set[str] = set()
    seen: set[str] = set()
    for start in graph:
        if start in seen:
            continue
        comp = {start}
        stack = [start]
        while stack:
            u = stack.pop()
            for v, _, _ in graph[u]:
                if v not in comp:
                    comp.add(v)
                    stack.append(v)
        seen |= comp
        if len(comp) > len(best):
            best = comp
    return best


def shortest_path(graph, src: str, dst: str) -> list[str]:
    """Dijkstra on road cost. Returns the node ids from src to dst."""
    dist = {src: 0.0}
    prev: dict[str, str] = {}
    heap = [(0.0, src)]
    while heap:
        d, u = heapq.heappop(heap)
        if u == dst:
            break
        if d > dist.get(u, math.inf):
            continue
        for v, cost, _ in graph[u]:
            nd = d + cost
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(heap, (nd, v))
    if dst not in dist:
        raise RuntimeError(f"No road path from node {src} to {dst}")
    path = [dst]
    while path[-1] != src:
        path.append(prev[path[-1]])
    return path[::-1]


# --------------------------------------------------------------------------- #
# Main
# --------------------------------------------------------------------------- #

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--osm-file", help="read a saved OSM XML file instead of downloading")
    args = ap.parse_args()

    nodes, node_tags, ways = parse(load_osm(args.osm_file))
    if CAMPUS_WAY_ID not in ways:
        sys.exit(f"Campus way {CAMPUS_WAY_ID} not found in the OSM data")

    poly = [nodes[r] for r in ways[CAMPUS_WAY_ID][1] if r in nodes]
    if poly[0] == poly[-1]:
        poly = poly[:-1]

    # Landmarks: named buildings/areas (centroid) and named nodes (gates).
    landmarks: dict[str, tuple[float, float]] = {}
    for wid, (tags, refs) in ways.items():
        name = tags.get("name")
        if wid in SKIP_WAY_IDS or name not in LANDMARKS or tags.get("highway"):
            continue
        pts = [nodes[r] for r in refs if r in nodes]
        if pts[0] == pts[-1] and len(pts) > 1:
            pts = pts[:-1]
        landmarks[LANDMARKS[name]] = (sum(p[0] for p in pts) / len(pts),
                                      sum(p[1] for p in pts) / len(pts))
    for nid, tags in node_tags.items():
        if tags.get("name") in LANDMARKS:
            landmarks[LANDMARKS[tags["name"]]] = nodes[nid]

    graph, road_nodes = build_graph(nodes, ways, poly)
    main_comp = largest_component(graph)
    stop_candidates = [n for n in road_nodes if n in main_comp]

    def nearest_road_node(name: str) -> str:
        if name not in landmarks:
            sys.exit(f"Unknown landmark in a demo route: {name!r}")
        target = landmarks[name]
        return min(stop_candidates, key=lambda n: haversine_m(nodes[n], target))

    routes_out = []
    for route in DEMO_ROUTES:
        stop_nodes = [nearest_road_node(s) for s in route["stops"]]
        path: list[str] = []
        for a, b in zip(stop_nodes, stop_nodes[1:] + stop_nodes[:1]):
            leg = shortest_path(graph, a, b)
            path.extend(leg[1:] if path else leg)  # junction node is already in the path
        # The loop ends where it starts; drop the duplicate closing node.
        if path[0] == path[-1]:
            path.pop()
        # Remove consecutive duplicates (a stop node can repeat after a U-turn).
        clean = [path[0]] + [n for p, n in zip(path, path[1:]) if n != p]
        coords = [[r6(nodes[n][0]), r6(nodes[n][1])] for n in clean]
        # Find each stop in the path, in driving order.
        remapped = []
        cursor = 0
        for name, node in zip(route["stops"], stop_nodes):
            while cursor < len(clean) and clean[cursor] != node:
                cursor += 1
            remapped.append({"index": min(cursor, len(clean) - 1), "name": name})
        length = sum(haversine_m(nodes[a], nodes[b]) for a, b in zip(clean, clean[1:] + clean[:1]))
        routes_out.append({
            "id": route["id"], "name": route["name"], "line": route["line"],
            "lengthM": round(length), "stops": remapped, "path": coords,
        })
        print(f"{route['name']:<9} {route['line']:<14} {len(coords):>4} points "
              f"{length / 1000:.2f} km, {len(remapped)} stops", file=sys.stderr)

    parked_node = nearest_road_node(DEMO_PARKED["at"])
    parked = {k: v for k, v in DEMO_PARKED.items() if k != "at"}
    parked["position"] = [r6(nodes[parked_node][0]), r6(nodes[parked_node][1])]
    parked["near"] = DEMO_PARKED["at"]
    charging = demo_charging(landmarks, routes_out)

    lats = [p[0] for p in poly]
    lngs = [p[1] for p in poly]
    header = ("// GENERATED by tools/build_campus_data.py. Do not edit by hand.\n"
              "// Map data (c) OpenStreetMap contributors, ODbL 1.0 "
              "(https://www.openstreetmap.org/copyright).\n\n")

    campus_js = (
        header
        + "/** SNU fence line as [lat, lng] pairs (OSM way " + CAMPUS_WAY_ID + "). */\n"
        + "export const CAMPUS_POLYGON = " + json.dumps([[r6(a), r6(b)] for a, b in poly]) + ";\n\n"
        + "/** Bounding box of the fence line: [[south, west], [north, east]]. */\n"
        + "export const CAMPUS_BBOX = " + json.dumps([[min(lats), min(lngs)], [max(lats), max(lngs)]]) + ";\n\n"
        + "/** Places used for \"Near <name>\" labels. */\n"
        + "export const LANDMARKS = " + json.dumps(
            [{"name": n, "lat": r6(p[0]), "lng": r6(p[1])} for n, p in sorted(landmarks.items())],
            indent=2) + ";\n"
    )
    routes_js = (
        header
        + "/** Road-following loops for the demo caddies. `stops[].index` points into `path`. */\n"
        + "export const DEMO_ROUTES = " + json.dumps(routes_out, separators=(",", ":")) + ";\n\n"
        + "/** A caddy that is parked and off shift during the demo. */\n"
        + "export const DEMO_PARKED = " + json.dumps(parked) + ";\n\n"
        + "/** A caddy that is plugged in and charging during the demo. */\n"
        + "export const DEMO_CHARGING = " + json.dumps(charging) + ";\n"
    )

    out_dir = ROOT / "js" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "campus.js").write_text(campus_js, encoding="utf-8")
    (out_dir / "demo-routes.js").write_text(routes_js, encoding="utf-8")
    print(f"Wrote {len(landmarks)} landmarks and {len(routes_out)} routes to {out_dir}",
          file=sys.stderr)


if __name__ == "__main__":
    main()
