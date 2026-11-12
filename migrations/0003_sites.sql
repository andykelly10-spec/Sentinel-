CREATE TABLE sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  lat REAL NOT NULL,
  lon REAL NOT NULL,
  -- Place name used for this site's own local news search (priority sites only).
  area TEXT NOT NULL DEFAULT '',
  -- Extra comma-separated place words that tie a report to this site.
  keywords TEXT NOT NULL DEFAULT '',
  -- 1 = gets its own local news search every run.
  priority INTEGER NOT NULL DEFAULT 0,
  -- 1 = coordinates were estimated from the address rather than supplied.
  approximate INTEGER NOT NULL DEFAULT 0
);

-- Starter sites from public information. Importing a site list replaces them.
INSERT INTO sites (name, address, city, country, lat, lon, area, keywords, priority, approximate) VALUES
  ('Paramount Pictures Studios', '5555 Melrose Ave', 'Los Angeles', 'US', 34.0838, -118.3206, 'Hollywood', 'hollywood, melrose', 1, 1),
  ('Skydance Media headquarters', '2900 Olympic Blvd', 'Santa Monica', 'US', 34.0283, -118.466, 'Santa Monica', '', 1, 1),
  ('Paramount Skydance New York', '1515 Broadway', 'New York', 'US', 40.7577, -73.986, 'Manhattan', 'manhattan, nyc, times square, midtown', 1, 1),
  ('CBS Broadcast Center', '524 W 57th St', 'New York', 'US', 40.7689, -73.9908, 'Manhattan', 'manhattan, nyc, midtown', 1, 1),
  ('CBS News Washington Bureau', '2020 M St NW', 'Washington', 'US', 38.9056, -77.0457, 'Washington DC', 'dc, d.c., district of columbia', 1, 1);
