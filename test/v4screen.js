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
t('옵션은 교통만 — 재건축은 이벤트로 넣지 않는다 (§4-2 STEP 4)', () => {
  const cx = mkCx({ location: { futureTransit: '9호선 연장 (공사 중·확정)' }, redev: { stage: 'union' } });
  const v = run(cx, mkArea());
  assert.strictEqual(v.events.length, 1, '교통 이벤트만');
  const tr = v.events[0];
  assert.strictEqual(tr.id, 'transit');
  assert.strictEqual(tr.bucket, 'constr');
  assert.ok(Math.abs(tr.amt - 0.85 * Math.min(V.uplift.transit, V.upliftCapPct.transit * v.P) / Math.pow(1 + v.k, 2)) < 1e-9);
  assert.ok(!v.events.some(e => e.id === 'redev'), '재건축 옵션가치 이벤트 없음');
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
t('비관 < 보수 < 낙관 (델타 k) · 보수는 확정 호재만', () => {
  const cx = mkCx({ location: { futureTransit: 'GTX (계획 단계·미확정)' } });
  const v = run(cx, mkArea(), { cxOld: null, gu: { gHist: 0.046 }, oldQ: '2016-Q3', yearsBack: 10 });
  assert.ok(v.scen.pess.v < v.scen.cons.v && v.scen.cons.v < v.scen.opti.v);
  const consNoOpt = E.v4FairAt(v.R, v.band.k + V.scenarios.cons.kDelta, V.scenarios.cons.g, CFG, [], v.P).Vrent;
  assert.ok(Math.abs(v.scen.cons.v - consNoOpt) < 1e-9, '계획 단계(30%)는 보수에서 제외되어야 함');
});

/* ── 카피 규칙 (§8) ── */
t('ui.js 금지어 0건 — 신뢰도·고평가·저평가·점수·등급', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../src/ui.js'), 'utf8');
  for (const w of ['신뢰도', '고평가', '점수', '등급']) {
    const n = (ui.match(new RegExp(w, 'g')) || []).length;
    assert.strictEqual(n, 0, `'${w}' ${n}건`);
  }
  // '저평가'는 단독 판정으로는 금지 — v4.2 §N4가 명시 요구한 '…대비 (—) 저평가' 관용구만 허용
  const bad = (ui.match(/저평가/g) || []).length - (ui.match(/대비\s*(—\s*)?저평가/g) || []).length;
  assert.strictEqual(bad, 0, `'저평가' 단독 판정 ${bad}건`);
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

/* ═══ v5 통합 — 모드 판별 · 가격대별 k · 생활권 g_s · 시세차익 경로 (§9 수용 기준) ═══ */
t('가격대별 k — 15억 이하 5.0 / 15~25 4.8 / 25 초과 4.3', () => {
  assert.strictEqual(E.v5KBand(12, CFG).k, 0.050);
  assert.strictEqual(E.v5KBand(20, CFG).k, 0.048);
  assert.strictEqual(E.v5KBand(38, CFG).k, 0.043);
});
t('g_s = 생활권 실적, 폴백은 전국 소득 + 표기 · 초과폭 경고', () => {
  const a = E.v5Gs({ g: 0.046, src: 'self' }, CFG);
  assert.ok(a.g === 0.046 && a.src === 'self' && a.warn === 1, '1~2.5%p → 1단계');
  const b = E.v5Gs({ g: 0.075, src: 'gu', guName: '강동구' }, CFG);
  assert.ok(b.warn === 2, '>2.5%p → 경고');
  const c = E.v5Gs(null, CFG);
  assert.ok(c.g === 0.034 && c.src === 'national' && /전국/.test(c.label), '폴백 표기');
});
t('노선 등급 — 1급(3호선)·2급(5호선)·3급(그 외)·복수는 최고', () => {
  assert.strictEqual(E.v5LineGrade(['3호선'], CFG), 1);
  assert.strictEqual(E.v5LineGrade(['5호선'], CFG), 2);
  assert.strictEqual(E.v5LineGrade(['경춘선'], CFG), 3);
  assert.strictEqual(E.v5LineGrade(['5호선', '9호선'], CFG), 1);
});
const NB_ITEMS = [
  { n: '강남신축A', gn: '서울 강남구', d: '대치동', y: 2023, hh: 5000, min: 5, lg: 1, sg: 1, deal: { price: 42, ym: '2026-07' }, Rg: 0.7 },
  { n: '역먼신축', gn: '서울 강남구', d: '개포동', y: 2023, hh: 6700, min: 15, lg: 1, sg: 1, deal: { price: 35.6, ym: '2026-06' }, Rg: 0.7 },
  { n: '소형신축', gn: '서울 강남구', d: '대치동', y: 2022, hh: 800, min: 5, lg: 1, sg: 1, deal: { price: 30, ym: '2026-07' }, Rg: 0.6 },
  { n: '이급노선', gn: '서울 강동구', d: '고덕동', y: 2019, hh: 5000, min: 5, lg: 2, sg: 2, deal: { price: 25, ym: '2026-07' }, Rg: 0.5 },
  { n: '구축큰것', gn: '서울 송파구', d: '잠실동', y: 2008, hh: 5600, min: 5, lg: 1, sg: 1, deal: { price: 30, ym: '2026-07' }, Rg: 0.6 }
];
t('§R1 매칭 — 조건 충족·탈락 사유·범위', () => {
  const m = E.v5Match(NB_ITEMS, { asOfYear: 2026, postHH: 5850, walk: 5, lineGrade: 1, schoolGrade: 1, selfNames: new Set(['자기']) }, CFG);
  assert.ok(m.matches.some(x => x.n === '강남신축A'));
  assert.ok(!m.matches.some(x => x.n === '이급노선'), '노선 등급 다르면 탈락');
  assert.ok(m.near.some(x => x.it.n === '역먼신축' && /역 접근/.test(x.why)), '탈락 사유 기록');
  assert.ok(m.range && m.range.hi === 42);
});
t('§R1 완화 체인 — 3개 미달 시 순서대로, 완화 목록 기록', () => {
  const items = NB_ITEMS.filter(x => x.n !== '강남신축A')
    .concat([{ n: '완화신축', gn: '서울 서초구', d: '반포동', y: 2017, hh: 5000, min: 5, lg: 1, sg: 1, deal: { price: 40, ym: '2026-07' }, Rg: 0.7 }]);
  const m = E.v5Match(items, { asOfYear: 2026, postHH: 5850, walk: 5, lineGrade: 1, schoolGrade: 1, selfNames: new Set() }, CFG);
  assert.ok(m.relaxed.length > 0 && /준공/.test(m.relaxed[0]), '준공 완화가 첫 단계');
  assert.ok(m.matches.some(x => x.n === '완화신축'), '완화 후 매칭');
});
t('은마 검산 (§R9 실측) — P_break 39.31 · 내재 39.3/44.5/50.3 · 지연 45.6', () => {
  const rb = E.v5Rebuild(38.1, 0.3638, 0.034, 6.0, 7, 0.95, 18.3, CFG, { lo: 35.6, hi: 37.0, mid: 36.3 });
  assert.ok(Math.abs(rb.rentFV - 3.18) < 0.05, '임대료_FV ' + rb.rentFV.toFixed(2));
  assert.ok(Math.abs(rb.depositAlt - 46.86) < 0.05, '예금 대안');
  assert.ok(Math.abs(rb.Pbreak - 39.31) < 0.1, 'P_break ' + rb.Pbreak.toFixed(2));
  assert.ok(Math.abs(rb.PbreakDelay - 45.6) < 0.2, '지연 손익분기 ' + rb.PbreakDelay.toFixed(2));
  const [i3, i5, i7] = rb.implied.map(x => x.P);
  assert.ok(Math.abs(i3 - 39.3) < 0.3 && Math.abs(i5 - 44.5) < 0.3 && Math.abs(i7 - 50.3) < 0.3, '내재 신축가 표');
});
t('내재 연수익률 — 하한 < 상한 · 확률 미적용 · 해 없으면 산출 불가', () => {
  const rb = E.v5Rebuild(38.1, 0.3638, 0.034, 6.0, 7, 0.95, 18.3, CFG, { lo: 35.6, hi: 37.0, mid: 36.3 });
  assert.ok(rb.irr.lo != null && rb.irr.hi != null && rb.irr.lo < rb.irr.hi, '하한 < 상한');
  const rbLowP = E.v5Rebuild(38.1, 0.3638, 0.034, 6.0, 7, 0.30, 18.3, CFG, { lo: 35.6, hi: 37.0, mid: 36.3 });
  assert.ok(Math.abs(rbLowP.irr.lo - rb.irr.lo) < 1e-12 && Math.abs(rbLowP.irr.hi - rb.irr.hi) < 1e-12, '확률은 수익률에 곱하지 않는다');
  const none = E.v5Rebuild(38.1, 0.3638, 0.034, 6.0, 7, 0.95, 18.3, CFG, { lo: 0.01, hi: 0.01, mid: 0.01 });
  assert.strictEqual(none.irr.hi, null, '해 없으면 null');
});
t('민감도 — 신축 가격 정체(g_target=0)가 가장 큰 변동', () => {
  const rb = E.v5Rebuild(38.1, 0.3638, 0.034, 6.0, 7, 0.95, 18.3, CFG, { lo: 35.6, hi: 37.0, mid: 36.3 });
  const ds = rb.sens.filter(x => x.id !== 'base').map(x => Math.abs(x.d));
  assert.ok(Math.abs(rb.sens.find(x => x.id === 'gzero').d) === Math.max(...ds));
});
t('§R7 세 값 산출 · p=0 기대값 = 임대료 가치 · 무산 폴백', () => {
  const rb = E.v5Rebuild(38.1, 0.3638, 0.034, 6.0, 7, 0.95, 18.3, CFG, { lo: 35.6, hi: 37.0, mid: 36.3 });
  assert.ok(rb.triple && isFinite(rb.triple.alt) && isFinite(rb.triple.flat) && isFinite(rb.triple.rise));
  assert.strictEqual(rb.VrentFail, 18.3);
  const p0 = E.v5Rebuild(38.1, 0.3638, 0.034, 6.0, 7, 0, 18.3, CFG, { lo: 35.6, hi: 37.0, mid: 36.3 });
  assert.ok(Math.abs(p0.expectPV - 18.3) < 1e-9);
});
t('요구수익률(k)이 시세차익 계산에 쓰이지 않음 — 코드 검증', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/engine.js'), 'utf8');
  const m = src.match(/function v5Rebuild\(([^)]*)\)/);
  assert.ok(m, 'v5Rebuild 존재');
  assert.ok(!/\bk\b/.test(m[1]), 'v5Rebuild 인자에 k 없음: ' + m[1]);
});
t('종합 점수·가중치가 매칭 코드에 없음 (문자열 검증)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/engine.js'), 'utf8');
  const fn = src.slice(src.indexOf('function v5Match'), src.indexOf('function v5Rebuild'));
  assert.ok(!/score|weight/i.test(fn), '매칭은 조건 필터만');
});
/* ── 게이트 검산 (§3·§9) ── */
const rbCx5 = o => mkCx(Object.assign({
  builtYear: 1979, far: 204, redev: { stage: 'biz_approval', doneYear: 2033 }, postHouseholds: 5850, contributionEst: 6.0,
  stationLink: { primary: { st: '대치', min: 5, status: 'MANUAL' } }
}, o));
const rbArea5 = () => mkArea({ jeonseRaw: [{ ym: '2026-07', v: 8.6 }], wolseRaw: [], jeonse: 8.6, trades: [{ ym: '2026-07', d: 5, price: 38.1, floor: 7 }] });
const RANGE = { matches: [], near: [], relaxed: [], n: 1, range: { lo: 35.6, hi: 37.0, mid: 36.3 }, cond: {} };
t('게이트: 신축(2019·단계 없음) → income · 신축 경로 미계산', () => {
  const v = E.engineV4(mkCx(), mkArea(), input, CFG, E.repRecentPrice(mkArea(), '2026-08', CFG), null, null, RANGE);
  assert.strictEqual(v.mode, 'income');
  assert.strictEqual(v.rb5, null);
  assert.ok(!v.gates.A.pass);
});
t('게이트 B: 준공 2000·용적 280%·비역세권 → 탈락, income', () => {
  const cx = mkCx({ builtYear: 2000, far: 280, redev: { stage: 'none' }, stationLink: { primary: { st: 'X', min: 15, status: 'MANUAL' } } });
  const v = E.engineV4(cx, mkArea(), input, CFG, E.repRecentPrice(mkArea(), '2026-08', CFG), null, null, RANGE);
  assert.ok(v.gates.A.pass && !v.gates.B.pass);
  assert.strictEqual(v.mode, 'income');
});
t('은마 실측 → rebuild · 배수 1.9±0.2 · P_break 재현', () => {
  const v = E.engineV4(rbCx5(), rbArea5(), input, CFG, E.repRecentPrice(rbArea5(), '2026-08', CFG), null, null, RANGE);
  assert.strictEqual(v.mode, 'rebuild', 'mode=' + v.mode + ' multiple=' + (v.gates.multiple && v.gates.multiple.toFixed(2)));
  assert.ok(v.gates.multiple >= 1.7 && v.gates.multiple <= 2.1, '배수 ' + v.gates.multiple.toFixed(2));
  assert.ok(!v.events.some(e => e.id === 'redev'), '재건축 옵션 없음');
  assert.ok(v.rb5 && v.rb5.y === 7 && Math.abs(v.rb5.Pbreak - 39.3) < 0.6, 'P_break ' + v.rb5.Pbreak.toFixed(1));
});
t('혼합 밴드 — 배수 1.0~1.2 → mixed', () => {
  const v = E.engineV4(rbCx5(), rbArea5(), input, CFG, E.repRecentPrice(rbArea5(), '2026-08', CFG), null, null,
    { range: { lo: 20, hi: 21.5, mid: 20.7 } });
  assert.ok(v.gates.multiple > 1.0 && v.gates.multiple < 1.2, '배수 ' + v.gates.multiple.toFixed(2));
  assert.strictEqual(v.mode, 'mixed');
});
t('매칭 없음 + 정비 단계 → income + noMatch 표기', () => {
  const v = E.engineV4(rbCx5(), rbArea5(), input, CFG, E.repRecentPrice(rbArea5(), '2026-08', CFG), null, null, null);
  assert.strictEqual(v.mode, 'income');
  assert.ok(v.gates.noMatch);
});
t('전세가율 편차 상충 플래그 — dev<0.7 & income', () => {
  const cx = mkCx({ builtYear: 1995, far: 280, redev: { stage: 'none' }, stationLink: { primary: { st: 'X', min: 15, status: 'MANUAL' } } });
  const area = mkArea({ jeonseRaw: [{ ym: '2026-07', v: 4 }], wolseRaw: [], jeonse: 4, trades: [{ ym: '2026-07', d: 5, price: 20, floor: 5 }] });
  const inp = Object.assign({}, input, { guJeonseMed: 0.5 });
  const v = E.engineV4(cx, area, inp, CFG, E.repRecentPrice(area, '2026-08', CFG), null, null, null);
  assert.ok(v.gates.dev < 0.7 && v.gates.conflict, '상충 표기 데이터');
});
t('수익형 조정기 — 재건축 컨트롤 없음 · IRR 용어 0건 (ui.js)', () => {
  const ui = fs.readFileSync(path.join(__dirname, '../src/ui.js'), 'utf8');
  assert.ok(!ui.includes('c-rb"'), '재건축 단계 컨트롤 제거');
  assert.strictEqual((ui.match(/IRR/g) || []).length, 0, 'IRR 용어 금지');
});

t('일반 경로 — V_rel = P_ref × (R / R_ref), 보정계수 없음', () => {
  const flag = { selfIsFlagship: false, scope: 'dong', item: { name: '대장', dong: '테스트동', builtYear: 2020, m2: 84, deal: { price: 30, ym: '2026-07' }, perM2: 30 / 84, jeonse: 14, Rgross: 0.7 } };
  const v = E.engineV4(mkCx(), mkArea(), input, CFG, E.repRecentPrice(mkArea(), '2026-08', CFG), null, flag, null);
  assert.ok(v.rel && v.rel.type === 'flagship');
  const Rref = 0.7 * (1 - CFG.v4.costRate);
  assert.ok(Math.abs(v.rel.Vrel - 30 * (v.R / Rref)) < 1e-12, '단순 비례 정확');
  assert.ok(Math.abs(v.rel.ratioTheo - v.R / Rref) < 1e-9, '이론비율 = R/R_ref');
});
t('고유 프리미엄 음수 → 기준 대비 저평가 플래그 (음수 % 노출 금지 데이터)', () => {
  // 대장 임대료가 자기보다 조금만 높고 시세는 훨씬 높음 → V_rel > P
  const flag = { selfIsFlagship: false, scope: 'dong', item: { name: '대장', dong: '테스트동', builtYear: 2020, m2: 84, deal: { price: 60, ym: '2026-07' }, perM2: 60 / 84, jeonse: 12, Rgross: 0.6 } };
  const v = E.engineV4(mkCx(), mkArea(), input, CFG, E.repRecentPrice(mkArea(), '2026-08', CFG), null, flag, null);
  assert.ok(v.rel.residRel < 0 && v.rel.ownLow === true);
});
t('자기 자신이 대장 → ② 생략 (type self)', () => {
  const v = E.engineV4(mkCx(), mkArea(), input, CFG, E.repRecentPrice(mkArea(), '2026-08', CFG), null, { selfIsFlagship: true, scope: 'dong' }, null);
  assert.ok(v.rel && v.rel.type === 'self' && v.rel.Vrel == null);
});
t('v4Flagship — 준공 10년·6개월 실거래·㎡당 최고 · 자기 대장 감지', () => {
  const mk = (name, dong, by, price, jr) => [name, { name, dong, builtYear: by, tradeCount: 5, areas: { 84: { m2: 84, trades: [{ ym: '2026-07', d: 5, price, floor: 9 }], jeonseRaw: jr, jeonse: { v: jr[0].v, n: 1, windowMo: 6 } } } }];
  const cxs = Object.fromEntries([
    mk('신축비쌈', '같은동', 2020, 30, [{ ym: '2026-07', v: 14 }]),
    mk('신축저렴', '같은동', 2022, 22, [{ ym: '2026-07', v: 11 }]),
    mk('구축', '같은동', 2010, 35, [{ ym: '2026-07', v: 12 }])
  ]);
  const f1 = E.v4Flagship(cxs, new Set(['자기']), '같은동', '2026-08', 0.047, CFG, 0.2);
  assert.ok(f1 && !f1.selfIsFlagship && f1.item.name === '신축비쌈', '10년 초과(구축) 제외 + ㎡당 최고 선택');
  const f2 = E.v4Flagship(cxs, new Set(['신축비쌈']), '같은동', '2026-08', 0.047, CFG, 0.2);
  assert.ok(f2 && f2.selfIsFlagship, '자기 자신이 대장');
});

console.log(`v4screen.js  ${pass} pass / ${fail.length} fail`);
if (fail.length) { fail.forEach(f => console.error(' ✗ ' + f)); process.exit(1); }
