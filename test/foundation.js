'use strict';
/* 최종 토대 v3 검증 — 6층 분해·2단계 성장·순 임대가치·가격 구간 k·옵션가치·잔여
   문서의 §1(버릴 것/취할 것)·§3(층 계산)·§5(구현 함정 5)·§6(잔여 분포)을 테스트로 강제 */
const H = require('./live_helper.js');
const { CFG, HUBS, JOBS, STN, E } = H;

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.error('  ✗ FAIL:', n); } };
const finite = x => typeof x === 'number' && isFinite(x);
const F3 = CFG.financialV3, F = CFG.financial;

/* 공용 합성 단지 — 조건만 바꿔 방향성 검증 */
function synth(o) {
  const price = o.price ?? 20, jeonse = o.jeonse ?? 10;
  return {
    name: 'S', regionTier: o.tier ?? '서울핵심', builtYear: o.builtYear ?? 2018, households: 2000,
    brandTier: 2, parkingRatio: 1.2, far: o.far ?? 250, allowedFar: o.allowedFar,
    rentalShare: 0, redev: { stage: o.redevStage ?? 'none' }, conversionRate: 0.047, dataGaps: [],
    dong: '', district: '',
    areas: [{ key: '84', label: '84', m2: 84, jeonse,
      trades: [{ ym: '2026-07', d: 10, price, floor: 10 }, { ym: '2026-06', d: 5, price: price * 0.99, floor: 7 }, { ym: '2026-05', d: 20, price: price * 0.985, floor: 12 }] }],
    location: { subwayMin: 6, lines: ['9호선'], transfer: false, express: false, futureTransit: o.futureTransit ?? null, jobMinutes: { GBD: 20, CBD: 30, YBD: 35 } },
    education: { zoneId: o.zoneId ?? 'daechi', middlePref: 4, elemM: 300, chopuma: true, age3049: 0.32, studentTrend: 'stable' },
    life: { martMin: 5, deptMin: 10, hospitalMin: 10, streetLevel: 4 },
    nature: { parkMin: 5, bigPark: true, riverMin: 15, hanRiver: false, hanRiverView: null, forest: false },
    supply: { pop: 500000, next3yAvg: o.supplyNext ?? 2500, adjacentRatio: 1, metroRatio: 1, unsoldLevel: 2, txVolumeLevel: 3, jeonseListingsLevel: 3, jeonseTrend: 'stable', regulated: true }
  };
}
const run = (cx, ov) => E.analyze({ complex: cx, areaKey: '84', asOfYM: '2026-08', overrides: ov || {} }, CFG, HUBS, JOBS, STN);

/* ═══ §3 준비: 순 임대가치 R — 보유비용 차감 ═══ */
{
  const r = run(synth({}));
  const f = r.financial;
  ok(Math.abs(f.Rgross - f.jeonse * f.conv) < 1e-12, 'R 총액 = 전세(신규) × 전환율');
  ok(Math.abs(f.R - f.Rgross * (1 - F3.ownerCostRate)) < 1e-12, `순 R = 총액 × (1 − 보유비용 ${F3.ownerCostRate})`);
  ok(f.ownerCost > 0, '보유세·수리·공실 차감이 가격에 직접 들어옴');
  // 문서 §3 예시 재현: 전세 10억 · c 4.7% · 비용 10% · k 4.8% → ① ≈ 8.8억
  const R = 10 * 0.047 * 0.9, k = 0.048;
  ok(Math.abs(R / k - 8.8125) < 1e-9, `문서 예시: ① 정적 사용가치 = ${(R / k).toFixed(2)}억 ≈ 8.8억`);
}

/* ═══ §5② c와 k의 분리 — 금리 스트레스는 k에만 (이중계상 금지) ═══ */
{
  const cx = synth({});
  const r0 = run(cx), r1 = run(cx, { rateDelta: 0.01 });
  ok(r1.financial.conv === r0.financial.conv, '금리 +1%p에도 전환율(c) 불변 — 새 전환율로 월세 재생성 금지');
  ok(Math.abs(r1.financial.r - r0.financial.r - 0.01) < 1e-12, '금리 +1%p는 k에만 전액 반영');
  ok(r1.financial.R === r0.financial.R, 'R(순 임대가치)은 금리와 무관');
  ok(r1.financial.value < r0.financial.value, '금리↑ → 임대가치↓');
}

/* ═══ §5④ 가격 구간별 k — 상단 구간은 현금매수 구조로 k가 낮다 ═══ */
{
  const k10 = run(synth({ price: 10, jeonse: 5.5 })).financial.r;
  const k20 = run(synth({ price: 20, jeonse: 10 })).financial.r;
  const k30 = run(synth({ price: 30, jeonse: 14 })).financial.r;
  ok(k10 > k20 && k20 > k30, `가격 구간 k 단조 감소: 10억 ${(k10 * 100).toFixed(2)}% > 20억 ${(k20 * 100).toFixed(2)}% > 30억 ${(k30 * 100).toFixed(2)}%`);
  ok(Math.abs((k10 - k30) - 0.005) < 1e-9, '상단 구간 조정폭 = config kPriceBands');
}

/* ═══ §2·3 6층 분해 — 산술 정합·순서 고정·재현성 ═══ */
{
  const r = run(synth({ futureTransit: '9호선 연장 (공사 중·확정)' }));
  const d = r.decomp, L = d.layers;
  ok(L.length === 6 && L[0].id === 'static' && L[5].id === 'residual', '층 순서 ①②③④⑤⑥ 고정');
  ok(Math.abs(L.slice(0, 5).reduce((s, l) => s + l.amt, 0) - d.explained) < 1e-9, '①~⑤ 합 = 설명분');
  ok(Math.abs(d.explained + d.residual - r.currentPrice) < 1e-9, '설명분 + ⑥잔여 = 시장가격 P');
  ok(L[1].amt > 0, '② 물가·소득 성장가치 > 0 — 거품이 아니라 펀더멘털');
  ok(L[3].amt <= 0, '④ 공급·노후화는 마이너스 층');
  ok(L[4].amt > 0, '⑤ 확정 교통 사건 → 옵션가치 양수');
  const r2 = run(synth({ futureTransit: '9호선 연장 (공사 중·확정)' }));
  ok(JSON.stringify(r2.decomp.layers.map(l => l.amt)) === JSON.stringify(L.map(l => l.amt)), '동일 입력 → 동일 분해 (재현성)');
}

/* ═══ §3③ 초과성장 10년 한정 — 영구 초과성장 대비 폭발 억제 ═══ */
{
  const r = run(synth({}));
  const f = r.financial, G = f.growth;
  const gHi = G.infl + 0.012;
  const twoStage = E.pv2Stage(f.R, f.r, gHi, G.infl, F3.excessYears, F3.terminalMinSpread).v;
  const gordonForever = f.R / (f.r - gHi);
  ok(twoStage < gordonForever, `초과성장 10년 한정: 2단계 ${twoStage.toFixed(1)} < 영구 고든 ${gordonForever.toFixed(1)}`);
  // 성장률 민감도 완화: 고든은 0.1%p에 ~7% 움직임 — 2단계는 그보다 훨씬 둔감
  const bump2 = E.pv2Stage(f.R, f.r, gHi + 0.001, G.infl, F3.excessYears, F3.terminalMinSpread).v / twoStage - 1;
  const bumpG = f.R / (f.r - gHi - 0.001) / gordonForever - 1;
  ok(bump2 < bumpG * 0.5, `손잡이 민감도: 2단계 ${(bump2 * 100).toFixed(2)}% ≪ 고든 ${(bumpG * 100).toFixed(2)}% (+0.1%p당)`);
}

/* ═══ 사건은 g에 넣지 않는다 — 교통 호재가 성장률을 안 바꾸고 ⑤로만 간다 ═══ */
{
  const rA = run(synth({}));
  const rB = run(synth({ futureTransit: '9호선 연장 (공사 중·확정)' }));
  ok(Math.abs(rB.financial.growth.excessG - rA.financial.growth.excessG) < 1e-12, '교통 사건 → 초과성장(g) 불변');
  ok(rB.decomp.layers[4].amt > rA.decomp.layers[4].amt, '교통 사건 → ⑤ 옵션가치로만 반영');
  // 단계별 차등: 확정(공사) vs 구상(추진)
  const rC = run(synth({ futureTransit: '신규 노선 추진 구상' }));
  ok(rB.decomp.events[0].prob > rC.decomp.events[0].prob, `확정 확률 ${rB.decomp.events[0].prob} > 구상 ${rC.decomp.events[0].prob} — 같은 호재도 단계 따라 다르다`);
  ok(rB.decomp.layers[4].amt > rC.decomp.layers[4].amt, '확정 사건의 옵션가치가 더 크다');
}

/* ═══ §3④ 노후화는 직선이 아니다 — 연식 드래그 + 재건축 진입 시 완화 ═══ */
{
  const dNew = run(synth({ builtYear: 2022 })).financial.growth.dragAging;
  const dOld = run(synth({ builtYear: 2004 })).financial.growth.dragAging;
  ok(dOld > dNew, `노후 드래그: 22년차 ${(dOld * 100).toFixed(2)}%p > 4년차 ${(dNew * 100).toFixed(2)}%p`);
  const dRedev = run(synth({ builtYear: 1996, redevStage: 'union', far: 180, allowedFar: 300 })).financial.growth.dragAging;
  const dNoRedev = run(synth({ builtYear: 1996 })).financial.growth.dragAging;
  ok(dRedev < dNoRedev, '재건축 단계 진입 → 노후 드래그 완화(땅 재평가는 ⑤에서)');
}

/* ═══ ⑤ 재건축 옵션가치 = 확률 × 상승 ÷ (1+k)^년수 ═══ */
{
  const r = run(synth({ builtYear: 1996, redevStage: 'biz_approval', far: 180, allowedFar: 300 }));
  const ev = r.decomp.events.find(e => e.id === 'redev');
  ok(ev && ev.amt > 0, '재건축(사업시행인가) 옵션가치 산출');
  const O = CFG.option;
  const expect = ev.prob * (ev.uplift / r.financial.value) * r.financial.value / Math.pow(1 + r.financial.r, ev.years);
  ok(Math.abs(ev.amt - expect) < 0.02, '옵션 공식 재현: 확률 × 상승 ÷ (1+k)^년수');
  const r2 = run(synth({ builtYear: 1996, redevStage: 'recon_review', far: 180, allowedFar: 300 }));
  const ev2 = r2.decomp.events.find(e => e.id === 'redev');
  ok(ev.amt > ev2.amt, `단계 진행 → 옵션가치 증가 (인가 ${ev.amt.toFixed(2)} > 초기검토 ${ev2.amt.toFixed(2)})`);
  // 용적률 미확인 → 금액 0 + 사유 (임의 추정 금지)
  const r3 = run(synth({ builtYear: 1996, redevStage: 'biz_approval' }));
  const ev3 = r3.decomp.events.find(e => e.id === 'redev');
  ok(ev3 && ev3.amt === 0 && ev3.note, '용적률 데이터 없음 → 옵션 금액 미반영 + 사유 표시');
}

/* ═══ §4 역산 헤드라인 — 옵션 차감 후 필요 성장률 ═══ */
{
  const r = run(synth({ futureTransit: '9호선 연장 (공사 중·확정)' }));
  const d = r.decomp, f = r.financial;
  ok(d.impliedG10 != null && finite(d.impliedG10), '역산 g₁₀ 산출');
  const back = f.valueAt(d.impliedG10);
  ok(Math.abs(back - (r.currentPrice - d.layers[4].amt)) < 1e-4, '역산 왕복: PV(g₁₀) = P − 옵션가치');
  ok(d.impliedG10 < d.impliedG10All, '옵션을 빼면 필요 성장률이 낮아진다 (§4 — 빼지 않으면 뛰어오름)');
  const rHi = run(synth({ price: 26, jeonse: 10 }));
  const rLo = run(synth({ price: 16, jeonse: 10 }));
  ok(rHi.decomp.impliedG10 > rLo.decomp.impliedG10, '가격↑(같은 전세) → 필요 성장률↑ (단조)');
  ok(d.marketExcessG != null && d.modelExcessG != null, '§8 역산 검증: 시장 내재 초과성장 vs 모형 신호 제공');
}

/* ═══ §5⑤ 금리 취약성 — 낮은 k−g 자산이 더 취약 (채권 원리) ═══ */
{
  const seoul = run(synth({ tier: '서울핵심', price: 20, jeonse: 10 }));
  const rural = run(synth({ tier: '기타', price: 5, jeonse: 3.2, zoneId: null }));
  const sS = seoul.decomp.rateSensitivity, sR = rural.decomp.rateSensitivity;
  ok(sS < sR, `k−g 작은 상급지가 금리에 더 취약: 서울핵심 ${(sS * 100).toFixed(1)}% < 기타 ${(sR * 100).toFixed(1)}% (+1%p당)`);
  ok(sS < -0.15 && sS > -0.45, '상급지 민감도 자릿수 (문서 −29% 부근)');
}

/* ═══ §6 잔여 — 정직한 잔여율 + 간이 잣대 상대비교 ═══ */
{
  const r = run(synth({}));
  ok(finite(r.decomp.residualPct), '잔여율 산출');
  ok(r.decomp.liteResidual != null, '간이 잔여율(①+② 잣대) 산출');
  const lite = E.residualLite(20, 10, 0.047, '서울핵심', CFG);
  const R = 10 * 0.047 * (1 - F3.ownerCostRate);
  const k = F.altReturn + F.liquidityPremium + F.assetRiskPremium + 0 + (-0.002);
  const expect = Math.round((1 - (R * (1 + F3.inflation * F3.passThrough) / (k - F3.inflation * F3.passThrough)) / 20) * 1000) / 10;   // CF₁=R×(1+g) 규약
  ok(Math.abs(lite - expect) < 0.11, `residualLite 재현 (${lite} vs ${expect})`);
  ok(E.residualLite(20, null, 0.047, '서울', CFG) === null, '전세 없음 → 간이 잔여 null (억지 산출 금지)');
}

/* ═══ 실전 단지 — 잔여율 분포가 단지마다 갈리는가 (§6: 다 비슷하면 모형이 설명 못 하는 것) ═══ */
{
  const ids = ['고덕그라시움', '래미안대치팰리스', '잠실엘스', '헬리오시티', '마포래미안푸르지오'];
  const rs = [];
  for (const q of ids) {
    const hit = H.findLive(q)[0];
    if (!hit) continue;
    const prep = H.prepareLive(hit.id);
    const areaKey = E.pickDefaultAreaKey(prep.cx.areas, CFG.search.defaultAreaPrefs);
    const r = H.analyze(prep.cx, areaKey);
    if (r.decomp) rs.push({ q, res: r.decomp.residualPct, g10: r.decomp.impliedG10 });
  }
  ok(rs.length >= 4, `실전 ${rs.length}개 단지 분해 완주`);
  const vals = rs.map(x => x.res);
  ok(Math.max(...vals) - Math.min(...vals) >= 5, `잔여율이 단지마다 분화 (${rs.map(x => `${x.q} ${x.res}%`).join(' / ')})`);
  ok(rs.every(x => x.res > -60 && x.res < 75), '잔여율 상식 범위(−60~75%)');
  ok(rs.every(x => x.g10 != null && x.g10 < 0.30), '역산 g₁₀ 전 단지 산출·비포화');
}

console.log(`\nfoundation.js  ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
