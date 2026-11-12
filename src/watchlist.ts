// What Sentinel watches. Edit this file to change coverage.
//
// searchTerms are sent to every source; any item matching one is pulled in and
// then judged by the classifier. Keep them distinctive: a bare "Paramount"
// would also match the city, the theatres and unrelated companies. Each term
// adds about five requests to every run, and Cloudflare's free plan allows 50.
export const WATCHLIST = {
  organization: "Paramount Skydance Corporation",

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
};
