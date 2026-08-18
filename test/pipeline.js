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
P.mergeMonth(shard, '202607', trades, rents);
P.mergeMonth(shard, '202607', trades, rents);   // 같은 데이터 재병합 → 매매 중복 없어야 함
P.finalizeShard(shard, '2026-08');

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
