# Meander

Walking directions that take the nicest way there, not just the shortest.

- **Go somewhere**: pick a destination and how many extra minutes you are happy to spend. Meander compares the fastest route with progressively more scenic ones and tells you what each trade buys (parks, waterfront, quieter streets, avoiding areas with higher reported crime).
- **Just walk**: pick a length and get a scenic loop from where you stand.
- **Subway aware**: knows the rail maps (no buses) and suggests the train when it is clearly the better call, with scenic walks at each end.
- **After dark**: prefers lit streets over unlit park paths.

Featured cities with pre-baked maps, curated scenic spots and safety data: New York City, London, Chicago, Boston, Los Angeles and Las Vegas. Everywhere else it falls back to live OpenStreetMap data.

## How it works

Everything runs in the browser. `core.js` builds a walking graph from OpenStreetMap, scores every street segment (parks, water, landmarks, traffic, lighting, curated spots), and runs A* several times with increasing weight on niceness. `tools/bake.js` turns an `.osm.pbf` extract into the compact tiles under `tiles/` and the rail networks under `transit/`.

## Caveats

- Higher-crime areas are approximate circles based on public police-reported crime patterns. They are a rough guide, not block-level fact, and conditions change by time of day.
- Train times are estimates from the route map, not live schedules.
- Map data © OpenStreetMap contributors (ODbL).
