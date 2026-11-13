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

  // Besides searchTerms, stories from the news outlet feeds that name one of
  // these are passed to the classifier.
  brandKeywords: ["Paramount", "Warner Bros", "HBO", "CBS News", "Ellison"],

  // Words that mark a news story as a possible incident.
  storyIncidentTerms: [
    "shooting", "shooter", "gunman", "gunfire", "shot", "stabbing", "bomb", "explosion", "blast", "evacuation",
    "evacuated", "lockdown", "shelter in place", "hostage", "terror", "attack", "protest", "riot", "unrest", "fire",
    "suspicious package", "police standoff", "barricaded",
  ],

  // Certificate logs are searched for new domains containing these names.
  // "strict" names are ordinary words too, so they only count next to a
  // phishing word such as "login".
  domainWatch: {
    tokens: [
      { term: "hbomax", strict: false },
      { term: "paramountplus", strict: false },
      { term: "warnerbros", strict: false },
      { term: "cbsnews", strict: false },
      { term: "skydance", strict: true },
    ],
    // Domains the company owns, which never count as lookalikes.
    official: [
      "skydance.com", "skydanceanimation.com", "skydancemedia.com", "skydancetv.com",
      "hbomax.com", "max.com", "hbo.com", "paramountplus.com", "paramount.com", "paramountplus.tv",
      "warnerbros.com", "wbd.com", "warnermedia.com", "wbgames.com", "cbsnews.com", "cbs.com", "cbsi.com",
      "cnn.com", "pluto.tv",
    ],
  },

  // Searched everywhere on news and social media, then kept only when the
  // report mentions a city or place word belonging to one of the sites.
  urgentTerms: ["active shooter", "bomb threat", "shelter in place", "mass shooting"],
};

export type Watchlist = typeof WATCHLIST;

// Local news searches are limited so a long site list cannot exhaust a run.
export const MAX_AREA_SEARCHES = 8;
