// THE PLAYBOOK: general, well-established seasonal patterns for Missouri reservoirs.
// This is general guidance, not a prediction of where fish are today. Every suggestion
// the app makes traces back to a line in this file, so you can see why and change it.
//
// Lure types: tags drive the condition adjustments in suggest.js
//   moving    = covers water; better in wind and cloud
//   topwater  = surface; best in low light and warm water
//   finesse   = small and slow; better in calm, bright, or post-front conditions
//   vibration = thump and rattle; better in stained or muddy water
//   natural   = live or cut bait

export const LURES = {
  jig:            { label: 'Jig (bass)', tags: ['finesse'] },
  jerkbait:       { label: 'Jerkbait (suspending)', tags: ['moving'] },
  squarebill:     { label: 'Squarebill crankbait', tags: ['moving', 'vibration'] },
  crankbait_deep: { label: 'Deep crankbait', tags: ['moving', 'vibration'] },
  lipless:        { label: 'Lipless crankbait', tags: ['moving', 'vibration'] },
  spinnerbait:    { label: 'Spinnerbait', tags: ['moving', 'vibration'] },
  chatterbait:    { label: 'Bladed jig (chatterbait)', tags: ['moving', 'vibration'] },
  swimbait:       { label: 'Swimbait', tags: ['moving'] },
  swim_jig:       { label: 'Swim jig', tags: ['moving'] },
  alabama_rig:    { label: 'Umbrella / A-rig', tags: ['moving'] },
  topwater_walk:  { label: 'Walking topwater', tags: ['topwater', 'moving'] },
  buzzbait:       { label: 'Buzzbait', tags: ['topwater', 'moving', 'vibration'] },
  popper:         { label: 'Popper', tags: ['topwater'] },
  frog:           { label: 'Frog', tags: ['topwater'] },
  texas_worm:     { label: 'Texas-rig worm/creature', tags: [] },
  wacky_worm:     { label: 'Wacky / weightless stick worm', tags: ['finesse'] },
  shaky_head:     { label: 'Shaky head', tags: ['finesse'] },
  ned_rig:        { label: 'Ned rig', tags: ['finesse'] },
  drop_shot:      { label: 'Drop shot', tags: ['finesse'] },
  tube:           { label: 'Tube', tags: ['finesse'] },
  grub:           { label: 'Curly-tail grub', tags: ['moving'] },
  crappie_jig:    { label: 'Crappie jig / tube', tags: ['finesse'] },
  jig_bobber:     { label: 'Jig under a float', tags: ['finesse'] },
  minnow_float:   { label: 'Minnow under a slip float', tags: ['finesse', 'natural'] },
  jig_minnow:     { label: 'Jig & minnow', tags: ['finesse', 'natural'] },
  trolling_crank: { label: 'Trolled crankbait', tags: ['moving', 'vibration'] },
  crawler_harness:{ label: 'Crawler harness / spinner rig', tags: ['moving', 'natural'] },
  leech_float:    { label: 'Leech or crawler under a slip float', tags: ['finesse', 'natural'] },
  inline_spinner: { label: 'Inline spinner', tags: ['moving', 'vibration'] },
  spoon:          { label: 'Jigging / slab spoon', tags: ['vibration'] },
  blade_bait:     { label: 'Blade bait', tags: ['vibration'] },
  cut_shad:       { label: 'Cut shad', tags: ['natural'] },
  live_shad:      { label: 'Live shad / sunfish', tags: ['natural'] },
  nightcrawler:   { label: 'Nightcrawler', tags: ['natural'] },
  dip_bait:       { label: 'Dip / punch bait', tags: ['natural'] },
  chicken_liver:  { label: 'Chicken liver', tags: ['natural'] },
  other:          { label: 'Other', tags: [] },
};

export const lureLabel = (t) => (LURES[t] || { label: t || '?' }).label;

// Phases per species. months: 1-12. temp: surface water °F range, used only if you enter a water temp.
// trend: 'rising' (spring/summer warming) or 'falling' (fall cooling) or 'any'.
// baits are in rough order of preference before conditions are applied.
export const PLAYBOOK = {
  walleye: [
    { id: 'winter', label: 'Winter', months: [12, 1, 2], temp: [33, 42], trend: 'any',
      where: 'Deep main-lake structure near the dam and channel edges; tailwaters below dams.',
      depth: '20–40 ft',
      baits: [
        ['blade_bait', 'Lift-drop, slow, near bottom', 'silver, gold'],
        ['spoon', 'Vertical jig on fish you mark', 'silver, white'],
        ['jig_minnow', 'Very slow drag', 'white, chartreuse'],
      ] },
    { id: 'spawn', label: 'Pre-spawn / spawn', months: [2, 3], temp: [40, 52], trend: 'rising',
      where: 'Rock riprap (dam face, causeways) and gravel points, especially after dark. Tailraces (e.g. Truman Dam for the Ozarks).',
      depth: '2–12 ft at night, deeper by day',
      baits: [
        ['jerkbait', 'Slow-twitch along riprap after dark', 'shad, black/silver, perch'],
        ['jig_minnow', 'Hop along rock', 'white, chartreuse, pink'],
        ['trolling_crank', 'Shallow-running stickbait parallel to riprap at night', 'shad, firetiger'],
      ] },
    { id: 'postspawn', label: 'Post-spawn', months: [4, 5], temp: [52, 65], trend: 'rising',
      where: 'Flats and points near spawning rock; transition to main-lake flats.',
      depth: '6–15 ft',
      baits: [
        ['crawler_harness', 'Slow drift or troll over flats', 'chartreuse, orange, gold blades'],
        ['jig_minnow', 'On points and flat edges', 'white, chartreuse'],
        ['leech_float', 'Set just above bottom on points', 'natural'],
        ['trolling_crank', 'Shallow-to-mid divers over flats', 'shad, perch'],
      ] },
    { id: 'summer', label: 'Summer', months: [6, 7, 8, 9], temp: [65, 90], trend: 'any',
      where: 'Main-lake points, flats edges, humps and ledges near the thermocline. Windblown points in low light.',
      depth: '12–25 ft',
      baits: [
        ['crawler_harness', 'Bottom bouncer + harness along flats/edges', 'chartreuse, orange, purple'],
        ['trolling_crank', 'Troll at 2–2.5 mph to tick bottom', 'shad, firetiger, chartreuse'],
        ['jig_minnow', 'On points at dawn and dusk', 'white, chartreuse'],
      ] },
    { id: 'fall', label: 'Fall', months: [10, 11], temp: [45, 65], trend: 'falling',
      where: 'Windblown points and rocky banks, moving shallower in low light as water cools. Follow shad.',
      depth: '8–20 ft',
      baits: [
        ['jig_minnow', 'Points and rock transitions', 'white, chartreuse'],
        ['trolling_crank', 'Shad-imitating cranks along points', 'shad, chrome'],
        ['jerkbait', 'Shallow rock after dark', 'shad, black/silver'],
        ['blade_bait', 'Once water drops below ~50°F', 'silver'],
      ] },
  ],

  bass: [
    { id: 'winter', label: 'Winter', months: [12, 1, 2], temp: [33, 47], trend: 'any',
      where: 'Deep main-lake points, bluff ends, channel swings. Slow everything down.',
      depth: '15–30 ft',
      baits: [
        ['jerkbait', 'Long pauses (10+ sec)', 'shad, clear/ghost'],
        ['jig', 'Slow drag on rock', 'green pumpkin, black/blue'],
        ['alabama_rig', 'Slow roll near schools of shad', 'shad'],
        ['spoon', 'Vertical on deep fish', 'silver'],
      ] },
    { id: 'prespawn', label: 'Pre-spawn', months: [3, 4], temp: [47, 60], trend: 'rising',
      where: 'Secondary points and channel-swing banks leading into spawning coves; chunk rock that warms in the sun.',
      depth: '5–15 ft',
      baits: [
        ['jerkbait', 'Twitch-pause on points', 'shad, ghost minnow'],
        ['squarebill', 'Deflect off rock and wood', 'red/crawfish, shad'],
        ['chatterbait', 'Around emerging grass and wood', 'green pumpkin, white'],
        ['jig', 'Rock transitions', 'brown/orange, green pumpkin'],
      ] },
    { id: 'spawn', label: 'Spawn', months: [4, 5], temp: [60, 70], trend: 'rising',
      where: 'Protected pockets and flats in the backs of coves. Release bedding fish quickly where they were caught.',
      depth: '1–6 ft',
      baits: [
        ['wacky_worm', 'Let it fall slowly near cover', 'green pumpkin, watermelon'],
        ['texas_worm', 'Lizard/creature into bed areas', 'green pumpkin, white'],
        ['shaky_head', 'Around docks and pockets', 'green pumpkin'],
        ['swim_jig', 'For cruising fish', 'white, bluegill'],
      ] },
    { id: 'postspawn', label: 'Post-spawn / shad spawn', months: [5, 6], temp: [68, 80], trend: 'rising',
      where: 'Points outside spawning coves. At dawn: riprap, willows, and seawalls during the shad spawn.',
      depth: '0–15 ft',
      baits: [
        ['topwater_walk', 'Dawn and dusk, points and flats', 'bone, shad'],
        ['spinnerbait', 'Shad spawn at first light on riprap/seawalls', 'white, white/chartreuse'],
        ['buzzbait', 'Low light along banks', 'white, black'],
        ['swimbait', 'Points through midday', 'shad'],
      ] },
    { id: 'summer', label: 'Summer', months: [7, 8], temp: [78, 95], trend: 'any',
      where: 'Deep brush piles, ledges, and docks (especially at the Ozarks). Shallow only in low light or at night.',
      depth: '12–25 ft (shallow at night)',
      baits: [
        ['texas_worm', '10" worm on brush and ledges', 'green pumpkin, plum, junebug'],
        ['crankbait_deep', 'Grind ledges and points', 'shad, citrus shad'],
        ['drop_shot', 'Suspended fish on brush', 'morning dawn, green pumpkin'],
        ['topwater_walk', 'First hour of light only', 'bone, shad'],
        ['jig', 'Football jig on rock', 'green pumpkin, brown'],
      ] },
    { id: 'fall', label: 'Fall', months: [9, 10, 11], temp: [50, 78], trend: 'falling',
      where: 'Follow shad into creek arms and flats. Bass roam, so cover water.',
      depth: '2–12 ft',
      baits: [
        ['lipless', 'Burn over flats, yo-yo when it cools', 'chrome/blue, shad, red'],
        ['spinnerbait', 'Windblown banks and pockets', 'white, white/chartreuse'],
        ['squarebill', 'Rock and wood in creek arms', 'shad, chartreuse'],
        ['topwater_walk', 'Around shad activity', 'bone, chrome'],
        ['swimbait', 'Around shad schools', 'shad'],
      ] },
  ],

  crappie: [
    { id: 'winter', label: 'Winter', months: [12, 1, 2], temp: [33, 45], trend: 'any',
      where: 'Suspended over deep brush, channel edges, and the mouths of major creeks.',
      depth: '15–30 ft (often suspended)',
      baits: [
        ['crappie_jig', 'Vertical over brush, very slow', 'white, silver, black/chartreuse'],
        ['minnow_float', 'Set at the depth you mark fish', 'natural'],
        ['spoon', 'Small spoon on deep schools', 'silver'],
      ] },
    { id: 'prespawn', label: 'Pre-spawn', months: [3], temp: [45, 55], trend: 'rising',
      where: 'Staging on brush and channel bends near spawning flats.',
      depth: '8–15 ft',
      baits: [
        ['crappie_jig', 'Slow swim or vertical', 'white/chartreuse, black/chartreuse'],
        ['minnow_float', 'Over staging brush', 'natural'],
        ['trolling_crank', 'Small cranks or long-lined jigs over flats', 'shad, chartreuse'],
      ] },
    { id: 'spawn', label: 'Spawn', months: [4, 5], temp: [55, 66], trend: 'rising',
      where: 'Shallow brush, rock, and timber in coves and along banks.',
      depth: '1–6 ft',
      baits: [
        ['jig_bobber', 'Twitch near cover', 'pink/white, chartreuse, black/chartreuse'],
        ['minnow_float', 'Tight to cover', 'natural'],
        ['crappie_jig', 'Swim slow along cover', 'white, chartreuse'],
      ] },
    { id: 'postspawn', label: 'Post-spawn', months: [5, 6], temp: [66, 76], trend: 'rising',
      where: 'Pulled back to the first brush and drops outside the spawning areas.',
      depth: '8–15 ft',
      baits: [
        ['crappie_jig', 'Vertical in brush', 'white, chartreuse'],
        ['trolling_crank', 'Troll small cranks along flats and edges', 'shad, chartreuse'],
        ['minnow_float', 'Over brush', 'natural'],
      ] },
    { id: 'summer', label: 'Summer', months: [7, 8, 9], temp: [76, 95], trend: 'any',
      where: 'Brush piles and docks with brush near the thermocline; under lights at night (Ozarks).',
      depth: '12–20 ft',
      baits: [
        ['crappie_jig', 'Vertical in brush', 'white, smoke, chartreuse'],
        ['minnow_float', 'Under lights at night or over brush', 'natural'],
        ['trolling_crank', 'Troll over flats and humps', 'shad, chartreuse'],
      ] },
    { id: 'fall', label: 'Fall', months: [10, 11], temp: [50, 76], trend: 'falling',
      where: 'Moving into creek arms following shad; brush at 8–15 ft, shallower on warm afternoons.',
      depth: '6–15 ft',
      baits: [
        ['crappie_jig', 'Brush in creek arms', 'white, chartreuse, black/chartreuse'],
        ['minnow_float', 'Over brush', 'natural'],
        ['jig_bobber', 'Shallow cover on warm days', 'chartreuse'],
      ] },
  ],

  whitebass: [
    { id: 'winter', label: 'Winter', months: [12, 1, 2], temp: [33, 48], trend: 'any',
      where: 'Schooled on deep main-lake structure and channel edges near shad.',
      depth: '20–40 ft',
      baits: [
        ['spoon', 'Vertical on schools you mark', 'silver, white'],
        ['blade_bait', 'Lift-drop near bottom', 'silver'],
      ] },
    { id: 'run', label: 'Spawning run', months: [3, 4], temp: [50, 64], trend: 'rising',
      where: 'Up the tributaries and creeks with current; windblown points near creek mouths.',
      depth: '2–10 ft',
      baits: [
        ['inline_spinner', 'Cast across current', 'silver, white'],
        ['grub', 'Small jig + curly tail', 'white, chartreuse'],
        ['trolling_crank', 'Small cranks near creek mouths', 'shad, chartreuse'],
      ] },
    { id: 'postspawn', label: 'Late spring', months: [5, 6], temp: [64, 76], trend: 'rising',
      where: 'Back to main-lake points and flats; windblown points.',
      depth: '5–15 ft',
      baits: [
        ['trolling_crank', 'Troll points and flats', 'shad, chrome'],
        ['grub', 'Cast points', 'white'],
        ['lipless', 'Windblown points', 'chrome, shad'],
      ] },
    { id: 'summer', label: 'Summer', months: [7, 8, 9], temp: [76, 95], trend: 'any',
      where: 'Schools chasing shad on flats, humps, and points; surface feeding ("jumps") early and late.',
      depth: '0–20 ft',
      baits: [
        ['topwater_walk', 'Into surface-feeding fish', 'chrome, bone'],
        ['spoon', 'Slab spoon on fish you mark', 'silver, white'],
        ['trolling_crank', 'Troll flats and humps at 2–3 mph', 'shad, chrome'],
        ['lipless', 'Cast into schools', 'chrome'],
      ] },
    { id: 'fall', label: 'Fall', months: [10, 11], temp: [50, 76], trend: 'falling',
      where: 'Chasing shad in creek arms and on flats; watch for birds.',
      depth: '5–20 ft',
      baits: [
        ['lipless', 'Cast into breaking fish', 'chrome, shad'],
        ['spoon', 'On schools', 'silver'],
        ['grub', 'Swim through schools', 'white'],
      ] },
  ],

  catfish: [
    { id: 'winter', label: 'Winter', months: [12, 1, 2], temp: [33, 48], trend: 'any',
      where: 'Blues feed on shad along deep channel edges (Ozarks); channels slow down on deep flats.',
      depth: '20–40 ft',
      baits: [
        ['cut_shad', 'Drift slowly or anchor on channel edges', 'natural'],
        ['live_shad', 'For bigger blues', 'natural'],
      ] },
    { id: 'spring', label: 'Spring', months: [3, 4, 5], temp: [48, 70], trend: 'rising',
      where: 'Shallow flats, windblown banks, and creek inflows, especially after rain.',
      depth: '3–12 ft',
      baits: [
        ['cut_shad', 'Windblown flats and inflows', 'natural'],
        ['nightcrawler', 'Inflows after rain', 'natural'],
        ['chicken_liver', 'Channel cats on flats', 'natural'],
      ] },
    { id: 'spawn', label: 'Spawn', months: [6], temp: [70, 82], trend: 'rising',
      where: 'Rocky banks, riprap, and cavities. The bite can slow while fish spawn.',
      depth: '2–15 ft',
      baits: [
        ['nightcrawler', 'Along riprap', 'natural'],
        ['cut_shad', 'Near rock', 'natural'],
        ['dip_bait', 'Channel cats', 'natural'],
      ] },
    { id: 'summer', label: 'Summer', months: [7, 8, 9], temp: [80, 95], trend: 'any',
      where: 'Drift flats and channel edges; night fishing is often best. Windblown banks.',
      depth: '8–25 ft',
      baits: [
        ['cut_shad', 'Drift flats', 'natural'],
        ['dip_bait', 'Channel cats on flats and brush', 'natural'],
        ['nightcrawler', 'At night', 'natural'],
        ['live_shad', 'For flatheads near cover', 'natural'],
      ] },
    { id: 'fall', label: 'Fall', months: [10, 11], temp: [50, 80], trend: 'falling',
      where: 'Following shad into creek arms; feeding heavily before winter.',
      depth: '5–20 ft',
      baits: [
        ['cut_shad', 'Creek arms and flats', 'natural'],
        ['live_shad', 'Blues and flatheads', 'natural'],
        ['nightcrawler', 'Channel cats', 'natural'],
      ] },
  ],
};

// Color advice by water clarity (general guidance)
export const COLOR_ADVICE = {
  clear: 'Clear water: natural, translucent colors (green pumpkin, shad, smoke, ghost). Lighter line, longer casts.',
  stained: 'Stained water: brighter/solid colors (chartreuse, white/chartreuse, firetiger, black/blue).',
  muddy: 'Muddy water: dark (black/blue) or very bright (chartreuse) with vibration or rattles. Fish tight to cover. Scent helps for catfish.',
};
