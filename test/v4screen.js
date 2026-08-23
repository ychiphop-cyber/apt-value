'use strict';
/* ═══ 결과화면 개편 v4 (PRD 2026-08-23) — 수용 기준 §8 검증 ═══
   계산: R=max(전세,월세)·클램프·잔여 음수·역산 수렴·4층 합계·전세 단독 표기
   카피: 금지어 0건 (ui.js 소스 기준) · 전문용어는 접힘 전용
   데이터: kaptResolve 세대수 해석 전체 경로 */
const assert = require('assert');
const fs = require('fs'), path = require('path');
const E = require('../src/engine.js');
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, '../config/valuation-parameters.json'), 'utf8'));
let pass = 0; const fail = [];
function t(name, fn) { try { fn(); pass++; } catch (e) { fail.push(name + ': ' + e.message); } }

const V = CFG.v4;
const mkArea = over => Object.assign({
  key: '84', m2: 84.9, trades: [{ ym: '2026-07', d: 10, price: 20, floor: 10 }],
  jeonseRaw: [{ ym: '2026-07', v: 10 }, { ym: '2026-06', v: 10.2 }, { ym: '2026-05', v: 9.8 }],
  wolseRaw: [{ ym: '2026-07', dep: 2, mr: 400 }, { ym: '2026-06', dep: 2, mr: 380 }],
  jeonse: 10, jeonseMeta: { v: 10, n: 5, windowMo: 6 }
}, over);
const mkCx = over => Object.assign({
  name: '테스트', dong: '테스트동', district: '테스트구', regionTier: '서울', builtYear: 2018,
  households: 2000, conversionRate: 0.047, redev: { stage: 'none' }, location: { futureTransit: null }, areas: []
}, over);
const input = { asOfYM: '2026-08', overrides: {} };
const run = (cx, area, hist) => E.engineV4(cx, area, input, CFG, E.repRecentPrice(area, '2026-08', CFG), hist || null);

/* ── STEP 1 ── */
t('R_gross = max(전세환산, 월세환산) · 보유비용 차감', () => {
  const v = run(mkCx(), mkArea());
  const Rj = v.rent.jeonse.v * 0.047, Rw = v.rent.wolse.dep * 0.047 + v.rent.wolse.mr * 12 / 10000;
  assert.ok(Math.abs(v.Rgross - Math.max(Rj, Rw)) < 1e-9);
  assert.strictEqual(v.rent.picked, Rw > Rj ? 'wolse' : 'jeonse');
  assert.ok(Math.abs(v.R - v.Rgross * (1 - V.costRate)) < 1e-9);
});
t('전세 3건 평균 · 월세 2건 평균 (최근순)', () => {
  const v = run(mkCx(), mkArea());
  assert.ok(Math.abs(v.rent.jeonse.v - (10 + 10.2 + 9.8) / 3) < 1e-9);
  assert.ok(Math.abs(v.rent.wolse.mr - 390) < 1e-9);
});
t('월세 없으면 전세 단독 + jeonseOnly 표기', () => {
  const v = run(mkCx(), mkArea({ wolseRaw: [] }));
  assert.ok(v.rent.jeonseOnly && v.rent.picked === 'jeonse');
});
t('6개월 내 거래 없으면 12개월 확대 + ext 표기', () => {
  const v = run(mkCx(), mkArea({ jeonseRaw: [{ ym: '2025-11', v: 9 }], wolseRaw: [] }));
  assert.ok(v.rent.jeonse.ext && v.rent.jeonse.windowMo === 12);
});
t('전월세 모두 없으면 null (임의 가정 금지)', () => {
  assert.strictEqual(run(mkCx(), mkArea({ jeonseRaw: [], wolseRaw: [], jeonse: null, jeonseMeta: null })), null);
});

/* ── STEP 2 가드 ── */
t('k − g_term < 0.5%p → 클램프, 값 폭발 없음', () => {
  const r1 = E.pv2Stage(0.5, 0.021, 0.034, 0.02, 10, V.termMinSpread);
  assert.ok(r1.terminalGuarded && isFinite(r1.v) && r1.v > 0 && r1.v < 200);
});

/* ── STEP 3 옵션 ── */
t('옵션 = 확률 × 상승분(캡) ÷ (1+k)^년', () => {
  const cx = mkCx({ location: { futureTransit: '9호선 연장 (공사 중·확정)' }, redev: { stage: 'union' } });
  const v = run(cx, mkArea());
  assert.strictEqual(v.events.length, 2);
  const tr = v.events.find(e => e.id === 'transit');
  assert.strictEqual(tr.bucket, 'constr');
  assert.ok(Math.abs(tr.amt - 0.85 * Math.min(V.uplift.transit, V.upliftCapPct.transit * v.P) / Math.pow(1 + V.k, 2)) < 1e-9);
  assert.strictEqual(v.events.find(e => e.id === 'redev').bucket, 'zoned');
});
t('교통 단계 매핑 — 계획·미확정·착공·임박', () => {
  assert.strictEqual(E.v4TransitBucket('GTX-C (계획 단계·미확정)'), 'plan');
  assert.strictEqual(E.v4TransitBucket('동북선 경전철 (공사 중·확정)'), 'constr');
  assert.strictEqual(E.v4TransitBucket('개통 임박'), 'imminent');
  assert.strictEqual(E.v4TransitBucket(''), null);
});

/* ── STEP 4·5 ── */
t('잔여 < 0 → residNone (음수 % 노출 금지)', () => {
  const v = run(mkCx(), mkArea({ trades: [{ ym: '2026-07', d: 1, price: 8, floor: 5 }] }));
  assert.ok(v.resid < 0 && v.residNone);
});
t('4층 합 = P (금액), % 합 100 (오차 L4 흡수), 순서 고정', () => {
  const v = run(mkCx({ location: { futureTransit: '9호선 (공사 중)' } }), mkArea());
  assert.ok(Math.abs(v.layers.reduce((s, l) => s + l.amt, 0) - v.P) < 1e-9);
  assert.strictEqual(v.layers.reduce((s, l) => s + l.pct, 0), 100);
  assert.strictEqual(v.layers[0].id, 'live');
  assert.strictEqual(v.layers[v.layers.length - 1].id, 'unknown');
});

/* ── STEP 6 역산 ── */
t('g_req 왕복 — fair(g_req) ≈ P (1e-4)', () => {
  const v = run(mkCx(), mkArea());
  assert.ok(v.gReq != null && !v.gReqSat);
  const back = E.v4FairAt(v.R, v.k, v.gReq, CFG, v.events, v.P).Vfair;
  assert.ok(Math.abs(back - v.P) / v.P < 1e-4);
});
t('g_req 탐색 상한 포화 시 플래그', () => {
  const v = run(mkCx(), mkArea({ trades: [{ ym: '2026-07', d: 1, price: 90, floor: 5 }] }));
  assert.strictEqual(v.gReqSat, 'high');
});

/* ── STEP 7 과거 실적 ── */
t('g_hist 단지 실측 = (now/old)^(1/10) − 1', () => {
  const v = run(mkCx(), mkArea(), { cxOld: { old: 6.7, n: 3 }, gu: { gHist: 0.05 }, oldQ: '2016-Q3', yearsBack: 10 });
  assert.strictEqual(v.hist.src, 'self');
  assert.ok(Math.abs(v.hist.g - (Math.pow(v.rent.jeonse.v / 6.7, 1 / 10) - 1)) < 1e-12);
});
t('단지 실측 없으면 구 지수 폴백 + 출처 구분', () => {
  const v = run(mkCx(), mkArea(), { cxOld: null, gu: { gHist: 0.045 }, oldQ: '2016-Q3', yearsBack: 10, guName: '테스트구' });
  assert.strictEqual(v.hist.src, 'gu');
  assert.ok(Math.abs(v.hist.g - 0.045) < 1e-12);
});

/* ── 시나리오 ── */
t('비관 < 보수 < 낙관 · 보수는 확정 호재만', () => {
  const cx = mkCx({ location: { futureTransit: 'GTX (계획 단계·미확정)' } });
  const v = run(cx, mkArea(), { cxOld: null, gu: { gHist: 0.046 }, oldQ: '2016-Q3', yearsBack: 10 });
  assert.ok(v.scen.pess.v < v.scen.cons.v && v.scen.cons.v < v.scen.opti.v);
  const consNoOpt = E.v4FairAt(v.R, V.scenarios.cons.k, V.scenarios.cons.g, CFG, [], v.P).Vrent;
  assert.ok(Math.abs(v.scen.cons.v - consNoOpt) < 1e-9, '계획 단계(30%)는 보수에서 제외되어야 함');
});

/* ── 카피 규칙 (§8) ── */
t('ui.js 금지어 0건 — 신뢰도·고평가·저평가·점수·등급', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../src/ui.js'), 'utf8');
  for (const w of ['신뢰도', '고평가', '저평가', '점수', '등급']) {
    const n = (ui.match(new RegExp(w, 'g')) || []).length;
    assert.strictEqual(n, 0, `'${w}' ${n}건`);
  }
});
t('head.html 금지어 0건', () => {
  const h = fs.readFileSync(path.join(__dirname, '../src/head.html'), 'utf8');
  for (const w of ['신뢰도', '고평가', '저평가', '점수', '등급']) {
    const n = (h.match(new RegExp(w, 'g')) || []).length;
    assert.strictEqual(n, 0, `'${w}' ${n}건`);
  }
});
t('전문용어는 접힘 전용 — 캡레이트·NOI·고든 0건, 요구수익률 위치 검사', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../src/ui.js'), 'utf8');
  for (const w of ['캡레이트', 'NOI', '고든']) {
    assert.strictEqual((ui.match(new RegExp(w, 'g')) || []).length, 0, w);
  }
  const lines = ui.split('\n');
  const hits = lines.map((l, i) => l.includes('요구수익률') ? i : -1).filter(i => i >= 0);
  const collStart = lines.findIndex(l => l.includes('function v4CollapsesHtml'));
  const collEnd = lines.findIndex((l, i) => i > collStart && /^\}\s*$/.test(l));
  const assumeStart = lines.findIndex(l => l.includes("assumeCard"));
  for (const i of hits) {
    const inColl = collStart >= 0 && i > collStart && i < collEnd;
    const nearAssume = assumeStart >= 0 && Math.abs(i - assumeStart) < 40;
    assert.ok(inColl || nearAssume, `요구수익률이 본문 위치(줄 ${i + 1})에 노출`);
  }
});

/* ── 세대수 해석 경로 ── */
t('kaptResolve — 통합 등재 폴백 + 수기 확인 테이블', () => {
  const info = { meta: { asOf: '2026-08' }, byName: { '통합단지': { kaptCode: 'X', households: 4000 } } };
  const AL = {
    aliases: {},
    splitGroups: [{ id: 'g1', display: '통합단지 (통합 1~2단지)', region: '11', members: ['11|동|통합단지1단지', '11|동|통합단지2단지'] }],
    manualHouseholds: { '11|동|수기단지': { households: 999, note: '수기 확인' } }
  };
  const r1 = E.kaptResolve(info, '통합단지1단지', '11|동|통합단지1단지', AL);
  assert.ok(r1 && r1.grouped && r1.households === 4000);
  const r2 = E.kaptResolve(info, '수기단지', '11|동|수기단지', AL);
  assert.ok(r2 && r2.manualSrc && r2.households === 999);
  assert.strictEqual(E.kaptResolve(info, '없는단지', '11|동|없는단지', AL), null);
});
t('사용자 시세·전세 오버라이드 반영', () => {
  const v = E.engineV4(mkCx(), mkArea(), { asOfYM: '2026-08', overrides: { price: 30, jeonse: 12 } }, CFG,
    E.repRecentPrice(mkArea(), '2026-08', CFG), null);
  assert.strictEqual(v.P, 30);
  assert.ok(v.manualPrice && v.rent.jeonse.manual);
  assert.ok(Math.abs(v.rent.jeonse.v - 12) < 1e-9);
});

console.log(`v4screen.js  ${pass} pass / ${fail.length} fail`);
if (fail.length) { fail.forEach(f => console.error(' ✗ ' + f)); process.exit(1); }
