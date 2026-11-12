// What Sentinel watches. Edit this file to change coverage.

export interface Site {
  name: string;
  address: string;
  lat: number;
  lon: number;
  // The place name searched for incidents around this site. Sites that share
  // an area share one search.
  area: string;
  // Lower-case words that tie a social post to this area.
  areaKeywords: string[];
}

export interface Watchlist {
  organization: string;
  searchTerms: string[];
  brands: string[];
  people: string[];
  sites: Site[];
  incidentTerms: string[];
  urgentTerms: string[];
}

export const WATCHLIST: Watchlist = {
  organization: "Paramount Skydance Corporation",

  // Sent to every source; any item matching one is pulled in and then judged
  // by the classifier. Keep them distinctive: a bare "Paramount" would also
  // match the city, the theatres and unrelated companies. Each term adds about
  // five requests to every run, and Cloudflare's free plan allows 50.
  searchTerms: ["Skydance", "David Ellison"],

  brands: [
    "Paramount Skydance Corporation (parent company)",
    "Skydance Media",
    "Skydance Animation",
    "Skydance Television",
    "Skydance Sports",
    "Skydance Interactive / Skydance Games",
    "Skydance New Media",
  ],

  // Named people whose safety is in scope. Add executives and talent here and,
  // if their name should be searched directly, to searchTerms above.
  people: ["David Ellison (Chairman and CEO)"],

  // Buildings to watch for nearby incidents. Coordinates are approximate.
  sites: [
    {
      name: "Paramount Pictures Studios",
      address: "5555 Melrose Ave, Los Angeles, CA",
      lat: 34.0838,
      lon: -118.3206,
      area: "Hollywood",
      areaKeywords: ["hollywood", "melrose", "los angeles"],
    },
    {
      name: "Skydance Media headquarters",
      address: "2900 Olympic Blvd, Santa Monica, CA",
      lat: 34.0283,
      lon: -118.466,
      area: "Santa Monica",
      areaKeywords: ["santa monica"],
    },
    {
      name: "Paramount Skydance New York",
      address: "1515 Broadway, New York, NY",
      lat: 40.7577,
      lon: -73.986,
      area: "Manhattan",
      areaKeywords: ["manhattan", "times square", "midtown", "new york", "nyc"],
    },
    {
      name: "CBS Broadcast Center",
      address: "524 W 57th St, New York, NY",
      lat: 40.7689,
      lon: -73.9908,
      area: "Manhattan",
      areaKeywords: ["manhattan", "midtown", "hell's kitchen", "new york", "nyc"],
    },
    {
      name: "CBS News Washington Bureau",
      address: "2020 M St NW, Washington, DC",
      lat: 38.9056,
      lon: -77.0457,
      area: "Washington DC",
      areaKeywords: ["washington", "d.c.", " dc", "district of columbia"],
    },
  ],

  // Searched in news alongside each site's area.
  incidentTerms: ["active shooter", "shooting", "bomb threat", "explosion", "evacuation", "lockdown"],

  // Searched on social media everywhere, then kept only when a post mentions
  // one of the site areas.
  urgentTerms: ["active shooter", "bomb threat", "shelter in place"],
};
