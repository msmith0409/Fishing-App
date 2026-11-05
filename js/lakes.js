// Lakes and official source links.
// Coordinates are a general point on each lake, used only to fetch the NWS forecast.
// bounds ([[south, west], [north, east]]) frame the lake on the map and decide which lake a spot belongs to.
// They can be changed in More → Lakes. Lake of the Ozarks is huge, so set it to the arm you fish.
// MDC links were verified to exist on 2026-11-04 (Truman and Stockton on 2026-11-05). Prospect reports are updated by MDC each year.

export const LINKS_VERIFIED = '2026-11-04';

export const DEFAULT_LAKES = [
  {
    id: 'jacomo',
    name: 'Lake Jacomo',
    lat: 38.958, lon: -94.335,
    bounds: [[38.93, -94.365], [39.005, -94.29]],
    note: 'Fleming Park, Blue Springs. Check current horsepower rules on the MDC/county pages.',
    links: [
      { label: 'MDC: Lake Jacomo area page', url: 'https://mdc.mo.gov/fishing/fishing-prospects/areas/lake-jacomo' },
      { label: 'MDC: Lake Jacomo prospect report', url: 'https://mdc.mo.gov/fishing/fishing-prospects/reports/lake-jacomo-prospect-report' },
    ],
  },
  {
    id: 'smithville',
    name: 'Smithville Lake',
    lat: 39.415, lon: -94.535,
    bounds: [[39.36, -94.6], [39.6, -94.44]],
    note: 'Big, open water. Wind across the main lake builds rough water fast.',
    links: [
      { label: 'MDC: Smithville prospect report', url: 'https://mdc.mo.gov/fishing/fishing-prospects/reports/smithville-lake-prospect-report' },
      { label: 'MDC: Fish attractor GPX files', url: 'https://mdc4.mdc.mo.gov/fishing/where-fish/fish-attractor-gpx-files' },
    ],
  },
  {
    id: 'watkins',
    name: 'Watkins Mill Lake',
    lat: 39.405, lon: -94.258,
    bounds: [[39.385, -94.275], [39.41, -94.245]],
    note: 'Small state park lake. Check current outboard rules before launching the 15 HP.',
    links: [
      { label: 'MDC: Watkins Mill State Park Lake', url: 'https://mdc.mo.gov/fishing/fishing-prospects/areas/watkins-mill-state-park-lake' },
    ],
  },
  {
    id: 'ozarks',
    name: 'Lake of the Ozarks',
    lat: 38.13, lon: -92.72,
    bounds: [[37.9, -93.3], [38.4, -92.35]],
    note: 'Default point is mid-lake. Weather varies along the lake, so set this to the arm you fish. Heavy weekend boat wakes.',
    links: [
      { label: 'MDC: Lake of the Ozarks area page', url: 'https://mdc.mo.gov/fishing/fishing-prospects/areas/lake-ozarks' },
      { label: 'MDC: Lake of the Ozarks prospect report', url: 'https://mdc.mo.gov/fishing/fishing-prospects/reports/lake-ozarks-prospect-report' },
    ],
  },
  {
    id: 'truman',
    name: 'Truman Lake',
    lat: 38.27, lon: -93.45,
    bounds: [[38.0, -93.95], [38.45, -93.3]],
    note: 'Default point is the lower lake near Warsaw. Huge, with flooded timber and stumps just under the surface: go slow off the channel with the outboard. Water level swings a lot.',
    links: [
      { label: 'MDC: Truman Lake area page', url: 'https://mdc.mo.gov/fishing/fishing-prospects/areas/truman-lake' },
      { label: 'MDC: Truman Lake prospect report', url: 'https://mdc.mo.gov/fishing/fishing-prospects/reports/truman-lake-prospect-report' },
    ],
  },
  {
    id: 'stockton',
    name: 'Stockton Lake',
    lat: 37.6, lon: -93.75,
    bounds: [[37.4, -93.9], [37.75, -93.53]],
    note: 'Clear water and big open arms. A known walleye lake. Wind builds big waves on the main lake, so check the wind before crossing.',
    links: [
      { label: 'MDC: Stockton Lake area page', url: 'https://mdc.mo.gov/fishing/fishing-prospects/areas/stockton-lake' },
      { label: 'MDC: Stockton Lake prospect report', url: 'https://mdc.mo.gov/fishing/fishing-prospects/reports/stockton-lake-prospect-report' },
    ],
  },
];

export const GENERAL_LINKS = [
  { label: 'MDC: Fishing regulations & info', url: 'https://mdc.mo.gov/fishing' },
  { label: 'MDC: Fish attractor GPX files (all lakes)', url: 'https://mdc4.mdc.mo.gov/fishing/where-fish/fish-attractor-gpx-files' },
];

export const SPECIES = [
  { id: 'walleye', name: 'Walleye' },
  { id: 'bass', name: 'Bass' },
  { id: 'crappie', name: 'Crappie' },
  { id: 'whitebass', name: 'White bass' },
  { id: 'catfish', name: 'Catfish' },
];

export const OTHER_SPECIES = [
  { id: 'hybrid', name: 'Hybrid striper' },
  { id: 'bluegill', name: 'Bluegill/sunfish' },
  { id: 'drum', name: 'Drum' },
  { id: 'other', name: 'Other' },
];

export const ALL_SPECIES = [...SPECIES, ...OTHER_SPECIES];

export const speciesName = (id) => (ALL_SPECIES.find((s) => s.id === id) || { name: id || '?' }).name;
