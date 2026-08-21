'use strict';
/* 테스트 공용: 자동수집(live) 단지를 UI(prepareComplexForAnalysis)와 동일한 경로로 빌드.
   §1 파이프라인 통일 — 검색(liveSearchMatch) → shard 조회 → dongLink·K-apt 매칭 → buildAutoComplex */
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..');
const R = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const E = require('../src/engine.js');

const CFG = R('config/valuation-parameters.json');
const HUBS = R('config/education_hubs.json');
HUBS.anchors = R('config/anchor_academies.json');   // UI 초기화와 동일 (§6)
const JOBS = R('config/job_centers.json');
const STN = R('data/station_intelligence.json');
const LINEI = R('data/line_intelligence.json');
const DONG = R('data/dong_stations.json');
const REGIONS = R('pipeline/regions.json');
const ALIASES = R('data/complex_aliases.json');
const INDEX = R('data/live/index.json');

const shards = {};
const shardOf = code => shards[code] || (shards[code] = R(`data/live/${code}.json`));
const kaptCache = {};
function kaptOf(code) {
  if (code in kaptCache) return kaptCache[code];
  const p = path.join(ROOT, 'data', 'complex_info', `${code}.json`);
  return (kaptCache[code] = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null);
}
const regionOf = code => REGIONS.regions.find(r => r.code === code);

function dongLinkFor(regionCode, dong) {
  const scoped = DONG.map[`${regionCode}:${dong}`];
  if (scoped !== undefined) return scoped.length ? scoped : null;
  return DONG.map[dong] || null;
}

/* 검색: UI renderAptList와 동일한 매처.
   순위: 직접 매칭(브랜드 접두어 제거 없이) > 접두어 제거 매칭, 그 안에서 거래 수(t) 순.
   gu를 주면 해당 시군구로 한정(회귀 테스트의 오지역 매칭 방지). */
function findLive(query, gu) {
  const brandPrefixes = (CFG.search && CFG.search.brandPrefixes) || [];
  const pool = gu ? INDEX.complexes.filter(e => (e.gn || '').includes(gu)) : INDEX.complexes;
  const hits = pool
    .filter(e => E.liveSearchMatch(query, e, { brandPrefixes, aliases: (ALIASES.aliases || {})[e.id] }))
    .map(e => ({ e, direct: E.liveSearchMatch(query, e, { aliases: (ALIASES.aliases || {})[e.id] }) ? 1 : 0 }))
    .sort((a, b) => b.direct - a.direct || (b.e.t || 0) - (a.e.t || 0))
    .map(x => x.e);
  return hits;
}

/* UI prepareComplexForAnalysis({kind:'live'})와 동일한 빌드 */
function prepareLive(id) {
  const e = INDEX.complexes.find(x => x.id === id);
  if (!e) return null;
  const shard = shardOf(e.g);
  const key = id.split('|').slice(1).join('|');
  const entry = shard.complexes[key];
  if (!entry) return null;
  const cx = E.buildAutoComplex(entry, regionOf(e.g), {
    edits: {}, ovPrice: null, ovJeonse: null, areaKey: null, conv: null,
    asOf: INDEX.meta.updatedAt, stations: STN, hubs: HUBS,
    dongLink: dongLinkFor(e.g, entry.dong),
    kapt: E.matchKaptInfo(kaptOf(e.g), entry.name, (ALIASES.aliases || {})[id]),
    liveId: id
  });
  return { cx, entry, region: regionOf(e.g), id };
}

const analyze = (cx, areaKey) => E.analyze(
  { complex: cx, areaKey, asOfYM: INDEX.meta.updatedAt, overrides: {} }, CFG, HUBS, JOBS, STN);

module.exports = { CFG, HUBS, JOBS, STN, LINEI, DONG, REGIONS, ALIASES, INDEX, E, findLive, prepareLive, analyze, shardOf, regionOf };
