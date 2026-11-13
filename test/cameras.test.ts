import { describe, expect, it } from "vitest";
import { CAMERA_FEEDS, correlate, feedsForSites, nearestCameras } from "../public/cameras.js";

const parse = (id: string, body: unknown) =>
  CAMERA_FEEDS.find((feed) => feed.id === id)!.parse(typeof body === "string" ? body : JSON.stringify(body));

// Trimmed copies of what each service returns.
describe("camera feed parsers", () => {
  it("reads Caltrans, skipping cameras out of service and images from other hosts", () => {
    const entry = (inService: string, url: string) => ({
      cctv: {
        location: { locationName: "I-110 : (196) Avenue 26 Off Ramp", longitude: "-118.2215", latitude: "34.0837" },
        inService,
        imageData: { static: { currentImageURL: url } },
      },
    });
    const good = "https://cwwp2.dot.ca.gov/data/d7/cctv/image/i110196avenue26offramp/i110196avenue26offramp.jpg";
    expect(parse("los-angeles", { data: [entry("true", good), entry("false", good), entry("true", "https://evil.example/x.jpg")] })).toEqual([
      { owner: "Caltrans", lat: 34.0837, lon: -118.2215, name: "I-110 : (196) Avenue 26 Off Ramp", image: good, link: null },
    ]);
  });

  it("reads New York", () => {
    const image = "https://webcams.nyctmc.org/api/cameras/1b3248f9-f26e-4f36-943f-b7a7731595fb/image";
    expect(
      parse("new-york", [
        { id: "1b3248f9", name: "QBB @ Crescent St", latitude: 40.750889, longitude: -73.940613, isOnline: "true", imageUrl: image },
        { id: "off", name: "Offline", latitude: 40.7, longitude: -73.9, isOnline: "false", imageUrl: image },
      ]),
    ).toEqual([{ owner: "NYC DOT", lat: 40.750889, lon: -73.940613, name: "QBB @ Crescent St", image, link: null }]);
  });

  it("reads Seattle, where the position is in the geometry", () => {
    const [camera] = parse("seattle", {
      features: [{ attributes: { CameraTitle: "I-5 at MP 143.7: S 320th St", ImageURL: "https://images.wsdot.wa.gov/nw/005vc14379.jpg" }, geometry: { x: -122.29732, y: 47.31484 } }],
    });
    expect(camera).toMatchObject({ lat: 47.31484, lon: -122.29732, name: "I-5 at MP 143.7: S 320th St", image: "https://images.wsdot.wa.gov/nw/005vc14379.jpg" });
  });

  it("reads Maryland as links to live video", () => {
    const link = "https://chart.maryland.gov/Video/GetVideo/7a00a1dc01250075004d823633235daa";
    expect(parse("maryland", [{ name: "I-270 & Old Hundred Rd (MD 109)", lat: 39.2773, lon: -77.3236, opStatus: "OK", publicVideoURL: link }])).toEqual([
      { owner: "Maryland CHART", lat: 39.2773, lon: -77.3236, name: "I-270 & Old Hundred Rd (MD 109)", image: null, link },
    ]);
  });

  it("reads Sydney, ignoring the incidents that share its feed", () => {
    const cameras = parse("sydney", [
      { type: "Feature", geometry: { type: "Point", coordinates: [151.10533, -34.02977] }, properties: { title: "5 Ways (Miranda)", href: "https://webcams.transport.nsw.gov.au/livetraffic-webcams/cameras/5_ways_miranda.jpeg" }, eventCategory: "liveCams" },
      { type: "Feature", geometry: { type: "Point", coordinates: [151.2, -33.9] }, properties: { title: "Crash" }, eventCategory: "incident" },
    ]);
    expect(cameras).toHaveLength(1);
    expect(cameras[0]).toMatchObject({ lat: -34.02977, lon: 151.10533, name: "5 Ways (Miranda)" });
  });

  it("reads Singapore", () => {
    const image = "https://images.data.gov.sg/api/traffic-images/2026/11/12d415ad-ee2d-4898-8762-9240b2bceb47.jpg";
    expect(parse("singapore", { items: [{ cameras: [{ image, location: { latitude: 1.447023728, longitude: 103.7716543 }, camera_id: "2701" }] }] })).toEqual([
      { owner: "LTA Singapore", lat: 1.447023728, lon: 103.7716543, name: "Camera 2701", image, link: null },
    ]);
  });

  it("reads Hong Kong's XML", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?> <image-list> <image> <key>H429F</key> <region>Hong Kong Island</region> <description>Aberdeen Praya Road near Fish Market [H429F]</description> <latitude>22.24845</latitude> <longitude>114.1505</longitude> <url>https://tdcctv.data.one.gov.hk/H429F.JPG</url> </image> </image-list>`;
    expect(parse("hong-kong", xml)).toEqual([
      { owner: "Hong Kong Transport Department", lat: 22.24845, lon: 114.1505, name: "Aberdeen Praya Road near Fish Market [H429F]", image: "https://tdcctv.data.one.gov.hk/H429F.JPG", link: null },
    ]);
  });

  it("reads Madrid's KML", () => {
    const kml = `<kml><Document><Placemark> <description>&lt;div align=center&gt;&lt;img src=https://informo.madrid.es/cameras/Camara06304.jpg?v=53623 width=300 height=220/&gt;&lt;br/&gt;PLAZA DE CASTILLA (SUR)&lt;/div&gt;</description> <ExtendedData> <Data name="Numero"> <Value>06304</Value> </Data> <Data name="Nombre"> <Value>PLAZA DE CASTILLA (SUR)</Value> </Data> </ExtendedData> <Point> <altitudeMode>relativeToGround</altitudeMode> <coordinates>-3.68963237924212,40.4657761535436,10 </coordinates> </Point> </Placemark></Document></kml>`;
    expect(parse("madrid", kml)).toEqual([
      { owner: "Ayuntamiento de Madrid", lat: 40.4657761535436, lon: -3.68963237924212, name: "PLAZA DE CASTILLA (SUR)", image: "https://informo.madrid.es/cameras/Camara06304.jpg", link: null },
    ]);
  });

  it("reads London", () => {
    const image = "https://s3-eu-west-1.amazonaws.com/jamcams.tfl.gov.uk/00001.07450.jpg";
    const place = (available: string) => ({ commonName: "A40 Westway/Paddington Slip", lat: 51.5197, lon: -0.1836, additionalProperties: [{ key: "available", value: available }, { key: "imageUrl", value: image }] });
    expect(parse("london", [place("true"), place("false")])).toEqual([
      { owner: "Transport for London", lat: 51.5197, lon: -0.1836, name: "A40 Westway/Paddington Slip", image, link: null },
    ]);
  });
});

describe("tying cameras to sites", () => {
  const sites = [
    { name: "CBS Broadcast Center", lat: 40.7689, lon: -73.9908 },
    { name: "Paramount UK (Camden)", lat: 51.5413, lon: -0.1437 },
    { name: "Techwood Campus", lat: 33.7838, lon: -84.392 },
  ];
  const cameras = [
    { owner: "NYC DOT", name: "10 Ave @ 57 St", lat: 40.7695, lon: -73.9885, image: "x", link: null },
    { owner: "NYC DOT", name: "Broadway @ 46 St", lat: 40.7585, lon: -73.9853, image: "x", link: null },
    { owner: "NYC DOT", name: "Coney Island", lat: 40.5755, lon: -73.9707, image: "x", link: null },
  ];

  it("downloads only the feeds whose region holds a site", () => {
    expect(feedsForSites(sites).map((feed) => feed.id)).toEqual(["new-york", "london"]);
    expect(feedsForSites([])).toEqual([]);
  });

  it("marks cameras within range of a site", () => {
    const marked = correlate(cameras, sites, 2);
    expect(marked.map((each: { nearSite: string | null }) => each.nearSite)).toEqual(["CBS Broadcast Center", "CBS Broadcast Center", null]);
    expect(marked[0]!.siteMiles).toBeLessThan(0.2);
  });

  it("lists the nearest cameras to a point", () => {
    const near = nearestCameras(cameras, 40.7689, -73.9908, 4, 2);
    expect(near.map((each: { name: string }) => each.name)).toEqual(["10 Ave @ 57 St", "Broadway @ 46 St"]);
    expect(nearestCameras(cameras, 40.7689, -73.9908, 1, 2)).toHaveLength(1);
    expect(nearestCameras(cameras, 33.7838, -84.392, 4, 2)).toEqual([]);
  });
});
