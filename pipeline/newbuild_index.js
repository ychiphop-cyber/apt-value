'use strict';
/* ═══════════════════════════════════════════════════════════════════
   동급 신축 인덱스 (§R1 매칭용) — 준공 12년 이내 단지의 세대수·역·노선 등급·
   학군 등급·84형 실거래/전월세 요약을 한 파일로 만든다.
   API 호출 없음 — 로컬 샤드(data/live)·K-apt(data/complex_info)·역 연결(dong_stations)·
   교육생활권(education_hubs)에서 파생. 수집 갱신 후 재실행.
   출력: data/newbuild_index.json  { meta, items: [{id,n,g,gn,d,y,hh,st,min,lg,sg,m2,deal,Rg,jeonse,perM2}] }
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const R = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const E = require('../src/engine.js');

const CFG = R('config/valuation-parameters.json');
const HUBS = R('config/education_hubs.json');
HUBS.anchors = R('config/anchor_academies.json');
const STN = R('data/station_intelligence.json');
const DONG = R('data/dong_stations.json');
const REGIONS = R('pipeline/regions.json');
const ALIASES = R('data/complex_aliases.json');
const E2 = CFG.education;

const MAX_AGE = 12;
const asOfYM = R('data/live/index.json').meta.updatedAt;
const asOfYear = Number(asOfYM.slice(0, 4));

function dongLinkFor(regionCode, dong) {
  const scoped = DONG.map[`${regionCode}:${dong}`];
  if (scoped !== undefined) return scoped.length ? scoped : null;
  return DONG.map[dong] || null;
}
// 학군 등급: 교육생활권 존 Tier — S·A→1, B→2, 그 외→3 (미매칭 null)
function schoolGradeOf(dong, district, stCoord) {
  const zm = E.matchEduZone(HUBS, { dong, district, coord: stCoord }, E2);
  if (!zm) return null;
  const zs = E.eduZoneScore(zm.zone, E2, HUBS.anchors);
  if (!zs) return null;
  return zs.tierIdx <= 1 ? 1 : zs.tierIdx === 2 ? 2 : 3;
}

const items = [];
for (const region of REGIONS.regions.filter(r => r.enabled)) {
  const shardPath = path.join(ROOT, 'data', 'live', `${region.code}.json`);
  if (!fs.existsSync(shardPath)) continue;
  const shard = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
  const infoPath = path.join(ROOT, 'data', 'complex_info', `${region.code}.json`);
  const info = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, 'utf8')) : null;
  for (const [key, e] of Object.entries(shard.complexes)) {
    if (!e.builtYear || asOfYear - e.builtYear > MAX_AGE) continue;
    // 84 최근접 평형
    let best = null;
    for (const [k2, a] of Object.entries(e.areas || {})) {
      const dd = Math.abs((a.m2 || Number(k2) || 84) - 84);
      if (dd > 12) continue;
      if (!best || dd < best.dd) best = { a, dd };
    }
    if (!best) continue;
    const id = `${region.code}|${key}`;
    const kapt = E.kaptResolve(info, e.name, id, ALIASES);
    const hh = kapt && kapt.households > 0 ? kapt.households : null;
    const dl = dongLinkFor(region.code, e.dong);
    const stName = dl && dl.length && STN.stations[dl[0].st] ? dl[0].st : null;
    const stMin = stName ? dl[0].min : null;
    const lg = stName ? E.v5LineGrade(STN.stations[stName].lines, CFG) : null;
    const stCoord = stName ? STN.stations[stName].c : null;
    const sg = schoolGradeOf(e.dong, region.district || region.name, stCoord);
    const conv = region.conv || CFG.financial.defaultConversionRate;
    const basis = E.v4RentBasis({
      jeonseRaw: best.a.jeonseRaw || [], wolseRaw: best.a.wolseRaw || [],
      jeonse: best.a.jeonse ? best.a.jeonse.v : null, jeonseMeta: best.a.jeonse || null
    }, { overrides: {} }, CFG, asOfYM);
    const Rj = basis.jeonse ? basis.jeonse.v * conv : null;
    const Rw = basis.wolse ? basis.wolse.dep * conv + basis.wolse.mr * 12 / 10000 : null;
    const Rg = Math.max(Rj ?? -1, Rw ?? -1);
    const bt = (best.a.trades || [])[0];
    const deal = bt && E.monthsBetween(asOfYM, bt.ym) <= 12 ? { price: bt.price, ym: bt.ym } : null;
    if (!deal && !(Rg > 0)) continue;   // 실거래도 임대도 없으면 무의미
    const m2 = best.a.m2 || 84;
    items.push({
      id, n: e.name, g: region.code, gn: `${region.sido} ${region.name}`, d: e.dong,
      y: e.builtYear, hh, st: stName, min: stMin, lg, sg, m2: Math.round(m2 * 10) / 10,
      deal, Rg: Rg > 0 ? Math.round(Rg * 1000) / 1000 : null,
      jeonse: basis.jeonse ? Math.round(basis.jeonse.v * 100) / 100 : null,
      perM2: deal ? Math.round(deal.price / m2 * 1000) / 1000 : null
    });
  }
}
items.sort((a, b) => (b.hh || 0) - (a.hh || 0));
const out = { meta: { asOf: asOfYM, maxAgeYears: MAX_AGE, n: items.length, note: '동급 신축 매칭(§R1) 인덱스 — 로컬 샤드 파생, API 미사용' }, items };
fs.writeFileSync(path.join(ROOT, 'data', 'newbuild_index.json'), JSON.stringify(out));
console.log(`newbuild_index OK — ${items.length}개 단지 (${Math.round(JSON.stringify(out).length / 1024)}KB)`);
