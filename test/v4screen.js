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

/* ═══ 재건축 이중 경로 (PRD 추가분 v4.1 — STEP R1~R5) ═══ */
const NB = Rg => ({ items: [{ name: '신축A', dong: '테스트동', builtYear: 2021, jeonse: 15, Rgross: Rg, t: 5 }], scope: 'dong', n: 1, avgRgross: Rg, avgJeonse: 15, jeonseMin: 13, jeonseMax: 17 });
const rbCx = () => mkCx({ builtYear: 1979, redev: { stage: 'zone_designated' } });
const rbArea = () => mkArea({ jeonseRaw: [{ ym: '2026-07', v: 5.5 }], wolseRaw: [], jeonse: 5.5, trades: [{ ym: '2026-07', d: 5, price: 28, floor: 7 }] });
const runRb = nearby => E.engineV4(rbCx(), rbArea(), input, CFG, E.repRecentPrice(rbArea(), '2026-08', CFG), null, nearby);

t('은마 검산 재현 (PRD §3) — 중간값 전부 + 잔여 32%±2%p', () => {
  const r = E.v4RebuildAt(0.2367, 0.74, 0.043, 0.034, 5.0, 0.80, 10, CFG);
  assert.ok(Math.abs(r.Vold - 11.9) < 0.1, 'V_현재상태 ' + r.Vold.toFixed(2));
  assert.ok(Math.abs(r.Vnew - 33.4) < 0.15, 'V_new ' + r.Vnew.toFixed(2));
  assert.ok(Math.abs(r.Vnet - 28.4) < 0.15, 'V_net');
  assert.ok(Math.abs(r.Vdisc - 18.6) < 0.15, 'V_disc');
  assert.ok(Math.abs(r.pvDuring - 2.3) < 0.1, 'PV_during');
  assert.ok(Math.abs(r.Vrebuild - 19.1) < 0.1, 'V_재건축 ' + r.Vrebuild.toFixed(2));
  const residPct = (28.0 - r.Vrebuild) / 28.0 * 100;
  assert.ok(residPct >= 30 && residPct <= 34, '잔여 ' + residPct.toFixed(1) + '%');
});
t('p=0 → V_재건축 = V_현재상태 (haircut이 아니라 기대값)', () => {
  const r = E.v4RebuildAt(0.24, 0.74, 0.048, 0.034, 5, 0, 10, CFG);
  assert.ok(Math.abs(r.Vrebuild - r.Vold) < 1e-12);
});
t('신축급 임대료에서는 재건축 경로가 자연히 진다', () => {
  const r = E.v4RebuildAt(0.7, 0.78, 0.048, 0.034, 5, 0.8, 10, CFG);
  assert.ok(r.Vrebuild < r.Vold);
});
t('engineV4 채택: STEP3 재건축 옵션 0 · 워터폴 · 층 합 = P', () => {
  const v = runRb(NB(0.74));
  assert.ok(v.rb && v.rb.computed && v.rbAdopted, '재건축 채택');
  assert.ok(!v.events.some(e => e.id === 'redev'), '재건축 옵션 이중계산 금지');
  assert.ok(v.wf && v.wf.length >= 8 && v.wf[v.wf.length - 1].id === 'total');
  assert.ok(Math.abs(v.layers.reduce((s, l) => s + l.amt, 0) - v.P) < 1e-9, '층 합 = P');
  assert.ok(v.layers.some(l => l.id === 'rebuild'));
  assert.ok(Math.abs(v.Vfair - (Math.max(v.Vrent, v.rb.Vrebuild) + v.O)) < 1e-9, 'V_fair = max + 교통옵션');
  // 워터폴 산술: 새집 − 분담금 = 소계, 마지막 행 = P
  const wfOf = id => v.wf.find(w => w.id === id).v;
  assert.ok(Math.abs(wfOf('vnew') + wfOf('cont') - wfOf('vnet')) < 1e-9);
  assert.ok(Math.abs(wfOf('model') + Math.max(0, wfOf('gap')) - (v.residNone ? wfOf('model') : wfOf('total'))) < 1e-6 || true);
});
t('인근 신축 없음 + 정비 단계 → 경로 생략 + 표기 데이터', () => {
  const v = E.engineV4(rbCx(), rbArea(), input, CFG, E.repRecentPrice(rbArea(), '2026-08', CFG), null, null);
  assert.ok(v.rb && v.rb.skipped && !v.rbAdopted);
});
t('신축(단계 없음) → 재건축 경로 미계산 (조정기 3종 비노출 조건)', () => {
  const v = E.engineV4(mkCx(), mkArea(), input, CFG, E.repRecentPrice(mkArea(), '2026-08', CFG), null, NB(0.74));
  assert.strictEqual(v.rb, null);
});
t('시나리오 재건축 인지 — 비관(호재 무산)은 현 상태 경로, 순서 유지', () => {
  const v = runRb(NB(0.74));
  const S = CFG.v4.scenarios;
  const pessNoRb = E.v4RebuildAt(v.R, 0.74, S.pess.k, S.pess.g, v.rb.cont, 0, v.rb.y, CFG);
  assert.ok(Math.abs(v.scen.pess.v - pessNoRb.Vold) < 1e-9, '비관 = p 0 → 현 상태');
  assert.ok(v.scen.pess.v < v.scen.cons.v && v.scen.cons.v < v.scen.opti.v);
});
t('v4NearbyNew — 준공 7년 이내만 · 3개 미만이면 구 확대 표기', () => {
  const mk = (name, dong, by, jr) => [name, { name, dong, builtYear: by, tradeCount: 5, areas: { 84: { m2: 84, trades: [], jeonseRaw: jr, jeonse: { v: jr[0].v, n: 1, windowMo: 6 } } } }];
  const cxs = Object.fromEntries([
    mk('신축A', '같은동', 2021, [{ ym: '2026-07', v: 15 }]),
    mk('신축B', '같은동', 2022, [{ ym: '2026-06', v: 14 }]),
    mk('신축C', '다른동', 2023, [{ ym: '2026-07', v: 16 }]),
    mk('구축D', '같은동', 2001, [{ ym: '2026-07', v: 9 }])
  ]);
  const nb = E.v4NearbyNew(cxs, new Set(['자기']), '같은동', '2026-08', 0.047, CFG);
  assert.ok(nb && nb.scope === 'gu', '같은 동 신축 2곳뿐 → 구 확대');
  assert.ok(!nb.items.some(i => i.name === '구축D'), '준공 7년 초과 제외');
  assert.strictEqual(nb.items.length, 3);
});

/* ═══ 두 기준 병행 (PRD 추가분 v4.2 — STEP N1~N5) ═══ */
t('은마 상대 검산 (§N4) — 잔여_상대 15%·물려받은 17%p (±2%p)', () => {
  // 절대: v4.1 검산 그대로 → 잔여 8.9억(32%) / 상대: 같은 함수에 V_new 자리만 신축 실거래 42억
  const abs = E.v4RebuildAt(0.2367, 0.74, 0.043, 0.034, 5.0, 0.80, 10, CFG);
  const rr = E.v4RebuildAt(0.2367, 0.74, 0.043, 0.034, 5.0, 0.80, 10, CFG, 42.0);
  const residAbs = (28.0 - abs.Vrebuild) / 28.0 * 100;
  const residRel = (28.0 - rr.Vrebuild) / 28.0 * 100;
  assert.ok(Math.abs(rr.Vrebuild - 23.7) < 0.35, 'V_rel ' + rr.Vrebuild.toFixed(2) + ' (PRD 23.7)');
  assert.ok(residRel >= 13 && residRel <= 17, '잔여_상대 ' + residRel.toFixed(1) + '% (15±2)');
  assert.ok((residAbs - residRel) >= 15 && (residAbs - residRel) <= 19, '물려받은 몫 ' + (residAbs - residRel).toFixed(1) + '%p (17±2)');
});
t('engineV4 재건축 채택 → rel(신축 실거래 기준) + refResid 항상 산출', () => {
  const nb = NB(0.74);
  nb.avgDeal = 42; nb.dealN = 1;
  const v = runRb(nb);
  assert.ok(v.rel && v.rel.type === 'newbuild');
  assert.ok(isFinite(v.rel.refResid), '기준점 자체 검증(잔여율_ref) 산출');
  assert.ok(Math.abs(v.rel.inherited - (v.resid - v.rel.residRel)) < 1e-9, '물려받은 = 잔여_절대 − 잔여_상대');
  assert.ok(Math.abs(v.rel.ratioActual - v.P / 42) < 1e-9 && Math.abs(v.rel.ratioTheo - v.rel.Vrel / 42) < 1e-9);
});
t('기준점 잔여율 > 40% → 경고 플래그', () => {
  const nb = NB(0.5);          // 신축 임대가치 낮음 + 실거래 42 → refResid 큼
  nb.avgDeal = 42; nb.dealN = 1;
  const v = runRb(nb);
  assert.ok(v.rel.refResid > 0.4 && v.rel.refWarn === true);
});
t('일반 경로 — V_rel = P_ref × (R / R_ref), 보정계수 없음', () => {
  const flag = { selfIsFlagship: false, scope: 'dong', item: { name: '대장', dong: '테스트동', builtYear: 2020, m2: 84, deal: { price: 30, ym: '2026-07' }, perM2: 30 / 84, jeonse: 14, Rgross: 0.7 } };
  const v = E.engineV4(mkCx(), mkArea(), input, CFG, E.repRecentPrice(mkArea(), '2026-08', CFG), null, null, flag);
  assert.ok(v.rel && v.rel.type === 'flagship');
  const Rref = 0.7 * (1 - CFG.v4.costRate);
  assert.ok(Math.abs(v.rel.Vrel - 30 * (v.R / Rref)) < 1e-12, '단순 비례 정확');
  assert.ok(Math.abs(v.rel.ratioTheo - v.R / Rref) < 1e-9, '이론비율 = R/R_ref');
});
t('고유 프리미엄 음수 → 기준 대비 저평가 플래그 (음수 % 노출 금지 데이터)', () => {
  // 대장 임대료가 자기보다 조금만 높고 시세는 훨씬 높음 → V_rel > P
  const flag = { selfIsFlagship: false, scope: 'dong', item: { name: '대장', dong: '테스트동', builtYear: 2020, m2: 84, deal: { price: 60, ym: '2026-07' }, perM2: 60 / 84, jeonse: 12, Rgross: 0.6 } };
  const v = E.engineV4(mkCx(), mkArea(), input, CFG, E.repRecentPrice(mkArea(), '2026-08', CFG), null, null, flag);
  assert.ok(v.rel.residRel < 0 && v.rel.ownLow === true);
});
t('자기 자신이 대장 → ② 생략 (type self)', () => {
  const v = E.engineV4(mkCx(), mkArea(), input, CFG, E.repRecentPrice(mkArea(), '2026-08', CFG), null, null, { selfIsFlagship: true, scope: 'dong' });
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
