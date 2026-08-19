'use strict';
/* 엔진 단위 테스트 — 가드·캡·단조성 검증 */
const fs = require('fs'), path = require('path');
const E = require('../src/engine.js');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/valuation-parameters.json'), 'utf8'));
const HUBS = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/education_hubs.json'), 'utf8'));
const JOBS = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/job_centers.json'), 'utf8'));
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/apartments.json'), 'utf8'));

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ FAIL:', name); }
}
const finite = x => typeof x === 'number' && isFinite(x);

/* ── 유틸 ── */
ok(E.weightedMedian([{ v: 1, w: 1 }, { v: 2, w: 1 }, { v: 100, w: 0.01 }]) <= 2, 'weightedMedian: 저가중 이상치에 강건');
ok(E.monthsBetween('2026-08', '2026-05') === 3, 'monthsBetween 기본');
ok(E.monthsBetween('2026-08', '2027-01') === 0, 'monthsBetween 미래 거래는 0');
ok(E.interp(7, [[5, 88], [8, 78]]) > 78 && E.interp(7, [[5, 88], [8, 78]]) < 88, 'interp 중간값');

/* ── 대표 최근가 (V3.2) — 이상 저가 1건이 현재가로 표기되는 문제 보정 ── */
{
  // 헬리오시티형: 직전 19.3억이 3개월 또래(25~26.9억) 대비 이상 저가 → 3개월 최고가 표기
  const helio = { trades: [
    { ym: '2026-07', d: 23, price: 19.3, floor: 19 },
    { ym: '2026-07', d: 17, price: 26.47, floor: 18 },
    { ym: '2026-05', d: 13, price: 26.8, floor: 12 },
    { ym: '2026-05', d: 4, price: 25.5, floor: 15 },
    { ym: '2026-05', d: 1, price: 25, floor: 12 }
  ] };
  const r1 = E.repRecentPrice(helio, '2026-08', CFG);
  ok(r1.anomalous === true && Math.abs(r1.price - 26.8) < 1e-9, `대표최근가: 이상 저가 → 3개월 최고가 26.8 (got ${r1.price})`);
  ok(Math.abs(r1.latest.price - 19.3) < 1e-9, '대표최근가: 원래 최근 거래는 사실대로 보존');
  // 정상: 직전 거래가 또래 범위 안 → 그대로 사용 (최근 거래 우선 원칙)
  const normal = { trades: [
    { ym: '2026-07', d: 20, price: 25.8, floor: 10 },
    { ym: '2026-06', d: 5, price: 26.2, floor: 8 },
    { ym: '2026-05', d: 2, price: 25.1, floor: 14 }
  ] };
  const r2 = E.repRecentPrice(normal, '2026-08', CFG);
  ok(r2.anomalous === false && Math.abs(r2.price - 25.8) < 1e-9, '대표최근가: 정상 거래는 최근가 그대로');
  // 또래 표본 부족(1건) → 보정하지 않음 (억지 판단 금지)
  const sparse = { trades: [{ ym: '2026-07', d: 20, price: 19, floor: 3 }, { ym: '2026-06', d: 5, price: 26, floor: 8 }] };
  const r3 = E.repRecentPrice(sparse, '2026-08', CFG);
  ok(r3.anomalous === false && Math.abs(r3.price - 19) < 1e-9, '대표최근가: 또래 2건 미만이면 판단 유보');
  // 이상거래 플래그(o)가 있으면 또래가 충분할 때 보정
  const flagged = { trades: [
    { ym: '2026-07', d: 23, price: 20, floor: 2, o: 1 },
    { ym: '2026-07', d: 10, price: 26, floor: 18 },
    { ym: '2026-06', d: 13, price: 25.5, floor: 12 }
  ] };
  const r4 = E.repRecentPrice(flagged, '2026-08', CFG);
  ok(r4.anomalous === true && Math.abs(r4.price - 26) < 1e-9, '대표최근가: o 플래그 거래도 보정 (플래그 거래는 최고가 후보에서 제외)');
}

/* ── 기본 분석 파이프라인 ── */
const cx = DATA.complexes.find(c => c.id === 'godeok-gracium');
const base = { complex: cx, areaKey: '84', asOfYM: '2026-08', overrides: {} };
const r = E.analyze(base, CFG, HUBS, JOBS);

ok(finite(r.combineOut.center) && r.combineOut.center > 0, '적정가치 center 유한·양수');
ok(r.range.low < r.combineOut.center && r.combineOut.center < r.range.high, '범위 순서: low < center < high');
ok(r.range.spread >= CFG.range.minSpread - 1e-9 && r.range.spread <= CFG.range.maxSpread + 1e-9, '범위 spread가 config 한도 내');
ok(Math.abs(r.combineOut.center / r.market.value - 1) <= CFG.final.anchorClamp + 1e-9, '시장앵커 클램프 준수');
ok(r.scores.living.total >= 0 && r.scores.living.total <= 100, '주거가치 0~100');
ok(r.scores.invest.total >= 0 && r.scores.invest.total <= 100, '투자가치 0~100');
ok(r.scores.attract.score >= CFG.scores.priceAttractClamp[0] && r.scores.attract.score <= CFG.scores.priceAttractClamp[1], '가격매력도 클램프');
ok(Math.abs(r.hedonic.total) <= CFG.hedonic.totalCap + 1e-9, '히도닉 총 조정 캡 준수');
ok(Math.abs(r.supplyE.adj) <= CFG.supply.priceAdjCap + 1e-9, '수급 조정 캡 준수');
ok(r.market.compQuality > 0.5, '동일단지 동일평형 비교거래가 지배적');
ok(Math.abs(r.combineOut.hRes) < Math.abs(r.hedonic.total) + 1e-12, '히도닉 잔차는 원조정보다 작음(중복반영 방지)');
ok(['높음', '보통', '낮음'].includes(r.confidence.label), '신뢰도 라벨');
ok(r.explain.up.length > 0 && r.explain.down.length > 0, '상승·하락 요인 생성');
ok(r.explain.interpretation.length > 0, '조건부 해석 생성');
ok(r.explain.contrib.length === 7, '기여도 7개 카테고리');

/* ── 고든 가드: r-g 근접 시 DCF 전환·유한 ── */
{
  const cfg2 = JSON.parse(JSON.stringify(CFG));
  cfg2.financial.longTermRentGrowth['서울'] = cfg2.financial.altReturn + cfg2.financial.liquidityPremium + cfg2.financial.assetRiskPremium + 0.002 - 0.001; // g ≈ r
  const r2 = E.analyze(base, cfg2, HUBS, JOBS);
  ok(r2.financial.mode === 'dcf', 'r−g < minSpread → DCF 모드');
  ok(finite(r2.financial.value) && r2.financial.value > 0, 'DCF 값 유한·양수');
}

/* ── 역산 g* 왕복 검증: P = R/(r−g*) ── */
{
  const f = r.financial;
  const back = f.R / (f.r - f.impliedG);
  ok(Math.abs(back - r.currentPrice) / r.currentPrice < 1e-9, '역산 성장률 왕복 일치');
}

/* ── 스트레스 단조성 ── */
{
  const up = E.applyStress(base, ['rate_up'], CFG, HUBS, JOBS);
  ok(up.financial.value < r.financial.value, '금리 +1%p → 임대내재가치 하락');
  ok(up.financial.impliedG > r.financial.impliedG, '금리 +1%p → 필요성장률 상승');

  const jd = E.applyStress(base, ['jeonse_down'], CFG, HUBS, JOBS);
  ok(jd.financial.value < r.financial.value, '전세 -10% → 임대내재가치 하락');
  ok(jd.support.score <= r.support.score, '전세 -10% → 전세지지력 비상승');

  const ju = E.applyStress(base, ['jeonse_up'], CFG, HUBS, JOBS);
  ok(ju.financial.value > r.financial.value, '전세 +10% → 임대내재가치 상승');

  const s2 = E.applyStress(base, ['supply_x2'], CFG, HUBS, JOBS);
  ok(s2.supplyE.combined > r.supplyE.combined, '공급 2배 → 부담률 상승');
  ok(s2.supplyE.adj <= r.supplyE.adj, '공급 2배 → 가격조정 비상승');
  ok(s2.scores.invest.total <= r.scores.invest.total, '공급 2배 → 투자가치 비상승');

  const sh = E.applyStress(base, ['supply_half'], CFG, HUBS, JOBS);
  ok(sh.supplyE.combined < r.supplyE.combined, '공급 절반 → 부담률 하락');

  const pd = E.applyStress(base, ['price_down'], CFG, HUBS, JOBS);
  ok(pd.currentPrice < r.currentPrice, '가격 -10% 반영');
  ok(pd.scores.attract.score >= r.scores.attract.score, '가격 -10% → 가격매력도 비하락');
  const pu = E.applyStress(base, ['price_up'], CFG, HUBS, JOBS);
  ok(pu.scores.attract.score <= r.scores.attract.score, '가격 +10% → 가격매력도 비상승');

  const multi = E.applyStress(base, ['rate_up', 'jeonse_down', 'supply_x2'], CFG, HUBS, JOBS);
  ok(finite(multi.combineOut.center) && multi.range.low > 0, '복합 스트레스도 유한·양수');
}

/* ── 수동 가격 수정 → 신뢰도 감점 ── */
{
  const m = E.analyze(Object.assign({}, base, { overrides: { price: 19.0 } }), CFG, HUBS, JOBS);
  ok(m.currentPrice === 19.0, '가격 오버라이드 반영');
  ok(m.confidence.score <= r.confidence.score, '수동 보정 → 신뢰도 비상승');
}

/* ── 옵션가치: 데이터 없으면 금액 미반영 ── */
{
  const cx2 = JSON.parse(JSON.stringify(DATA.complexes.find(c => c.id === 'eunma')));
  delete cx2.allowedFar;
  const r3 = E.analyze({ complex: cx2, areaKey: '84', asOfYM: '2026-08', overrides: {} }, CFG, HUBS, JOBS);
  ok(r3.option.premium === 0 && r3.option.premiumNote, '용적률 데이터 없음 → 프리미엄 0 + 등급만');
  const r4 = E.analyze({ complex: DATA.complexes.find(c => c.id === 'eunma'), areaKey: '84', asOfYM: '2026-08', overrides: {} }, CFG, HUBS, JOBS);
  ok(r4.option.premium > 0, '용적률 데이터 있음 → 제한적 프리미엄');
  ok(r4.option.premium <= CFG.option.maxOptionPremium, '옵션 프리미엄 캡 준수');
}

/* ── 한강조망 결측 → 데이터 공백 기록 ── */
{
  const els = E.analyze({ complex: DATA.complexes.find(c => c.id === 'jamsil-els'), areaKey: '84', asOfYM: '2026-08', overrides: {} }, CFG, HUBS, JOBS);
  ok(els.gaps.some(g => g.includes('한강 조망')), '조망 데이터 결측 기록');
  ok(els.fillRate < 1, '결측 → 충족률 < 1');
}

console.log(`units.js  ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
