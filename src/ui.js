'use strict';
/* ═══════════════════════════════════════════════════════════════════
   닥터마빈 아파트 가치진단 — UI
   (빌드 시 CFG/HUBS/JOBS/DATA/REGIONS/AptEngine 주입)
   단지 소스 3종: ① 상세 프로필 샘플(DATA) ② 실거래 자동수집(data/live/*)
                 ③ 직접 입력
   ═══════════════════════════════════════════════════════════════════ */
const APP_VERSION = '2.0.0';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtEok = x => `${(Math.round(x * 10) / 10).toFixed(1)}억`;
const fmtEokW = x => `${(Math.round(x * 10) / 10).toFixed(1)}억원`;
const fmtPct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const signPct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

/* ── 테마 ── */
(function initTheme() {
  let t = null; try { t = localStorage.getItem('aptdx_theme'); } catch (e) {}
  if (!t) t = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
})();
$('themeBtn').textContent = document.documentElement.getAttribute('data-theme') === 'dark' ? '라이트' : '다크';
$('themeBtn').onclick = () => {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', cur);
  try { localStorage.setItem('aptdx_theme', cur); } catch (e) {}
  $('themeBtn').textContent = cur === 'dark' ? '라이트' : '다크';
};

/* ── 상태 ── */
const state = {
  step: 1, cxId: null, manual: false, manualVals: {},
  liveSel: null,            // {id, code, key, entry, region}
  autoEdits: {},            // 자동수집 단지 보완 입력
  areaKey: null,
  ovPrice: null, ovJeonse: null, ovConv: null,
  result: null, baseInput: null, stress: new Set()
};

/* ── 자동수집(live) 데이터 ── */
const LIVE = { index: null, shards: {}, status: 'loading' };
async function loadLive() {
  try {
    const r = await fetch('data/live/index.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error('none');
    LIVE.index = await r.json();
    LIVE.status = 'ready';
  } catch (e) { LIVE.status = 'none'; }
  renderVerLine(); renderAptList($('q').value.trim());
}
async function getShard(code) {
  if (LIVE.shards[code]) return LIVE.shards[code];
  const r = await fetch(`data/live/${code}.json`, { cache: 'no-cache' });
  if (!r.ok) throw new Error('지역 데이터를 불러오지 못했습니다.');
  const j = await r.json();
  LIVE.shards[code] = j;
  return j;
}
const regionOf = code => REGIONS.regions.find(r => r.code === code);

const STEPS = ['아파트 선택', '정보 확인', '진단 결과'];

/* ── 스테퍼·내비 ── */
function renderStepper() {
  $('stepper').innerHTML = STEPS.map((s, i) => {
    const n = i + 1;
    const cls = n === state.step ? 'st cur' : n < state.step ? 'st done' : 'st';
    return `<button class="${cls}" data-go="${n}"><i></i>${s}</button>`;
  }).join('');
  $('stepper').querySelectorAll('.st.done').forEach(b => b.onclick = () => go(Number(b.dataset.go)));
}

function step2Valid() {
  const cx = getComplex();
  if (!cx) return { ok: false, msg: '' };
  const area = cx.areas.find(a => a.key === state.areaKey) || cx.areas[0];
  const latest = (area.trades || [])[0];
  const price = state.ovPrice != null ? state.ovPrice : (latest ? latest.price : null);
  const jeonse = state.ovJeonse != null ? state.ovJeonse : area.jeonse;
  if (!(price > 0)) return { ok: false, msg: '이 평형의 실거래가 없어 현재 시세를 직접 입력해야 합니다.' };
  if (!(jeonse > 0)) return { ok: false, msg: '전세 실거래가 없어 전세 시세를 직접 입력해야 합니다.' };
  return { ok: true, msg: '' };
}

function nav() {
  const prev = $('btnPrev'), next = $('btnNext'), msg = $('navMsg');
  prev.style.visibility = state.step === 1 ? 'hidden' : 'visible';
  msg.style.display = 'none';
  if (state.step === 1) {
    next.textContent = '다음';
    next.disabled = !selectionValid();
  } else if (state.step === 2) {
    next.textContent = '분석하기';
    const v = step2Valid();
    next.disabled = !v.ok;
    if (!v.ok && v.msg) { msg.textContent = v.msg; msg.style.display = 'block'; }
  } else {
    next.textContent = '다른 아파트 진단하기'; next.disabled = false;
  }
}

function go(n) {
  state.step = n;
  $('step1').hidden = n !== 1; $('step2').hidden = n !== 2; $('step3').hidden = n !== 3;
  renderStepper();
  if (n === 2) renderStep2();
  nav();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$('btnPrev').onclick = () => { if (state.step > 1) go(state.step - 1); };
$('btnNext').onclick = () => {
  if (state.step === 1 && selectionValid()) go(2);
  else if (state.step === 2 && step2Valid().ok) runAnalysis();
  else if (state.step === 3) resetAll();
};

function resetAll() {
  state.cxId = null; state.manual = false; state.manualVals = {};
  state.liveSel = null; state.autoEdits = {};
  state.areaKey = null;
  state.ovPrice = null; state.ovJeonse = null; state.ovConv = null;
  state.result = null; state.baseInput = null; state.stress = new Set();
  $('q').value = ''; $('manualCard').hidden = true; $('report').innerHTML = '';
  renderAptList(''); go(1);
}

function selectionValid() {
  if (state.manual) {
    const v = state.manualVals;
    return !!(v.name && v.price > 0 && v.jeonse > 0 && v.m2 > 0 && v.builtYear > 1960 && v.households > 0);
  }
  return !!state.cxId || !!state.liveSel;
}

/* ── STEP 1 · 검색 + 단지 목록 (샘플 + 자동수집) ── */
function matchTokens(q, hay) { return q.split(/\s+/).every(t => hay.includes(t)); }

function liveStatusHtml() {
  if (LIVE.status === 'loading') return `<div class="notebox">실거래 자동수집 데이터 확인 중…</div>`;
  if (LIVE.status === 'ready') {
    const m = LIVE.index.meta;
    return `<div class="notebox">🔄 <b>실거래 자동수집 연결됨</b> — ${m.regions}개 시군구 · ${LIVE.index.complexes.length.toLocaleString()}개 단지 (국토교통부 실거래가, ${esc(m.updatedAt)} 기준). 검색하면 자동수집 단지가 함께 검색됩니다.</div>`;
  }
  return `<div class="notebox"><b>실거래 자동수집 대기 중</b> — 공공데이터포털(국토교통부 실거래가 API) 키를 연결하면
    수도권 40개 시군구의 <b>모든 아파트 단지</b>가 자동 등재되고 매일 갱신됩니다.
    <details style="margin-top:6px"><summary style="cursor:pointer">연결 방법 (5분, 1회)</summary>
    <ol style="margin:6px 0 0;padding-left:18px;line-height:1.7">
      <li>data.go.kr 로그인 → <b>"아파트 매매 실거래자료"</b>와 <b>"아파트 전월세 자료"</b> 각각 활용신청 (즉시 승인)</li>
      <li>마이페이지의 일반 인증키를 GitHub 저장소 apt-value → Settings → Secrets → Actions에 <b>DATA_GO_KR_KEY</b>로 등록</li>
      <li>Actions 탭 → "실거래 데이터 자동 갱신" → Run workflow (months=24로 1회 백필) — 이후 매일 자동</li>
    </ol></details></div>`;
}

function renderAptList(q) {
  const sample = DATA.complexes.filter(c => {
    if (!q) return true;
    return matchTokens(q, [c.name, c.city, c.district, c.dong, ...(c.aliases || []), ...(c.tags || [])].join(' '));
  });
  let liveMatches = [];
  if (q && LIVE.status === 'ready') {
    const sampleNames = new Set(sample.map(c => c.name));
    liveMatches = LIVE.index.complexes
      .filter(e => matchTokens(q, `${e.n} ${e.gn} ${e.d}`))
      .filter(e => !sampleNames.has(e.n))
      .slice(0, 30);
  }
  const sampleCards = sample.map(c => `
    <button class="apt ${state.cxId === c.id && !state.manual && !state.liveSel ? 'sel' : ''}" data-id="${c.id}">
      <b>${esc(c.name)}</b>
      <span class="l1">${esc(c.city)} ${esc(c.district)} ${esc(c.dong)} · ${c.builtYear}년 · ${c.households.toLocaleString()}세대</span>
      <span class="tagrow"><span class="tg" style="color:var(--accent);border-color:var(--accent)">상세 프로필</span>${(c.tags || []).map(t => `<span class="tg">${esc(t)}</span>`).join('')}</span>
    </button>`).join('');
  const liveCards = liveMatches.map(e => `
    <button class="apt" data-live="${esc(e.id)}">
      <b>${esc(e.n)}</b>
      <span class="l1">${esc(e.gn)} ${esc(e.d)} · ${e.y ? e.y + '년' : '연식 미상'} · 최근 2년 매매 ${e.t}건</span>
      <span class="tagrow"><span class="tg">실거래 자동</span><span class="tg">${e.a.map(a => a + '㎡').join(' · ')}</span></span>
    </button>`).join('');
  $('aptList').innerHTML = liveStatusHtml() + sampleCards + liveCards + `
    <button class="apt dashed full" data-id="__manual__">
      <b>＋ 직접 입력</b>
      <span class="l1">검색에 없는 아파트를 핵심 정보만으로 진단합니다 (신뢰도는 낮게 표시됩니다)</span>
    </button>` +
    (q && !sample.length && !liveMatches.length ? `<div class="notebox">검색 결과가 없습니다. ${LIVE.status !== 'ready' ? '자동수집을 연결하면 수도권 전 단지가 검색됩니다. ' : ''}직접 입력으로 진단할 수 있습니다.</div>` : '');

  $('aptList').querySelectorAll('.apt').forEach(b => b.onclick = async () => {
    if (b.dataset.live) {
      try {
        b.querySelector('b').textContent = '불러오는 중…';
        await selectLive(b.dataset.live);
      } catch (e) {
        b.querySelector('b').textContent = '불러오기 실패 — 다시 시도';
      }
      return;
    }
    if (b.dataset.id === '__manual__') {
      state.manual = true; state.cxId = null; state.liveSel = null;
      $('manualCard').hidden = false;
      renderManualForm();
      $('manualCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
      renderAptList($('q').value.trim()); nav();
    } else {
      state.manual = false; state.liveSel = null; state.cxId = b.dataset.id; state.areaKey = null;
      state.ovPrice = null; state.ovJeonse = null; state.ovConv = null;
      $('manualCard').hidden = true;
      go(2);
    }
  });
}
$('q').addEventListener('input', () => renderAptList($('q').value.trim()));

async function selectLive(id) {
  const e = LIVE.index.complexes.find(x => x.id === id);
  if (!e) throw new Error('단지 없음');
  const shard = await getShard(e.g);
  const key = id.split('|').slice(1).join('|');
  const entry = shard.complexes[key];
  if (!entry) throw new Error('단지 데이터 없음');
  state.liveSel = { id, code: e.g, key, entry, region: regionOf(e.g) };
  state.manual = false; state.cxId = null; state.areaKey = null; state.autoEdits = {};
  state.ovPrice = null; state.ovJeonse = null; state.ovConv = null;
  $('manualCard').hidden = true;
  go(2);
}

/* ── 자동수집 단지 → 엔진 스키마 ── */
function matchHub(dong, district) {
  const norm = s => String(s || '').replace(/\s/g, '');
  for (const h of HUBS.hubs) {
    const d1 = norm(district), d2 = norm(h.district);
    if (!d1.includes(d2) && !d2.includes(d1)) continue;
    if (norm(h.neighborhood).includes(norm(dong))) return h;
  }
  return null;
}

function buildAutoComplex() {
  const { entry, region } = state.liveSel;
  const e = state.autoEdits;
  const gaps = [];
  const hub = matchHub(entry.dong, region.district);
  if (!(e.households > 0)) gaps.push('세대수 미확인 (중립 가정)');
  if (!e.redevStage) gaps.push('정비사업 단계 미확인');
  if (!entry.builtYear) gaps.push('준공연도 미확인');
  gaps.push('주차·브랜드·생활·자연환경 기본값 사용');
  if (!hub) gaps.push('교육 상세 미확인 (중립 가정)');

  // 역 연결: 사용자 입력(MANUAL) > 법정동 자동 연결(ESTIMATED) > 미확인(UNKNOWN)
  let stationLink = null, unknownTransport = false, stStatus = 'UNKNOWN';
  const es = e.station;
  if (es && es.st && STN.stations[es.st]) {
    stationLink = { primary: { st: es.st, min: es.min > 0 ? es.min : 8, status: 'MANUAL' } };
    stStatus = 'MANUAL';
  } else {
    const dl = DONG.map[entry.dong];
    if (dl && dl.length && STN.stations[dl[0].st]) {
      stationLink = {
        primary: { st: dl[0].st, min: dl[0].min, status: 'ESTIMATED' },
        secondary: dl[1] && STN.stations[dl[1].st] ? { st: dl[1].st, min: dl[1].min } : null
      };
      stStatus = 'ESTIMATED';
    } else { unknownTransport = true; }
  }

  const fieldStatus = {
    price: state.ovPrice != null ? 'MANUAL' : 'VERIFIED',
    jeonse: state.ovJeonse != null ? 'MANUAL' : (Object.values(entry.areas).some(a => a.jeonse) ? 'VERIFIED' : 'UNKNOWN'),
    builtYear: entry.builtYear ? 'VERIFIED' : 'UNKNOWN',
    households: e.households > 0 ? 'MANUAL' : 'UNKNOWN',
    station: stStatus,
    redev: e.redevStage ? 'MANUAL' : 'UNKNOWN',
    supply: e.supplyNext3yAvg > 0 ? 'MANUAL' : 'ESTIMATED',
    education: hub ? 'ESTIMATED' : 'UNKNOWN',
    lifeNature: 'UNKNOWN',
    product: 'UNKNOWN'
  };

  const areas = Object.entries(entry.areas).map(([k, a]) => ({
    key: k, label: `전용 ${k}㎡형`, m2: a.m2,
    trades: (a.trades || []).map(t => ({ ym: t.ym, price: t.price, floor: t.floor })),
    jeonse: a.jeonse ? a.jeonse.v : null, jeonseMeta: a.jeonse || null
  })).sort((x, y) => Number(x.key) - Number(y.key));

  // 이 단지에 매매 실거래가 전혀 없으면, 사용자가 입력한 시세를 앵커로 사용
  const totTrades = areas.reduce((s, a) => s + a.trades.length, 0);
  if (!totTrades && state.ovPrice > 0) {
    const sel = areas.find(a => a.key === state.areaKey) || areas[0];
    sel.trades = [{ ym: liveAsOf(), price: state.ovPrice, floor: 0 }];
    gaps.push('매매 실거래 없음 — 입력 시세 기준');
  }

  return {
    id: 'live|' + state.liveSel.id, name: entry.name,
    city: region.sido, district: region.name, dong: entry.dong,
    regionTier: region.tier, builtYear: entry.builtYear || 2000,
    households: e.households > 0 ? e.households : 700, brandTier: 2,
    parkingRatio: 0.9, far: 250, rentalShare: 0,
    redev: { stage: e.redevStage || 'none' },
    conversionRate: state.ovConv != null ? state.ovConv : region.conv,
    tags: ['실거래 자동'], dataGaps: gaps, fieldStatus, stationLink,
    areas,
    location: { subwayMin: stationLink ? stationLink.primary.min : null, unknownTransport, lines: [], transfer: false, express: false, futureTransit: null, jobMinutes: region.jobMinutes },
    education: hub
      ? { elemM: 400, chopuma: false, middlePref: hub.hub_type === 'school_zone' ? 4 : 3, hubId: hub.id, inHub: true, hubAccess: [], age3049: 0.31, studentTrend: 'stable' }
      : { elemM: 500, chopuma: false, middlePref: 3, hubId: null, inHub: false, localAcademyLevel: 3, hubAccess: [], age3049: 0.30, studentTrend: 'stable' },
    life: { martMin: 10, deptMin: 20, hospitalMin: 15, streetLevel: 3 },
    nature: { parkMin: 10, bigPark: false, riverMin: 30, hanRiver: false, hanRiverView: null, forest: false },
    supply: {
      pop: region.pop, next3yAvg: e.supplyNext3yAvg > 0 ? e.supplyNext3yAvg : region.supplyNext3yAvg,
      adjacentRatio: region.adjacentRatio, metroRatio: region.metroRatio,
      unsoldLevel: 2, txVolumeLevel: 3, jeonseListingsLevel: 3, jeonseTrend: 'stable', regulated: region.regulated
    }
  };
}
function liveAsOf() { return (LIVE.index && LIVE.index.meta.updatedAt) || DATA.meta.asOf; }

/* ── 직접 입력 ── */
const REDEV_OPTS = Object.entries(CFG.option.stageLabels);
function renderManualForm() {
  const v = state.manualVals;
  $('manualForm').innerHTML = `
    <div class="grid2">
      <div class="full"><label class="mini">단지명<input type="text" class="box" id="mName" value="${esc(v.name || '')}" placeholder="예: ○○아파트"></label></div>
      <div><label class="mini">지역 구분
        <select id="mTier">${['서울핵심', '서울', '수도권핵심', '수도권', '지방광역', '기타'].map(t => `<option ${v.tier === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <p class="subtle">요구수익률·임대가치 성장률 가정에 쓰입니다.</p></div>
      <div><label class="mini">준공연도<span class="inline-num"><input type="number" id="mYear" min="1965" max="2026" value="${v.builtYear || 2010}"><em>년</em></span></label></div>
      <div><label class="mini">세대수<span class="inline-num"><input type="number" id="mHH" min="50" step="50" value="${v.households || 1000}"><em>세대</em></span></label></div>
      <div><label class="mini">전용면적<span class="inline-num"><input type="number" id="mM2" min="20" step="1" value="${v.m2 || 84}"><em>㎡</em></span></label></div>
      <div><label class="mini">현재 시세 (매매)<span class="inline-num"><input type="number" id="mPrice" min="0.5" step="0.1" value="${v.price || ''}"><em>억원</em></span></label></div>
      <div><label class="mini">전세 시세<span class="inline-num"><input type="number" id="mJeonse" min="0.1" step="0.1" value="${v.jeonse || ''}"><em>억원</em></span></label></div>
      <div><label class="mini">지하철 도보<span class="inline-num"><input type="number" id="mSubway" min="1" max="40" value="${v.subwayMin || 10}"><em>분</em></span></label></div>
      <div><label class="mini">강남까지 (대중교통)<span class="inline-num"><input type="number" id="mGBD" min="5" max="120" value="${v.gbd || 45}"><em>분</em></span></label></div>
      <div><label class="mini">중학교 학군 선호도
        <select id="mMid">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${((v.middlePref || 3) === n) ? 'selected' : ''}>${n} — ${['매우 낮음', '낮음', '보통', '선호', '매우 선호'][n - 1]}</option>`).join('')}</select></label></div>
      <div><label class="mini">동네 학원가 수준
        <select id="mAcad">${[1, 2, 3, 4, 5].map(n => `<option value="${n}" ${((v.acadLevel || 3) === n) ? 'selected' : ''}>${n} — ${['거의 없음', '작음', '보통', '큼', '대형 학원가'][n - 1]}</option>`).join('')}</select></label></div>
      <div><label class="mini">향후 3년 연평균 입주(시군구)<span class="inline-num"><input type="number" id="mSupply" min="0" step="100" value="${v.supply || 2000}"><em>호</em></span></label></div>
      <div><label class="mini">지역 인구<span class="inline-num"><input type="number" id="mPop" min="1" step="1" value="${v.popMan || 40}"><em>만명</em></span></label></div>
      <div><label class="mini">정비사업 단계
        <select id="mRedev">${REDEV_OPTS.map(([k, l]) => `<option value="${k}" ${((v.redev || 'none') === k) ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
    </div>
    <p class="subtle">그 밖의 항목(주차·브랜드·공원·규제 등)은 중립 가정값으로 계산되며, 결과의 신뢰도 표시에 반영됩니다.</p>`;
  const bind = (id, key, num) => { $(id).addEventListener('input', () => { state.manualVals[key] = num ? Number($(id).value) : $(id).value.trim(); nav(); }); };
  bind('mName', 'name'); bind('mYear', 'builtYear', 1); bind('mHH', 'households', 1);
  bind('mM2', 'm2', 1); bind('mPrice', 'price', 1); bind('mJeonse', 'jeonse', 1); bind('mSubway', 'subwayMin', 1);
  bind('mGBD', 'gbd', 1); bind('mSupply', 'supply', 1); bind('mPop', 'popMan', 1);
  ['mTier', 'mMid', 'mAcad', 'mRedev'].forEach(id => $(id).addEventListener('change', () => {
    const map = { mTier: 'tier', mMid: 'middlePref', mAcad: 'acadLevel', mRedev: 'redev' };
    state.manualVals[map[id]] = (id === 'mTier' || id === 'mRedev') ? $(id).value : Number($(id).value); nav();
  }));
  if (!v.tier) { v.tier = '서울'; v.builtYear = v.builtYear || 2010; v.households = v.households || 1000; v.m2 = v.m2 || 84; }
}

function buildManualComplex() {
  const v = state.manualVals;
  const conv = CFG.financial.defaultConversionRate;
  return {
    id: '__manual__', name: v.name || '직접 입력 단지', city: '', district: '', dong: '',
    regionTier: v.tier || '서울', builtYear: v.builtYear || 2010, households: v.households || 1000,
    brandTier: 2, parkingRatio: 1.0, far: 250, rentalShare: 0,
    redev: { stage: v.redev || 'none' }, conversionRate: state.ovConv != null ? state.ovConv : conv,
    tags: ['직접 입력'],
    areas: [{ key: 'M', label: `전용 ${v.m2 || 84}㎡`, m2: v.m2 || 84, jeonse: v.jeonse, trades: [{ ym: DATA.meta.asOf, price: v.price }] }],
    location: { subwayMin: v.subwayMin || 10, lines: [], transfer: false, express: false, futureTransit: null, jobMinutes: { GBD: v.gbd || 45, CBD: 50, YBD: 55, PANGYO: 45 } },
    education: { elemM: 500, chopuma: false, middlePref: v.middlePref || 3, hubId: null, inHub: false, localAcademyLevel: v.acadLevel || 3, hubAccess: [], age3049: 0.30, studentTrend: 'stable' },
    life: { martMin: 10, deptMin: 20, hospitalMin: 15, streetLevel: 3 },
    nature: { parkMin: 10, bigPark: false, riverMin: 30, hanRiver: false, hanRiverView: null, forest: false },
    supply: { pop: (v.popMan || 40) * 10000, next3yAvg: v.supply ?? 2000, adjacentRatio: 1.0, metroRatio: 1.0, unsoldLevel: 2, txVolumeLevel: 3, jeonseListingsLevel: 3, jeonseTrend: 'stable', regulated: false }
  };
}

/* ── STEP 2 · 정보 확인 ── */
function getComplex() {
  if (state.manual) return buildManualComplex();
  if (state.liveSel) return buildAutoComplex();
  return DATA.complexes.find(c => c.id === state.cxId);
}

function renderStep2() {
  const cx = getComplex();
  if (!cx) return;
  if (!state.areaKey || !cx.areas.some(a => a.key === state.areaKey)) state.areaKey = cx.areas[0].key;
  const isLive = !!state.liveSel;
  const S = DATA.defaultSources;

  $('cxSummary').innerHTML = `
    <div class="stepnum">STEP 2 / 3</div>
    <h2>${esc(cx.name)} ${isLive ? '<span class="stat info">실거래 자동</span>' : ''}</h2>
    <p class="hint">${esc(cx.city)} ${esc(cx.district)} ${esc(cx.dong)} · ${cx.builtYear}년 준공${cx.households ? ` · ${cx.households.toLocaleString()}세대${cx.householdsNote ? ` (${esc(cx.householdsNote)})` : ''}` : ''}</p>
    ${isLive ? '' : `<div class="kv"><span>주차</span><span>${cx.parkingRatio ?? '—'}대/세대</span></div>
    <div class="kv"><span>용적률</span><span>${cx.far ?? '—'}%${cx.allowedFar ? ` (허용 ${cx.allowedFar}%)` : ''}</span></div>
    <div class="kv"><span>교통</span><span>${esc((cx.location.lines || []).join(' · ') || '—')} 도보 ${cx.location.subwayMin}분</span></div>
    <div class="kv"><span>정비사업</span><span>${CFG.option.stageLabels[(cx.redev && cx.redev.stage) || 'none']}</span></div>`}
    ${state.manual ? '<p class="subtle">직접 입력 단지 — 미입력 항목은 중립 가정값입니다.</p>'
      : isLive ? `<p class="subtle">국토교통부 실거래가 자동수집 단지 (${esc(liveAsOf())} 기준). 실거래·전세는 자동, 입지·상품 상세는 아래 보완 입력 또는 기본값을 사용합니다.</p>`
      : `<p class="subtle">${esc(DATA.meta.notice)}</p>`}`;

  const area = cx.areas.find(a => a.key === state.areaKey);
  const latest = (area.trades || []).slice().sort((a, b) => b.ym.localeCompare(a.ym))[0];
  const priceVal = state.ovPrice != null ? state.ovPrice : (latest ? latest.price : '');
  const jeonseVal = state.ovJeonse != null ? state.ovJeonse : (area.jeonse ?? '');
  const jm = area.jeonseMeta;
  $('areaCard').innerHTML = `
    <h2>평형과 가격을 확인해 주세요</h2>
    <p class="hint">자동입력 값은 수정할 수 있습니다. 수정하면 결과 신뢰도 계산에 반영됩니다.</p>
    <div class="seg" id="areaSeg">${cx.areas.map(a => `<button data-k="${a.key}" aria-pressed="${a.key === state.areaKey}">${esc(a.label)}${isLive ? ` · ${a.trades.length}건` : ''}</button>`).join('')}</div>
    <div class="grid2" style="margin-top:16px">
      <div>
        <label class="mini">현재 시장가격 ${state.ovPrice != null ? '<span class="stat est">수정됨</span>' : (latest ? '<span class="stat ok">자동입력</span>' : '<span class="stat chk" style="color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent)">입력 필요</span>')}
          <span class="inline-num"><input type="number" id="inPrice" step="0.1" min="0" value="${priceVal}"><em>억원</em></span></label>
        ${latest ? `<div class="srcline">최근 실거래 ${latest.ym} · ${fmtEok(latest.price)}${latest.floor ? ` (${latest.floor}층)` : ''} — ${isLive ? '국토교통부 실거래가 API' : esc(S.trades.src)}, ${isLive ? esc(liveAsOf()) : esc(S.trades.asOf)} 기준</div>` : '<div class="srcline">이 평형은 최근 매매 실거래가 없습니다 — 시세를 직접 입력하세요.</div>'}
      </div>
      <div>
        <label class="mini">전세 시세 ${state.ovJeonse != null ? '<span class="stat est">수정됨</span>' : (area.jeonse ? '<span class="stat ok">자동입력</span>' : '<span class="stat chk" style="color:var(--accent);background:var(--accent-soft);border:1px solid var(--accent)">입력 필요</span>')}
          <span class="inline-num"><input type="number" id="inJeonse" step="0.1" min="0" value="${jeonseVal}"><em>억원</em></span></label>
        <div class="srcline">${isLive ? (jm ? `전월세 실거래 ${jm.n}건 중앙값 (최근 ${jm.windowMo}개월, 신규계약)` : '전세 실거래 없음 — 직접 입력') : `${esc(S.jeonse.src)}, ${esc(S.jeonse.asOf)} 기준`}</div>
      </div>
    </div>`;
  $('areaSeg').querySelectorAll('button').forEach(b => b.onclick = () => {
    state.areaKey = b.dataset.k; state.ovPrice = null; state.ovJeonse = null; renderStep2(); nav();
  });
  $('inPrice').addEventListener('input', () => {
    const n = Number($('inPrice').value);
    state.ovPrice = (latest && Math.abs(n - latest.price) < 1e-9) ? null : (n > 0 ? n : null);
    nav();
  });
  $('inJeonse').addEventListener('input', () => {
    const n = Number($('inJeonse').value);
    state.ovJeonse = (area.jeonse && Math.abs(n - area.jeonse) < 1e-9) ? null : (n > 0 ? n : null);
    nav();
  });

  /* 자동수집 단지 보완 입력 + 계산 가정 */
  const F = CFG.financial;
  const conv = state.ovConv != null ? state.ovConv : (cx.conversionRate || F.defaultConversionRate);
  const r = F.altReturn + F.liquidityPremium + F.assetRiskPremium + (F.regionRiskPremium[cx.regionTier] ?? 0.013);
  const e = state.autoEdits;
  let stationRow = '';
  if (isLive) {
    const dl = DONG.map[state.liveSel.entry.dong];
    const autoSt = (!e.station && dl && dl.length && STN.stations[dl[0].st]) ? dl[0] : null;
    const badge = e.station && e.station.st ? '<span class="stat ok">입력됨</span>'
      : autoSt ? `<span class="stat est">자동연결(추정) ${esc(autoSt.st)}역 ${autoSt.min}분</span>`
      : '<span class="stat" style="color:var(--muted);background:var(--raised);border:1px solid var(--line)">미확인 — 중립 처리</span>';
    stationRow = `
      <div><label class="mini">가장 가까운 역 ${badge}
        <input type="text" class="box" id="edStName" list="stnList" value="${esc((e.station && e.station.st) || '')}" placeholder="${autoSt ? autoSt.st : '역 이름 입력'}"></label>
        <datalist id="stnList">${Object.keys(STN.stations).sort((a, b) => a.localeCompare(b, 'ko')).map(n => `<option value="${esc(n)}">`).join('')}</datalist></div>
      <div><label class="mini">역까지 도보
        <span class="inline-num"><input type="number" id="edStMin" min="1" max="40" value="${(e.station && e.station.min) || (autoSt ? autoSt.min : '')}" placeholder="8"><em>분</em></span></label>
        <p class="subtle">역을 바꾸거나 도보시간을 입력하면 확인값(MANUAL)으로 계산합니다.</p></div>`;
  }
  const liveExtra = isLive ? `
    <h3 class="mini-h">보완 정보 (선택) — 입력하면 정확도·신뢰도가 올라갑니다</h3>
    <div class="grid2">
      ${stationRow}
      <div><label class="mini">세대수 ${e.households > 0 ? '<span class="stat ok">입력됨</span>' : '<span class="stat" style="color:var(--muted);background:var(--raised);border:1px solid var(--line)">미확인 — 중립 가정</span>'}
        <span class="inline-num"><input type="number" id="edHH" min="50" step="50" value="${e.households || ''}" placeholder="미확인"><em>세대</em></span></label></div>
      <div><label class="mini">정비사업 단계 ${e.redevStage ? '<span class="stat ok">입력됨</span>' : '<span class="stat est">해당 없음 가정</span>'}
        <select id="edRedev"><option value="">모름 / 해당 없음</option>${REDEV_OPTS.filter(([k]) => k !== 'none').map(([k, l]) => `<option value="${k}" ${e.redevStage === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <div><label class="mini">향후 3년 연평균 입주(시군구) ${e.supplyNext3yAvg > 0 ? '<span class="stat ok">입력됨</span>' : `<span class="stat est">기본값 ${(state.liveSel.region.supplyNext3yAvg).toLocaleString()}호</span>`}
        <span class="inline-num"><input type="number" id="edSupply" min="0" step="100" value="${e.supplyNext3yAvg || ''}" placeholder="${state.liveSel.region.supplyNext3yAvg}"><em>호</em></span></label></div>
    </div>` : '';

  $('assumeCard').innerHTML = `
    <h2>계산 가정</h2>
    <p class="hint">기본값 그대로 두어도 됩니다. 모든 가정은 결과 화면에 표시됩니다.</p>
    <div class="kv"><span>${esc(F.baseRate.label)}</span><span>${fmtPct(F.baseRate.value)} <span class="srcline" style="display:inline">(${esc(F.baseRate.asOf)})</span></span></div>
    <div class="kv"><span>${esc(F.mortgageRate.label)}</span><span>${fmtPct(F.mortgageRate.value)} <span class="srcline" style="display:inline">(${esc(F.mortgageRate.asOf)})</span></span></div>
    <div class="kv"><span>요구수익률 r (합성)</span><span>${fmtPct(r)} = 대체투자 ${fmtPct(F.altReturn)} + 유동성 ${fmtPct(F.liquidityPremium)} + 지역·자산위험</span></div>
    <div class="kv"><span>장기 임대가치 성장률 g</span><span>${fmtPct(F.longTermRentGrowth[cx.regionTier] ?? 0.006)} (${esc(cx.regionTier)})</span></div>
    <div class="grid2" style="margin-top:12px"><div>
      <label class="mini">시장 전월세전환율 ${state.ovConv != null ? '<span class="stat est">수정됨</span>' : '<span class="stat ok">자동입력</span>'}
        <span class="inline-num"><input type="number" id="inConv" step="0.1" min="1" max="12" value="${(conv * 100).toFixed(1)}"><em>%</em></span></label>
      <div class="srcline">법정 전환율이 아닌 지역 시장 전환율 기준</div>
    </div></div>
    ${liveExtra}`;
  $('inConv').addEventListener('input', () => {
    const n = Number($('inConv').value) / 100;
    const base = state.liveSel ? state.liveSel.region.conv : (state.manual ? F.defaultConversionRate : (cx.conversionRate || F.defaultConversionRate));
    state.ovConv = (n > 0.01 && Math.abs(n - base) > 1e-6) ? n : null;
  });
  if (isLive) {
    const bindE = (id, key) => { const el = $(id); if (!el) return; el.addEventListener('input', () => { state.autoEdits[key] = Number(el.value) || 0; nav(); }); };
    bindE('edHH', 'households'); bindE('edSupply', 'supplyNext3yAvg');
    $('edRedev').addEventListener('change', () => { state.autoEdits.redevStage = $('edRedev').value || null; nav(); });
    const syncStation = () => {
      const name = $('edStName').value.trim();
      const min = Number($('edStMin').value) || 0;
      if (name && STN.stations[name]) state.autoEdits.station = { st: name, min: min > 0 ? min : 8 };
      else if (!name) state.autoEdits.station = null;
      nav();
    };
    $('edStName').addEventListener('change', syncStation);
    $('edStName').addEventListener('blur', syncStation);
    $('edStMin').addEventListener('input', () => { if (state.autoEdits.station) { state.autoEdits.station.min = Number($('edStMin').value) || 8; } else syncStation(); });
  }
}

/* ── 분석 실행 ── */
function buildInput() {
  const cx = getComplex();
  const overrides = {};
  if (state.ovPrice != null) overrides.price = state.ovPrice;
  if (state.ovJeonse != null) overrides.jeonse = state.ovJeonse;
  return {
    complex: cx,
    areaKey: state.manual ? 'M' : state.areaKey,
    asOfYM: state.liveSel ? liveAsOf() : DATA.meta.asOf,
    overrides, manualComplex: state.manual, autoComplex: !!state.liveSel
  };
}

function runAnalysis() {
  go(3);
  $('report').innerHTML = ''; $('loading').style.display = 'block';
  state.stress = new Set();
  setTimeout(() => {
    try {
      state.baseInput = buildInput();
      state.result = AptEngine.analyze(state.baseInput, CFG, HUBS, JOBS, STN);
      $('loading').style.display = 'none';
      renderReport(state.result);
    } catch (e) {
      $('loading').style.display = 'none';
      $('report').innerHTML = `<div class="warnbox"><b>분석 불가</b> — ${esc(e.message)}</div>`;
    }
  }, 700);
}

/* ── 등급 헬퍼 ── */
function gradeCls(score) { const B = CFG.scores.gradeBands; return score >= B.high ? 'A' : score >= B.mid ? 'B' : 'C'; }
function verdictBadge(pos) {
  if (pos.includes('하단 아래')) return ['green', pos + ' — 지표상 저평가 신호'];
  if (pos.includes('하단')) return ['green', pos];
  if (pos.includes('중앙')) return ['blue', pos];
  if (pos.includes('상단 위')) return ['', pos + ' — 프리미엄 구간'];
  return ['amber', pos];
}

/* ── 결과 렌더 ── */
function renderReport(r) {
  const cx = r.cx, area = r.area;
  const isLive = !!state.liveSel;
  const [vbCls, vbText] = verdictBadge(r.scores.attract.positionLabel);
  const conf = r.confidence;
  const S = DATA.defaultSources;

  const lo0 = Math.min(r.range.low, r.currentPrice), hi0 = Math.max(r.range.high, r.currentPrice);
  const span = hi0 - lo0 || 1;
  const dLo = lo0 - span * 0.18, dHi = hi0 + span * 0.18;
  const pos = x => ((x - dLo) / (dHi - dLo) * 100).toFixed(1);

  const tiles = [
    { k: '주거가치', v: Math.round(r.scores.living.total), s: '실제 거주하기 좋은가', id: 'accC' },
    { k: '투자가치', v: Math.round(r.scores.invest.total), s: '자산으로 보유할 경쟁력', id: 'accI' },
    { k: '가격매력도', v: r.scores.attract.score, s: '장점을 감안해도 지금 싼가', id: 'accP' }
  ];

  const contribRows = r.explain.contrib.map(c => {
    const w = Math.min(50, Math.abs(c.v) / 40 * 50);
    return `<div class="cr"><div class="ck">${esc(c.k)}</div>
      <div class="cbar"><span class="mid"></span><i class="${c.v >= 0 ? 'pos' : 'neg'}" style="width:${w}%"></i></div>
      <div class="cv">${c.v >= 0 ? '+' : ''}${Math.round(c.v)}</div></div>`;
  }).join('');

  const sbRow = (k, v) => `<div class="sb"><div class="k">${k}</div><div class="sbar"><i style="width:${Math.round(v)}%"></i></div><div class="v">${Math.round(v)}</div></div>`;

  const compRows = r.market.comps.slice().sort((a, b) => b.w - a.w).slice(0, 8).map(c =>
    `<tr><td>${c.ym}</td><td>${esc(c.label)}</td><td>${fmtEok(c.raw)}</td><td>${fmtEok(c.v)}</td><td>${(c.w * 100).toFixed(0)}%</td></tr>`).join('');

  const fin = r.financial, sup = r.supplyE, opt = r.option, hd = r.hedonic, ed = hd.eduDetail;

  const srcRows = isLive
    ? `<div class="kv"><span>국토교통부 실거래가 공개 API (매매·전월세 자동수집)</span><span>${esc(liveAsOf())} 기준</span></div>
       <div class="kv"><span>입지·수급 간이 기본값 (pipeline/regions.json)</span><span>${esc(REGIONS.asOf)} 기준</span></div>`
    : Object.values(S).map(s => `<div class="kv"><span>${esc(s.src)}</span><span>${esc(s.asOf)} 기준</span></div>`).join('');

  $('report').innerHTML = `
  <div class="hero">
    <div class="aptname">${esc(cx.name)} <span style="font-weight:500;color:var(--muted);font-size:13px">${esc(area.label)}</span></div>
    <div class="aptsub">${esc(cx.city)} ${esc(cx.district)} ${esc(cx.dong)} · ${cx.builtYear}년 · ${cx.households.toLocaleString()}세대${isLive ? ' · 실거래 자동수집' : ''}</div>
    <div class="duo">
      <div><div class="k">현재 시장가격</div><div class="big">${fmtEokW(r.currentPrice)}</div></div>
      <div><div class="k">모델 적정가치</div><div class="big accent">${fmtEok(r.range.low)} ~ ${fmtEokW(r.range.high)}</div></div>
    </div>
    <div class="rangeviz">
      <div class="rv-band">
        <div class="rv-rail"></div>
        <div class="rv-fill" style="left:${pos(r.range.low)}%;width:${(pos(r.range.high) - pos(r.range.low)).toFixed(1)}%"></div>
        <div class="rv-center" style="left:${pos(r.combineOut.center)}%"></div>
        <div class="rv-price" style="left:${pos(r.currentPrice)}%" title="현재 가격"></div>
      </div>
      <div class="rv-labels"><span>${fmtEok(r.range.low)}</span><span>적정범위 (중앙 ${fmtEok(r.combineOut.center)})</span><span>${fmtEok(r.range.high)}</span></div>
      <div class="rv-cap">● 현재 가격 위치</div>
    </div>
    <div class="chiprow">
      <span class="badge ${vbCls}">${vbText}</span>
      <span class="badge gray">신뢰도 ${conf.label}</span>
    </div>
    <div class="conf">최근 동일평형 비교거래 ${r.market.compCount}건 · 데이터 충족률 ${(r.fillRate * 100).toFixed(0)}% · 신뢰도 점수 ${conf.score}/100${r.dataStatus ? ` · 확인 ${r.dataStatus.VERIFIED} / 수동 ${r.dataStatus.MANUAL} / 추정 ${r.dataStatus.ESTIMATED} / 미확인 ${r.dataStatus.UNKNOWN}` : ''}</div>
  </div>

  <div class="card">
    <h2>핵심 진단</h2>
    <p class="hint">좋은 아파트와 싼 아파트는 다른 개념입니다 — 세 점수를 분리해 보세요. 점수를 누르면 상세 근거로 이동합니다.</p>
    <div class="tiles3">
      ${tiles.map(t => { const g = gradeCls(t.v); return `<button class="t3" data-acc="${t.id}">
        <div class="k">${t.k}</div><div class="v g${g}">${t.v}<em> / 100</em></div>
        <div class="bar"><i class="bg${g}" style="width:${t.v}%"></i></div><div class="s">${t.s}</div></button>`; }).join('')}
    </div>
    ${isLive ? '<p class="subtle" style="margin-top:10px">실거래 자동수집 단지는 가격·전세는 실데이터, 입지·상품 상세는 기본값 기반입니다. 주거가치·투자가치는 참고 수준으로 보고, 보완 정보를 입력할수록 정확해집니다.</p>' : ''}
  </div>

  ${r.transit ? (() => {
    const t = r.transit, p = t.primary;
    const totalStn = Object.keys(STN.stations).length;
    const goldenRows = p.lines.map(ln => { const L = LINEI.lines.find(x => x.name === ln); return L ? `<span class="badge gray" style="border-color:${L.color};color:var(--ink)"><i style="width:8px;height:8px;border-radius:50%;background:${L.color};display:inline-block"></i>${esc(ln)} 황금노선 지수 ${L.golden}</span>` : ''; }).join(' ');
    let hopViz = '';
    for (const ln of p.lines) {
      const le = RAIL_LINES.find(x => x.name === ln && !x.overlay && x.stations.includes(p.st));
      if (!le) continue;
      const i = le.stations.indexOf(p.st);
      const trio = [le.stations[i - 1], p.st, le.stations[i + 1]].filter(Boolean);
      hopViz = `<h3 class="mini-h">한 정거장의 가치 (${esc(ln)})</h3><div class="hopviz">${trio.map(s => { const d = STN.stations[s]; return `<div class="hop ${s === p.st ? 'cur' : ''}"><div class="hn">${esc(s)}</div><div class="hv">${d ? Math.round(d.sv) : '—'}</div><div class="hs">Station Value</div></div>`; }).join('')}</div>`;
      break;
    }
    let sentence;
    if (t.bonus > 0.01 && t.bonusNotes.length) sentence = `단순한 복수 역세권이 아니라, ${t.bonusNotes[0]} — 서로 다른 생활권을 실제로 확장하는 구성이라 추가 가치를 인정했습니다.`;
    else if (t.secondary) sentence = `두 개 역을 이용할 수 있지만 접근 가능한 업무지가 크게 겹쳐, 가장 강한 역(${esc(p.st)}) 중심으로 평가했습니다 — 노선 개수가 아니라 새로 열리는 목적지가 기준입니다.`;
    else if (p.express) sentence = `${esc(p.st)}은(는) 급행·광역 노선이 정차해 단일 노선임에도 주요 업무지 도달력이 높게 평가됐습니다.`;
    else sentence = `${esc(p.st)}의 힘(업무지 접근·네트워크·목적지가치)과 도보 ${p.min}분 거리를 함께 반영한 평가입니다.`;
    const sb = (k, v) => `<div class="sb"><div class="k">${k}</div><div class="sbar"><i style="width:${Math.round(v)}%"></i></div><div class="v">${Math.round(v)}</div></div>`;
    return `<div class="card" id="transitCard">
    <h2>교통 가치 분석 <span style="font-size:14px;color:var(--accent)">${Math.round(r.hedonic.subs.transport)} / 100</span></h2>
    <p class="hint">"역세권인가?"가 아니라 "얼마나 강력한 역을 얼마나 가까이 이용하는가"를 평가합니다.</p>
    <div class="tiles3" style="grid-template-columns:1fr 1fr">
      <div class="t3" style="cursor:default"><div class="k">가장 강력한 역 — 내 역의 힘</div>
        <div class="v">${esc(p.st)} <em>${p.lines.map(esc).join(' · ')}</em></div>
        <div class="s">Station Value <b>${p.sv}</b> / 100 · 수도권 ${totalStn}개 역 중 <b>${p.rank}위 (상위 ${p.rankPct}%)</b> · 도보 ${p.min}분${p.status === 'ESTIMATED' ? ' <span class="stat est">추정</span>' : p.status === 'MANUAL' ? ' <span class="stat ok">확인</span>' : ''}</div></div>
      <div class="t3" style="cursor:default"><div class="k">강남 핵심 접근</div>
        <div class="v g${gradeCls(t.gangnamScore)}">${t.gangnamScore}<em> / 100</em></div>
        <div class="s">${esc(p.st)}에서 강남권 약 ${t.gangnamMin}분</div></div>
    </div>
    <h3 class="mini-h">역 가치 구성</h3>
    ${sb('업무지 접근성', p.comps.job)}${sb('네트워크 연결성', p.comps.net)}${sb('역 목적지가치', p.comps.dest)}${sb('역세권 경제활동', p.comps.econ)}
    <div class="chips" style="margin-top:10px">${goldenRows}
      <span class="badge blue">Station Wealth ${p.wealth} — 참고용(가치평가 미사용)</span></div>
    ${hopViz}
    <div class="op" style="margin-top:14px"><div class="ot">분석</div><p>${sentence}</p></div>
    <button class="btn ghost" id="openMapFromResult" style="width:100%;margin-top:8px">🚇 역 가치 지도에서 ${esc(p.st)}역 보기</button>
    <p class="subtle" style="margin-top:8px">역 가치는 그래프 이동시간·공개 데이터 기반 자동 계산(추정 포함)이며, 기존 교통점수를 대체할 뿐 별도 가산되지 않습니다.</p>
  </div>`; })() : ''}

  <div class="card">
    <h2>가격을 움직이는 요인</h2>
    <div class="factors">
      <div class="fbox up"><div class="fh">가격을 올리는 요인</div><ul>${r.explain.up.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>
      <div class="fbox down"><div class="fh">가격을 누르는 요인</div><ul>${r.explain.down.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>
    </div>
    <h3 class="mini-h">상대적 가치 기여도 <span style="font-weight:400">— 평균적 아파트(0) 대비, 개념적 지표이며 금액 분해가 아닙니다</span></h3>
    <div class="contrib">${contribRows}</div>
  </div>

  <div class="card">
    <h2>진단 요약</h2>
    <div class="diag core"><div class="dt">이 아파트의 핵심 경쟁력</div><p>${esc(r.explain.diagnosis.core)}</p></div>
    <div class="diag supp"><div class="dt">현재 가격을 지지하는 요소</div><p>${esc(r.explain.diagnosis.support)}</p></div>
    <div class="diag weak"><div class="dt">현재 가격의 취약점</div><p>${esc(r.explain.diagnosis.weakness)}</p></div>
    <div class="diag watch"><div class="dt">앞으로 볼 변수</div><p>${esc(r.explain.diagnosis.watch)}</p></div>
  </div>

  <div class="card">
    <h2>현재 가격에 대한 해석</h2>
    ${r.explain.interpretation.map(t => `<div class="op"><div class="ot">해석</div><p>${esc(t)}</p></div>`).join('')}
    ${opt.scenario ? `<div class="notebox"><b>미래 옵션가치 ${opt.gradeLabel}</b> — ${esc(opt.scenario)}${opt.note ? `<br>※ ${esc(opt.note)}` : ''}${opt.premiumNote ? `<br>※ ${esc(opt.premiumNote)}` : ''}</div>` : ''}
  </div>

  <div class="card" id="stressCard">
    <h2>스트레스 테스트</h2>
    <p class="hint">조건이 바뀌면 이 가격은 어떻게 되나 — 시나리오를 눌러 즉시 확인하세요. 복수 선택할 수 있습니다.</p>
    <div class="stressgrid" id="stressBtns">
      ${CFG.stress.presets.map(p => `<button class="sbtn" data-sid="${p.id}" aria-pressed="false">${esc(p.label)}</button>`).join('')}
      <button class="sreset" id="stressReset">초기화</button>
    </div>
    <div id="stressOut"></div>
  </div>

  <div class="card">
    <h2>상세 분석</h2>
    <p class="hint">다섯 개 엔진의 계산 근거를 각각 확인할 수 있습니다.</p>

    <details class="acc" id="accA"><summary><span class="sumleft">시장 상대가치 — 비교거래 앵커</span><span class="sumr">${fmtEok(r.market.value)}</span></summary><div class="detail-body">
      <div class="kv"><span>비교거래 가중중앙값</span><span>${fmtEokW(r.market.value)}</span></div>
      <div class="kv"><span>가중 25~75분위</span><span>${fmtEok(r.market.p25)} ~ ${fmtEokW(r.market.p75)}</span></div>
      <div class="kv"><span>비교거래 구성</span><span>동일평형 ${r.market.compCount}건 / 전체 ${r.market.compCountAll}건 (동일평형 비중 ${(r.market.compQuality * 100).toFixed(0)}%)</span></div>
      <p class="subtle">거래시점이 오래될수록 가중치를 절반씩 감소(반감기 ${CFG.market.compHalfLifeMonths}개월), 타평형·타단지는 면적·특성 보정 후 낮은 유사도로 반영합니다.</p>
      <div class="tblwrap"><table><thead><tr><th>시점</th><th>구분</th><th>거래가</th><th>보정가</th><th>가중치</th></tr></thead><tbody>${compRows}</tbody></table></div>
    </div></details>

    <details class="acc" id="accB"><summary><span class="sumleft">금융·임대 내재가치</span><span class="sumr">${fmtEok(fin.value)}</span></summary><div class="detail-body">
      <div class="kv"><span>연간 주거서비스 가치 R</span><span>${fmtEokW(fin.R)} <span class="srcline" style="display:inline">(${esc(fin.rSourceText)})</span></span></div>
      <div class="kv"><span>요구수익률 r</span><span>${fmtPct(fin.r)}</span></div>
      <div class="kv"><span>장기 임대가치 성장률 g</span><span>${fmtPct(fin.g)}</span></div>
      <div class="kv"><span>계산 방식</span><span>${fin.mode === 'gordon' ? 'V = R ÷ (r − g)' : `유한 DCF ${CFG.financial.dcfYears}년 (r−g 근접 가드)`}</span></div>
      <div class="kv"><span>임대 내재가치</span><span class="strong">${fmtEokW(fin.value)}</span></div>
      <div class="kv"><span>현재가 유지에 필요한 성장률 (역산)</span><span class="strong">연 ${fmtPct(fin.impliedG)}</span></div>
      <h3 class="mini-h">전세 = 자금조달 구조</h3>
      <div class="kv"><span>전세가율</span><span>${fmtPct(fin.jeonseRatio, 0)}</span></div>
      <div class="kv"><span>필요 자기자본 (매매가 − 전세가)</span><span>${fmtEokW(fin.equity)}</span></div>
      <div class="kv"><span>전세지지력</span><span class="strong">${r.support.label} (${r.support.score}점)</span></div>
      <p class="subtle">근거: ${r.support.factors.map(esc).join(' · ')}</p>
    </div></details>

    <details class="acc" id="accC"><summary><span class="sumleft">주거·입지·상품가치</span><span class="sumr">주거가치 ${Math.round(r.scores.living.total)}점</span></summary><div class="detail-body">
      ${sbRow('교통', hd.subs.transport)}${sbRow('직주근접', hd.subs.job)}${sbRow('교육', hd.subs.education)}${sbRow('생활편의', hd.subs.life)}${sbRow('자연환경', hd.subs.nature)}${sbRow('상품성', hd.subs.product)}
      <h3 class="mini-h">교육가치 상세</h3>
      ${sbRow('학교환경', ed.school)}${sbRow('학원가', ed.academy)}${sbRow('교육접근성', ed.access)}${sbRow('수요 지속성', ed.demand)}
      <p class="subtle">${esc(hd.notes.education.join(' / '))}</p>
      <h3 class="mini-h">근거 메모</h3>
      <ul style="margin:4px 0 0;padding-left:18px;font-size:12.5px;color:var(--ink2);line-height:1.7">
        ${['transport', 'job', 'life', 'nature', 'product'].map(k => (hd.notes[k] || []).map(x => `<li>${esc(x)}</li>`).join('')).join('')}
      </ul>
      <p class="subtle" style="margin-top:10px">겹치는 프리미엄(역세권·직주·학군 등)은 카테고리 안에서 점수화하고, 가격 반영은 카테고리별 상한(cap)과 총량 상한으로 제한해 중복가산을 막습니다. 동일단지 동일평형 실거래로 비교할 때는 이 조정이 이미 시장가격에 들어있다고 보고 잔차만 반영합니다(현재 잔차 ${signPct(r.combineOut.hRes)}).</p>
    </div></details>

    <details class="acc" id="accD"><summary><span class="sumleft">수요·공급·시장구조</span><span class="sumr">${sup.gradeLabel}</span></summary><div class="detail-body">
      ${sup.notes.map(x => `<div class="kv"><span style="flex:1">${esc(x)}</span><span></span></div>`).join('')}
      <div class="kv"><span>종합 공급부담 판정</span><span class="strong">${sup.gradeLabel}</span></div>
      <div class="kv"><span>가격 반영(제한적)</span><span>${signPct(sup.adj)}</span></div>
      <p class="subtle">간이 수요추정치(인구×${fmtPct(CFG.supply.demandRate, 1)})는 절대수요가 아닌 관행적 근사값입니다. 행정구역만이 아니라 인접 생활권·광역시장을 ${Math.round(CFG.supply.zoneWeights.local * 100)}:${Math.round(CFG.supply.zoneWeights.adjacent * 100)}:${Math.round(CFG.supply.zoneWeights.metro * 100)}으로 가중합니다.${isLive ? ' 자동수집 단지의 공급·인구는 시군구 간이 기본값입니다(STEP 2에서 수정 가능).' : ''}</p>
      <h3 class="mini-h">규제 효과 (양면)</h3>
      <div class="kv"><span>매수수요 압력</span><span style="text-align:left;flex:1.2">${esc(sup.regulation.demandSide)}</span></div>
      <div class="kv"><span>매물잠김 압력</span><span style="text-align:left;flex:1.2">${esc(sup.regulation.lockinSide)}</span></div>
    </div></details>

    <details class="acc" id="accE"><summary><span class="sumleft">미래 옵션가치</span><span class="sumr">${opt.gradeLabel}</span></summary><div class="detail-body">
      <div class="kv"><span>정비사업 단계</span><span>${opt.label}</span></div>
      <div class="kv"><span>단계별 실현확률 가정</span><span>${(opt.prob * 100).toFixed(0)}%</span></div>
      ${opt.headroom != null ? `<div class="kv"><span>용적률 여유</span><span>${cx.far}% → 허용 ${cx.allowedFar}% (+${(opt.headroom * 100).toFixed(0)}%)</span></div>` : ''}
      <div class="kv"><span>내재가치 보정(제한적)</span><span>${opt.premium > 0 ? '+' + fmtPct(opt.premium) : '금액 미반영'}</span></div>
      ${opt.scenario ? `<p class="subtle">${esc(opt.scenario)}</p>` : '<p class="subtle">현재 정비사업·리모델링 추진 단계가 아닙니다. 연식이 쌓이고 용적률 여유가 있으면 옵션가치가 생길 수 있습니다.</p>'}
      <p class="subtle">연식에 따른 상품성 감점과 재건축 옵션가치는 분리해 계산합니다.</p>
    </div></details>

    <details class="acc" id="accI"><summary><span class="sumleft">투자가치 구성</span><span class="sumr">${Math.round(r.scores.invest.total)}점</span></summary><div class="detail-body">
      ${sbRow('전세지지력', r.scores.invest.subs.jeonseSupport)}${sbRow('수급 구조', r.scores.invest.subs.supplyDemand)}${sbRow('희소성', r.scores.invest.subs.scarcity)}${sbRow('미래가치', r.scores.invest.subs.future)}${sbRow('핵심입지', r.scores.invest.subs.location)}${sbRow('유동성', r.scores.invest.subs.liquidity)}
    </div></details>

    <details class="acc" id="accP"><summary><span class="sumleft">가격매력도 산출</span><span class="sumr">${r.scores.attract.score}점</span></summary><div class="detail-body">
      <div class="kv"><span>모델 적정가치 (중앙)</span><span>${fmtEokW(r.combineOut.center)}</span></div>
      <div class="kv"><span>현재가의 프리미엄/할인</span><span class="strong">${signPct(r.scores.attract.premium)}</span></div>
      <div class="kv"><span>판단</span><span>${r.scores.attract.positionLabel}</span></div>
      <p class="subtle">결합 가중치: 시장앵커 ${(r.combineOut.wm * 100).toFixed(0)}% + 임대내재가치 ${(r.combineOut.wf * 100).toFixed(0)}% (두 모델의 괴리 ${fmtPct(r.combineOut.disagreement, 0)}만큼 내재가치 가중을 줄이고 범위를 넓힘${r.combineOut.anchorClamped ? ' · 시장앵커 ±' + fmtPct(CFG.final.anchorClamp, 0) + ' 클램프 적용' : ''}). 좋은 아파트라는 사실이 아니라, 그 장점을 감안한 뒤에도 가격이 싼지를 봅니다.</p>
    </div></details>

    <details class="acc" id="accConf"><summary><span class="sumleft">신뢰도 · 데이터 출처</span><span class="sumr">${conf.label} ${conf.score}/100</span></summary><div class="detail-body">
      ${conf.penalties.length ? `<ul style="margin:0;padding-left:18px;font-size:12.5px;color:var(--ink2);line-height:1.7">${conf.penalties.map(p => `<li>${esc(p)}</li>`).join('')}</ul>` : '<p class="subtle">감점 요인이 없습니다.</p>'}
      ${r.dataStatus ? `<h3 class="mini-h">자동 데이터 상태</h3>
      <div class="chips">
        <span class="stat ok">확인(VERIFIED) ${r.dataStatus.VERIFIED}</span>
        <span class="stat info">수동 입력(MANUAL) ${r.dataStatus.MANUAL}</span>
        <span class="stat est">추정(ESTIMATED) ${r.dataStatus.ESTIMATED}</span>
        <span class="stat" style="color:var(--muted);background:var(--raised);border:1px solid var(--line)">미확인(UNKNOWN) ${r.dataStatus.UNKNOWN}</span>
      </div>
      <p class="subtle">미확인 항목은 실제 값처럼 계산하지 않고 중립 처리하며, 그만큼 신뢰도를 낮춰 표시합니다.</p>` : ''}
      ${r.gaps.length ? `<p class="subtle">데이터 공백: ${r.gaps.map(esc).join(' · ')}</p>` : ''}
      <h3 class="mini-h">데이터 출처·기준일</h3>
      ${srcRows}
      <div class="kv"><span>금리·계수 설정</span><span>${esc(CFG.asOf)} 기준 (config)</span></div>
      ${isLive ? '' : `<p class="subtle">${esc(DATA.meta.notice)}</p>`}
    </div></details>
  </div>

  <div class="card" id="cmpCard">
    <h2>다른 단지와 비교</h2>
    <p class="hint">같은 돈으로 무엇을 사는 것인지 — 상세 프로필 단지와 나란히 봅니다.</p>
    <div class="grid2">
      <div><label class="mini">비교 단지<select id="cmpSel"><option value="">선택하세요</option>${DATA.complexes.filter(c => c.id !== cx.id).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label></div>
      <div><label class="mini">평형<select id="cmpArea" disabled></select></label></div>
    </div>
    <div id="cmpOut"></div>
  </div>

  <div class="warnbox"><b>이 결과를 읽는 법</b> — 본 진단은 미래 집값 예측이 아니라, 현재 가격이 어떤 요인으로 설명되며 어떤 조건이 무너지면 취약해지는지 이해를 돕는 도구입니다. 적정가치는 범위로만 제시하며, 개별 동·층·향·내부상태는 반영되지 않습니다. 투자 권유가 아닙니다.</div>`;

  $('report').querySelectorAll('.t3[data-acc]').forEach(b => b.onclick = () => {
    const acc = $(b.dataset.acc); if (!acc) return;
    acc.open = true; acc.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  const omr = $('openMapFromResult');
  if (omr && r.transit) omr.onclick = () => openMap(r.transit.primary.st);

  $('stressBtns').querySelectorAll('.sbtn').forEach(b => b.onclick = () => {
    const id = b.dataset.sid;
    const preset = CFG.stress.presets.find(p => p.id === id);
    if (state.stress.has(id)) state.stress.delete(id);
    else {
      (preset.excludes || []).forEach(x => state.stress.delete(x));
      state.stress.add(id);
    }
    $('stressBtns').querySelectorAll('.sbtn').forEach(x => x.setAttribute('aria-pressed', state.stress.has(x.dataset.sid) ? 'true' : 'false'));
    renderStress();
  });
  $('stressReset').onclick = () => {
    state.stress.clear();
    $('stressBtns').querySelectorAll('.sbtn').forEach(x => x.setAttribute('aria-pressed', 'false'));
    renderStress();
  };

  $('cmpSel').onchange = () => {
    const c2 = DATA.complexes.find(c => c.id === $('cmpSel').value);
    const sel = $('cmpArea');
    if (!c2) { sel.innerHTML = ''; sel.disabled = true; $('cmpOut').innerHTML = ''; return; }
    sel.innerHTML = c2.areas.map(a => `<option value="${a.key}">${esc(a.label)}</option>`).join('');
    sel.disabled = false; renderCompare();
  };
  $('cmpArea').onchange = renderCompare;
}

/* ── 스트레스 렌더 ── */
function renderStress() {
  const out = $('stressOut');
  if (!state.stress.size) { out.innerHTML = ''; return; }
  const ids = Array.from(state.stress);
  let sr;
  try { sr = AptEngine.applyStress(state.baseInput, ids, CFG, HUBS, JOBS, STN); }
  catch (e) { out.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; return; }
  const b = state.result;
  const dArrow = (a, c) => {
    const d = c - a;
    if (Math.abs(d) < 0.05) return '<span style="color:var(--muted)">변화 없음</span>';
    const up = d > 0;
    return `<span class="${up ? 'd-up' : 'd-down'}">${up ? '▲' : '▼'} ${Math.abs(d) < 1 ? Math.abs(d).toFixed(1) : Math.round(Math.abs(d))}</span>`;
  };
  const labels = ids.map(id => CFG.stress.presets.find(p => p.id === id).label).join(' + ');
  out.innerHTML = `
    <div class="notebox" style="margin-top:14px"><b>시나리오: ${esc(labels)}</b></div>
    <div class="tblwrap"><table class="deltatbl">
      <thead><tr><th>지표</th><th>기본</th><th>시나리오</th><th>변화</th></tr></thead><tbody>
      <tr><td>적정가치 범위</td><td>${fmtEok(b.range.low)}~${fmtEok(b.range.high)}</td><td class="strong">${fmtEok(sr.range.low)}~${fmtEok(sr.range.high)}</td><td class="delta">${dArrow(b.combineOut.center, sr.combineOut.center)}억</td></tr>
      <tr><td>가격 판단</td><td>${b.scores.attract.positionLabel}</td><td class="strong">${sr.scores.attract.positionLabel}</td><td></td></tr>
      <tr><td>가격매력도</td><td>${b.scores.attract.score}</td><td class="strong">${sr.scores.attract.score}</td><td class="delta">${dArrow(b.scores.attract.score, sr.scores.attract.score)}</td></tr>
      <tr><td>투자가치</td><td>${Math.round(b.scores.invest.total)}</td><td class="strong">${Math.round(sr.scores.invest.total)}</td><td class="delta">${dArrow(b.scores.invest.total, sr.scores.invest.total)}</td></tr>
      <tr><td>전세지지력</td><td>${b.support.label}</td><td class="strong">${sr.support.label}</td><td></td></tr>
      <tr><td>임대 내재가치</td><td>${fmtEok(b.financial.value)}</td><td class="strong">${fmtEok(sr.financial.value)}</td><td class="delta">${dArrow(b.financial.value, sr.financial.value)}억</td></tr>
      <tr><td>필요 성장률(역산)</td><td>${fmtPct(b.financial.impliedG)}</td><td class="strong">${fmtPct(sr.financial.impliedG)}</td><td></td></tr>
      </tbody></table></div>
    <p class="subtle">시나리오는 해당 변수만 바꾼 조건부 재계산입니다. 실제 시장에서는 변수들이 함께 움직일 수 있습니다.</p>`;
}

/* ── 비교 렌더 ── */
function renderCompare() {
  const c2 = DATA.complexes.find(c => c.id === $('cmpSel').value);
  if (!c2) return;
  const areaKey = $('cmpArea').value || c2.areas[0].key;
  let r2;
  try { r2 = AptEngine.analyze({ complex: c2, areaKey, asOfYM: DATA.meta.asOf, overrides: {} }, CFG, HUBS, JOBS, STN); }
  catch (e) { $('cmpOut').innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; return; }
  const a = state.result, b = r2;
  const row = (k, va, vb, strong) => `<tr><td>${k}</td><td${strong ? ' class="strong"' : ''}>${va}</td><td${strong ? ' class="strong"' : ''}>${vb}</td></tr>`;
  const diff = b.currentPrice - a.currentPrice;
  let sentence;
  const dl = Math.round(b.scores.living.total - a.scores.living.total);
  const di = Math.round(b.scores.invest.total - a.scores.invest.total);
  const nm = x => `<b>${esc(x.cx.name)}</b>`;
  if (Math.abs(diff) < 0.05) sentence = `두 단지의 현재 가격이 비슷합니다. 주거가치 ${dl >= 0 ? '+' : ''}${dl} · 투자가치 ${di >= 0 ? '+' : ''}${di} 차이로 판단해 보세요.`;
  else {
    const hi = diff > 0 ? b : a, lo2 = diff > 0 ? a : b;
    const hl = Math.round(hi.scores.living.total - lo2.scores.living.total);
    const hv = Math.round(hi.scores.invest.total - lo2.scores.invest.total);
    sentence = `${fmtEok(Math.abs(diff))}을 더 주고 ${nm(hi)}를 선택한다면 — 주거가치 ${hl >= 0 ? '+' : ''}${hl}점, 투자가치 ${hv >= 0 ? '+' : ''}${hv}점의 차이에 값을 지불하는 셈입니다. `;
    const optEdge = hi.option.gradeIdx <= 1 && lo2.option.gradeIdx >= 2;
    if (optEdge) sentence += `점수 차이보다도, 정비사업 기대(미래 옵션 ${hi.option.gradeLabel})가 이 프리미엄의 큰 부분을 설명합니다 — 사업 지연 시나리오의 변동성도 함께 고려하세요.`;
    else if (hl <= 0 && hv <= 0) sentence += '지표상으로는 추가 지불의 근거가 뚜렷하지 않습니다 — 개별 요인(동·층·향, 실물 상태)을 확인하세요.';
    else if (hi.scores.attract.score < lo2.scores.attract.score - 8) sentence += `다만 가격매력도는 ${nm(lo2)} 쪽이 높아, 프리미엄의 상당 부분이 이미 가격에 반영되어 있습니다.`;
    else if (hl + hv <= 8) sentence += '지표상 점수 차이는 크지 않습니다 — 희소성·상징성 등 지표 밖 프리미엄에 값을 지불하는 것인지 확인해 보세요.';
    else sentence += '점수 차이가 가격 차이를 상당 부분 뒷받침합니다.';
  }
  $('cmpOut').innerHTML = `
    <div class="tblwrap"><table>
      <thead><tr><th></th><th>${esc(a.cx.name)} ${esc(a.area.key)}㎡</th><th>${esc(b.cx.name)} ${esc(b.area.key)}㎡</th></tr></thead><tbody>
      ${row('현재 가격', fmtEokW(a.currentPrice), fmtEokW(b.currentPrice), true)}
      ${row('적정가치 범위', `${fmtEok(a.range.low)}~${fmtEok(a.range.high)}`, `${fmtEok(b.range.low)}~${fmtEok(b.range.high)}`)}
      ${row('가격 판단', a.scores.attract.positionLabel, b.scores.attract.positionLabel)}
      ${row('주거가치', Math.round(a.scores.living.total), Math.round(b.scores.living.total))}
      ${row('투자가치', Math.round(a.scores.invest.total), Math.round(b.scores.invest.total))}
      ${row('가격매력도', a.scores.attract.score, b.scores.attract.score)}
      ${row('전세지지력', a.support.label, b.support.label)}
      ${row('수급', a.supplyE.gradeLabel, b.supplyE.gradeLabel)}
      ${row('미래 옵션', a.option.gradeLabel, b.option.gradeLabel)}
      ${row('신뢰도', a.confidence.label, b.confidence.label)}
      </tbody></table></div>
    <div class="op"><div class="ot">비교 해석</div><p>${sentence}</p></div>`;
}

/* ═══════════════ 역 가치 지도 (Station Intelligence 시각화) ═══════════════ */
const mapState = { built: false, mode: 'sv', line: null, sel: null, netPct: {} };

function openMap(focusStation) {
  document.querySelectorAll('.step').forEach(s => s.dataset.wasHidden = s.hidden ? '1' : '0');
  $('step1').hidden = $('step2').hidden = $('step3').hidden = true;
  $('stepper').style.display = 'none'; $('bottnav').style.display = 'none';
  $('mapView').hidden = false;
  if (!mapState.built) buildMap();
  if (focusStation && STN.stations[focusStation]) selectStation(focusStation);
  window.scrollTo({ top: 0 });
}
function closeMap() {
  $('mapView').hidden = true;
  $('stepper').style.display = ''; $('bottnav').style.display = '';
  document.querySelectorAll('.step').forEach(s => { s.hidden = s.dataset.wasHidden !== '0'; });
  window.scrollTo({ top: 0 });
}
$('mapBtn').onclick = () => openMap();
$('mapBack').onclick = closeMap;

function metricOf(s) { return mapState.mode === 'sv' ? s.sv : s.wealth; }

function buildMap() {
  mapState.built = true;
  // 네트워크 백분위 (교통 대비 가격 콘텐츠용)
  const entries = Object.entries(STN.stations);
  const netSorted = entries.slice().sort((a, b) => a[1].comps.net - b[1].comps.net);
  netSorted.forEach(([n], i) => { mapState.netPct[n] = Math.round((i + 1) / netSorted.length * 100); });

  // 노선 칩
  $('lineChips').innerHTML = `<button class="lchip" data-line="" aria-pressed="true">전체</button>` +
    LINEI.lines.map(l => `<button class="lchip" data-line="${esc(l.name)}" aria-pressed="false"><i style="background:${l.color}"></i>${esc(l.name)} ${l.golden}</button>`).join('');
  $('lineChips').querySelectorAll('.lchip').forEach(b => b.onclick = () => {
    mapState.line = b.dataset.line || null;
    $('lineChips').querySelectorAll('.lchip').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    drawMap(); renderLineCard(); renderRank();
  });
  $('mapMode').querySelectorAll('button').forEach(b => b.onclick = () => {
    mapState.mode = b.dataset.v;
    $('mapMode').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    $('mapHint').textContent = mapState.mode === 'sv'
      ? '역 가치(Station Value) — 업무지 접근·목적지·네트워크·경제활동으로 자동 계산. 아파트 교통가치 평가에 쓰이는 지표입니다.'
      : '역세권 경제력(Station Wealth) — 역 주변 주거 자산 수준의 추정 지표. 참고용 콘텐츠이며 아파트 가치평가에는 사용하지 않습니다.';
    drawMap(); renderRank();
    if (mapState.sel) selectStation(mapState.sel);
  });
  drawMap(); renderRank();
}

function drawMap() {
  const names = Object.keys(STN.stations).filter(n => STN.stations[n].c);
  const lats = names.map(n => STN.stations[n].c[0]), lngs = names.map(n => STN.stations[n].c[1]);
  const laMin = Math.min(...lats), laMax = Math.max(...lats), loMin = Math.min(...lngs), loMax = Math.max(...lngs);
  const W = 700, kx = 0.793;   // cos(37.5°) 근사 — 경도 축척 보정
  const H = Math.round(W * (laMax - laMin) / ((loMax - loMin) * kx));
  const pad = 26;
  const X = lng => pad + (lng - loMin) / (loMax - loMin) * (W - pad * 2);
  const Y = lat => pad + (laMax - lat) / (laMax - laMin) * (H - pad * 2);

  const lineOn = mapState.line;
  const lineStations = new Set();
  let paths = '';
  for (const le of RAIL_LINES) {
    if (le.overlay) continue;
    const hi = lineOn && le.name === lineOn;
    if (hi) le.stations.forEach(s => lineStations.add(s));
    const pts = le.stations.filter(s => STN.stations[s] && STN.stations[s].c)
      .map(s => `${X(STN.stations[s].c[1]).toFixed(1)},${Y(STN.stations[s].c[0]).toFixed(1)}`).join(' ');
    paths += `<polyline class="lpath ${hi ? 'hi' : ''}" stroke="${le.color}" points="${pts}"${le.loop ? '' : ''}></polyline>`;
  }

  const ranked = names.slice().sort((a, b) => metricOf(STN.stations[b]) - metricOf(STN.stations[a]));
  const labelSet = new Set(ranked.slice(0, 22));
  if (lineOn) [...lineStations].forEach(s => labelSet.add(s));
  if (mapState.sel) labelSet.add(mapState.sel);

  let dots = '';
  for (const n of ranked.slice().reverse()) {
    const s = STN.stations[n];
    const v = metricOf(s);
    const x = X(s.c[1]).toFixed(1), y = Y(s.c[0]).toFixed(1);
    const rr = (2 + Math.pow(v / 100, 1.7) * 10).toFixed(1);
    const dim = lineOn && !lineStations.has(n);
    const op = (0.25 + v / 100 * 0.72).toFixed(2);
    dots += `<g class="stn ${dim ? 'dim' : ''} ${mapState.sel === n ? 'sel' : ''}" data-st="${esc(n)}">
      <circle cx="${x}" cy="${y}" r="${rr}" fill="var(--accent)" fill-opacity="${op}"></circle>
      ${labelSet.has(n) && !dim ? `<text class="slabel ${v >= 70 ? 'hi' : ''}" x="${x}" y="${(y - rr - 2.5)}" text-anchor="middle">${esc(n)}${lineOn ? ' ' + Math.round(v) : ''}</text>` : ''}
    </g>`;
  }
  $('mapBox').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="역 가치 지도">${paths}${dots}</svg>`;
  $('mapLegend').innerHTML = `<span>● 크기·진하기 = ${mapState.mode === 'sv' ? 'Station Value' : 'Station Wealth'}</span><span>좌표는 근사값(개념도)</span><span>역 ${names.length}개 · 자동 계산 (${esc(STN.meta.updatedAt)})</span>`;
  $('mapBox').querySelectorAll('.stn').forEach(g => g.onclick = () => selectStation(g.dataset.st));
}

function selectStation(name) {
  mapState.sel = name;
  drawMap();
  const s = STN.stations[name];
  if (!s) return;
  const total = Object.keys(STN.stations).length;
  const sb = (k, v) => `<div class="sb"><div class="k">${k}</div><div class="sbar"><i style="width:${Math.round(v)}%"></i></div><div class="v">${Math.round(v)}</div></div>`;
  // 한 정거장 비교
  let hop = '';
  for (const le of RAIL_LINES) {
    if (le.overlay || !le.stations.includes(name)) continue;
    const i = le.stations.indexOf(name);
    const trio = [le.stations[i - 1], name, le.stations[i + 1]].filter(Boolean);
    hop += `<h3 class="mini-h">한 정거장의 가치 — ${esc(le.name)}</h3><div class="hopviz">${trio.map(x => { const d = STN.stations[x]; return `<div class="hop ${x === name ? 'cur' : ''}"><div class="hn">${esc(x)}</div><div class="hv">${d ? Math.round(d.sv) : '—'}</div><div class="hs">SV</div></div>`; }).join('')}</div>`;
    if (hop.split('hopviz').length > 2) break;
  }
  // 교통 대비 상대가치 (§36 — 콘텐츠 전용)
  let rel = '';
  if (s.areaPriceLevel != null) {
    const netP = mapState.netPct[name] ?? 50;
    const diff = netP - s.areaPriceLevel;
    let msg;
    if (diff >= 20) msg = '역 네트워크 가치 대비 주변 주택가격 수준이 낮습니다 — 교통 대비 상대적으로 저렴한 생활권입니다.';
    else if (diff <= -20) msg = '주변 주택가격 수준이 역 네트워크 가치보다 높습니다 — 이 지역의 가격은 교통보다 학군·환경·신축·희소성 등의 영향이 더 큰 것으로 보입니다.';
    else msg = '역 네트워크 가치와 주변 주택가격 수준이 대체로 부합합니다.';
    rel = `<h3 class="mini-h">교통 대비 가격 (참고 콘텐츠)</h3>
      ${sb('역 네트워크 가치', netP)}${sb('주변 주택가격 수준', s.areaPriceLevel)}
      <p class="subtle">${msg} ※ 실거래 기반 백분위 비교이며 아파트 가치평가에는 사용하지 않습니다.</p>`;
  }
  $('stnCard').hidden = false;
  $('stnCard').innerHTML = `
    <div class="stnhead"><b>${esc(name)}</b>
      <span>${s.lines.map(esc).join(' · ')}${s.express ? ' · 급행/광역' : ''}</span></div>
    <div class="tiles3" style="grid-template-columns:1fr 1fr;margin-top:10px">
      <div class="t3" style="cursor:default"><div class="k">Station Value</div><div class="v g${gradeCls(s.sv)}">${Math.round(s.sv)}<em> /100</em></div><div class="s">수도권 ${total}개 역 중 ${s.rank}위 · 상위 ${s.rankPct}%</div></div>
      <div class="t3" style="cursor:default"><div class="k">Station Wealth <span class="stat info" style="margin-left:2px">참고용</span></div><div class="v">${s.wealth}<em> /100</em></div><div class="s">역세권 경제력 추정 — 가치평가 미사용</div></div>
    </div>
    ${sb('업무지 접근성', s.comps.job)}${sb('네트워크 연결성', s.comps.net)}${sb('목적지가치', s.comps.dest)}${sb('경제활동', s.comps.econ)}
    <div class="kv"><span>강남 핵심 업무지</span><span>약 ${s.gangnamMin}분</span></div>
    ${hop}${rel}`;
  $('stnCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderLineCard() {
  const nm = mapState.line;
  if (!nm) { $('lineCard').hidden = true; return; }
  const L = LINEI.lines.find(x => x.name === nm);
  if (!L) { $('lineCard').hidden = true; return; }
  const strengths = [];
  if (L.centersOnLine.length) strengths.push(`${L.centersOnLine.join('·')} 업무지 직접 연결`);
  strengths.push(`상위 역 평균 ${L.top20} (${L.topStations.slice(0, 3).map(s => s.n).join('·')})`);
  if (L.util >= 60) strengths.push('노선 전반의 네트워크 효용 높음');
  const weaknesses = [];
  if (L.stdev >= 12) weaknesses.push(`전체 역의 가치 편차가 큼(±${L.stdev}) — 같은 노선이라도 역마다 프리미엄이 다름`);
  if (L.avg < 45) weaknesses.push('노선 평균 접근성은 보통 이하 — 핵심 구간 위주로 평가 필요');
  if (!weaknesses.length) weaknesses.push('뚜렷한 구조적 약점 없음');
  $('lineCard').hidden = false;
  $('lineCard').innerHTML = `
    <h2><i style="width:10px;height:10px;border-radius:50%;background:${L.color};display:inline-block;margin-right:6px"></i>${esc(nm)} — 황금노선 지수 ${L.golden} / 100 <span style="font-size:12px;color:var(--muted)">(${LINEI.lines.findIndex(x => x.name === nm) + 1}위)</span></h2>
    <p class="hint">전체 역 평균 ${L.avg} · 상위 20% 역 평균 ${L.top20} · 네트워크 효용 ${L.util} · ${L.count}개 역 — 역 점수의 합이 아니라 가중 구조로 계산합니다.</p>
    <div class="factors">
      <div class="fbox up"><div class="fh">강점</div><ul>${strengths.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
      <div class="fbox down"><div class="fh">약점</div><ul>${weaknesses.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
    </div>`;
}

function renderRank() {
  const inLine = mapState.line ? new Set((RAIL_LINES.filter(l => l.name === mapState.line)).flatMap(l => l.stations)) : null;
  const names = Object.keys(STN.stations).filter(n => !inLine || inLine.has(n));
  const ranked = names.sort((a, b) => metricOf(STN.stations[b]) - metricOf(STN.stations[a])).slice(0, 15);
  $('rankCard').innerHTML = `
    <h2>${mapState.line ? esc(mapState.line) + ' 역 가치 순위' : (mapState.mode === 'sv' ? '수도권 역 가치 TOP 15' : '역세권 경제력 TOP 15')}</h2>
    <p class="hint">실제 계산 결과로 생성된 순위입니다 — 사전에 고정된 순위가 없습니다.${mapState.mode === 'wealth' ? ' 경제력 지표는 참고용 콘텐츠입니다.' : ''}</p>
    ${ranked.map((n, i) => { const s = STN.stations[n]; return `<div class="rankrow" data-st="${esc(n)}" style="cursor:pointer"><span class="rk ${i < 3 ? 'top' : ''}">${i + 1}</span><span class="nm">${esc(n)}</span><span class="ln">${s.lines.map(esc).join('·')}</span><span class="sc">${Math.round(metricOf(s))}</span></div>`; }).join('')}
    <p class="subtle" style="margin-top:10px">황금노선: ${LINEI.lines.slice(0, 5).map(l => `${esc(l.name)} ${l.golden}`).join(' · ')}</p>`;
  $('rankCard').querySelectorAll('.rankrow').forEach(row => row.onclick = () => selectStation(row.dataset.st));
}

/* ── 부팅 ── */
function renderVerLine() {
  const live = LIVE.status === 'ready'
    ? `실거래 자동 ${LIVE.index.meta.regions}개 지역 · ${LIVE.index.complexes.length.toLocaleString()}개 단지 (${LIVE.index.meta.updatedAt})`
    : '실거래 자동수집 연결 대기';
  $('verLine').textContent = `v${APP_VERSION} · ${live} · 상세 프로필 ${DATA.complexes.length}개 (${DATA.meta.asOf}) · 계수 ${CFG.asOf}`;
}
renderVerLine();
renderAptList('');
renderStepper(); nav();
loadLive();
