'use strict';
/* 수집 파이프라인 단위 테스트 — 픽스처 XML로 파싱·집계·병합 검증 */
const P = require('../pipeline/collect.js');

let pass = 0, fail = 0;
function ok(cond, name) { if (cond) pass++; else { fail++; console.error('  ✗ FAIL:', name); } }

const fx = P.fixtureXml();
const trades = P.parseItems(fx.trade);
const rents = P.parseItems(fx.rent);

ok(trades.length === 8, '매매 파싱 8건');
ok(trades[0].price === 152000 && trades[0].m2 === 84.94, '금액·면적 파싱');
ok(trades.some(t => t.cancel), '해제거래 플래그 파싱');
ok(P.areaKey(84.97) === '84' && P.areaKey(59.76) === '59' && P.areaKey(114.9) === '114', '평형 버킷 = floor');
ok(P.recentMonths(3, '2026-08').join(',') === '202608,202607,202606', 'recentMonths');
ok(P.checkResult('<r><resultCode>000</resultCode></r>').ok, 'resultCode 000 정상');
ok(!P.checkResult('<r><resultCode>22</resultCode><resultMsg>LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS</resultMsg></r>').ok, '한도초과 감지');

const region = { code: '11440', name: '마포구', sido: '서울' };
const shard = P.emptyShard(region);
// 실사용 패턴: 월별로 해당 월 데이터만 병합 — 같은 월 재수집 시 Full Replace로 멱등해야 함
const byM = arr => { const m = {}; for (const it of arr) { const k = `${it.y}${String(it.mo).padStart(2, '0')}`; (m[k] = m[k] || []).push(it); } return m; };
const tM = byM(trades), rM = byM(rents);
const months = [...new Set([...Object.keys(tM), ...Object.keys(rM)])];
for (const ymd of months) P.mergeMonth(shard, ymd, tM[ymd] || [], rM[ymd] || []);
for (const ymd of months) P.mergeMonth(shard, ymd, tM[ymd] || [], rM[ymd] || []);   // 재수집 → Full Replace 멱등
P.finalizeShard(shard, '2026-08');
{
  // 취소거래 반영 검증: 다음 수집에서 그 거래가 취소로 바뀌면 기존 기록이 제거되어야 함 (§4)
  const before = shard.complexes['공덕동|공덕삼성래미안'].areas['84'].trades.length;
  const cancelled = (tM['202607'] || []).map(t => ({ ...t, cancel: t.price === 152000 ? true : t.cancel }));
  P.mergeMonth(shard, '202607', cancelled, rM['202607'] || []);
  P.finalizeShard(shard, '2026-08');
  const after = shard.complexes['공덕동|공덕삼성래미안'].areas['84'].trades;
  ok(!after.some(t => t.price === 15.2), 'Full Replace: 취소된 거래가 DB에서 제거됨');
  ok(after.length === before - 1, 'Full Replace: 해당 월만 교체되고 다른 월 보존');
  // 원상복구
  P.mergeMonth(shard, '202607', tM['202607'] || [], rM['202607'] || []);
  P.finalizeShard(shard, '2026-08');
}

const cx = shard.complexes['공덕동|공덕삼성래미안'];
ok(!!cx, '단지 키 생성 (동|단지명)');
ok(cx.builtYear === 1999, '건축년도');
ok(Object.keys(cx.areas).sort().join(',') === '59,84', '평형 그룹 59/84 (84.94와 84.97 병합)');
ok(cx.areas['84'].trades.length === 4, '84형 매매 4건 · 재병합 중복 제거');
ok(cx.areas['84'].trades[0].price === 15.2, '만원→억 변환 + 최신순 정렬');
ok(!shard.complexes['아현동|취소테스트'], '해제거래 단지 제외');
ok(cx.areas['84'].jeonse && Math.abs(cx.areas['84'].jeonse.v - 7.8) < 0.01, '전세 대표값 = 신규 전세 중앙값 (갱신·월세 제외)');
ok(cx.tradeCount === 5, '단지 총 매매 건수');

const idx = P.buildIndex([shard]);
ok(idx.length === 2, '인덱스 단지 수');
ok(idx[0].t >= idx[1].t, '인덱스 거래량 정렬');
ok(idx[0].gn === '서울 마포구' && Array.isArray(idx[0].a), '인덱스 필드');

console.log(`pipeline.js  ${pass} pass / ${fail} fail`);
if (fail) process.exit(1);
