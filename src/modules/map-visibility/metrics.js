import geolib from 'geolib';
import { createHash } from 'node:crypto';

export function generateGrid(center, radiusKm, size) {
  // An inscribed square keeps every measurement point inside the chosen radius.
  const extent = radiusKm * 1000 / Math.sqrt(2);
  const points = [];
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const east = -extent + column * 2 * extent / (size - 1);
      const north = extent - row * 2 * extent / (size - 1);
      const location = geolib.computeDestinationPoint(center, Math.hypot(east, north), Math.atan2(east, north) * 180 / Math.PI, 6378137);
      points.push({ index: points.length + 1, row, column, latitude: location.latitude, longitude: location.longitude, status: 'pending', rank: null, results: [] });
    }
  }
  return points;
}

const round = n => Math.round(n * 10) / 10;
export function metrics(points, range, placeId) {
  const checked = points.filter(p => p.status === 'checked');
  const observed = checked.map(p => placeId ? p.results?.find(r => r.placeId === placeId)?.position : p.rank).filter(r => Number.isInteger(r) && r > 0 && r <= 20);
  const ranks = observed.filter(r => r <= range).sort((a, b) => a - b);
  const complete = checked.length === points.length && points.length > 0;
  const pct = n => complete ? round(n / points.length * 100) : null;
  return {
    total: points.length, checked: checked.length, unknown: points.length - checked.length,
    visible: ranks.length, notVisible: checked.length - ranks.length,
    visibility: pct(ranks.length), average: ranks.length ? round(ranks.reduce((a, b) => a + b, 0) / ranks.length) : null,
    median: ranks.length ? round((ranks[Math.floor((ranks.length - 1) / 2)] + ranks[Math.floor(ranks.length / 2)]) / 2) : null,
    best: ranks[0] ?? null, worst: ranks.at(-1) ?? null,
    top3: pct(observed.filter(r => r <= 3).length), top10: pct(observed.filter(r => r <= 10).length), top20: pct(observed.length),
  };
}

export function signature(scan) {
  return createHash('sha256').update(JSON.stringify([scan.placeId, scan.keyword, scan.center.latitude, scan.center.longitude, scan.radiusKm, scan.gridSize, scan.rankingRange, scan.language, scan.provider || 'serpapi'])).digest('hex');
}
export function compareScans(current, before) {
  if (!before || current.signature !== before.signature || current.status !== 'complete' || before.status !== 'complete' || new Date(before.createdAt) >= new Date(current.createdAt)) return { comparable: false, reason: 'Choose an earlier completed scan with the same business, keyword, coordinates, grid, radius, language and ranking range.' };
  const a = metrics(current.points, current.rankingRange), b = metrics(before.points, before.rankingRange);
  if (a.visibility === null || b.visibility === null) return { comparable: false, reason: 'Incomplete measurement points cannot be compared.' };
  return { comparable: true, before: b, current: a, visibilityChange: round(a.visibility - b.visibility), averageImprovement: a.average === null || b.average === null ? null : round(b.average - a.average) };
}
export function competitorMetrics(scan) {
  const names = new Map([[scan.placeId, scan.businessName]]);
  for (const p of scan.points) for (const r of p.results || []) if (r.placeId) names.set(r.placeId, r.title);
  const rows = [...names].map(([placeId, title]) => ({ placeId, title, own: placeId === scan.placeId, ...metrics(scan.points, scan.rankingRange, placeId) }));
  return [...rows.filter(r => r.own), ...rows.filter(r => !r.own).sort((a, b) => b.visible - a.visible || (a.average ?? Infinity) - (b.average ?? Infinity)).slice(0, 99)];
}
export function regions(scan) {
  const mid = (scan.gridSize - 1) / 2;
  const buckets = { North: [], East: [], South: [], West: [], Center: [] };
  for (const p of scan.points) {
    const n = mid - p.row, e = p.column - mid;
    const name = !n && !e ? 'Center' : Math.abs(n) >= Math.abs(e) ? n > 0 ? 'North' : 'South' : e > 0 ? 'East' : 'West';
    buckets[name].push(p);
  }
  return Object.entries(buckets).map(([area, points]) => ({ area, ...metrics(points, scan.rankingRange) }));
}
export function recommendations(scan) {
  const areas = regions(scan).filter(r => r.area !== 'Center' && r.visibility !== null).sort((a, b) => a.visibility - b.visibility);
  if (scan.status !== 'complete') return [{ title: 'Complete the measurement', detail: 'Unchecked or failed points are unknown, not missing rankings. Resolve the provider error before comparing visibility.', href: '/app/map-visibility' }];
  if (!areas.length || areas[0].visibility === 100) return [];
  const weak = areas[0];
  return [
    { title: `${weak.area}: ${weak.visibility}% observed visibility`, detail: `For "${scan.keyword}", ${weak.visible}/${weak.total} points in this direction appeared in the top ${scan.rankingRange}. Compare the actual competitors at these points.`, href: '/app/map-visibility' },
    { title: 'Investigate genuine service and category coverage', detail: 'Check whether this search describes a service you actually offer and whether it is accurately represented in your profile. This is a possible factor, not a diagnosed ranking cause.', href: '/app/profile?tab=audit' },
    { title: 'Review the corresponding website service page', detail: 'Check useful service details, contact consistency and technical accessibility. Do not create fabricated location pages.', href: '/app/website-audit' },
    { title: 'Check local reputation and location accuracy', detail: 'Review legitimate mentions, genuine customer feedback and your actual map pin. Distance and personalized results remain outside your control.', href: '/app/prominence' },
  ];
}
export function scanReport(scan, baseline) {
  const m = metrics(scan.points, scan.rankingRange);
  const c = compareScans(scan, baseline);
  const rank = n => n === null ? 'Unavailable' : `#${n}`;
  return [
    'ReviewRankr - Local Map Visibility', scan.businessName,
    `Search: ${scan.keyword}`, `Scan: ${new Date(scan.createdAt).toISOString()}`,
    `Provider: ${scan.provider} / language: ${scan.language} / top ${scan.rankingRange}`,
    `Center: ${scan.center.latitude}, ${scan.center.longitude} / radius: ${scan.radiusKm} km / grid: ${scan.gridSize} x ${scan.gridSize}`,
    `Status: ${scan.status} / measured points: ${m.checked}/${m.total} / unknown: ${m.unknown}`,
    `Visibility: ${m.visibility === null ? 'Unavailable (incomplete scan)' : `${m.visibility}%`}`,
    `Average observed rank (found points): ${rank(m.average)} / best: ${rank(m.best)} / median: ${rank(m.median)}`,
    ...(c.comparable ? [`Compared with: ${new Date(baseline.createdAt).toISOString()}`, `Visibility: ${c.before.visibility}% to ${c.current.visibility}% (${c.visibilityChange >= 0 ? '+' : ''}${c.visibilityChange} percentage points)`, `Average observed rank: ${rank(c.before.average)} to ${rank(c.current.average)}`] : baseline ? [`Comparison unavailable: ${c.reason}`] : []),
    ...regions(scan).map(r => {
      const old = c.comparable ? regions(baseline).find(before => before.area === r.area) : null;
      return `${r.area}: ${r.visibility === null ? 'Unknown' : `${r.visibility}%`} / ${r.visible}/${r.total} visible${old ? ` / previously ${old.visibility}% / change ${round(r.visibility - old.visibility)} percentage points` : ''}`;
    }),
    '', 'Possible factors to investigate:', ...recommendations(scan).map(r => `${r.title}: ${r.detail}`),
    '', 'These are third-party observational search measurements, not a Google-provided ranking or visibility score. Results are not guaranteed to be within the requested area and do not establish why rankings changed. Ads are excluded. No ranking or growth guarantee.',
  ].join('\n');
}
