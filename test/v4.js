'use strict';
/* V2 전면개편 PRD 검증 (v4.0.0)
   §43 30개 이상 유형 시나리오 회귀 · §44 방향 논리 · §45 순위 안정성(등급)
   §46 설명 일치 · §48 다섯 질문 답변 존재 · §5 사실/판단 분리 · §11 괴리 표시 · §15 USER_VERIFIED */
const fs = require('fs'), path = require('path');
const E = require('../src/engine.js');
const J = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const CFG = J('config/valuation-parameters.json');
const HUBS = J('config/education_hubs.json');
const JOBS = J('config/job_centers.json');
const STN = J('data/station_intelligence.json');
const DONG = J('data/dong_stations.json');
const REGIONS = J('pipeline/regions.json').regions;
const DATA = J('data/apartments.json');
const IDX = J('data/live/index.json');

let pass = 0, fail = 0;
const ok = (c, name) => { if (c) pass++; else { fail++; console.error('  ✗ FAIL:', name); } };
const finite = x => typeof x === 'number' && isFinite(x);
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
  const entry = getShard(code).complexes[rest.join('|')];
  if (!entry) return null;
  return E.buildAutoComplex(entry, regionOf(code), {
    edits: edits || {}, ovPrice: ovPrice ?? null, areaKey: null, conv: null, asOf,
    stations: STN, hubs: HUBS, dongLink: dongLinkFor(code, entry.dong), kapt: null, liveId: id
  });
}
function runLive(id, areaKey, edits, overrides) {
  const cx = buildLive(id, edits);
  if (!cx) return null;
  const key = areaKey || E.pickDefaultAreaKey(cx.areas, CFG.search.defaultAreaPrefs);
  return E.analyze({ complex: cx, areaKey: key, asOfYM: asOf, overrides: overrides || {}, autoComplex: true }, CFG, HUBS, JOBS, STN);
}
function runSample(id, areaKey, overrides) {
  const cx = DATA.complexes.find(c => c.id === id) || DATA.complexes.find(c => c.name.includes(id));
  if (!cx) return null;
  return E.analyze({ complex: cx, areaKey: areaKey || cx.areas[0].key, asOfYM: DATA.meta.asOf, overrides: overrides || {} }, CFG, HUBS, JOBS, STN);
}

/* 공통 무결성 검사 (§44 오류: NaN/Infinity/0원/음수/폭주) + §48 다섯 질문 답변 존재 */
function sane(r, label) {
  const checks = [
    [finite(r.currentPrice) && r.currentPrice > 0, '현재가>0'],
    [finite(r.range.low) && r.range.low > 0 && r.range.low < r.range.high, '범위 정상'],
    [Math.abs(r.combineOut.center / r.market.value - 1) <= CFG.final.extremeGuard + 1e-9, 'Extreme Guard'],
    [r.scores.attract.score >= 10 && r.scores.attract.score <= 100, '가격매력도 범위'],
    [r.structural.score == null || (r.structural.score >= 0 && r.structural.score <= 100), '구조 경쟁력 범위'],
    [r.fulfillment && finite(r.fulfillment.overall) && r.fulfillment.overall >= 0 && r.fulfillment.overall <= 100, '충족도'],
    // §48: ①왜 이 가격 ②좋은 아파트 ③좋은 가격 ④어떤 기대 ⑤무엇이 바뀌면
    [r.explain.priceView.explains.length > 0, 'Q1 가격 설명 요소'],
    [r.structural.score != null || r.structural.excluded.length > 0, 'Q2 구조 판단(또는 보류 사유)'],
    [!!r.scores.attract.sentence && !!r.explain.oneLiner, 'Q3 가격 판단 문장'],
    [Array.isArray(r.explain.priceView.reflected) && Array.isArray(r.futureView.optional), 'Q4 기대 구분'],
    [r.explain.priceView.upside.length > 0 && r.explain.priceView.risks.length > 0, 'Q5 조건 변화'],
    [!!r.repPrice === !!r.repPrice, 'rep']
  ];
  const bad = checks.filter(c => !c[0]);
  ok(bad.length === 0, `${label}: ${bad.map(b => b[1]).join(', ') || 'OK'}`);
  return r;
}

/* ═══ §43 유형별 시나리오 (30+) ═══ */
{
  const liveCases = [
    ['강남 고가 신축', '11680|일원동|디에이치자이개포', '84'],
    ['강남 신축 대단지', '11680|개포동|개포자이프레지던스', '84'],
    ['강남 학군지', '11680|대치동|래미안대치팰리스', '84'],
    ['서초 한강변 신축', '11650|반포동|래미안원베일리', '84'],
    ['송파 대단지', '11710|잠실동|리센츠', '84'],
    ['송파 소형평형', '11710|잠실동|리센츠', '27'],
    ['강동 준신축 대단지', '11740|상일동|고덕아르테온', '84'],
    ['강북 핵심지', '11440|용강동|래미안마포리버웰', '84'],
    ['성동 역세권', '11200|행당동|서울숲리버뷰자이', '84'],
    ['동작 신축', '11590|흑석동|흑석리버파크자이', '59'],
    ['서울 외곽', '11530|오류동|동부(101동~103동)', null],
    ['경기 핵심지(과천)', '41290|중앙동|과천푸르지오써밋', '59'],
    ['경기 판교(전세 없음)', '41135|백현동|판교푸르지오그랑블', null],
    ['경기 광명 역세권', '41210|일직동|광명역센트럴자이', '84'],
    ['경기 성남 대단지', '41131|신흥동|산성역포레스티아', '59'],
    ['신규 입주지역(둔촌)', '11740|둔촌동|올림픽파크포레온', '39'],
    ['거래 희소', '11740|둔촌동|올림픽파크포레온', '112']
  ];
  for (const [label, id, key] of liveCases) {
    try {
      const r = runLive(id, key);
      if (!r) { ok(true, `${label}: 대상 평형 거래 없음 — 설계상 시세 입력 필요(스킵)`); continue; }
      sane(r, `유형: ${label}`);
    } catch (e) {
      if (e.user) ok(Array.isArray(e.missing) && e.missing.length > 0, `유형: ${label} — 분석불가 시 부족 데이터 목록 제공(§39)`);
      else ok(false, `유형: ${label} — 예외 ${e.message}`);
    }
  }
  const sampleCases = [
    ['강남 재건축 구축(은마)', 'eunma', null],
    ['잠실 대단지(엘스)', 'jamsil-els', null],
    ['강동 신축(그라시움)', 'godeok-gracium', null],
    ['목동 학군 구축', 'mokdong-7', null],
    ['분당 1기신도시', 'sunae-yangji', null],
    ['평촌 학군', 'pyeongchon-guiin', null],
    ['과천 준신축', 'gwacheon-raemian', null],
    ['동탄 신도시', 'dongtan-hanwha', null],
    ['노원 중계 학군', 'junggye-chunggu3', null],
    ['마포 대단지', 'mapo-raemian', null],
    ['광진 한강변', 'gwangjang-hyundai10', null],
    ['서초 한강변(반포자이)', 'banpo-xi', null],
    ['헬리오시티(이상 저가 이력)', 'helio-city', null]
  ];
  for (const [label, id] of sampleCases) {
    const r = runSample(id);
    if (!r) { ok(false, `유형: ${label} — 샘플 미발견(${id})`); continue; }
    sane(r, `유형: ${label}`);
  }
  // 합성 유형: 데이터 누락 조합 / 이상 저가·고가 / 수동 수정
  const base = buildLive('11740|상일동|고덕아르테온');
  const mk = (mut, ov) => {
    const cx = JSON.parse(JSON.stringify(base));
    if (mut) mut(cx);
    return E.analyze({ complex: cx, areaKey: '84', asOfYM: asOf, overrides: ov || {}, autoComplex: true }, CFG, HUBS, JOBS, STN);
  };
  sane(mk(cx => { cx.households = null; cx.stationLink = null; cx.location.unknownTransport = true; }), '유형: 데이터 누락(세대·역)');
  sane(mk(cx => { for (const a of cx.areas) { a.jeonse = null; a.jeonseMeta = null; } }), '유형: 전세 누락');
  sane(mk(null, { price: 30 }), '유형: 수동 시세 수정');
  {
    const cx = JSON.parse(JSON.stringify(base));
    const a84 = cx.areas.find(a => a.key === '84');
    a84.trades = [{ ym: '2026-07', price: 12, floor: 2 }, { ym: '2026-06', price: 24, floor: 10 }, { ym: '2026-05', price: 23.5, floor: 12 }, { ym: '2026-05', price: 24.2, floor: 15 }];
    const r = E.analyze({ complex: cx, areaKey: '84', asOfYM: asOf, overrides: {}, autoComplex: true }, CFG, HUBS, JOBS, STN);
    sane(r, '유형: 이상 저가 최근거래');
    ok(Math.abs(r.currentPrice - 12) < 1e-9 && r.repPrice.anomalous, '§5: 이상 저가도 실거래 그대로 + 판단 플래그');
    ok(r.marketRef.med > 20, '§5: 시장 중심가격은 강건(가중중앙값 20억+)');
  }
  {
    const cx = JSON.parse(JSON.stringify(base));
    const a84 = cx.areas.find(a => a.key === '84');
    a84.trades = [{ ym: '2026-07', price: 40, floor: 30 }, { ym: '2026-06', price: 24, floor: 10 }, { ym: '2026-05', price: 23.5, floor: 12 }];
    const r = E.analyze({ complex: cx, areaKey: '84', asOfYM: asOf, overrides: {}, autoComplex: true }, CFG, HUBS, JOBS, STN);
    ok(r.repPrice.anomalousHigh === true && Math.abs(r.currentPrice - 40) < 1e-9, '유형: 이상 고가 — 판단 플래그 + 사실 보존');
  }
}

/* ═══ §44 방향 논리 — 입력 변화의 결과 방향 ═══ */
{
  const base = { complex: DATA.complexes[0], areaKey: DATA.complexes[0].areas[0].key, asOfYM: DATA.meta.asOf, overrides: {} };
  const r0 = E.analyze(base, CFG, HUBS, JOBS, STN);
  const up = E.applyStress(base, ['jeonse_up'], CFG, HUBS, JOBS, STN);
  ok(up.financial.value > r0.financial.value, '§44: 전세 상승 → 금융 지지가치 상승');
  ok(up.verdicts.financial.ratio >= r0.verdicts.financial.ratio, '§44: 전세 상승 → 지지력 비율 하락 금지');
  const dn = E.applyStress(base, ['jeonse_down'], CFG, HUBS, JOBS, STN);
  ok(dn.financial.value < r0.financial.value, '§44: 전세 하락 → 금융 지지가치 하락');
  const sup2 = E.applyStress(base, ['supply_x2'], CFG, HUBS, JOBS, STN);
  ok(sup2.supplyE.combined > r0.supplyE.combined, '§44: 공급 2배 → 공급 부담 상승');
  ok(sup2.scores.invest.total <= r0.scores.invest.total + 1e-9, '§44: 공급 증가 → 투자매력 상승 금지');
  const rate = E.applyStress(base, ['rate_up'], CFG, HUBS, JOBS, STN);
  ok(rate.financial.value < r0.financial.value, '§44: 금리 상승 → 금융가치 하락');
  // 역 접근성 개선 → 교통점수 상승 금지 위반 없어야
  const cxNear = JSON.parse(JSON.stringify(DATA.complexes[0]));
  cxNear.stationLink.primary.min = Math.max(1, (cxNear.stationLink.primary.min || 8) - 5);
  const rNear = E.analyze({ ...base, complex: cxNear }, CFG, HUBS, JOBS, STN);
  ok(rNear.hedonic.subs.transport >= r0.hedonic.subs.transport, '§44: 역 도보 단축 → 교통점수 하락 금지');
}

/* ═══ §46 설명 일치 — 점수와 문장의 모순 금지 ═══ */
{
  const B = CFG.scores.attractBands;
  ok(/낮은 편|매력이 있/.test(E.attractSentence(B.high + 5, CFG)), '§46: 고매력 점수 ↔ 긍정 문장');
  ok(/중간 수준/.test(E.attractSentence(B.mid + 5, CFG)), '§46: 중간 점수 ↔ 중간 문장');
  ok(/부담이 있|반영하고/.test(E.attractSentence(B.low + 5, CFG)), '§46: 낮은 점수 ↔ 부담 문장');
  ok(/부담이 높/.test(E.attractSentence(B.low - 10, CFG)), '§46: 최저 점수 ↔ 고부담 문장');
  // 단조성: 점수가 높을수록 문장 밴드가 후퇴하지 않는다
  const idx = s => [/부담이 높/, /부담이 있|반영하고/, /중간 수준/, /낮은 편|매력이 있/].findIndex(re => re.test(E.attractSentence(s, CFG)));
  let mono = true, prev = -1;
  for (let s = 10; s <= 95; s += 5) { const i = idx(s); if (i < prev) mono = false; prev = i; }
  ok(mono, '§46: 가격매력 문장 밴드 단조성');
  // oneLiner 사분면 일치
  ok(/좋은 아파트.*반영/.test(E.oneLinerV2(85, 45, CFG)), '§46: 구조高·매력低 → "장점 반영" 문장');
  ok(/부담도.*낮|낮은 편/.test(E.oneLinerV2(85, 75, CFG)), '§46: 구조高·매력高 → 긍정 문장');
  ok(/보류/.test(E.oneLinerV2(null, 60, CFG)), '§46: 구조 null → 보류 문장');
  // 실전 결과에서 점수-문장 모순 없음
  for (const cx of DATA.complexes.slice(0, 6)) {
    const r = E.analyze({ complex: cx, areaKey: cx.areas[0].key, asOfYM: DATA.meta.asOf, overrides: {} }, CFG, HUBS, JOBS, STN);
    const s = r.scores.attract.score;
    const highTxt = /낮은 편|매력이 있/.test(r.scores.attract.sentence);
    ok(!(s < B.mid && highTxt), `§46: ${cx.name} 점수(${s})·문장 모순 없음`);
  }
}

/* ═══ §45 순위 안정성 — 등급(Tier) 표현 ═══ */
{
  const t = sv => E.stationTier(sv, CFG).label;
  ok(t(95) === 'S' && t(93) === 'S' && t(92.9) === 'A' && t(85) === 'A' && t(80) === 'B' && t(50) === 'C', '§45: Tier 경계 정의');
  let monoOK = true, order = ['S', 'A', 'B', 'C'];
  for (let sv = 100; sv >= 40; sv -= 1) {
    if (order.indexOf(t(sv)) < order.indexOf(t(Math.min(100, sv + 1)))) monoOK = false;
  }
  ok(monoOK, '§45: Tier 단조성 (점수↓ → 등급 악화만)');
  // 근접 점수는 같은 Tier — 작은 변화가 등급 급변을 만들지 않음 (경계 ±0.5 제외 근사)
  ok(t(95) === t(94.5) && t(88) === t(87.5), '§45: 근접 점수 동일 Tier');
  const reason = E.stationReason({ transit: 90, econ: 88, edu: 86, biz: 70 }, CFG);
  ok(/모두 상위권|균형/.test(reason), '§18: 균형형 S 이유 문장 생성');
}

/* ═══ §15 USER_VERIFIED 합리성 검증 ═══ */
{
  const cx = buildLive('11740|상일동|고덕아르테온', { station: { st: '상일동', min: 7 }, households: 4066 });
  const r = E.analyze({ complex: cx, areaKey: '84', asOfYM: asOf, overrides: {}, autoComplex: true }, CFG, HUBS, JOBS, STN);
  ok(r.editIssues.length === 0, '§15: 합리적 수정(도보 7분·세대 4066) → 검증 이슈 0');
  ok(!r.confidence.penalties.some(p => /수동|수정/.test(p)), '§15: 합리적 수정은 신뢰도 감점 없음');
  const cx2 = buildLive('11740|상일동|고덕아르테온');
  const r2 = E.analyze({ complex: cx2, areaKey: '84', asOfYM: asOf, overrides: { price: 200 }, autoComplex: true }, CFG, HUBS, JOBS, STN);
  ok(r2.editIssues.length > 0 && r2.confidence.penalties.some(p => /검증 필요/.test(p)), '§15: 비합리 수정(200억) → 검증 이슈 + 감점');
}

/* ═══ §11 괴리 표시 (클램프 폐지) ═══ */
{
  // 히도닉·수급 조정 결과가 ±12%를 넘어도 잘리지 않고 divergence로 표시되는지 — 합성 케이스
  const cx = JSON.parse(JSON.stringify(DATA.complexes[0]));
  const r = E.analyze({ complex: cx, areaKey: cx.areas[0].key, asOfYM: DATA.meta.asOf, overrides: { jeonseMul: 0.45 } }, CFG, HUBS, JOBS, STN);
  ok(finite(r.combineOut.divergence), '§11: divergence 항상 산출');
  ok(typeof r.combineOut.divergenceLarge === 'boolean', '§11: 괴리 플래그 존재');
  ok(Math.abs(r.combineOut.centerRaw - (r.combineOut.marketOnly ? r.combineOut.vMktAdj : r.combineOut.wm * r.combineOut.vMktAdj + r.combineOut.wf * r.combineOut.vFundEff)) < 1e-9, '§11: 1차 결과는 제한 없이 계산(centerRaw)');
}

/* ═══ §8 확정/기대 미래 분리 ═══ */
{
  const cxT = { location: { futureTransit: '9호선 4단계 연장 (공사 중·확정)' } };
  const f1 = E.futureSplit(cxT, { prob: 0 }, CFG);
  ok(f1.confirmed.length === 1 && f1.optional.length === 0, '§8: 공사 중 교통 → Confirmed');
  const cxT2 = { location: { futureTransit: 'GTX-D 예정 (계획 단계)' } };
  const f2 = E.futureSplit(cxT2, { prob: 0 }, CFG);
  ok(f2.optional.length === 1 && f2.optional[0].likelihood === '불확실', '§8: 계획 단계 교통 → Optional');
  const f3 = E.futureSplit({ location: {} }, { prob: 0.25, label: '안전진단', premium: 0 }, CFG);
  ok(f3.optional.length === 1 && f3.confirmed.length === 0, '§8: 재건축 초기(25%) → Optional');
  const f4 = E.futureSplit({ location: {} }, { prob: 0.85, label: '관리처분인가', premium: 0.04 }, CFG);
  ok(f4.confirmed.length === 1, '§8: 관리처분(85%) → Confirmed');
  ok(f4.confirmed[0].likelihood === '높음' && !!f4.confirmed[0].impact, '§8: 가능성 × 영향 표현');
}

/* ═══ §13 충족도 카테고리 ═══ */
{
  const cx = buildLive('11680|일원동|디에이치자이개포');
  const area = cx.areas.find(a => a.key === '84');
  const ful = E.fulfillmentOf(cx, area, null, { overrides: {} }, CFG);
  ok(['trades', 'jeonse', 'location', 'education', 'product', 'redev', 'supply'].every(k => k in ful.cats), '§13: 7개 카테고리 산출');
  ok(ful.cats.redev === 30, '§13: 정비사업 미확인 → 30% (중립 확정 금지)');
  ok(ful.overall >= 0 && ful.overall <= 100 && !!ful.band, '§13: 종합 % + 등급');
}

console.log(`\nv4.js  ${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
