'use strict';
/* Station Intelligence 검증 — PRD §48 Test A~E + 엔진 연결 검증
   사전 조작 금지: 모든 값은 계산 결과. 여기서는 "구조적 타당성"만 검증한다. */
const fs = require('fs'), path = require('path');
const E = require('../src/engine.js');
const R = p => JSON.parse(fs.readFileSync(path.join(__dirname, '..', p), 'utf8'));
const CFG = R('config/valuation-parameters.json');
const HUBS = R('config/education_hubs.json');
const JOBS = R('config/job_centers.json');
const DATA = R('data/apartments.json');
const STN = R('data/station_intelligence.json');
const LINEI = R('data/line_intelligence.json');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.error('  ✗ FAIL:', name); } }
const st = n => STN.stations[n];

/* 기본 무결성 */
ok(Object.keys(STN.stations).length > 300, '역 300개 이상 계산됨');
ok(Object.values(STN.stations).every(s => s.sv >= 0 && s.sv <= 100 && isFinite(s.sv)), 'Station Value 0~100');
ok(LINEI.lines.length >= 10 && LINEI.lines.every(l => l.golden > 0 && l.golden <= 100), '노선 지수 정상');

/* Test A — 같은 3호선: 신사 vs 녹번, 차이가 컴포넌트로 설명 가능해야 */
{
  const a = st('신사'), b = st('녹번');
  ok(a.sv > b.sv + 15, 'A: 신사 SV가 녹번보다 뚜렷이 높음');
  ok(a.comps.job > b.comps.job && a.comps.net > b.comps.net && a.comps.dest > b.comps.dest,
    'A: 차이가 직주·네트워크·목적지 컴포넌트로 설명됨');
  ok(a.gangnamMin < b.gangnamMin, 'A: 강남 접근시간 차이 반영');
}

/* Test B — 가치 높은 단일노선 역 > 가치 낮은 노선 환승역 (환승 개수만으로 승리 금지) */
{
  const single = st('압구정');      // 3호선 단일
  const weakTransfer = st('석계');  // 1호선+6호선 환승, 외곽
  ok(single.sv > weakTransfer.sv, `B: 압구정(단일 ${single.sv}) > 석계(환승 ${weakTransfer.sv})`);
  const single2 = st('한티');       // 수인분당 단일, 강남권
  const weakTransfer2 = st('온수'); // 1+7 환승 외곽
  ok(single2.sv > weakTransfer2.sv, `B: 한티(단일 ${single2.sv}) > 온수(환승 ${weakTransfer2.sv})`);
}

/* Test C·D — 더블역세권: 같은 방향이면 보너스 작고, 다른 업무지를 열면 커야 */
{
  const mk = (p, s) => ({
    name: 'T', regionTier: '서울', builtYear: 2015, households: 1000, brandTier: 2, parkingRatio: 1, far: 250, rentalShare: 0,
    redev: { stage: 'none' }, conversionRate: 0.045,
    stationLink: { primary: p, secondary: s },
    areas: [{ key: '84', label: '84', m2: 84, jeonse: 8, trades: [{ ym: '2026-07', price: 15, floor: 10 }] }],
    location: { subwayMin: p.min, lines: [], transfer: false, express: false, futureTransit: null, jobMinutes: {} },
    education: { elemM: 500, chopuma: false, middlePref: 3, hubId: null, inHub: false, localAcademyLevel: 3, hubAccess: [], age3049: 0.3, studentTrend: 'stable' },
    life: { martMin: 10, deptMin: 20, hospitalMin: 15, streetLevel: 3 },
    nature: { parkMin: 10, bigPark: false, riverMin: 30, hanRiver: false, hanRiverView: null, forest: false },
    supply: { pop: 400000, next3yAvg: 2000, adjacentRatio: 1, metroRatio: 1, unsoldLevel: 2, txVolumeLevel: 3, jeonseListingsLevel: 3, jeonseTrend: 'stable', regulated: false }
  });
  const run = cx => E.analyze({ complex: cx, areaKey: '84', asOfYM: '2026-08', overrides: {} }, CFG, HUBS, JOBS, STN);
  // C: 목동(5호선) + 오목교(5호선 같은 노선·같은 방향) → 보너스 거의 0
  const same = run(mk({ st: '목동', min: 7, status: 'VERIFIED' }, { st: '오목교', min: 10 }));
  ok(same.transit.bonus < 0.03, `C: 같은 방향 추가역 보너스 미미 (${(same.transit.bonus * 100).toFixed(1)}%)`);
  // D: 목동(5호선, CBD·여의도·마곡) + 신정(2호선 아님... 신정도 5호선) → 대신: 애오개(5호선) vs 공덕(5+6+공항+경의: 용산 등 확장)
  const solo = run(mk({ st: '애오개', min: 4, status: 'VERIFIED' }, null));
  const dual = run(mk({ st: '애오개', min: 4, status: 'VERIFIED' }, { st: '공덕', min: 9 }));
  ok(dual.transit.bonus >= same.transit.bonus, 'D: 네트워크 확장형 추가역 보너스가 동일방향보다 큼·같음');
  ok(dual.hedonic.subs.transport >= solo.hedonic.subs.transport, 'D: 확장형 더블역세권은 교통점수 상승');
  ok(dual.transit.bonus <= CFG.station.multiStation.totalBonusCap + 1e-9, 'D: 보너스 총량 캡 준수');
}

/* Test E — 경제력 높음·네트워크 보통 vs 경제력 보통·네트워크 우수: 다른 프로필로 설명 */
{
  const rich = st('압구정');   // wealth 매우 높음
  const hub = st('서울역');    // wealth 보통, 네트워크 탁월
  ok(rich.wealth > hub.wealth && hub.comps.net > rich.comps.net,
    `E: 압구정(경제력 ${rich.wealth}·네트워크 ${rich.comps.net}) vs 서울역(경제력 ${hub.wealth}·네트워크 ${hub.comps.net}) 프로필 상이`);
}

/* 대표역 스팟체크 — 순서 타당성 (사전 점수 조작 없음, 관계만 검증) */
ok(st('강남').sv >= st('신사').sv, '강남 ≥ 신사');
ok(st('신사').sv > st('수내').sv, '신사 > 수내');
ok(st('판교').sv > st('평촌').sv, '판교 > 평촌');
ok(st('잠실').sv > st('고덕').sv, '잠실 > 고덕');
ok(st('여의도').sv > st('목동').sv, '여의도 > 목동');
ok(st('고속터미널').sv > st('녹번').sv, '고속터미널 > 녹번');

/* 엔진 연결: 샘플 단지 교통이 Station 기반으로 교체되고 캡·중복가산 방지 유지 */
{
  const cx = DATA.complexes.find(c => c.id === 'eunma');
  const r = E.analyze({ complex: cx, areaKey: '84', asOfYM: '2026-08', overrides: {} }, CFG, HUBS, JOBS, STN);
  ok(!!r.transit && r.transit.primary.st === '대치', '은마: 주력역 대치 연결');
  ok(r.hedonic.subs.transport === r.transit.score, '교통점수 = Station 기반 점수로 교체(가산 아님)');
  ok(Math.abs(r.hedonic.total) <= CFG.hedonic.totalCap + 1e-9, '히도닉 총량 캡 유지');
  ok(r.explain.diagnosis && r.explain.diagnosis.core && r.explain.diagnosis.watch, '진단형 문장 생성');
  // STN 없이 호출하면 기존 방식으로 정상 폴백
  const legacy = E.analyze({ complex: cx, areaKey: '84', asOfYM: '2026-08', overrides: {} }, CFG, HUBS, JOBS);
  ok(!legacy.transit && legacy.hedonic.subs.transport > 0, 'STN 없음 → 기존 로직 폴백 정상');
}

/* 미확인 처리: 역 정보 없는 자동 단지 → 중립점수 + 신뢰도 하락, 서비스는 정상 */
{
  const cx = {
    name: 'U', regionTier: '서울', builtYear: 2010, households: 700, brandTier: 2, parkingRatio: 0.9, far: 250, rentalShare: 0,
    redev: { stage: 'none' }, conversionRate: 0.045, dataGaps: ['역거리 미확인'],
    fieldStatus: { households: 'UNKNOWN', subway: 'UNKNOWN', price: 'VERIFIED' },
    areas: [{ key: '84', label: '84', m2: 84, jeonse: 6, trades: [{ ym: '2026-07', price: 11, floor: 5 }] }],
    location: { unknownTransport: true, subwayMin: null, lines: [], transfer: false, express: false, futureTransit: null, jobMinutes: { GBD: 45, CBD: 50 } },
    education: { elemM: 500, chopuma: false, middlePref: 3, hubId: null, inHub: false, localAcademyLevel: 3, hubAccess: [], age3049: 0.3, studentTrend: 'stable' },
    life: { martMin: 10, deptMin: 20, hospitalMin: 15, streetLevel: 3 },
    nature: { parkMin: 10, bigPark: false, riverMin: 30, hanRiver: false, hanRiverView: null, forest: false },
    supply: { pop: 400000, next3yAvg: 2000, adjacentRatio: 1, metroRatio: 1, unsoldLevel: 2, txVolumeLevel: 3, jeonseListingsLevel: 3, jeonseTrend: 'stable', regulated: false }
  };
  const r = E.analyze({ complex: cx, areaKey: '84', asOfYM: '2026-08', overrides: {}, autoComplex: true }, CFG, HUBS, JOBS, STN);
  ok(r.hedonic.subs.transport === CFG.station.unknownTransportScore, '미확인 역거리 → 중립점수(몰래 좋은 값 금지)');
  ok(r.gaps.some(g => g.includes('역거리 미확인')), '미확인이 데이터 공백에 기록');
  ok(r.dataStatus && r.dataStatus.UNKNOWN === 2 && r.dataStatus.VERIFIED === 1, '필드 상태 집계(VERIFIED/UNKNOWN)');
  ok(isFinite(r.combineOut.center) && r.range.low > 0, '미확인 상태에서도 전체 분석 정상 완주');
}

console.log(`station.js  ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
