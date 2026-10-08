# Location data attribution

Postal code data © GeoNames, CC BY 4.0, https://www.geonames.org

- `US.txt` — GeoNames postal code dump for the United States (tab-separated:
  country code, postal code, place name, state, state code, county, county
  code, community, community code, latitude, longitude, accuracy). Licensed
  under the Creative Commons Attribution 4.0 License
  (https://creativecommons.org/licenses/by/4.0/). See `README-geonames.txt`
  for the upstream readme.
- `dataimpulse-states.csv` — the US state parameter values published by
  DataImpulse (https://docs.dataimpulse.com), one `state.<value>` per line.

This directory ships with the application (`extraResources` → `geonames/`) and
is read at runtime by the Locations service.
