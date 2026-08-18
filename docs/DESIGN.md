# 닥터마빈 아파트 가치진단 — 설계 문서

PRD 68항(구현 전 정리 항목)에 따른 설계 요약. 구현과 함께 유지·갱신한다.

---

## 1. 전체 파일 구조

```
apt-value/
├── build.sh                  # 테스트 → 조립 → 암호화 빌드 (테스트 실패 시 빌드 중단)
├── package.json              # npm test
├── index.html                # 배포본(암호화 게이트 + 암호문). 저장소에는 이것만 실행 산출물로 존재
├── src/
│   ├── head.html             # HTML 골격 + CSS (세금 시뮬레이터 디자인 시스템 승계)
│   ├── engine.js             # 가치평가 엔진 A~E + 하이브리드 결합 + 신뢰도 + 스트레스 (순수함수, Node 테스트 가능)
│   └── ui.js                 # 화면 흐름·렌더링·스트레스 테스트·비교 UI
├── config/
│   ├── valuation-parameters.json   # 모든 계수·가중치·캡·경계값 (코드에 하드코딩 금지)
│   ├── education_hubs.json         # 교육 허브 DB
│   └── job_centers.json            # 업무지역 DB
├── data/
│   └── apartments.json       # 샘플 단지 DB (실거래·전세·입지·수급, 출처·기준일 포함)
├── test/
│   ├── units.js              # 엔진 단위 테스트 (가드·캡·단조성)
│   └── cases.js              # PRD 69 완료기준 사례 회귀 테스트 (전 단지 × 전 평형)
├── tools/
│   ├── build.js              # src + config + data → app.html (config/data JSON을 빌드 시점에 인라인)
│   └── gate.js               # app.html → index.html (AES-256-GCM + PBKDF2 60만회, 비번은 커밋 안 함)
└── docs/DESIGN.md            # 이 문서
```

- 평문 `app.html`, 비밀번호 파일 `.gate-password`는 `.gitignore` — 저장소·배포본에는 암호문만 존재.
- config·data는 **JSON 파일이 원본**이고 빌드 시 앱에 인라인된다. 계수 수정 = JSON 수정 후 재빌드.

## 2. 데이터 스키마 (data/apartments.json)

단위 규약: 가격 **억원**, 월세 **만원/월**, 면적 ㎡, 시간 분, 비율 소수(0.047).

```jsonc
{
  "meta": { "kind": "sample", "asOf": "2026-08", "notice": "데모 샘플 데이터 — 화면에서 수정 가능" },
  "complexes": [{
    "id": "godeok-gracium",
    "name": "고덕그라시움", "city": "서울", "district": "강동구", "dong": "고덕동",
    "regionTier": "서울",            // 요구수익률 지역위험·임대성장률 키
    "builtYear": 2019, "households": 4932, "brandTier": 1,   // 1(메이저컨소)~4
    "parkingRatio": 1.34, "far": 249, "rentalShare": 0.05,
    "redev": { "stage": "none" },     // PRD 32 단계 코드
    "conversionRate": 0.046,          // 지역 시장 전월세전환율
    "areas": [{
      "key": "84", "label": "전용 84㎡ (33~34평형)", "m2": 84.9,
      "trades": [{ "ym": "2026-07", "price": 17.8, "floor": 18 }, ...],   // 매매 실거래
      "jeonse": 8.9,                  // 대표 전세 시세
      "jeonseTrades": [...],          // 선택
      "rentExample": { "deposit": 3.0, "rent": 210 }   // 선택(만원)
    }],
    "location": { "subwayMin": 7, "lines": ["5호선","9호선(연장 예정)"], "transfer": false,
                  "express": false, "futureTransit": "9호선 4단계 (확정)",
                  "jobMinutes": { "GBD": 40, "CBD": 55, "YBD": 65, "JAMSIL": 25, ... } },
    "education": { "elemM": 250, "chopuma": true, "middlePref": 4,        // 1~5
                   "hubId": "godeok-myeongil", "inHub": true, "hubAccess": [{ "hubId": "daechi", "min": 35 }],
                   "age3049": 0.335, "studentTrend": "stable" },
    "life": { "martMin": 8, "deptMin": 25, "hospitalMin": 15, "streetLevel": 3 },   // 1~5
    "nature": { "parkMin": 5, "bigPark": true, "riverMin": 20, "hanRiver": false,
                "hanRiverView": null,   // null = 데이터 없음 → 항목 제외 + 신뢰도 반영
                "forest": true },
    "supply": { "pop": 460000, "next3yAvg": 3900, "adjacentRatio": 1.4, "metroRatio": 1.0,
                "unsoldLevel": 1, "txVolumeLevel": 3, "jeonseListingsLevel": 2,      // 1~5
                "jeonseTrend": "stable", "regulated": true },
  "sources": { "trades": { "src": "국토교통부 실거래가(샘플)", "asOf": "2026-08-12" }, ... }
  }]
}
```

`직접 입력` 모드는 위 스키마의 축약형을 화면 폼으로 채워 동일 파이프라인에 태운다.

## 3. Valuation Engine 구조 (src/engine.js)

모든 함수는 `(input, CFG)`를 받는 순수함수. `input`은 (단지 스냅샷 + 사용자 수정값 + 스트레스 오버라이드) 병합 결과.

```
engineMarket(A)   비교거래 앵커
  - 후보: ①동일단지 동일평형(유사도 1.0) ②동일단지 유사평형(면적탄력 보정×패널티)
          ③인근 유사단지(특성보정×패널티) — 데이터에 comparables로 명시
  - 가중치 w = 유사도 × 0.5^(경과개월/반감기) , 최대 경과월 초과 거래 제외
  - 가중중앙값 = V_market, 가중 p25/p75 = 분산(범위 폭 입력)
engineFinancial(B)   금융·임대 내재가치
  - R(연간 주거서비스) = 월세×12 + 보증금×전환율 | 전세×전환율 (시장 전환율)
  - r = 대체투자수익률 + 유동성 + 지역위험 + 자산위험 (config 합성)
  - r−g < minSpread → 고든 중단, 유한 DCF(40y) 대체   [가드]
  - 역산 g* = r − R/P → "현재가 유지에 필요한 임대가치 성장률"
  - 전세 = 자금조달 구조: 필요자기자본 E = P−J, 전세가율, 전세지지력 5등급
engineHedonic(C)   주거·입지·상품 (0~100 점수 체계)
  - 교통 / 직주(Job Accessibility = Σ 규모×e^(−t/τ)) / 교육(4개 하위: 학교·학원가·접근성·수요지속)
    / 생활 / 자연(한강 접근≠조망 분리, 결측 시 제외) / 상품(연식 비선형·세대수 로그·브랜드 제한·주차)
  - 가격 반영: adj_c = cap_c × (score_c − baseline)/40, 교육은 지역 Education Coefficient 곱
  - Σ를 totalCap으로 클램프, **비교거래 유사도만큼 잔차 축소** (동일단지 동일평형 비교 시 ≈0)
    → 점수는 "왜 이 가격인가" 설명, 가격은 이중가산하지 않음 [PRD 35]
engineSupply(D)   수급·시장구조
  - 간이수요 = 인구×0.5% (간이 수요추정치로 표기), 공급부담률 = 3단계(구/인접/광역) 가중
  - 등급 경계 config, 가격조정 ±cap 제한, 규제 = 수요억제/매물잠김 양면 서술
engineOption(E)   미래 옵션가치
  - 단계→실현확률(config), 용적률 여유 있으면 제한적 프리미엄, 데이터 부족 시 금액 없이 등급+시나리오만
combine()   하이브리드 결합
  - V_mkt_adj = V_market × (1 + 히도닉잔차 + 수급조정)
  - V_fund_eff = V_fund × (1 + 옵션프리미엄)
  - 모델 괴리 d = |차이|/V_market 클수록 fundamental 가중 축소·범위 확대·신뢰도 하락
  - V_center = 정규화 가중합, 시장앵커 ±12% 안전 클램프 [PRD 38]
  - 범위 = V_center × (1±spread), spread = f(거래분산, 괴리, 데이터충족) ∈ [4.5%, 12%]
scores()    3대 점수: 주거가치 / 투자가치 / 가격매력도(현재가 vs 범위 매핑)
confidence()  비교거래 수·최신성·충족률·유사도·수동보정·괴리 → 높음/보통/낮음
applyStress()  오버라이드(금리±, 전세±, 공급×, 가격±) 병합 후 전체 파이프라인 재계산
```

## 4. Config 구조 (config/valuation-parameters.json)

코드에 계수 하드코딩 금지 — 전부 여기서 관리:
`market`(반감기·패널티·특성보정캡) / `financial`(금리·프리미엄·전환율·성장률·minSpread) /
`hedonic`(baseline·카테고리캡·totalCap) / `education`(하위 가중치·지역계수) /
`supply`(수요율·경계값·존가중·캡) / `option`(단계확률·최대프리미엄) /
`final`(결합 가중치·안전클램프) / `range` / `scores`(3대 점수 가중·매핑) /
`confidence`(감점표·등급 경계) / `stress`(프리셋 정의).

## 5. MVP 화면 Flow

```
[잠금] 4자리 비밀번호 (초기 0731, AES 게이트)
STEP 1  아파트 선택 — 검색(단지명/지역) → 샘플 카드 선택 | "직접 입력"
STEP 2  정보 확인 — 평형 선택 → 현재가·전세가·금리·전환율 자동입력값 확인/수정 (출처·기준일 표시)
STEP 3  진단 결과
  HERO(시장가격 / 적정가치범위 / 판단 배지 / 신뢰도) → 3대 점수 타일(클릭=상세)
  → 올리는 요인 / 누르는 요인 → 상대적 가치 기여도 차트 → 조건부 해석(역산 포함)
  → 엔진별 상세(접힘) → 스트레스 테스트(토글 즉시 재계산) → 단지 비교 → 출처·신뢰도·면책
```

## 6. 현재 자동 입력 가능한 데이터 (MVP)

- 샘플 단지 DB 12곳: 실거래 이력·전세 시세·연식·세대수·용적률·주차·입지·교육·수급 — **출처·기준일 표시, 데모 샘플임을 명시**
- config 기본값: 기준금리·주담대·대체수익률·전환율·성장률 (기준일 표시)
- 정적 사이트 제약상 실시간 API 미연결(키 노출 금지, PRD 51). services adapter 구조와 스키마는
  국토부 실거래·부동산원·통계청 연동을 전제로 설계되어 있어 Phase 2에서 어댑터만 교체하면 된다.

## 7. 수동 입력이 필요한 데이터

- 현재 시장가격(최신 실거래/호가 반영 수정), 전세 시세 수정 — STEP 2에서 항상 확인·수정 가능
- "직접 입력" 모드: 샘플에 없는 단지의 핵심 필드(가격·전세·연식·세대수·역거리·학군·수급 수준 등)
- 수동 수정은 신뢰도 계산에 반영(보정 항목 수만큼 감점)되고 결과 화면에 표시된다.

---

## 8. 실거래 자동수집 파이프라인 (v1.1)

네이버부동산·아실은 크롤링이 약관상 금지된 상용 서비스이므로 직접 수집하지 않는다.
대신 그 서비스들의 원천인 **국토교통부 실거래가 공개 API**(매매+전월세)를 직접 수집한다.

```
pipeline/regions.json     수집 대상 시군구 레지스트리 (서울 25 + 수도권 주요, enabled 플래그)
                          + 시군구별 간이 기본값 (tier·인구·전환율·직주시간·공급 — 화면에 '기본값' 표시)
pipeline/collect.js       수집기: 시군구×월 → 파싱 → 단지·평형(floor ㎡) 집계 → 기존 샤드와 병합
data/live/index.json      전 단지 검색 인덱스 (이름·지역·연식·거래량·평형)
data/live/{code}.json     시군구 샤드: 단지·평형별 최근 매매 14건 + 전세 대표값(신규계약 중앙값, 갱신 제외)
.github/workflows/update-data.yml   매일 06:10 KST 최근 2개월 증분 수집·커밋 (시크릿 DATA_GO_KR_KEY)
```

- 해제거래(cdealType=O) 제외, 갱신계약 전세 제외(5% 상한 왜곡 방지), 만원→억 변환, 24개월 이력 유지
- 앱은 잠금 해제 후 index.json을 fetch → 검색 통합. 단지 선택 시 해당 샤드만 fetch
- 자동수집 단지: 가격·전세 = 실데이터, 입지·상품 상세 = regions 기본값 + STEP 2 보완 입력
  → 결측 항목은 `cx.dataGaps`로 엔진에 전달되어 **데이터 충족률·신뢰도에 그대로 반영** [PRD 53·54]
- API 키는 브라우저에 절대 노출되지 않는다 — 수집은 GitHub Actions(시크릿) 또는 로컬에서만 [PRD 51]
- 일 1,000회 호출 한도(개발키) 안에서: 일상 갱신 = 지역×2개월×2API ≈ 160회, 백필은 나눠 실행
