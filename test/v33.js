'use strict';
/* V3.3 P0 회귀 테스트 — 개선 PRD(20260819) 수용 기준
   AC-01/09: 부록 20단지 + 무작위 자동수집 단지 E2E 무오류
   AC-02: 세대수·전세·역·공급 null 조합에서 분석 완주
   AC-03: 디에이치자이개포 84 — 세대수 입력 없이 결과 산출
   AC-04: 판교푸르지오그랑블 — 전세 없어도 시장·교통·상품 분석
   AC-05: 통칭(잠실리센츠)·분할명(e편한세상옥수파크힐스) 검색
   AC-06: 거래 0건 평형 기본선택 금지
   AC-07: 근거 패널 수치의 재계산 일치 (기준가·금융·브리지·범위)
   AC-08: 기준가 low/high = med ∓ half 정합 (단일 원천 필드) */
const fs = require('fs'), path = require('path');
const E = require('../src/engine.js');
const J = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const CFG = J('config/valuation-parameters.json');
const HUBS = J('config/education_hubs.json');
const JOBS = J('config/job_centers.json');
const STN = J('data/station_intelligence.json');
const DONG = J('data/dong_stations.json');
const REGIONS = J('pipeline/regions.json').regions;
const ALIASES = J('data/complex_aliases.json');
const IDX = J('data/live/index.json');

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.error('  ✗ FAIL:', name); } };
const regionOf = code => REGIONS.find(r => r.code === code);
const dongLinkFor = (code, dong) => {
  const scoped = DONG.map[`${code}:${dong}`];
  if (scoped !== undefined) return scoped.length ? scoped : null;
  return DONG.map[dong] || null;
};
const shards = {};
const getShard = code => shards[code] || (shards[code] = J(`data/live/${code}.json`));
const asOf = IDX.meta.updatedAt || '2026-08';

function buildLive(id, edits, ovPrice) {
  const [code, ...rest] = id.split('|');
  const key = rest.join('|');
  const entry = getShard(code).complexes[key];
  if (!entry) return null;
  const region = regionOf(code);
  return E.buildAutoComplex(entry, region, {
    edits: edits || {}, ovPrice: ovPrice ?? null, areaKey: null,
    conv: null, asOf, stations: STN, hubs: HUBS,
    dongLink: dongLinkFor(code, entry.dong), kapt: null, liveId: id
  });
}
function analyzeLive(id, areaKey, edits) {
  const cx = buildLive(id, edits);
  if (!cx) return { skip: true };
  const key = areaKey || E.pickDefaultAreaKey(cx.areas, CFG.search.defaultAreaPrefs);
  const area = cx.areas.find(a => a.key === key) || cx.areas[0];
  if (!(area.trades || []).length) return { skip: true, noTrades: true, cx, key };
  const r = E.analyze({ complex: cx, areaKey: key, asOfYM: asOf, overrides: {}, autoComplex: true }, CFG, HUBS, JOBS, STN);
  return { r, cx, key };
}

/* ── josa (FR-09 조사 오류) ── */
ok(E.josa('단지 규모', '이', '가') === '단지 규모가', 'josa: 규모+가');
ok(E.josa('희소성', '이', '가') === '희소성이', 'josa: 희소성+이');
ok(E.josa('전세수요', '이', '가') === '전세수요가', 'josa: 수요+가');
ok(E.josa('흐름', '이', '가') === '흐름이', 'josa: 흐름+이');

/* ── AC-06 · FR-04 평형 기본선택 ── */
{
  const areas = [
    { key: '63', m2: 63, trades: [] },
    { key: '84', m2: 84, trades: [{ ym: '2026-05', price: 36.5 }] },
    { key: '118', m2: 118, trades: [] }
  ];
  ok(E.pickDefaultAreaKey(areas) === '84', 'FR-04: 거래 0건(63) 대신 거래 있는 84 선택');
  const areas2 = [
    { key: '27', m2: 27, trades: [{ ym: '2026-05', price: 10 }, { ym: '2026-04', price: 10 }] },
    { key: '59', m2: 59, trades: [{ ym: '2026-05', price: 20 }] },
    { key: '84', m2: 84, trades: [{ ym: '2026-05', price: 26 }] }
  ];
  ok(E.pickDefaultAreaKey(areas2) === '84', 'FR-04: 84 최근접 우선 (거래량보다 우선)');
  const areas3 = [{ key: '27', m2: 27, trades: [] }, { key: '59', m2: 59, trades: [] }];
  ok(E.pickDefaultAreaKey(areas3) === '27', 'FR-04: 전 평형 거래 0건이면 첫 평형 폴백');
  // 리센츠 실데이터: 27이 아닌 84가 기본
  const cx = buildLive('11710|잠실동|리센츠');
  ok(E.pickDefaultAreaKey(cx.areas, CFG.search.defaultAreaPrefs) === '84', 'AC-06: 리센츠 기본 84㎡ (27 아님)');
  const dh = buildLive('11680|일원동|디에이치자이개포');
  const dhKey = E.pickDefaultAreaKey(dh.areas, CFG.search.defaultAreaPrefs);
  ok((dh.areas.find(a => a.key === dhKey).trades || []).length > 0, `AC-06: 디에이치자이개포 기본평형(${dhKey})은 거래 보유 (63 아님)`);
}

/* ── AC-05 · FR-01 검색 정규화 ── */
{
  const bp = CFG.search.brandPrefixes;
  const ricen = IDX.complexes.find(e => e.id === '11710|잠실동|리센츠');
  ok(E.liveSearchMatch('잠실리센츠', ricen, { brandPrefixes: bp, aliases: ALIASES.aliases[ricen.id] }), 'AC-05: "잠실리센츠" → 리센츠 (통칭)');
  ok(E.liveSearchMatch('리센츠', ricen, { brandPrefixes: bp }), 'AC-05: "리센츠" 기본 검색');
  const oksu = IDX.complexes.filter(e => /옥수파크힐스/.test(e.n));
  ok(oksu.length === 2 && oksu.every(e => E.liveSearchMatch('e편한세상옥수파크힐스', e, { brandPrefixes: bp })), 'AC-05: "e편한세상옥수파크힐스" → 분할 등재 2건 (브랜드 접두어 제거)');
  ok(oksu.every(e => E.liveSearchMatch('e편한세상 옥수 파크힐스', e, { brandPrefixes: bp })), 'AC-05: 공백 포함 검색 흡수');
  const g = ALIASES.splitGroups.find(x => x.id === 'oksu-parkhills');
  ok(!!g && E.liveSearchMatch('옥수파크힐스', { n: g.display, gn: '', d: '' }, { brandPrefixes: bp, aliases: g.aliases }), 'AC-05: 통합단지 그룹 매칭');
  const parkrio = IDX.complexes.find(e => e.id === '11710|신천동|파크리오');
  ok(E.liveSearchMatch('잠실파크리오', parkrio, { brandPrefixes: bp, aliases: ALIASES.aliases[parkrio.id] }), 'FR-01: 별칭 테이블 (잠실파크리오 — 신천동 소재)');
  ok(E.liveSearchMatch('파크리오아파트', parkrio, { brandPrefixes: bp }), 'FR-01: "아파트" 접미어 흡수');
  ok(!E.liveSearchMatch('존재하지않는단지명', parkrio, { brandPrefixes: bp }), 'FR-01: 무관 검색어는 미매칭');
}

/* ── FR-01 분할단지 병합 ── */
{
  const g = ALIASES.splitGroups.find(x => x.id === 'oksu-parkhills');
  const shard = getShard(g.region);
  const entries = g.members.map(m => shard.complexes[m.split('|').slice(1).join('|')]).filter(Boolean);
  ok(entries.length === 2, 'FR-01: 옥수파크힐스 구성 2건 로드');
  const merged = E.mergeLiveEntries(g.display, entries);
  const n1 = Object.values(entries[0].areas).reduce((s, a) => s + (a.trades || []).length, 0);
  const n2 = Object.values(entries[1].areas).reduce((s, a) => s + (a.trades || []).length, 0);
  const nm = Object.values(merged.areas).reduce((s, a) => s + (a.trades || []).length, 0);
  ok(nm === n1 + n2, `FR-01: 병합 거래 수 보존 (${n1}+${n2}=${nm})`);
  ok(merged.mergedFrom.length === 2, 'FR-01: 원 등재명 보존');
  const region = regionOf(g.region);
  const cx = E.buildAutoComplex(merged, region, { edits: {}, areaKey: null, conv: null, asOf, stations: STN, hubs: HUBS, dongLink: dongLinkFor(g.region, merged.dong), kapt: null, liveId: 'group|' + g.id });
  const key = E.pickDefaultAreaKey(cx.areas, CFG.search.defaultAreaPrefs);
  const r = E.analyze({ complex: cx, areaKey: key, asOfYM: asOf, overrides: {}, autoComplex: true }, CFG, HUBS, JOBS, STN);
  ok(r.currentPrice > 0 && isFinite(r.range.low), 'FR-01: 통합단지 분석 완주');
}

/* ── AC-03 · 디에이치자이개포 84 — 세대수 없이 완주 ── */
{
  const { r } = analyzeLive('11680|일원동|디에이치자이개포', '84');
  ok(r && r.currentPrice > 0 && r.cx.households == null, 'AC-03: 세대수 null 상태로 분석 완주');
  ok(r.scores.living.total >= 0 && isFinite(r.scores.invest.total), 'AC-03: 점수 산출 (재정규화)');
}

/* ── AC-04 · 판교푸르지오그랑블 — 전세 없어도 부분 분석 ── */
{
  const out = analyzeLive('41135|백현동|판교푸르지오그랑블');
  ok(!out.skip, 'AC-04: 판교푸르지오그랑블 거래 보유 평형 존재');
  if (!out.skip) {
    const r = out.r;
    const areaHasJeonse = r.area.jeonse > 0;
    if (!areaHasJeonse) {
      ok(r.finHeld === true && r.financial == null, 'AC-04: 전세 없음 → 금융만 보류');
      ok(r.verdicts.financial.held && r.verdicts.financial.label === CFG.verdicts.heldLabel, 'AC-04: 금융 판정 = 분석 보류');
    }
    ok(isFinite(r.scores.living.total) && isFinite(r.scores.invest.total) && r.currentPrice > 0, 'AC-04: 시장·주거·투자 분석은 제공');
    ok(r.hedonic.subs.transport == null || isFinite(r.hedonic.subs.transport), 'AC-04: 교통 분석 정상(또는 미확인 제외)');
  }
}

/* ── AC-02 · null 조합 내성 (세대수/전세/역/공급) ── */
{
  const base = buildLive('11740|상일동|고덕아르테온');
  const mk = mut => {
    const cx = JSON.parse(JSON.stringify(base));
    mut(cx);
    const key = E.pickDefaultAreaKey(cx.areas, CFG.search.defaultAreaPrefs);
    return E.analyze({ complex: cx, areaKey: key, asOfYM: asOf, overrides: {}, autoComplex: true }, CFG, HUBS, JOBS, STN);
  };
  const combos = [
    ['세대수 null', cx => { cx.households = null; }],
    ['전세 null', cx => { for (const a of cx.areas) { a.jeonse = null; a.jeonseMeta = null; } }],
    ['역 null', cx => { cx.stationLink = null; cx.location.subwayMin = null; cx.location.unknownTransport = true; }],
    ['공급 기본', cx => { cx.supply.next3yAvg = cx.supply.next3yAvg || 0; }],
    ['세대수+전세+역 동시 null', cx => {
      cx.households = null; cx.stationLink = null; cx.location.unknownTransport = true;
      for (const a of cx.areas) { a.jeonse = null; a.jeonseMeta = null; }
    }]
  ];
  for (const [name, mut] of combos) {
    let ok1 = false, r = null;
    try { r = mk(mut); ok1 = r.currentPrice > 0 && isFinite(r.range.low) && isFinite(r.scores.living.total); } catch (e) { ok1 = false; }
    ok(ok1, `AC-02: ${name} → 분석 완주`);
  }
  // 세대수 수동 입력 = MANUAL 상태 (회귀: 고덕아르테온 4,066)
  const cxM = buildLive('11740|상일동|고덕아르테온', { households: 4066 });
  ok(cxM.households === 4066 && cxM.fieldStatus.households === 'MANUAL', '회귀: 세대수 수동 입력 → MANUAL 표시');
}

/* ── FR-02 · normNameK 정규화 (파이프라인 normName과 동일해야 함) ── */
ok(E.normNameK('강동리버스트 8단지') === '강동리버스트8단지', 'normNameK: 공백');
ok(E.normNameK('고덕센트럴IPARK') === '고덕센트럴아이파크', 'normNameK: 영문 브랜드 한글화');
ok(E.normNameK('선사현대아파트') === '선사현대', 'normNameK: 아파트 접미어');
ok(E.normNameK('삼익파크맨션') === '삼익파크', 'normNameK: 맨션 접미어');
ok(E.normNameK('광남캐스빌(247-0)') === '광남캐스빌', 'normNameK: 괄호 제거');

/* ── FR-02 · K-apt 매칭 (모의 데이터 — 형식 검증) ── */
{
  const info = { meta: { asOf: '2026-08-19' }, byName: { '고덕아르테온': { kaptCode: 'A1', households: 4066, parkingRatio: 1.2, asOf: '2026-08-01' }, '동명단지': { ambiguous: true, candidates: ['A2', 'A3'] } } };
  const rec = E.matchKaptInfo(info, '고덕아르테온');
  ok(rec && rec.households === 4066, 'FR-02: normName 매칭');
  ok(E.matchKaptInfo(info, '동명단지') === null, 'FR-02: 동명 복수 후보(ambiguous) → 자동 확정 금지');
  const [code, ...rest] = '11740|상일동|고덕아르테온'.split('|');
  const entry = getShard(code).complexes[rest.join('|')];
  const cx = E.buildAutoComplex(entry, regionOf(code), { edits: {}, areaKey: null, conv: null, asOf, stations: STN, hubs: HUBS, dongLink: dongLinkFor(code, entry.dong), kapt: rec, liveId: 'x' });
  ok(cx.households === 4066 && cx.fieldStatus.households === 'VERIFIED' && cx.householdsSource === 'KAPT', 'FR-02: K-apt 세대수 → VERIFIED 반영');
  ok(cx.parkingRatio === 1.2, 'FR-02: K-apt 주차비율 반영');
  ok(E.matchKaptInfo(null, '고덕아르테온') === null, 'FR-02: 샤드 없음 → null (임의 기본값 없음)');
}

/* ── FR-02 · K-apt 실수집 샤드 검증 (수집된 경우에만 — 승인·수집 전 클론에서도 테스트 통과) ── */
{
  const p = path.join(__dirname, '../data/complex_info/11680.json');
  if (fs.existsSync(p)) {
    const info = JSON.parse(fs.readFileSync(p, 'utf8'));
    const dh = E.matchKaptInfo(info, '디에이치자이개포');
    ok(dh && dh.households === 1996, `FR-02 실데이터: 디에이치자이개포 1,996세대 (got ${dh && dh.households})`);
    const info710 = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/complex_info/11710.json'), 'utf8'));
    ok(E.matchKaptInfo(info710, '파크리오') === null, 'FR-02: 파크리오 직접 매칭은 실패 (K-apt명 "잠실파크리오")');
    const pr = E.matchKaptInfo(info710, '파크리오', ALIASES.aliases['11710|신천동|파크리오']);
    ok(pr && pr.households > 6000, `FR-02: 별칭 경유 매칭 → 잠실파크리오 ${pr && pr.households}세대`);
    // 통합: buildAutoComplex에 K-apt 반영 → households VERIFIED
    const [code, ...rest] = '11680|일원동|디에이치자이개포'.split('|');
    const entry = getShard(code).complexes[rest.join('|')];
    const cx = E.buildAutoComplex(entry, regionOf(code), { edits: {}, areaKey: null, conv: null, asOf, stations: STN, hubs: HUBS, dongLink: dongLinkFor(code, entry.dong), kapt: dh, liveId: 'x' });
    ok(cx.households === 1996 && cx.fieldStatus.households === 'VERIFIED', 'FR-02 실데이터: 세대수 VERIFIED 반영');
    const r = E.analyze({ complex: cx, areaKey: '84', asOfYM: asOf, overrides: {}, autoComplex: true }, CFG, HUBS, JOBS, STN);
    ok(r.currentPrice > 0 && r.dataStatus.VERIFIED >= 3, 'FR-02 실데이터: K-apt 반영 분석 완주 (VERIFIED 증가)');
  }
}

/* ── AC-07 · 근거 패널 수치 재계산 일치 ── */
{
  const { r } = analyzeLive('11740|상일동|고덕아르테온', '84');
  const m = r.marketRef;
  // ② 기준가: 공개 items → 가중중앙값 재계산 = med
  const med2 = E.weightedMedian(m.items.map(t => ({ v: t.price, w: t.wRaw })));
  ok(Math.abs(med2 - m.med) < 1e-9, 'AC-07: 기준가 중앙값 = 공개 거래·가중치 재계산값');
  ok(Math.abs((m.med - m.formula.half) - m.low) < 1e-9 && Math.abs((m.med + m.formula.half) - m.high) < 1e-9, 'AC-07/AC-08: low/high = med ∓ half');
  ok(Math.abs(Math.max(m.formula.minHalf, m.formula.iqrHalf) - m.formula.half) < 1e-9, 'AC-07: half = max(최소반폭, IQR/2)');
  // ③ 금융: V = R/(r−g) 재계산
  const f = r.financial;
  if (f) {
    for (const s of f.scen) {
      if (s.mode === 'gordon') ok(Math.abs(f.R / (f.r - s.g) - s.v) < 1e-9, `AC-07: 금융 ${s.k} = R/(r−g) 재계산`);
    }
    const rSum = f.rParts.altReturn + f.rParts.liquidityPremium + f.rParts.assetRiskPremium + f.rParts.regionRiskPremium + f.rParts.rateDelta;
    ok(Math.abs(rSum - f.r) < 1e-12, 'AC-07: r = 구성요소 합');
  }
  // ④ 브리지: vMktAdj = vM×(1+hRes+supAdj), center 결합 재계산
  const co = r.combineOut, vM = r.market.value;
  ok(Math.abs(vM * (1 + co.hRes + r.supplyE.adj) - co.vMktAdj) < 1e-9, 'AC-07: 조정 후 시장경로 = 앵커×(1+잔차+수급)');
  if (!co.marketOnly && !co.anchorClamped) {
    ok(Math.abs(co.wm * co.vMktAdj + co.wf * co.vFundEff - co.center) < 1e-9, 'AC-07: 결합 중심 = 가중합');
  }
  ok(Math.abs(co.center * (1 - r.range.spread) - r.range.low) < 1e-9 && Math.abs(co.center * (1 + r.range.spread) - r.range.high) < 1e-9, 'AC-07: 범위 = 중심×(1∓spread)');
}

/* ── AC-01 · 부록 20단지 (검색 실패 2건은 AC-05에서 검증) ── */
{
  const list = [
    ['11680|일원동|디에이치자이개포', '84'], ['11740|둔촌동|올림픽파크포레온', '39'],
    ['11740|상일동|고덕아르테온', '84'], ['11650|반포동|아크로리버파크', '84'],
    ['11650|반포동|래미안원베일리', '84'], ['41135|백현동|판교푸르지오그랑블', null],
    ['41290|중앙동|과천푸르지오써밋', '59'], ['11710|신천동|파크리오', '84'],
    ['11680|대치동|래미안대치팰리스', '84'], ['11680|개포동|개포자이프레지던스', '84'],
    ['11710|잠실동|리센츠', null], ['11680|개포동|래미안블레스티지', '84'],
    ['11200|행당동|서울숲리버뷰자이', '84'], ['11440|용강동|래미안마포리버웰', '84'],
    ['11590|흑석동|흑석리버파크자이', '59'], ['11590|흑석동|아크로리버하임', '59'],
    ['41210|일직동|광명역센트럴자이', '84'], ['41131|신흥동|산성역포레스티아', '59']
  ];
  let done = 0, held = 0;
  for (const [id, keyWant] of list) {
    try {
      const out = analyzeLive(id, keyWant);
      if (out.skip && out.noTrades) { out.cx && done++; continue; }   // 해당 평형 거래 없음 — '시세 입력 필요' 설계 동작
      const r = out.r;
      if (r.currentPrice > 0 && isFinite(r.range.low) && isFinite(r.scores.living.total)) done++;
      if (r.finHeld) held++;
    } catch (e) { console.error('    ✗', id, e.message); }
  }
  ok(done === list.length, `AC-01: 부록 단지 ${done}/${list.length} 전건 오류 없이 완주 (금융 보류 ${held}건 포함)`);
}

/* ── AC-09 · 무작위 자동수집 단지 E2E (전 지역, 결정적 표본 120+) ── */
{
  const sample = IDX.complexes.filter((e, i) => i % 70 === 0);   // 8,880 → ~127단지, 결정적
  let ran = 0, crashed = 0;
  for (const e of sample) {
    try {
      const out = analyzeLive(e.id);
      if (out.skip) continue;   // 거래 전무 단지 — 시세 입력 필요(설계 동작)
      const r = out.r;
      if (!(r.currentPrice > 0) || !isFinite(r.range.low) || !isFinite(r.scores.living.total) || !isFinite(r.scores.invest.total)) {
        crashed++; console.error('    ✗ 비정상 결과:', e.id);
      } else ran++;
    } catch (err) { crashed++; console.error('    ✗ 예외:', e.id, err.message); }
  }
  ok(crashed === 0 && ran >= 60, `AC-09: 무작위 ${sample.length}단지 표본 — 분석 ${ran}건, 치명 오류 ${crashed}건`);
}

console.log(`\nV3.3 P0: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
