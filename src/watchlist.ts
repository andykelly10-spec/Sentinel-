// What Sentinel watches. Edit this file to change coverage. The buildings it
// watches are kept in the database and managed from the dashboard.

export const WATCHLIST = {
  organization: "Skydance, the company formed in October 2026 when Paramount Skydance acquired Warner Bros. Discovery",

  // Sent to every source; any item matching one is pulled in and then judged
  // by the classifier. Keep them distinctive: a bare "Paramount" would also
  // match the city, the theatres and unrelated companies. Each term adds about
  // five requests to every run, and Cloudflare's free plan allows 50.
  searchTerms: ["Skydance", "David Ellison", "Warner Bros. Discovery"],

  // Brands the classifier treats as in scope when they appear in an item.
  brands: [
    "Paramount Skydance Corporation and Skydance Media (Animation, Television, Sports, Games, New Media)",
    "Paramount Pictures, Paramount+, Pluto TV, Showtime",
    "CBS, CBS News, CBS Sports, CBS Studios",
    "Nickelodeon, MTV, BET, Comedy Central",
    "Warner Bros. Discovery: Warner Bros. Pictures, Warner Bros. Television, Warner Bros. Games, DC Studios",
    "HBO, Max, CNN, TNT, TBS, Discovery, Turner Classic Movies",
  ],

  // Named people whose safety is in scope. Add executives and talent here and,
  // if their name should be searched directly, to searchTerms above.
  people: ["David Ellison (Chairman and CEO)", "Ynon Kreiz (Co-CEO)"],

  // Searched in news alongside each priority site's area.
  incidentTerms: ["active shooter", "shooting", "bomb threat", "explosion", "evacuation", "lockdown"],

  // Searched everywhere on news and social media, then kept only when the
  // report mentions a city or place word belonging to one of the sites.
  urgentTerms: ["active shooter", "bomb threat", "shelter in place", "mass shooting"],
};

export type Watchlist = typeof WATCHLIST;

// Local news searches are limited so a long site list cannot exhaust a run.
export const MAX_AREA_SEARCHES = 8;
