'use strict';
/* V2 개선 PRD 검증 — §1 비교 파이프라인 / §2-14 교육 V2 / §15-22 지하철 / §23-26 기여도
   + 필수 회귀 Test A~E (§32) */
const fs = require('fs'), path = require('path');
const H = require('./live_helper.js');
const { CFG, HUBS, JOBS, STN, LINEI, E } = H;

let pass = 0, fail = 0;
const ok = (c, n) => { if (c) pass++; else { fail++; console.error('  ✗ FAIL:', n); } };
const finite = x => typeof x === 'number' && isFinite(x);

/* ═══ 교육 V2 단위 (§4-11·14) ═══ */
{
  const E2 = CFG.education;
  // 가중치 합 = 1 (25+25+15+15+10+10)
  const wsum = Object.values(E2.weights).reduce((a, b) => a + b, 0);
  ok(Math.abs(wsum - 1) < 1e-9, `교육 가중치 합 1.0 (${wsum})`);
  // §11 데이터 → 점수 → 등급: 존 config에 사전 tier·strength 필드가 없어야 한다
  ok(HUBS.zones.every(z => z.tier === undefined && z.initial_strength === undefined),
    '§11: 존에 사전 지정 Tier/강도 없음 — 점수는 구성요소에서만 계산');
  // 전 구성요소 만점+anchor 전체 → 100 클램프, 등급 S
  const full = { school: 100, academy: 100, admission: 100, commute: 100, demand: 100, continuity: 100 };
  const s1 = E.eduScoreFromComponents(full, E2, 1, HUBS.anchors);
  ok(s1.score === 100 && s1.tier === 'S', `만점+anchor → 100·S (${s1.score}·${s1.tier})`);
  ok(s1.anchorBonus <= (HUBS.anchors.anchorMax ?? 5) + 1e-9, `§6 Anchor 보조 최대 ${HUBS.anchors.anchorMax}점 (${s1.anchorBonus})`);
  // §7 결측 제외·재정규화: admission null이어도 나머지로 계산 + missing 기록
  const part = { school: 80, academy: 80, admission: null, commute: 80, demand: 80, continuity: 80 };
  const s2 = E.eduScoreFromComponents(part, E2, 0, HUBS.anchors);
  ok(s2 && s2.base === 80 && s2.missing.includes('admission'), `§7 결측 재정규화 (base ${s2 && s2.base}, missing ${s2 && s2.missing})`);
  ok(s2.coverage < 1 && s2.coverage >= E2.coverage.partial, '§14 커버리지 반영');
  // 전부 null → null (억지 점수 금지)
  ok(E.eduScoreFromComponents({}, E2, 0, HUBS.anchors) === null, '전체 결측 → 점수 없음(추정 금지)');
  // 등급 경계 단조성
  const at = v => E.eduScoreFromComponents({ school: v, academy: v, admission: v, commute: v, demand: v, continuity: v }, E2, null, HUBS.anchors).tier;
  ok(at(92) === 'S' && at(85) === 'A' && at(75) === 'B' && at(65) === 'C' && at(50) === 'D', `등급 밴드 S/A/B/C/D (${at(92)}/${at(85)}/${at(75)}/${at(65)}/${at(50)})`);
  // 존 점수 스코어러: 대치가 등록 존 중 최상위권
  const scores = HUBS.zones.map(z => [z.id, E.eduZoneScore(z, E2, HUBS.anchors).score]).sort((a, b) => b[1] - a[1]);
  ok(scores[0][0] === 'daechi', `대치가 존 점수 1위 — 하드코딩이 아니라 구성요소 결과 (상위: ${scores.slice(0, 3).map(x => x.join(':')).join(' ')})`);
}

/* ═══ §12·13 매칭 — 법정동·좌표, 고덕 생활권 핫픽스 ═══ */
{
  const E2 = CFG.education;
  const m1 = E.matchEduZone(HUBS, { dong: '상일동', district: '강동구' }, E2);
  ok(m1 && m1.zone.id === 'godeok' && !m1.adjacent, `§13 상일동 → 고덕 생활권 (${m1 && m1.zone.id})`);
  const m2 = E.matchEduZone(HUBS, { dong: '명일동', district: '강동구' }, E2);
  const m3 = E.matchEduZone(HUBS, { dong: '고덕동', district: '강동구' }, E2);
  ok(m2 && m3 && m2.zone.id === 'godeok' && m3.zone.id === 'godeok', '명일동·고덕동 → 같은 생활권');
  // 타 구 동명 오연결 방지: 목동은 양천구에서만
  const m4 = E.matchEduZone(HUBS, { dong: '목동', district: '강동구' }, E2);
  ok(!m4 || m4.via === 'coord', '구 가드: 타 구 동명 문자열 오연결 없음');
  // 좌표 매칭: 대치 좌표 근처 → daechi, 존에서 아주 먼 좌표 → null
  const m5 = E.matchEduZone(HUBS, { dong: '없는동', district: '강남구', coord: [37.494, 127.062] }, E2);
  ok(m5 && m5.zone.id === 'daechi' && m5.via === 'coord', '§12 좌표 기반 매칭');
  const m6 = E.matchEduZone(HUBS, { dong: '없는동', district: '어딘가', coord: [36.0, 128.5] }, E2);
  ok(m6 === null, '생활권 밖 좌표 → 매칭 없음(임의 배정 금지)');
}

/* ═══ Test A (§32): 고덕아르테온 — 교육정보 존재 + 고덕 생활권 ═══ */
let arteon = null;
{
  const hits = H.findLive('고덕아르테온');
  ok(hits.length >= 1, `Test A: 고덕아르테온 검색 (${hits.length}건)`);
  if (hits.length) {
    arteon = H.prepareLive(hits[0].id);
    ok(arteon && arteon.cx.education && arteon.cx.education.zoneId === 'godeok',
      `Test A: 상일동 아르테온 → 고덕 교육생활권 (${arteon && arteon.cx.education && arteon.cx.education.zoneId})`);
    ok(arteon.cx.fieldStatus.education === 'ESTIMATED', 'Test A: 교육 상태 ESTIMATED(미확인 아님)');
    ok(arteon.cx.households === 4066, `Test A: K-apt 세대수 4,066 (${arteon.cx.households})`);
    const r = H.analyze(arteon.cx, '84');
    ok(r.hedonic.eduDetail && r.hedonic.eduDetail.zoneName === '고덕·명일·상일', `Test A: 교육 카드 생성 (${r.hedonic.eduDetail && r.hedonic.eduDetail.zoneName})`);
    ok(r.hedonic.subs.education != null && r.hedonic.subs.education > 0, `Test A: 교육점수 산출 ${r.hedonic.subs.education && Math.round(r.hedonic.subs.education)}`);
  }
}

/* ═══ Test B (§32): 비교 파이프라인 — 동일 단지 메인/비교 가격 완전 동일 ═══ */
{
  // 같은 prepare 경로를 두 번 독립 실행 → 모든 산출 동일 (§1 AC: 불일치 0건)
  const g1 = H.prepareLive(H.findLive('고덕그라시움')[0].id);
  const g2 = H.prepareLive(H.findLive('고덕그라시움')[0].id);
  const r1 = H.analyze(g1.cx, '84'), r2 = H.analyze(g2.cx, '84');
  ok(r1.currentPrice === r2.currentPrice && r1.combineOut.center === r2.combineOut.center
    && r1.marketRef.med === r2.marketRef.med, 'Test B: 그라시움 메인/비교 경로 가격 완전 동일');
  ok(r1.marketRef && r1.marketRef.n >= 3, `Test B: 비교단지도 최신 실거래 병합 (${r1.marketRef.n}건/${r1.marketRef.windowDays}일창)`);
  if (arteon) {
    const ra = H.analyze(arteon.cx, '84');
    const ra2 = H.analyze(H.prepareLive(arteon.id).cx, '84');
    ok(ra.currentPrice === ra2.currentPrice, 'Test B: 아르테온 메인/비교 가격 동일');
    ok(ra.input.asOfYM === r1.input.asOfYM, 'Test B: 기준일 동일');
  }
}

/* ═══ Test C (§32): 래대팰 vs 아르테온 — 교육 차이가 세부항목으로 설명 ═══ */
{
  const rd = H.prepareLive(H.findLive('래미안대치팰리스')[0].id);
  ok(rd && rd.cx.education && rd.cx.education.zoneId === 'daechi', `Test C: 래대팰 → 대치 생활권 (${rd && rd.cx.education && rd.cx.education.zoneId})`);
  if (rd && arteon) {
    const r1 = H.analyze(rd.cx, '84'), r2 = H.analyze(arteon.cx, '84');
    const e1 = r1.hedonic.eduDetail, e2 = r2.hedonic.eduDetail;
    ok(e1.score > e2.score, `Test C: 대치 ${e1.score} > 고덕 ${e2.score}`);
    // 차이가 '대치라는 이름' 때문이 아니라 세부 구성요소로 설명되어야 한다
    ok(e1.comps.academy > e2.comps.academy && e1.comps.admission > e2.comps.admission,
      `Test C: 학원 생태계 ${e1.comps.academy}>${e2.comps.academy} · 입시 성과 ${e1.comps.admission}>${e2.comps.admission}로 설명`);
    ok(Object.keys(e1.comps).length >= 5 && Object.keys(e2.comps).length >= 5, 'Test C: 세부항목 5개 이상 공개');
    ok(typeof e1.why === 'string' && e1.why.length > 5 && typeof e2.weak === 'string', 'Test C: 왜 높은가/아쉬운 점 문장 생성');
    ok(e1.relative && e1.relative.pctile <= 10, `Test C: 대치 상대평가 상위 ${e1.relative && e1.relative.pctile}% (§35)`);
  }
}

/* ═══ Test D (§32): 8호선 별내선 최신화 (§15) ═══ */
{
  for (const s of ['암사역사공원', '장자호수공원', '구리', '동구릉', '다산', '별내'])
    ok(STN.stations[s] && finite(STN.stations[s].sv), `Test D: ${s}역 존재 + SV 산출 (${STN.stations[s] && STN.stations[s].sv})`);
  ok(STN.stations['별내'].lines.includes('8호선') && STN.stations['별내'].lines.includes('경춘선'),
    `Test D: 별내 8호선·경춘선 환승 (${STN.stations['별내'].lines.join('·')})`);
  ok(STN.stations['구리'].lines.includes('경의중앙선'), `Test D: 구리 경의중앙선 환승 (${STN.stations['구리'].lines.join('·')})`);
  // §16 최신성: 진접선·석남
  ok(STN.stations['별내별가람'] && STN.stations['진접'], '§16: 4호선 진접선 반영');
  ok(STN.stations['석남'] && STN.stations['석남'].lines.includes('7호선'), '§16: 7호선 석남 반영');
  // 별내에서 잠실 접근 — 8호선 직결 (환승시간 포함 체감 45분 내)
  ok(STN.stations['별내'].jobMinutes.JAMSIL <= 45, `Test D: 별내→잠실 체감 ${STN.stations['별내'].jobMinutes.JAMSIL}분 (직결)`);
}

/* ═══ Test E (§32) + §21: 8호선 제거 시 잠실 접근성 손실이 노선가치에 반영 ═══ */
{
  const l8 = LINEI.lines.find(l => l.name === '8호선');
  ok(l8, 'Test E: 8호선 노선 프로필 존재');
  ok(l8.breakdown.detour >= 40, `Test E: 8호선 제거 시 우회비용 detour ${l8.breakdown.detour} (핵심지 접근 손실 반영)`);
  ok(l8.breakdown.uniqueness >= 50, `Test E: 대체불가능성 축 ${l8.breakdown.uniqueness}`);
  // §21 다핵 핵심지: 잠실이 detour 핵심지에 포함되는 구조 (config 기준)
  const minImp = CFG.station.lineV5.coreCenterMinImportance;
  const jamsil = JOBS.centers.find(c => c.id === 'JAMSIL');
  ok(minImp != null && jamsil.importance >= minImp, `§21: 잠실(importance ${jamsil.importance}) ≥ 핵심지 기준 ${minImp}`);
  // §22 순위 강제 금지: 노선 점수가 상식 범위(최상위권 진입을 강제하지 않음) + Tier 존재
  ok(['S', 'A', 'B', 'C'].includes(l8.tier), `§22: 8호선 Tier ${l8.tier} — 자의적 가산 없음 (점수 ${l8.golden})`);
}

/* ═══ §23-26 가격 기여도 — 실제 재계산 검증 ═══ */
{
  const g = H.prepareLive(H.findLive('고덕그라시움')[0].id);
  const input = { complex: g.cx, areaKey: '84', asOfYM: H.INDEX.meta.updatedAt, overrides: {} };
  const cb = E.priceContributions(input, CFG, HUBS, JOBS, STN);
  ok(cb && cb.items.length >= 3, `기여도 항목 ${cb && cb.items.length}개 산출`);
  ok(cb.items.every(i => finite(i.amt)), '기여도 금액 유한');
  const edu = cb.items.find(i => i.id === 'education');
  ok(edu && edu.amt > 0, `교육 기여 양수 (${edu && edu.amt}억) — 고덕 생활권`);
  // §25 재계산 일치: 중립화 분석을 직접 돌려 차이를 재현
  const base = E.analyze(Object.assign({}, input, { attribution: true }), CFG, HUBS, JOBS, STN);
  const neu = E.analyze(Object.assign({}, input, { attribution: true, neutralize: ['education'] }), CFG, HUBS, JOBS, STN);
  ok(Math.abs((base.combineOut.center - neu.combineOut.center) - edu.amt) < 0.011,
    `§25 기여도 = 실제 재계산 차이 (${(base.combineOut.center - neu.combineOut.center).toFixed(3)} vs ${edu.amt})`);
  ok(neu.hedonic.adj.education === 0, '중립화 시 교육 가격조정 0');
  // 일반 분석은 attribution 미사용 — 기존 결과 불변
  const normal = E.analyze(input, CFG, HUBS, JOBS, STN);
  ok(!normal.input.attribution && finite(normal.combineOut.center), '일반 분석 경로 불변');
}

console.log(`\nv2fix.js  ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
