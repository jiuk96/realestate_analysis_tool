import {
  LOAN_PRODUCTS, analyzeCouple, won2eok, won2man, calcMonthlyPayment, personDsrLoan,
  splitParentSupport, maxFamilyLoanFor,
  LEGAL_BASIS, FAMILY_LOAN, REFERENCES, LOAN_RATE_SOURCES, GIFT_TAX_TABLE,
  JEONSE_LOAN_PRODUCTS, calcJeonseBroker, jeonseLoanFor, maxJeonseBudget, JEONSE_INSURE_RATE,
} from './financeCalculator.js';

/* ── 유틸 ──────────────────────────────────────────────── */
async function fetchJSON(url) {
  const r = await fetch(url);
  return r.json();
}

// composite_score/mdd_ranking/timeseries는 여러 화면(전체 1위, 동네별 추천 상세 모달)에서
// 공통으로 쓰이므로 한 번만 불러와 캐시한다.
let _scoreDataCache = null;
async function loadScoreData() {
  if (_scoreDataCache) return _scoreDataCache;
  const [comp, mdd, ts] = await Promise.all([
    fetchJSON('/api/composite_score'),
    fetchJSON('/api/mdd_ranking'),
    fetchJSON('/api/timeseries'),
  ]);
  _scoreDataCache = { comp, mdd, ts };
  return _scoreDataCache;
}

const fmt = n => n != null ? n.toLocaleString() : '—';
const fmtScore = v => v != null ? v.toFixed(1) : '—';

/* ── 서울 25개 구 GeoJSON 근사 폴리곤 (simplified bounds) ── */
const DISTRICT_POLYGONS = {
  "마포구":   [[37.572,126.879],[37.572,126.951],[37.534,126.951],[37.534,126.879]],
  "용산구":   [[37.546,126.963],[37.546,127.012],[37.520,127.012],[37.520,126.963]],
  "성동구":   [[37.574,127.017],[37.574,127.075],[37.540,127.075],[37.540,127.017]],
  "광진구":   [[37.561,127.065],[37.561,127.115],[37.530,127.115],[37.530,127.065]],
  "동대문구": [[37.598,127.025],[37.598,127.075],[37.568,127.075],[37.568,127.025]],
  "은평구":   [[37.638,126.886],[37.638,126.953],[37.600,126.953],[37.600,126.886]],
  "서대문구": [[37.590,126.921],[37.590,126.973],[37.557,126.973],[37.557,126.921]],
  "양천구":   [[37.540,126.848],[37.540,126.900],[37.510,126.900],[37.510,126.848]],
  "강서구":   [[37.572,126.808],[37.572,126.875],[37.530,126.875],[37.530,126.808]],
  "영등포구": [[37.536,126.877],[37.536,126.935],[37.508,126.935],[37.508,126.877]],
  "동작구":   [[37.522,126.931],[37.522,126.988],[37.494,126.988],[37.494,126.931]],
  "관악구":   [[37.493,126.928],[37.493,126.985],[37.462,126.985],[37.462,126.928]],
  "강동구":   [[37.569,127.120],[37.569,127.185],[37.531,127.185],[37.531,127.120]],
  "종로구":   [[37.610,126.960],[37.610,127.010],[37.571,127.010],[37.571,126.960]],
  // 나머지 11개 구 (서울 25개 구 전체 커버 — 실제 GeoJSON 로드 실패 시의 사각형 폴백용)
  "중구":     [[37.580,126.972],[37.580,127.024],[37.548,127.024],[37.548,126.972]],
  "중랑구":   [[37.626,127.064],[37.626,127.121],[37.586,127.121],[37.586,127.064]],
  "성북구":   [[37.609,126.989],[37.609,127.045],[37.569,127.045],[37.569,126.989]],
  "강북구":   [[37.660,127.000],[37.660,127.052],[37.620,127.052],[37.620,127.000]],
  "도봉구":   [[37.691,127.021],[37.691,127.073],[37.647,127.073],[37.647,127.021]],
  "노원구":   [[37.676,127.027],[37.676,127.087],[37.632,127.087],[37.632,127.027]],
  "구로구":   [[37.515,126.857],[37.515,126.917],[37.475,126.917],[37.475,126.857]],
  "금천구":   [[37.468,126.878],[37.468,126.926],[37.436,126.926],[37.436,126.878]],
  "서초구":   [[37.508,126.996],[37.508,127.068],[37.460,127.068],[37.460,126.996]],
  "강남구":   [[37.541,127.013],[37.541,127.081],[37.493,127.081],[37.493,127.013]],
  "송파구":   [[37.538,127.070],[37.538,127.142],[37.490,127.142],[37.490,127.070]],
};

/* ── 전역 상태 ──────────────────────────────────────────── */
let districtData = [];
let seoulMap = null;
let mapLayers = {};

/* ── ① 지도 + 구별 카드 ──────────────────────────────────── */
// districtData는 여러 페이지(동네별 TOP의 구 색상, 상세 모달 등)에서 쓰이므로
// 지도 페이지가 아니어도 항상 로드한다.
async function loadDistrictData() {
  if (districtData.length) return districtData;
  const data = await fetchJSON('/api/districts');
  districtData = data.districts;

  // 히어로 통계 (홈에만 존재 — 없으면 스킵)
  const districtsEl = document.getElementById('statDistricts');
  if (districtsEl) {
    districtsEl.textContent = `${data.districts_with_data}/${data.total_districts}`;
  }
  try {
    const q = await fetchJSON('/api/quality');
    const rawEl = document.getElementById('statRaw');
    const aptsEl = document.getElementById('statApts');
    if (rawEl) rawEl.textContent = q.total_raw.toLocaleString() + '건';
    if (aptsEl) aptsEl.textContent = q.total_apts != null
      ? q.total_apts + '개' : districtData.filter(d=>d.has_data).reduce((s,d)=>s+d.apt_count,0) + '개';
  } catch(e) {}
  return districtData;
}

// ── 구별 평균가 색상 (choropleth) ─────────────────────────
// 평균가 = (최저~최고 가격대의 중간값). 낮을수록 초록, 높을수록 붉은 계열.
const PRICE_COLOR_TIERS = [
  { max: 8,        color: '#34d399', label: '8억 미만' },
  { max: 11,       color: '#818cf8', label: '8~11억' },
  { max: 14,       color: '#a78bfa', label: '11~14억' },
  { max: 18,       color: '#fb923c', label: '14~18억' },
  { max: Infinity, color: '#f87171', label: '18억 이상' },
];

function districtAvgPrice(d) {
  if (d.price_low && d.price_high) return (d.price_low + d.price_high) / 2;
  return d.avg_peak_price || null;
}

function districtPriceColor(d) {
  const avg = districtAvgPrice(d);
  if (avg == null) return '#475569';   // 데이터 없음 — 회색
  return PRICE_COLOR_TIERS.find(t => avg < t.max).color;
}

async function renderMap() {
  await loadDistrictData();
  if (!document.getElementById('seoulMap')) return;   // 구별 소개 페이지가 아니면 스킵

  // 구 카드 그리드를 지도보다 먼저 — 지도(CDN)가 실패해도 카드는 항상 뜬다
  renderDistrictCards(districtData);

  // 평균가 색상 범례 (지도 아래)
  const legendEl = document.getElementById('mapPriceLegend');
  if (legendEl) {
    legendEl.innerHTML =
      `<span class="legend-chip legend-hint">구 색상 = 분석 단지(전용 59㎡) 평균 가격대</span>` +
      PRICE_COLOR_TIERS.map(t =>
        `<span class="legend-chip"><span class="legend-dot" style="background:${t.color}"></span>${t.label}</span>`
      ).join('') +
      `<span class="legend-chip"><span class="legend-dot" style="background:#475569"></span>데이터 없음</span>`;
  }


  // Leaflet 지도 초기화
  if (!seoulMap) {
    seoulMap = L.map('seoulMap', { center: [37.555, 126.975], zoom: 11, zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18
    }).addTo(seoulMap);
    addWorkMarkers(seoulMap);   // 💼/💗 두 직장 항상 표시
  }

  const popupFor = d => {
    const stat = d.has_data
      ? `분석 완료 ✓<br>단지 수: ${d.apt_count}개<br>최우수: ${d.top_apt_name || '—'}<br>최고점: ${d.top_score != null ? d.top_score.toFixed(1) : '—'}점`
      : `데이터 수집 예정`;
    const tags = (d.tags && d.tags.length) ? d.tags : (d.famous || []).slice(0, 4).map(f => '#' + f);
    const tagHtml = tags.length
      ? `<div class="map-popup-tags">${tags.map(t => `<span class="map-popup-tag">${t}</span>`).join('')}</div>`
      : '';
    const oneLiner = d.character ? `<div class="map-popup-char">${d.character}</div>` : '';
    return `<div class="map-popup">
        <b>${d.icon ? d.icon + ' ' : ''}${d.name}</b><br>
        ${stat}
        ${oneLiner}
        ${tagHtml}
      </div>`;
  };

  // 실제 구 경계 GeoJSON (jsDelivr CDN, 브라우저에서 직접 로드) — 실패 시 사각형 폴백
  let geo = null;
  try {
    geo = await fetchJSON('https://cdn.jsdelivr.net/gh/southkorea/seoul-maps@master/kostat/2013/json/seoul_municipalities_geo_simple.json');
  } catch (e) { /* 폴백 사용 */ }

  if (geo && geo.features) {
    L.geoJSON(geo, {
      filter: f => districtData.some(d => d.name === f.properties.name),
      style: f => {
        const d = districtData.find(x => x.name === f.properties.name);
        // 구별 평균 부동산 가격대에 따라 색을 나눈다 (범례는 지도 아래)
        const color = districtPriceColor(d);
        return { color, weight: 2, fillColor: color, fillOpacity: d.has_data ? 0.42 : 0.12 };
      },
      onEachFeature: (f, layer) => {
        const d = districtData.find(x => x.name === f.properties.name);
        if (!d) return;
        layer.bindTooltip(popupFor(d), { sticky: true, direction: 'top', className: 'district-tooltip' });
        layer.on('click', () => scrollToDistrict(d.name));
        layer.on('mouseover', () => layer.setStyle({ fillOpacity: 0.62 }));
        layer.on('mouseout', () => layer.setStyle({ fillOpacity: d.has_data ? 0.42 : 0.12 }));
        mapLayers[d.name] = mapLayers[d.name] || {};
        mapLayers[d.name].rect = layer;
      }
    }).addTo(seoulMap);
  }

  // 구 라벨 마커 (+ GeoJSON 실패 시 사각형 폴리곤 폴백)
  districtData.forEach(d => {
    const poly = DISTRICT_POLYGONS[d.name];
    if (!poly) return;
    const color = districtPriceColor(d);

    if (!geo || !geo.features) {
      const rect = L.rectangle(
        [[Math.min(...poly.map(p=>p[0])), Math.min(...poly.map(p=>p[1]))],
         [Math.max(...poly.map(p=>p[0])), Math.max(...poly.map(p=>p[1]))]],
        { color, weight: 2, fillColor: color, fillOpacity: d.has_data ? 0.42 : 0.12 }
      );
      rect.bindTooltip(popupFor(d), { sticky: true, direction: 'top', className: 'district-tooltip' });
      rect.on('click', () => scrollToDistrict(d.name));
      rect.addTo(seoulMap);
      mapLayers[d.name] = mapLayers[d.name] || {};
      mapLayers[d.name].rect = rect;
    }

    const center = d.center || [
      (Math.min(...poly.map(p=>p[0])) + Math.max(...poly.map(p=>p[0]))) / 2,
      (Math.min(...poly.map(p=>p[1])) + Math.max(...poly.map(p=>p[1]))) / 2
    ];
    // ⚠️ 예전엔 replace('구','')로 줄였는데 "은평"처럼 어색하고, 심지어
    // "구로구"는 첫 글자부터 지워져 "로구"가 되는 버그였다 — 풀네임으로 표기.
    const icon = L.divIcon({
      className: '',
      html: `<div class="map-label ${d.has_data ? 'map-label-data' : ''}">${d.name}</div>`,
      iconSize: [72, 24],
      iconAnchor: [36, 12]
    });
    const marker = L.marker(center, { icon });
    marker.bindTooltip(popupFor(d), { sticky: true, direction: 'top', className: 'district-tooltip' });
    marker.on('click', () => scrollToDistrict(d.name));
    marker.addTo(seoulMap);
    mapLayers[d.name] = mapLayers[d.name] || {};
    mapLayers[d.name].marker = marker;
  });

}

function scrollToDistrict(name) {
  const el = document.getElementById('card-' + name);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderDistrictCards(districts) {
  const grid = document.getElementById('districtCardGrid');
  grid.innerHTML = districts.map(d => {
    const priceStr = d.price_low && d.price_high
      ? `${d.price_low}~${d.price_high}억`
      : (d.avg_peak_price ? `평균 ${d.avg_peak_price}억` : '데이터 준비중');
    const famousStr = (d.famous || []).slice(0, 3).join(' · ');
    const dataTag = d.has_data
      ? `<span class="card-tag tag-data">분석완료</span>`
      : `<span class="card-tag tag-pending">수집예정</span>`;

    const topApt = d.has_data && d.top_apt_name
      ? `<div class="card-top-apt">🏆 ${d.top_apt_name} <span class="card-score">${d.top_score != null ? d.top_score.toFixed(1) : '—'}점</span></div>`
      : '';

    const ageRows = d.age_dist
      ? Object.entries(d.age_dist).map(([k,v]) =>
          `<div class="age-row"><span class="age-label">${k}</span><div class="age-bar"><div class="age-fill" style="width:${v}%;background:${d.color||'#818cf8'}"></div></div><span class="age-val">${v}%</span></div>`
        ).join('')
      : '';

    return `
    <div class="district-card" id="card-${d.name}" onclick="highlightDistrict('${d.name}')">
      <div class="card-header" style="border-left:4px solid ${d.color||'#818cf8'}">
        <div class="card-name-row">
          <span class="card-icon">${d.icon||'🏙️'}</span>
          <span class="card-name">${d.name}</span>
          ${dataTag}
        </div>
        <div class="card-price">${priceStr}</div>
      </div>
      <div class="card-body">
        <p class="card-desc">${d.character || ''}</p>
        ${(d.tags && d.tags.length) ? `<div class="card-tags">${d.tags.map(t => `<span class="card-tag-chip">${t}</span>`).join('')}</div>` : (famousStr ? `<div class="card-famous">📍 ${famousStr}</div>` : '')}
        ${ageRows ? `<div class="age-chart">${ageRows}</div>` : ''}
        ${topApt}
      </div>
    </div>`;
  }).join('');
}

function highlightDistrict(name) {
  if (!mapLayers[name]) return;
  seoulMap.closePopup();
  const layer = mapLayers[name];
  layer.rect.openPopup();
  const d = districtData.find(x => x.name === name);
  if (d && d.center) seoulMap.setView(d.center, 13, { animate: true });
  seoulMap.scrollTo && window.scrollTo({ top: document.getElementById('seoulMap').offsetTop - 80, behavior: 'smooth' });
}

/* ── ② 점수 산출 방식 ───────────────────────────────────── */
function renderScoring() {
  if (!document.getElementById('formulaAxes')) return;   // 점수 근거 페이지 아님
  const axes = [
    { key: '가격방어력', weight: 25, color: '#34d399',
      desc: '전체 수집 기간 중 겪었던 가장 큰 하락(MDD)이 얼마나 작았는지와, 그 저점 이후 얼마나 회복했는지를 함께 봅니다. 신고가를 갱신한 단지는 가점을 받습니다. 단, 2022~23년 하락장을 데이터로 겪지 않은 신축 등은 "MDD 0%"가 방어력 근거가 될 수 없어 중립(50점) 처리합니다.',
      metric: 'MDD(50%) + 회복률(30%) + 가격 안정성(20%) · 하락장 미경험 단지는 중립', example: 'MDD -12% & 전고점 회복 & 변동 작음 → 최상위 방어력' },
    { key: '전세가율', weight: 10, color: '#4ade80',
      desc: '전세가가 매매가에 얼마나 가까운지(수준)와 전세가가 오르는 중인지(추세)를 함께 봅니다. 전세가율이 높으면 실거주 수요가 매매가를 아래에서 떠받쳐 "이 아래로는 잘 안 떨어지는" 지지선 역할을 하고, 전세는 투기 수요가 없는 순수 실수요 가격이라 전세가 상승은 지지선이 올라가는 중이라는 선행 신호입니다. 전용 59㎡ 순수 전세 실거래로 계산합니다.',
      metric: '전세가율 수준(70%) + 전세가 추세(30%) · 최근 18개월, 전용 59㎡', example: '전세가율 60% & 전세 연 +5% 추세 → 강한 하방 지지' },
    { key: '거래유동성', weight: 20, color: '#818cf8',
      desc: '전 기간에 걸쳐 거래가 꾸준했는지, 하락장에서도 거래가 유지됐는지, 그리고 규모 대비 얼마나 활발히 거래되는지(회전율)를 함께 봅니다. 팔고 싶을 때 팔리는 단지가 진짜 우량 단지입니다.',
      metric: '거래 공백률 + 하락기 유지율 + 변동계수 + 회전율(거래건수÷세대수)', example: '하락장에도 매달 거래 + 높은 회전율 → 높은 점수' },
    { key: '상승참여도', weight: 15, color: '#fbbf24',
      desc: '2021년 상승장에서 얼마나 올랐는지를 측정합니다. 하락에 강하면서 상승에도 참여해야 진정한 우량 단지입니다.',
      metric: '(고점가 − 2020년 기저가) / 기저가', example: '기저 대비 +50% 상승 → 높은 참여도' },
    { key: '회복모멘텀', weight: 15, color: '#a78bfa',
      desc: '최근 12개월 가격 추세를 측정합니다. 하락 후 다시 오르는 단지와 바닥에 머무는 단지를 구분합니다. 이상거래 한 달에 흔들리지 않도록 중앙값 기반(Theil-Sen) 추세를 쓰고, 관측이 6개월 미만이면 판단을 보류(중립)합니다.',
      metric: '최근 12개월 Theil-Sen 추세 (연율화 %) · 6개월 미만 관측은 중립', example: '최근 1년간 연 +8% 추세 → 강한 모멘텀' },
    { key: '입지프리미엄', weight: 15, color: '#fb923c',
      desc: '단위면적(m²)당 가격 수준입니다. 교통·학군·인프라 가치는 이미 시장가격에 반영되어 있어, 평단가가 가장 객관적인 입지 지표입니다. 단지마다 고점 시점이 달라 비교가 어긋나던 문제를 피하기 위해, 전 단지 동일 시점인 최신 시세 기준으로 계산합니다.',
      metric: 'm²당 최신 시세 percentile (전 단지 동일 시점)', example: '평단가 상위 10% → 시장이 인정한 입지' },
    { key: '교통', weight: 10, color: '#f87171',
      desc: '단지 좌표에서 가장 가까운 지하철역까지의 도보거리(직선거리 기반)와 반경 1km 내 역 수(더블역세권)를 평가합니다.',
      metric: '최근접역 도보 분(80%) + 1km 내 역 수(20%)', example: '도보 5분 역세권 + 더블역세권 → 최고점' },
    { key: '직주근접', weight: 7, color: '#f472b6',
      desc: '서울 3대 업무지구(강남권 GBD·도심 CBD·여의도 YBD) 중 가장 가까운 곳까지의 직선거리를 평가합니다. 직주근접은 실제 서울 집값을 가장 크게 가르는 축이라, 가격에 이미 녹아든 입지프리미엄과 별개로 물리적 근접성을 명시적으로 반영합니다. (지하철 소요시간이 이상적이나 경로 데이터가 없어 직선거리로 근사)',
      metric: '3대 업무지구 최단 직선거리 percentile (가까울수록 높음)', example: '강남·여의도·도심 어느 한 곳과 3km 이내 → 최상위' },
    { key: '학군', weight: 5, color: '#c084fc',
      desc: '공개 데이터로 얻을 수 있는 두 프록시로 학군 매력을 근사합니다: 가장 가까운 초등학교까지의 거리(초품아, 학교 위치데이터)와 반경 1km 내 학원 수(학원가 밀집도, 공공데이터포털 상가정보 전수). 학업성취도·명문중 배정 같은 핵심 데이터는 비공개라 반영할 수 없어, 학군의 우열을 단정하지 않는 참고 지표입니다.',
      metric: '초품아 최근접 초등학교 거리(50%) + 반경 1km 학원 수(50%, 공공데이터 상가정보)', example: '초등학교 도보권 + 학원가 밀집(대치·목동 등) → 높은 점수' },
    { key: '재건축잠재력', weight: 8, color: '#22d3ee',
      desc: '준공 후 경과 연수를 기준으로 재건축·리모델링 가능성을 평가합니다. 재건축 안전진단 연한(준공 30년)에 가까울수록 미래가치 상승 잠재력이 큽니다.',
      metric: '준공연도 기준 재건축 연한(30년) 근접도', example: '준공 30년 경과 → 재건축 추진 가능 구간' },
  ];

  // 실제 사용된 가중치를 API에서 받아 반영 (교통 축은 좌표 데이터 있을 때만)
  fetchJSON('/api/composite_score').then(cs => {
    const w = cs.weights || {};
    const active = axes.filter(a => w[a.key] != null).map(a => ({ ...a, weight: Math.round(w[a.key] * 100) }));
    active.sort((a, b) => b.weight - a.weight);   // 가중치 큰 축부터 (읽는 순서 = 중요도)
    renderAxes(active.length ? active : axes.filter(a => a.key !== '교통'));
  }).catch(() => renderAxes(axes.filter(a => a.key !== '교통')));

  function renderAxes(axes) {

  document.getElementById('formulaAxes').innerHTML = axes.map(a => `
    <div class="formula-axis" style="border-top:3px solid ${a.color}">
      <div class="fa-name" style="color:${a.color}">${a.key}</div>
      <div class="fa-weight">${a.weight}%</div>
    </div>
  `).join('');

  document.getElementById('axesDetail').innerHTML = axes.map(a => `
    <div class="axis-card">
      <div class="axis-card-header">
        <span class="axis-dot" style="background:${a.color}"></span>
        <span class="axis-name">${a.key}</span>
        <span class="axis-weight-badge">${a.weight}%</span>
      </div>
      <p class="axis-desc">${a.desc}</p>
      <div class="axis-meta">
        <div class="axis-metric"><b>측정 방법:</b> ${a.metric}</div>
        <div class="axis-example"><b>예시:</b> ${a.example}</div>
      </div>
    </div>
  `).join('');
  }

  // 필터 요약
  fetchJSON('/api/pipeline').then(p => {
    const stages = p.stages || [];
    const raw = stages[0]?.count || 0;
    const clean = stages[stages.length-1]?.count || 0;
    document.getElementById('filterSummary').innerHTML = `
      <div class="filter-sum-grid">
        <div class="filter-sum-item"><span class="fsv">${raw.toLocaleString()}</span><span class="fsk">원본 거래</span></div>
        <div class="filter-arr">→</div>
        <div class="filter-sum-item"><span class="fsv fsvg">${clean.toLocaleString()}</span><span class="fsk">정제 거래</span></div>
        <div class="filter-arr">→</div>
        <div class="filter-sum-item"><span class="fsv">6가지</span><span class="fsk">분석 축</span></div>
        <div class="filter-arr">→</div>
        <div class="filter-sum-item"><span class="fsv" style="color:#fbbf24">종합점수</span><span class="fsk">산출</span></div>
      </div>
      <p class="filter-note">벌점 5점 이상 거래(1층/직거래/이상치/결측) 자동 제외 후 분석</p>
    `;
  }).catch(() => {
    document.getElementById('filterSummary').innerHTML = `<p class="filter-note">데이터 로딩 중...</p>`;
  });

  renderBacktest();
}

/* ── 점수 백테스트: "이 점수, 실제로 맞았나?" ─────────────────
   2022-06까지의 데이터만으로 점수를 매긴 뒤, 이후 실제 하락장(22.7~23.12)과
   회복(최신가)을 얼마나 맞췄는지 공개한다. 잘 맞은 것과 못 맞은 것을 함께
   보여주는 것이 이 도구의 신뢰 원칙이다. */
async function renderBacktest() {
  const box = document.getElementById('backtestBox');
  if (!box) return;
  let bt;
  try { bt = await fetchJSON('/api/backtest'); } catch (e) { return; }
  if (!bt || !bt.quintiles) { box.innerHTML = ''; return; }

  const h = bt.headline;
  const rows = bt.quintiles.map(q => {
    const w = Math.min(100, Math.abs(q.avg_realized_dd) * 3.2);
    return `
      <div class="bt-row">
        <span class="bt-q">${q.label}</span>
        <div class="bt-bar"><div class="bt-fill" style="width:${w}%"></div></div>
        <span class="bt-dd">${q.avg_realized_dd.toFixed(1)}%</span>
        <span class="bt-ret">${q.avg_total_ret >= 0 ? '+' : ''}${q.avg_total_ret.toFixed(1)}%</span>
      </div>`;
  }).join('');

  box.innerHTML = `
    <div class="backtest-box" style="margin-top:0;border:0;box-shadow:none;padding:0 0 .3rem">
      <div class="bt-title"><span class="bt-sub">${bt.train_cutoff}까지의 데이터로 점수를 매기고, 이후 실제 하락장과 비교한 결과입니다.</span></div>
      <div class="bt-head-row"><span></span><span></span><span class="bt-col-label">하락장 실현낙폭</span><span class="bt-col-label">현재까지 총수익</span></div>
      ${rows}
      <div class="bt-notes">
        <p>✅ <b>전체 사이클로 보면</b> 점수 상위 20% 단지의 평균 총수익(${h.top20_ret >= 0 ? '+' : ''}${h.top20_ret}%)이 하위 20%(${h.bottom20_ret >= 0 ? '+' : ''}${h.bottom20_ret}%)보다 높았습니다.</p>
        <p>⚠️ <b>정직한 한계</b>: 하락장 직전엔 점수 상위 단지가 오히려 더 크게 조정받았습니다(당시 점수엔 직전 상승세가 반영돼 있었기 때문). 특히 <b>직전에 가장 많이 오른 단지일수록 이후 전체 수익이 나빴습니다</b>(상관 ${bt.axis_corr?.upside?.vs_ret ?? '—'}) — 급등 단지 추격 매수를 경계해야 하는 이유입니다.</p>
        <p>💡 현재 점수의 방어력 축은 하락장을 <b>실제로 통과한 뒤의</b> 데이터로 계산되므로, 백테스트 시점(하락장 이전)의 점수보다 정보량이 많습니다.</p>
      </div>
    </div>`;
}

/* ── ③ 동네별 우수 아파트 ─────────────────────────────────── */
// 동네별 추천 목록 행 클릭 시 (구, 단지명)을 조회하기 위한 인덱스 (renderDistrictRankings에서 채움)
let _rankingRowMap = [];

// 동네별 추천 = 구별 지도 탐색. 구를 고르면 그 구의 분석 단지 전체를 지도에
// 뿌리고, 옆 패널에 구 소개 + 단지 목록(강점 근거 포함)을 보여준다. 단지를
// 클릭하면 전체 1위와 같은 상세 점수 모달(openApartmentModal)이 열린다.
let rankMap = null, rankMarkers = [], rankByDistrict = {}, rankSelected = null;
let rankMarkerByKey = {};

// 목록에서 고른 단지를 지도에서 강조: 확대 이동 + 버블 하이라이트(겹침 위로 끌어올림)
function focusRankMarker(a) {
  if (!(a.lat && a.lng)) return;
  rankMap.setView([a.lat, a.lng], 16, { animate: true });
  Object.values(rankMarkerByKey).forEach(m => {
    m.setZIndexOffset(0);
    m.getElement()?.querySelector('.apt-bubble')?.classList.remove('apt-bubble-focus');
  });
  const m = rankMarkerByKey[`${a.district}|${a.apt_name}`];
  if (m) {
    m.setZIndexOffset(1000);   // 돈암동처럼 버블이 겹치는 곳에서 맨 위로
    m.getElement()?.querySelector('.apt-bubble')?.classList.add('apt-bubble-focus');
  }
}
let rankPriceFilter = { min: 0, max: 9999 };   // 억 단위 (최근 실거래가 기준)

// 가격 필터 바 초기화 공통 헬퍼 — 칩/직접입력을 상태에 반영하고 onChange 호출
function initPriceFilterBar(prefix, state, onChange) {
  const chips = document.getElementById(`${prefix}PriceChips`);
  if (!chips) return;
  chips.querySelectorAll('.price-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      chips.querySelectorAll('.price-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`${prefix}PriceMin`).value = '';
      document.getElementById(`${prefix}PriceMax`).value = '';
      state.min = +btn.dataset.min; state.max = +btn.dataset.max;
      onChange();
    });
  });
  document.getElementById(`${prefix}PriceApply`)?.addEventListener('click', () => {
    chips.querySelectorAll('.price-chip').forEach(b => b.classList.remove('active'));
    state.min = parseFloat(document.getElementById(`${prefix}PriceMin`).value) || 0;
    state.max = parseFloat(document.getElementById(`${prefix}PriceMax`).value) || 9999;
    onChange();
  });
}

// 종합점수 색 구간(지도 탐색기 SCORE_TIERS와 동일 기준)
function rankBubbleClass(v) {
  if (v >= 60) return 'bubble-hot';
  if (v >= 55) return 'bubble-mid';
  return 'bubble-cool';
}

// 단지 한 곳의 대표 강점 2개 (축 점수 최상위)
function aptTopAxes(a, n = 2) {
  const axes = [
    ['가격방어', a.defense_score], ['전세가율', a.jeonse_score], ['유동성', a.liquidity_score],
    ['상승참여', a.upside_score], ['모멘텀', a.momentum_score], ['프리미엄', a.premium_score],
    ['교통', a.transit_score], ['직주근접', a.hub_score], ['학군', a.school_score],
    ['재건축', a.redevelop_score],
  ].filter(x => x[1] != null);
  return axes.sort((p, c) => c[1] - p[1]).slice(0, n);
}

async function renderDistrictRankings() {
  if (!document.getElementById('rankMap')) return;   // 동네별 페이지 아님
  await loadDistrictData();
  const data = await fetchJSON('/api/apartments');
  const apts = (data.apartments || []);

  rankByDistrict = {};
  apts.forEach(a => { (rankByDistrict[a.district] = rankByDistrict[a.district] || []).push(a); });
  Object.values(rankByDistrict).forEach(list =>
    list.sort((x, y) => (y.composite_score ?? 0) - (x.composite_score ?? 0)));

  // 구 순서: 분석 단지 수 많은 순 → 이름순
  const districts = Object.keys(rankByDistrict)
    .sort((a, b) => rankByDistrict[b].length - rankByDistrict[a].length || a.localeCompare(b, 'ko'));

  const chipEl = document.getElementById('rankDistrictChips');
  if (!districts.length) {
    chipEl.innerHTML = `<div class="empty-state">분석 데이터가 없습니다.</div>`;
    return;
  }
  chipEl.innerHTML = districts.map(d => {
    const info = districtData.find(x => x.name === d) || {};
    return `<button class="rank-chip" data-d="${d}">
      <span class="rank-chip-ic">${info.icon || '🏙️'}</span>${d}
      <span class="rank-chip-n">${rankByDistrict[d].length}</span>
    </button>`;
  }).join('');
  chipEl.querySelectorAll('.rank-chip').forEach(btn =>
    btn.addEventListener('click', () => selectRankDistrict(btn.dataset.d)));

  // 지도 초기화 (한 번만)
  rankMap = L.map('rankMap', { center: [37.545, 126.99], zoom: 11 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 18
  }).addTo(rankMap);
  addWorkMarkers(rankMap);   // 💼/💗 두 직장 항상 표시

  document.getElementById('rankLegend').innerHTML = [
    ['bubble-hot', '60점 이상'], ['bubble-mid', '55~60점'], ['bubble-cool', '55점 미만'],
  ].map(([c, l]) => `<span class="legend-chip"><span class="legend-dot ${c}"></span>${l}</span>`).join('');

  // 가격 필터 (구 안에서 가격대로 좁혀보기)
  initPriceFilterBar('rank', rankPriceFilter, () => selectRankDistrict(rankSelected));

  // 첫 구 자동 선택 (URL ?d=구 있으면 그 구)
  const want = new URLSearchParams(location.search).get('d');
  selectRankDistrict(districts.includes(want) ? want : districts[0]);
}

// 가격 필터 적용 시 구 칩의 숫자(단지 수)도 필터 통과 개수로 갱신
function rankFilterPass(a) {
  if (rankPriceFilter.min <= 0 && rankPriceFilter.max >= 9999) return true;
  const eok = a.latest_price != null ? a.latest_price / 10000 : null;
  return eok != null && eok >= rankPriceFilter.min && eok <= rankPriceFilter.max;
}
function updateRankChipCounts() {
  const isAll = rankPriceFilter.min <= 0 && rankPriceFilter.max >= 9999;
  document.querySelectorAll('#rankDistrictChips .rank-chip').forEach(btn => {
    const d = btn.dataset.d;
    const full = rankByDistrict[d] || [];
    const n = isAll ? full.length : full.filter(rankFilterPass).length;
    const el = btn.querySelector('.rank-chip-n');
    if (!el) return;
    el.textContent = isAll ? full.length : `${n}/${full.length}`;
    el.classList.toggle('rank-chip-n-zero', !isAll && n === 0);
  });
}

function selectRankDistrict(district) {
  rankSelected = district;
  updateRankChipCounts();
  const full = rankByDistrict[district] || [];
  const isAll = rankPriceFilter.min <= 0 && rankPriceFilter.max >= 9999;
  const list = isAll ? full : full.filter(a => {
    const eok = a.latest_price != null ? a.latest_price / 10000 : null;
    return eok != null && eok >= rankPriceFilter.min && eok <= rankPriceFilter.max;
  });
  const info = districtData.find(x => x.name === district) || {};
  const color = info.color || '#818cf8';

  document.querySelectorAll('.rank-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.d === district));

  // 지도 마커 교체
  rankMarkers.forEach(m => rankMap.removeLayer(m));
  rankMarkers = [];
  rankMarkerByKey = {};
  const coordApts = list.filter(a => a.lat && a.lng);
  coordApts.forEach((a, i) => {
    const icon = L.divIcon({
      className: '',
      html: `<div class="apt-bubble ${rankBubbleClass(a.composite_score ?? 0)}">
               <span class="apt-bubble-name">${shortName(a.apt_name)}</span>
               <span class="apt-bubble-price">${eokFmt(a.latest_price)}</span>
             </div>`,
      iconSize: [72, 40], iconAnchor: [36, 40],
    });
    const m = L.marker([a.lat, a.lng], { icon });
    m.on('click', () => openApartmentModal(a.district, a.apt_name));
    m.addTo(rankMap);
    rankMarkers.push(m);
    rankMarkerByKey[`${a.district}|${a.apt_name}`] = m;
  });
  if (coordApts.length) {
    rankMap.fitBounds(L.latLngBounds(coordApts.map(a => [a.lat, a.lng])).pad(0.2));
  } else if (info.center) {
    rankMap.setView(info.center, 13);
  }
  setTimeout(() => rankMap.invalidateSize(), 60);

  document.getElementById('rankCount').textContent = isAll
    ? `${district} · ${list.length}개 분석`
    : `${district} · 가격대 내 ${list.length}개 (전체 ${full.length}개)`;

  // 구 소개 + 단지 목록 (옆 패널)
  const avgP = info.avg_peak_price != null ? `평균 전고점 ${info.avg_peak_price}억` : '';
  const priceRange = (info.price_low && info.price_high) ? `현재가 ${info.price_low}~${info.price_high}억대` : '';
  const strengths = (info.strengths || []).map(s => `<span class="aptag">${s}</span>`).join('');
  const famous = (info.famous || []).slice(0, 4).join(' · ');

  const rows = list.map((a, i) => {
    const best = aptTopAxes(a, 2).map(([n, v]) => `${n} ${Math.round(v)}`).join(' · ');
    const mdd = a.mdd != null ? `MDD ${a.mdd.toFixed(1)}%` : '';
    return `
    <div class="rank-apt-row" data-i="${i}">
      <div class="rank-apt-rank" style="${i === 0 ? `color:${color}` : ''}">${i + 1}</div>
      <div class="rank-apt-main">
        <div class="rank-apt-name">${a.apt_name}</div>
        <div class="rank-apt-sub">${a.build_year || '—'}년 · ${Math.round(a.area_exclusive || 0)}㎡ ${mdd ? '· ' + mdd : ''}</div>
        <div class="rank-apt-why">💡 ${best || '분석 중'} 강점</div>
      </div>
      <div class="rank-apt-right">
        <div class="rank-apt-price">${eokFmt(a.latest_price)}</div>
        <div class="rank-apt-score" style="${i === 0 ? `color:${color}` : ''}">${fmtScore(a.composite_score)}점</div>
        <button class="rank-apt-detail" data-i="${i}" title="상세 점수 보기">📊 상세</button>
      </div>
    </div>`;
  }).join('');

  document.getElementById('rankPanel').innerHTML = `
    <div class="rank-dist-head" style="border-left:3px solid ${color}">
      <div class="rank-dist-title">${info.icon || '🏙️'} <b>${district}</b>
        <span class="rank-dist-tag">${info.character || ''}</span></div>
      <div class="rank-dist-meta">${[famous, avgP, priceRange].filter(Boolean).join(' · ')}</div>
      ${info.description ? `<p class="rank-dist-desc">${info.description}</p>` : ''}
      ${strengths ? `<div class="rank-dist-strengths">${strengths}</div>` : ''}
    </div>
    <div class="ep-list-head">단지 목록 <span class="ep-list-cnt">${list.length}</span>
      <span class="rank-list-hint">클릭 → 지도에서 위치 · 📊 → 상세 점수</span></div>
    <div class="rank-apt-list">${rows || '<div class="explorer-panel-empty">이 가격대의 단지가 없어요.<br>필터를 넓혀보세요 🙂</div>'}</div>
  `;

  // 행 클릭 → 지도에서 위치 강조 (모달이 지도를 가리지 않도록 상세는 📊 버튼으로 분리)
  document.querySelectorAll('.rank-apt-row').forEach(el => {
    el.addEventListener('click', () => {
      focusRankMarker(list[+el.dataset.i]);
      document.querySelectorAll('.rank-apt-row').forEach(x => x.classList.toggle('active', x === el));
    });
  });
  document.querySelectorAll('.rank-apt-detail').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const a = list[+btn.dataset.i];
      openApartmentModal(a.district, a.apt_name);
    });
  });
}

/* ── ④ 전체 1위 단지 상세 ──────────────────────────────────── */
// 8개 채점 축 → 레이더/막대에 쓸 공통 배열 (전체 1위·동네별 추천 상세 모달 공용)
function buildApartmentAxes(apt) {
  return [
    { name: '가격방어력', val: apt.defense_score, color: '#34d399' },
    { name: '전세가율', val: apt.jeonse_score, color: '#4ade80' },
    { name: '거래유동성', val: apt.liquidity_score, color: '#818cf8' },
    { name: '상승참여도', val: apt.upside_score, color: '#fbbf24' },
    { name: '회복모멘텀', val: apt.momentum_score, color: '#a78bfa' },
    { name: '입지프리미엄', val: apt.premium_score, color: '#fb923c' },
    { name: '교통', val: apt.transit_score, color: '#f87171' },
    { name: '직주근접', val: apt.hub_score, color: '#f472b6' },
    { name: '학군', val: apt.school_score, color: '#c084fc' },
    { name: '재건축잠재력', val: apt.redevelop_score, color: '#22d3ee' },
  ].filter(a => a.val != null);
}

// 축별 점수 근거 한 줄 — 실제 수치(MDD·회복률·거래공백률·평단가·역 거리 등)를
// 그대로 인용해 "왜 이 점수인지"를 축마다 설명한다. 70점 이상일 때만 문구가
// 뜨던 기존 buildApartmentInsights와 달리 점수 높낮이와 무관하게 항상 표시된다.
function buildAxisReasons(apt) {
  const pct = v => v != null ? Math.round(100 - v) : null;   // score(percentile) → "상위 X%"
  const reasons = {};

  if (apt.defense_score != null) {
    const mdd = apt.mdd_pct, rec = apt.recovery_rate;
    // 하락장 미경험 + MDD 평탄 → 중립(50) 처리된 경우: 수치 대신 그 사유를 설명한다.
    const neutralized = apt.downturn_experienced === false && mdd != null && mdd > -5;
    if (neutralized) {
      reasons['가격방어력'] = `2022~23년 하락장을 데이터로 겪지 않아(비교적 최근 거래·신축 등) MDD 0%가 방어력 근거가 될 수 없어, 방어력은 중립(50점)으로 평가했습니다.`;
    } else if (mdd != null && rec != null) {
      const recPct = Math.round(rec * 100);
      // 회복률이 100%를 넘으면 저점을 넘어 신고가를 갱신했다는 뜻 — "120% 회복"보다
      // "전고점을 넘어섰다"는 표현이 더 자연스럽다.
      const recPhrase = recPct >= 100 ? '저점 대비 이미 전고점을 넘어섰고' : `저점 대비 ${recPct}% 회복했고`;
      const recPhraseMid = recPct >= 100 ? '저점 대비 전고점을 회복한 상태' : `저점 대비 회복률 ${recPct}%`;
      // 가격 안정성(연 변동성)이 있으면 함께 언급 — 낮을수록 평소 가격이 안정적
      const volPhrase = apt.price_vol_annual != null
        ? ` 연 변동성은 ${(apt.price_vol_annual * 100).toFixed(1)}%${apt.price_vol_annual < 0.10 ? '로 안정적' : apt.price_vol_annual > 0.18 ? '로 출렁임이 큰 편' : ''}입니다.`
        : '';
      reasons['가격방어력'] = (apt.defense_score >= 70
        ? `역대 최대 낙폭(MDD) ${mdd.toFixed(1)}%로 하락폭이 작았고, ${recPhrase} 방어력이 우수합니다.`
        : apt.defense_score >= 45
          ? `역대 최대 낙폭 ${mdd.toFixed(1)}%, ${recPhraseMid}로 준수한 방어력입니다.`
          : `역대 최대 낙폭이 ${mdd.toFixed(1)}%로 컸고 회복률도 ${recPct}%에 그쳐 방어력이 약한 편입니다.`) + volPhrase;
    }
  }

  if (apt.jeonse_score != null && apt.jeonse_ratio != null) {
    const jr = Math.round(apt.jeonse_ratio * 100);
    // 전세 추세: 오르는 중이면 지지선이 올라가는 중이라는 선행 신호
    const tr = apt.jeonse_trend_pct;
    const trendPhrase = tr != null
      ? (tr >= 3 ? ` 최근 전세가가 연 +${tr.toFixed(1)}% 추세로 올라 지지선 자체가 상승 중입니다.`
         : tr <= -3 ? ` 다만 최근 전세가가 연 ${tr.toFixed(1)}% 추세로 내려 지지력이 약해지는 중입니다.`
         : '')
      : '';
    const gapPhrase = apt.jeonse_gap != null ? ` (갭 ${(apt.jeonse_gap/10000).toFixed(1)}억)` : '';
    reasons['전세가율'] = (apt.jeonse_score >= 70
      ? `전세가율 ${jr}%${gapPhrase}로 높아, 실거주 전세 수요가 매매가를 강하게 떠받칩니다.`
      : apt.jeonse_score >= 45
        ? `전세가율 ${jr}%${gapPhrase}로 무난한 수준의 하방 지지력입니다.`
        : `전세가율 ${jr}%${gapPhrase}로 낮은 편이라, 시세 하락 시 지지선이 약할 수 있습니다.`) + trendPhrase;
  }

  if (apt.liquidity_score != null && apt.gap_ratio != null) {
    const gapPct = Math.round(apt.gap_ratio * 100);
    const retPct = apt.retention != null ? Math.round(apt.retention * 100) : null;
    // 회전율(연간 거래건수÷세대수)을 %로 환산해 근거에 함께 노출
    const turnPct = apt.turnover != null ? (apt.turnover * 100) : null;
    const turnPhrase = turnPct != null ? ` 연 회전율 약 ${turnPct.toFixed(1)}%로` : '';
    reasons['거래유동성'] = apt.liquidity_score >= 70
      ? `거래 공백률 ${gapPct}%로 낮고${turnPhrase} 매물이 자주 나와 환금성이 좋습니다.`
      : apt.liquidity_score >= 45
        ? `거래 공백률 ${gapPct}%,${turnPhrase} 무난한 수준의 유동성입니다.`
        : `거래 공백률이 ${gapPct}%로 높고${turnPhrase} 매매 타이밍을 잡기 어려울 수 있습니다.`;
  }

  if (apt.upside_score != null && apt.upside_pct != null) {
    reasons['상승참여도'] = apt.upside_score >= 70
      ? `2020년 기저가 대비 고점가가 +${apt.upside_pct.toFixed(1)}% 상승 — 상승장 참여도가 상위 ${pct(apt.upside_score)}% 수준입니다.`
      : apt.upside_score >= 45
        ? `2020년 기저가 대비 고점가가 +${apt.upside_pct.toFixed(1)}% 상승해 시장 평균 수준으로 상승장에 참여했습니다.`
        : `2020년 기저가 대비 상승폭이 +${apt.upside_pct.toFixed(1)}%에 그쳐 상승장 참여도가 낮은 편입니다.`;
  }

  if (apt.momentum_score != null && apt.momentum_pct != null) {
    const m = apt.momentum_pct;
    reasons['회복모멘텀'] = m > 0
      ? `최근 12개월 가격이 연 +${m.toFixed(1)}% 추세로 ${apt.momentum_score >= 70 ? '뚜렷하게 상승' : '완만하게 상승'} 중입니다.`
      : `최근 12개월 가격이 연 ${m.toFixed(1)}% 추세로 하락 또는 보합 흐름입니다.`;
  }

  if (apt.premium_score != null && apt.price_per_m2 != null) {
    const inDist = apt.premium_in_district_top_pct != null
      ? ` · ${apt.district} 안에서는 상위 ${Math.round(apt.premium_in_district_top_pct)}%` : '';
    reasons['입지프리미엄'] = `㎡당 최신 시세 ${apt.price_per_m2.toLocaleString()}만원 — 서울 분석 단지 중 상위 ${pct(apt.premium_score)}%${inDist} 평단가입니다 (전 단지 동일 시점 비교).`;
  }

  if (apt.transit_score != null) {
    reasons['교통'] = apt.nearest_station
      ? `${apt.nearest_station} 도보 ${Math.round(apt.walk_min)}분${apt.stations_within_1km > 1 ? `, 반경 1km 내 역 ${apt.stations_within_1km}개(더블역세권)` : ''} — 교통 상위 ${pct(apt.transit_score)}% 입지입니다.`
      : `반경 1.5km 내 지하철역이 없어 도보 접근성이 낮은 편입니다.`;
  }

  if (apt.hub_score != null && apt.hub_min_km != null) {
    const km = apt.hub_min_km;
    const hub = apt.hub_nearest_name || '3대 업무지구';
    reasons['직주근접'] = apt.hub_score >= 70
      ? `가장 가까운 업무지구인 ${hub}까지 직선 ${km}km — 3대 업무지구 접근성 상위 ${pct(apt.hub_score)}%의 직주근접 입지입니다.`
      : apt.hub_score >= 45
        ? `가장 가까운 업무지구는 ${hub}(직선 ${km}km)로, 무난한 직주근접 수준입니다.`
        : `가장 가까운 업무지구(${hub})까지 직선 ${km}km로 3대 업무지구와 다소 떨어져 있습니다.`;
  }

  if (apt.school_score != null) {
    const elem = apt.nearest_elem_m != null
      ? (apt.nearest_elem_m <= 300 ? `초등학교가 직선 ${apt.nearest_elem_m}m로 사실상 초품아` : `가장 가까운 초등학교 직선 ${apt.nearest_elem_m}m`)
      : null;
    const aca = apt.academy_within_1km != null ? `반경 1km 내 학원 ${apt.academy_within_1km}곳` : null;
    const bits = [elem, aca].filter(Boolean).join(', ');
    reasons['학군'] = (apt.school_score >= 70
      ? `${bits} — 초등학교 근접·학원가 밀집도 상위 ${pct(apt.school_score)}%의 학군 프록시 점수입니다.`
      : apt.school_score >= 45
        ? `${bits} — 무난한 초등학교 접근성·학원 밀집도입니다.`
        : `${bits} — 초등학교·학원가 밀집도가 낮은 편입니다.`)
      + ` (학업성취도 등 공식 학군 데이터는 비공개라 초품아·학원가 밀집도만 반영한 참고 지표입니다.)`;
  }

  if (apt.redevelop_score != null && apt.apt_age != null) {
    const age = apt.apt_age;
    reasons['재건축잠재력'] = age >= 35
      ? `준공 ${age}년차로 재건축 연한을 넘어 사업 추진이 본격화될 수 있는 구간입니다.`
      : age >= 30
        ? `준공 ${age}년차로 재건축 안전진단 연한(30년)에 도달했습니다.`
        : age >= 27
          ? `준공 ${age}년차로 재건축 연한이 임박했습니다.`
          : age >= 22
            ? `준공 ${age}년차로 중장기적으로 리모델링·재건축을 기대할 수 있는 연차입니다.`
            : `준공 ${age}년차의 신축~준신축이라 재건축보다는 상품성 자체로 평가받는 단지입니다.`;
  }

  return reasons;
}

// 근거(왜 이 점수인가) 인사이트 리스트 — 전체 1위·상세 모달 공용
function buildApartmentInsights(apt, comp, extraLines = []) {
  const lines = [
    apt.defense_score >= 70 ? '<li>하락장에서 가격 방어력이 매우 뛰어나고 회복도 빠릅니다</li>' : '',
    apt.liquidity_score >= 70 ? '<li>6년간 꾸준한 거래가 이어진 환금성 높은 단지입니다</li>' : '',
    apt.upside_score >= 70 ? '<li>상승장에서도 시장 평균을 웃도는 상승률을 기록했습니다</li>' : '',
    apt.momentum_score >= 70 ? '<li>최근 12개월 가격 추세가 뚜렷한 상승 흐름입니다</li>' : '',
    apt.premium_score >= 70 ? '<li>단위면적당 가격 상위권 — 시장이 인정한 입지입니다</li>' : '',
    apt.transit_score >= 70 && apt.nearest_station ? `<li>${apt.nearest_station} 도보 ${Math.round(apt.walk_min)}분 거리의 역세권 단지입니다</li>` : '',
    apt.redevelop_score >= 70 ? `<li>준공 ${apt.apt_age || ''}년차 — 재건축 연한에 근접해 미래가치 상승 잠재력이 있습니다</li>` : '',
    ...extraLines,
  ].filter(Boolean);
  return lines.join('');
}

// 단지 상세(레이더+축별 점수+통계+근거) 공통 렌더러. containerId에 HTML을 채우고
// radarId/priceChartId에 Plotly 차트를 그린다. 전체 1위(top1Detail)와 동네별 추천
// 상세 모달(aptModalBody) 양쪽에서 재사용한다.
function renderApartmentDetail(containerId, radarId, priceChartId, apt, mddInfo, comp, aptTs, opts = {}) {
  const distInfo = districtData.find(d => d.name === apt.district) || {};
  const axes = buildApartmentAxes(apt);
  const radarLabels = axes.map(a => a.name);
  const radarVals = axes.map(a => a.val != null ? Math.min(100, a.val) : 0);
  const badgeHtml = opts.badgeHtml || '📍 동네별 추천 단지';
  const extraInsight = opts.extraInsight || [];
  const axisReasons = buildAxisReasons(apt);

  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="top1-hero">
      <div class="top1-badge">${badgeHtml}</div>
      <h3 class="top1-name">${apt.apt_name}</h3>
      <div class="top1-loc">${apt.district} ${distInfo.icon||''}</div>
      ${apt.data_confidence === 'low'
        ? `<div class="conf-badge conf-low">⚠️ 데이터 부족 주의 — 59㎡ 관측 ${apt.active_months ?? '—'}개월 · 거래 ${apt.total_trades ?? '—'}건이라 점수 불확실성이 큽니다</div>`
        : apt.data_confidence === 'high'
          ? `<div class="conf-badge conf-high">✓ 데이터 충분 (관측 ${apt.active_months}개월 · 거래 ${apt.total_trades}건)</div>`
          : ''}
      <div class="top1-score-big">${fmtScore(apt.composite_score)}<span class="top1-score-unit">점</span></div>
      <div id="${containerId}RvTags"></div>
      <div class="ep-links" style="justify-content:center;margin-top:.8rem">
        <a class="ep-map" href="${naverMapUrl(apt.district, apt.apt_name, apt.dong, apt.lat, apt.lng)}" target="_blank" rel="noopener">네이버 지도 ↗</a>
        <a class="ep-naver" href="${naverLandUrl(apt.district, apt.apt_name, apt.dong, apt.lat, apt.lng)}" target="_blank" rel="noopener">네이버 부동산 ↗</a>
        <a class="ep-hogang" href="${hogangnonoUrl(apt.district, apt.apt_name, apt.dong, apt.lat, apt.lng)}" target="_blank" rel="noopener">호갱노노 ↗</a>
      </div>
    </div>

    <div class="top1-body">
      <div class="top1-radar" id="${radarId}"></div>
      <div class="top1-axes">
        ${axes.map(a => `
          <div class="top1-ax-group">
            <div class="top1-axis-row">
              <span class="top1-ax-dot" style="background:${a.color}"></span>
              <span class="top1-ax-name">${a.name}</span>
              <div class="top1-ax-bar">
                <div class="top1-ax-fill" style="width:${Math.min(100,a.val||0)}%;background:${a.color}"></div>
              </div>
              <span class="top1-ax-val">${a.val != null ? a.val.toFixed(1) : '—'}</span>
            </div>
            ${axisReasons[a.name] ? `<div class="top1-ax-reason">${axisReasons[a.name]}</div>` : ''}
          </div>
        `).join('')}
      </div>
    </div>

    <div class="top1-stats-grid">
      <div class="top1-stat"><div class="ts-val">${mddInfo.peak_price != null ? (mddInfo.peak_price/10000).toFixed(1)+'억' : '—'}</div><div class="ts-key">최고 거래가</div></div>
      <div class="top1-stat"><div class="ts-val" style="color:#34d399">${mddInfo.mdd != null ? mddInfo.mdd.toFixed(1)+'%' : '—'}</div><div class="ts-key">MDD (최대낙폭)</div></div>
      <div class="top1-stat"><div class="ts-val">${mddInfo.total_trades != null ? mddInfo.total_trades.toLocaleString()+'건' : '—'}</div><div class="ts-key">총 거래 건수</div></div>
      <div class="top1-stat"><div class="ts-val">${apt.active_months != null ? apt.active_months+'개월' : '—'}</div><div class="ts-key">활성 거래 기간</div></div>
      ${apt.jeonse_ratio != null ? `<div class="top1-stat"><div class="ts-val" style="color:#4ade80">${Math.round(apt.jeonse_ratio*100)}%</div><div class="ts-key">전세가율 (최근 18개월)</div></div>` : ''}
      ${apt.jeonse_gap != null ? `<div class="top1-stat"><div class="ts-val">${(apt.jeonse_gap/10000).toFixed(1)}억</div><div class="ts-key">갭 (매매−전세)</div></div>` : ''}
    </div>

    <div id="${containerId}Transit"></div>

    <div class="top1-insight">
      <div class="insight-title">왜 이 점수인가요?</div>
      <ul class="insight-list">${buildApartmentInsights(apt, comp, extraInsight)}</ul>
    </div>

    <div class="top1-chart-legend">
      <span><span class="tcl-dot" style="background:#818cf8"></span>가격(억)</span>
      <span><span class="tcl-dot" style="background:#fbbf24"></span>⭐ 최고 거래가</span>
      <span><span class="tcl-dot" style="background:#f87171"></span>▽ 저점</span>
      <span><span class="tcl-bar tcl-up"></span><span class="tcl-bar tcl-down"></span>월 거래량(상승/하락)</span>
    </div>
    <div id="${priceChartId}" class="top1-price-chart" style="height:320px"></div>
  `;

  // 레이더 차트 렌더링
  const radarFull = [...radarVals, radarVals[0]];
  const radarFull2 = [...radarLabels, radarLabels[0]];
  try { Plotly.newPlot(radarId, [{
    type: 'scatterpolar',
    r: radarFull,
    theta: radarFull2,
    fill: 'toself',
    fillcolor: 'rgba(129,140,248,0.2)',
    line: { color: '#818cf8', width: 2 },
    marker: { color: '#818cf8', size: 6 },
    name: apt.apt_name
  }], {
    polar: {
      radialaxis: { visible: true, range: [0, 100], color: '#8f97a3', gridcolor: '#dfe5ec' },
      angularaxis: { color: '#6b7684' },
      bgcolor: 'transparent'
    },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#333d4b', family: 'sans-serif', size: 12 },
    margin: { t: 20, b: 20, l: 40, r: 40 },
    showlegend: false
  }, { responsive: true, displayModeBar: false });
  } catch (e) { console.error('radar', e); }

  // 가격 추이 차트 (있는 경우) — 주식 차트 스타일(가격 라인 + 최고가/저점 마커 + 거래량 바)
  // Plotly 로드 실패(CDN 장애 등)가 뒤 섹션(교통 안내)까지 막지 않도록 격리
  try {
    if (aptTs && aptTs.monthly) {
      renderPriceChart(priceChartId, aptTs, mddInfo);
    }
  } catch (e) { console.error('price chart', e); }

  // 🚇 우리 회사 가는 길 (비동기 — 지하철역 데이터 로드 후 채움)
  fillCommuteTransit(`${containerId}Transit`, apt);
  fillReviewTags(`${containerId}RvTags`, apt.district, apt.apt_name, true);   // 💬 점수 바로 아래 해시태그
}

async function renderTop1() {
  if (!document.getElementById('top1Detail')) return;   // 전체 1위 페이지 아님
  await loadDistrictData();
  const { comp, mdd, ts } = await loadScoreData();

  const top = comp.ranking?.[0];
  if (!top) {
    document.getElementById('top1Detail').innerHTML = `<div class="empty-state">데이터 없음</div>`;
    return;
  }

  const mddInfo = (mdd.ranking||[]).find(r => r.apt_name === top.apt_name && r.district === top.district) || {};
  const aptTs = (ts.apartments || []).find(a => a.apt_name === top.apt_name && a.district === top.district);
  const sameDistrictCount = comp.ranking.filter(r => r.district === top.district).length;

  renderApartmentDetail('top1Detail', 'top1Radar', 'top1PriceChart', top, mddInfo, comp, aptTs, {
    badgeHtml: '🏆 전체 종합 1위',
    extraInsight: [
      `<li>${top.district} 내 ${sameDistrictCount}개 단지 중 종합 1위를 차지했습니다</li>`,
      '<li>여러 분석 축에서 균형 잡힌 고득점을 기록했습니다</li>',
    ],
  });
}

// 주식 차트 스타일: 상단 가격 라인(+최고가⭐·저점▽ 마커) / 하단 거래량 바(상승월 초록·하락월 빨강)
function renderPriceChart(chartId, aptTs, mddInfo = {}) {
  const rows = aptTs.monthly;
  const months = rows.map(m => m.ym);                                  // 'YYYY-MM'
  const prices = rows.map(m => m.median != null ? +(m.median/10000).toFixed(2) : null);
  const vols   = rows.map(m => m.vol != null ? m.vol : 0);

  // 거래량 바 색: 전월 대비 가격이 오른 달=초록, 내린 달=빨강, 판단불가=회색
  const volColors = prices.map((p, i) => {
    const prev = i > 0 ? prices[i-1] : null;
    if (p == null || prev == null) return 'rgba(100,116,139,.55)';
    return p >= prev ? 'rgba(52,211,153,.6)' : 'rgba(248,113,113,.6)';
  });

  const traces = [
    // ① 가격 라인 (상단 subplot)
    {
      x: months, y: prices, type: 'scatter', mode: 'lines',
      line: { color: '#818cf8', width: 2.2, shape: 'spline', smoothing: 0.6 },
      name: '가격(억)', yaxis: 'y', connectgaps: false,
      hovertemplate: '%{x}<br>%{y}억<extra></extra>',
    },
    // ② 거래량 바 (하단 subplot)
    {
      x: months, y: vols, type: 'bar',
      marker: { color: volColors },
      name: '거래량(건)', yaxis: 'y2',
      hovertemplate: '%{x}<br>거래 %{y}건<extra></extra>',
    },
  ];

  // ③ 최고가·저점 마커 (mddInfo 기준)
  const markX = [], markY = [], markText = [], markPos = [], markSym = [], markColor = [], markSize = [];
  if (mddInfo.peak_date && mddInfo.peak_price != null && months.includes(mddInfo.peak_date)) {
    markX.push(mddInfo.peak_date); markY.push(+(mddInfo.peak_price/10000).toFixed(2));
    markText.push(`최고 ${(mddInfo.peak_price/10000).toFixed(1)}억`); markPos.push('top center');
    markSym.push('star'); markColor.push('#fbbf24'); markSize.push(14);
  }
  if (mddInfo.trough_date && mddInfo.trough_price != null && months.includes(mddInfo.trough_date)
      && mddInfo.trough_date !== mddInfo.peak_date) {
    markX.push(mddInfo.trough_date); markY.push(+(mddInfo.trough_price/10000).toFixed(2));
    markText.push(`저점 ${(mddInfo.trough_price/10000).toFixed(1)}억`); markPos.push('bottom center');
    markSym.push('triangle-down'); markColor.push('#f87171'); markSize.push(12);
  }
  if (markX.length) {
    traces.push({
      x: markX, y: markY, type: 'scatter', mode: 'markers+text',
      marker: { symbol: markSym, size: markSize, color: markColor,
                line: { color: '#ffffff', width: 1.5 } },
      text: markText, textposition: markPos,
      textfont: { size: 11, color: '#ffffff' },
      yaxis: 'y', hoverinfo: 'skip', showlegend: false,
    });
  }

  Plotly.newPlot(chartId, traces, {
    // 상단 70% = 가격, 하단 18% = 거래량 (주식창 레이아웃)
    xaxis: { color: '#6b7684', gridcolor: 'rgba(20,40,70,.07)', anchor: 'y2',
             showspikes: true, spikecolor: '#8f97a3', spikethickness: 1, spikemode: 'across' },
    yaxis: { domain: [0.30, 1], color: '#6b7684', gridcolor: 'rgba(20,40,70,.07)',
             ticksuffix: '억', fixedrange: true },
    yaxis2: { domain: [0, 0.18], color: '#8f97a3', gridcolor: 'rgba(20,40,70,.05)',
              title: { text: '거래량', font: { size: 10, color: '#8f97a3' } },
              fixedrange: true, rangemode: 'tozero' },
    paper_bgcolor: 'transparent',
    plot_bgcolor: '#ffffff',
    font: { color: '#333d4b' },
    margin: { t: 24, b: 40, l: 52, r: 16 },
    showlegend: false,
    bargap: 0.35,
    hovermode: 'x unified',
    shapes: [
      // 2021 상승장 / 2022~23 하락장 배경 (가격 subplot 영역에만)
      { type: 'rect', xref: 'x', yref: 'paper', x0: '2021-01', x1: '2021-12', y0: 0.30, y1: 1,
        fillcolor: 'rgba(251,191,36,0.06)', line: { width: 0 }, layer: 'below' },
      { type: 'rect', xref: 'x', yref: 'paper', x0: '2022-07', x1: '2023-06', y0: 0.30, y1: 1,
        fillcolor: 'rgba(248,113,113,0.06)', line: { width: 0 }, layer: 'below' },
    ]
  }, { responsive: true, displayModeBar: false });
}

/* ── ⑤ 지도 탐색기 ─────────────────────────────────────── */
// 국토부 실거래명 → 네이버부동산 등록명 별칭 (이름이 다른 단지)
const NAVER_ALIAS = {
  '관악드림(삼성)': '관악드림타운', '관악드림(동아)': '관악드림타운',
  '옥수파크힐스101동~116동': 'e편한세상옥수파크힐스',
  '우장산아이파크,이편한세상': '우장산아이파크이편한세상',
  '가양2단지(성지)': '가양2단지성지', '가양6단지': '가양6단지',
  '장안현대홈타운(336)': '장안현대홈타운',
  '독립문극동(200-0)': '독립문극동',
  '북한산현대힐스테이트3차아파트': '북한산현대힐스테이트3차',
  '대림e-편한세상': '대림e편한세상',
  '이편한세상금호파크힐스': 'e편한세상금호파크힐스',
};

// 로마숫자(Ⅰ~Ⅹ) → 아라비아숫자. 국토부 실거래명에 "센트레빌Ⅱ"처럼 로마숫자로
// 표기된 단지가 있는데, 네이버·호갱노노에는 "센트레빌2차"처럼 아라비아숫자로
// 등록돼 있어 로마숫자 그대로 검색하면 결과가 0건으로 뜬다.
const ROMAN_MAP = { 'Ⅰ':'1','Ⅱ':'2','Ⅲ':'3','Ⅳ':'4','Ⅴ':'5','Ⅵ':'6','Ⅶ':'7','Ⅷ':'8','Ⅸ':'9','Ⅹ':'10',
                    'ⅰ':'1','ⅱ':'2','ⅲ':'3','ⅳ':'4','ⅴ':'5','ⅵ':'6','ⅶ':'7','ⅷ':'8','ⅸ':'9','ⅹ':'10' };

// 구 없이 이름만으로 검색하면 엉뚱한 단지가 잡히는 흔한 단지명(서울 전역 다수 존재).
// 이런 이름만 지역(동/구)을 함께 붙여 구분하고, 나머지 고유한 브랜드명은 이름만으로
// 검색해 "구 + 풀네임"이 너무 좁아 0건이 뜨는 문제를 피한다.
const COMMON_APT_NAMES = new Set([
  '현대','삼성','우성','대림','한신','두산','쌍용','보람','경남','신동아','동아','럭키',
  '청구','삼익','미성','진흥','벽산','한양','삼부','극동','신성','성원','대우','롯데',
  '한일','태영','동부','서희','한라','금호','건영','우방','삼호','신안','풍림','대주',
]);

// 단지명을 네이버 검색에 맞게 정규화 (괄호·동번호·시공사 병기·로마숫자 제거/변환)
function normalizeAptName(name) {
  if (NAVER_ALIAS[name]) return NAVER_ALIAS[name];
  let n = name;
  for (const [r, a] of Object.entries(ROMAN_MAP)) n = n.split(r).join(a);
  return n
    .replace(/\([^)]*\)/g, '')       // (삼성), (336), (200-0) 등 괄호 제거
    .replace(/\d+동\s*~\s*\d+동/g, '') // 101동~116동 동범위 제거
    .replace(/,/g, ' ')              // 쉼표 → 공백
    .replace(/e-편한세상/gi, 'e편한세상')
    .replace(/이편한세상/g, 'e편한세상')
    .replace(/\s+/g, ' ')
    .trim();
}

// 검색어 생성: "동"(법정동) 정보가 있으면 항상 붙인다 — 구보다 훨씬 좁은 단위라
// "현대"·"주공10"처럼 흔한 이름도 정확히 구분되면서, 고유 브랜드명에도 붙여서
// 나쁠 게 없다(오히려 동명 단지가 다른 동네에도 있는 경우를 막아줌).
// dong이 없는 예외적인 경우에만: 흔한 이름은 구라도 붙이고, 고유한 이름은
// 지역 없이 이름만 넘겨 "구+풀네임"이 너무 좁아 0건이 뜨는 걸 피한다.
function naverSearchTerm(district, aptName, dong) {
  const name = normalizeAptName(aptName);
  const core = name.replace(/\s+/g, '');   // 공백 제거한 순수 글자 길이로 고유성 판단
  const isCommon = COMMON_APT_NAMES.has(core) || core.length <= 4;
  const area = dong || (isCommon ? district : '');
  return area ? `${area} ${name}`.trim() : name;
}

// 네이버 지도(위치 확인). 좌표 중심으로 열어 항상 정확한 위치 표시.
function naverMapUrl(district, aptName, dong, lat, lng) {
  const label = encodeURIComponent(normalizeAptName(aptName));
  if (lat && lng) return `https://map.naver.com/p?lat=${lat}&lng=${lng}&title=${label}&level=2`;
  return `https://map.naver.com/p/search/${encodeURIComponent(naverSearchTerm(district, aptName, dong))}`;
}

// 네이버 부동산(매물). 고유 단지명은 이름만, 흔한 이름은 지역+이름으로 검색.
// (단지 고유번호로 직접 연결하는 방식은 시도했으나, 네이버 검색 API가 GitHub
// Actions IP를 rate-limit(429)으로 계속 막아 안정적으로 수집할 수 없어 포기함)
// 좌표/이름이 전혀 없으면 네이버 부동산 홈으로 폴백.
function naverLandUrl(district, aptName, dong, lat, lng) {
  const term = naverSearchTerm(district, aptName, dong);
  if (!term) return `https://m.land.naver.com/`;
  return `https://m.land.naver.com/search/result/${encodeURIComponent(term)}`;
}

// 호갱노노. 좌표가 있으면 좌표 중심 지도로, 없으면 이름 검색(로마숫자·고유성 로직 공유).
function hogangnonoUrl(district, aptName, dong, lat, lng) {
  if (lat && lng) return `https://hogangnono.com/?zoom=16&lat=${lat}&lng=${lng}`;
  return `https://hogangnono.com/search/${encodeURIComponent(naverSearchTerm(district, aptName, dong))}`;
}

const askKey = a => `ask|${a.district}|${a.apt_name}`;
const getAsk = a => { const v = localStorage.getItem(askKey(a)); return v ? parseFloat(v) : null; };

let explorerMap = null;
let explorerMarkers = [];
let explorerApts = [];
let explorerVisible = [];
let explorerFilter = { min: 0, max: 9999 };

const shortName = n => n.length > 8 ? n.slice(0, 7) + '…' : n;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371, p = Math.PI / 180;
  const a = Math.sin((lat2-lat1)*p/2)**2 +
            Math.cos(lat1*p) * Math.cos(lat2*p) * Math.sin((lng2-lng1)*p/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

/* ── 커플 도구: 통근 모드 (기본 직장 위치 고정) ─────────── */
const DEFAULT_COMMUTE = {
  A: [37.5763, 126.9830],   // 💼 나: 종로구 율곡로2길 25 (안국역 서측 ~200m)
  B: [37.5608, 127.0045],   // 💗 여자친구: CJ제일제당센터, 중구 동호로 330 (동대입구역 북측)
};
// 키 버전 v2: 구버전에서 테스트로 찍어둔 위치가 기본값을 덮어쓰던 문제 방지
let commutePoints = { ...DEFAULT_COMMUTE, ...JSON.parse(localStorage.getItem('commutePoints_v2') || '{}') };
let commuteMarkers = {};
let placingWork = null;

function commuteInfo(a) {
  const parts = [];
  let total = 0, n = 0;
  for (const key of ['A', 'B']) {
    const pt = commutePoints[key];
    if (pt) {
      const km = haversineKm(a.lat, a.lng, pt[0], pt[1]);
      parts.push(`${key === 'A' ? '💼' : '💗'} ${km.toFixed(1)}km`);
      total += km; n++;
    }
  }
  return n ? { label: parts.join(' · '), total } : null;
}

function initCoupleTools() {
  const hint = document.getElementById('commuteHint');
  document.getElementById('setWorkA').addEventListener('click', () => {
    placingWork = 'A'; hint.textContent = '지도를 클릭해 내 직장 위치를 다시 지정하세요.';
  });
  document.getElementById('setWorkB').addEventListener('click', () => {
    placingWork = 'B'; hint.textContent = '지도를 클릭해 여자친구 직장 위치를 다시 지정하세요.';
  });
  document.getElementById('resetWork').addEventListener('click', () => {
    commutePoints = { ...DEFAULT_COMMUTE };
    localStorage.removeItem('commutePoints_v2');
    Object.keys(commutePoints).forEach(drawCommuteMarker);
    hint.textContent = '기본값(율곡로2길 25 / CJ제일제당센터)으로 복원했습니다.';
    applyPriceFilter(explorerFilter.min, explorerFilter.max);
  });

  explorerMap.on('click', e => {
    if (!placingWork) return;
    const key = placingWork;
    commutePoints[key] = [e.latlng.lat, e.latlng.lng];
    localStorage.setItem('commutePoints_v2', JSON.stringify(commutePoints));
    drawCommuteMarker(key);
    placingWork = null;
    hint.textContent = `직장 ${key === 'A' ? '(나)' : '(여자친구)'} 위치를 변경했습니다.`;
    applyPriceFilter(explorerFilter.min, explorerFilter.max);
  });

  Object.keys(commutePoints).forEach(drawCommuteMarker);
}

/* ── 예산 플래너 (financeCalculator.js 유틸 기반, 반응형) ── */
let lastAnalysis = null;

// 개인별 대출상품 select 초기화 (기본: 일반 주담대)
function initProductSelect(prefix) {
  const sel = document.getElementById(prefix + 'Product');
  sel.innerHTML = LOAN_PRODUCTS.map(p =>
    `<option value="${p.id}" title="${p.note}">${p.name} · ${(p.rate*100).toFixed(2)}%</option>`
  ).join('');
  sel.value = 'bank';
  const applyDefaults = () => {
    const p = LOAN_PRODUCTS.find(x => x.id === sel.value);
    document.getElementById(prefix + 'Rate').value = (p.rate * 100).toFixed(2);
    document.getElementById(prefix + 'Years').value = p.years;
  };
  applyDefaults();
  sel.addEventListener('change', () => { applyDefaults(); recalcBudget(); });
}

function initBudgetPlanner() {
  if (!document.getElementById('aCash')) return;   // 예산 플래너 페이지 아님
  initProductSelect('a');
  initProductSelect('b');

  // 모든 입력에 반응형 바인딩 (입력 즉시 재계산)
  ['aCash','aParent','aIncome','aNetMonthly','aRate','aYears','aBasicOn','aMarriageOn','aOtherDebt',
   'bCash','bParent','bIncome','bNetMonthly','bRate','bYears','bBasicOn','bMarriageOn','bOtherDebt',
   'repayType','familyYears','optBirth','optFirstHome','optRegulated'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', recalcBudget);
    if (el) el.addEventListener('change', recalcBudget);
  });

  // 대출 시뮬레이터 슬라이더: 사용자가 직접 움직인 값을 기억해두었다가
  // 다음 재계산에서도 유지한다 (다른 입력이 바뀌어 한도가 변해도 유지, 단 새 한도 초과 시 clamp).
  ['a', 'b'].forEach(prefix => {
    const slider = document.getElementById(prefix + 'LoanOverride');
    if (!slider) return;
    slider.addEventListener('input', () => {
      loanOverrideState[prefix] = parseFloat(slider.value) || 0;
      recalcBudget();
    });
  });

  // 무이자 차용 슬라이더: 줄이면 그만큼 "그 외 증여"로 넘어가도록 recalcBudget에서 재분배한다.
  ['a', 'b'].forEach(prefix => {
    const slider = document.getElementById(prefix + 'FamilyLoanOverride');
    if (!slider) return;
    slider.addEventListener('input', () => {
      familyLoanOverrideState[prefix] = parseFloat(slider.value) || 0;
      recalcBudget();
    });
    // 금액 직접 입력 칸(억) — 슬라이더와 양방향 동기화, 상한(슬라이더 max) 초과분은 잘라낸다
    const num = document.getElementById(prefix + 'FamilyLoanNum');
    if (num) num.addEventListener('input', () => {
      const won = Math.max(0, (parseFloat(num.value) || 0) * 1e8);
      familyLoanOverrideState[prefix] = Math.min(won, parseFloat(slider.max) || 0);
      recalcBudget();
    });
  });

  // ── 매매/전세 모드 토글 ──
  const jSel = document.getElementById('jProduct');
  if (jSel) {
    jSel.innerHTML = JEONSE_LOAN_PRODUCTS.map(pd =>
      `<option value="${pd.id}">${pd.name} · 기본 ${(pd.rate * 100).toFixed(2)}%</option>`).join('');
    jSel.value = 'butumok_newly';
    const syncJRate = () => {
      const pd = JEONSE_LOAN_PRODUCTS.find(x => x.id === jSel.value);
      document.getElementById('jRate').value = (pd.rate * 100).toFixed(2);
      recalcBudget();
    };
    jSel.addEventListener('change', syncJRate);
    document.getElementById('jRate').value = (JEONSE_LOAN_PRODUCTS[0].rate * 100).toFixed(2);
  }
  ['jRate', 'jMove', 'jInsure'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.addEventListener('input', recalcBudget); el.addEventListener('change', recalcBudget); }
  });
  const jSlider = document.getElementById('jTarget');
  if (jSlider) jSlider.addEventListener('input', () => {
    jTargetState = parseFloat(jSlider.value) || 0;
    recalcBudget();
  });
  document.querySelectorAll('#budgetModeToggle .legend-mode-btn').forEach(btn =>
    btn.addEventListener('click', () => applyBudgetMode(btn.dataset.mode)));
  document.querySelectorAll('#marriedToggle .legend-mode-btn').forEach(btn =>
    btn.addEventListener('click', () => applyMarried(btn.dataset.married === '1')));
  applyMarried(budgetMarried, true);   // 저장된 혼인신고 상태 복원
  restoreBudgetInputs();   // 마지막으로 저장된 입력값을 기본값으로 복원
  applyBudgetMode(localStorage.getItem('budgetMode_v1') || 'buy', true);
  initGiftView();

  renderLegalAccordion();
  renderReferences();
  renderRateSources();
  renderGiftTaxTable();
  recalcBudget();
}

let budgetMode = 'buy';
let budgetMarried = localStorage.getItem('budgetMarried_v1') !== '0';   // 기본: 혼인신고 완료(합산)
let jTargetState = null;   // 목표 전세금 슬라이더 (null=자동: 최대치의 90% 수준)

function applyBudgetMode(mode, skipRecalc) {
  budgetMode = mode === 'jeonse' ? 'jeonse' : 'buy';
  localStorage.setItem('budgetMode_v1', budgetMode);
  document.querySelectorAll('#budgetModeToggle .legend-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === budgetMode));
  document.querySelectorAll('[data-bmode]').forEach(el => {
    el.style.display = el.dataset.bmode === budgetMode ? '' : 'none';
  });
  if (!skipRecalc) recalcBudget();
}

function applyMarried(married, skipRecalc) {
  budgetMarried = !!married;
  localStorage.setItem('budgetMarried_v1', budgetMarried ? '1' : '0');
  document.querySelectorAll('#marriedToggle .legend-mode-btn').forEach(b =>
    b.classList.toggle('active', (b.dataset.married === '1') === budgetMarried));
  if (!skipRecalc) recalcBudget();
}

function renderGiftTaxTable() {
  const el = document.getElementById('giftTaxTable');
  if (!el) return;
  const T = GIFT_TAX_TABLE;
  el.innerHTML = `
    <div class="gt-formula">
      ${T.formula.map(f => `<div class="gt-f">${f}</div>`).join('')}
    </div>
    <div class="gt-two">
      <div class="gt-block">
        <div class="gt-sub">증여재산공제</div>
        <table class="gt-table">
          <tbody>${T.deductions.map(d => `<tr><td>${d.name}</td><td class="gt-amt">${d.amount}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="gt-block">
        <div class="gt-sub">세율표 (과세표준 구간별 · 상증세법 §26)</div>
        <table class="gt-table">
          <thead><tr><th>과세표준</th><th>세율</th><th>누진공제</th></tr></thead>
          <tbody>${T.brackets.map(b => `<tr><td>${b.base}</td><td class="gt-rate">${b.rate}</td><td>${b.deduct}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </div>
    <div class="gt-example">${T.example}</div>`;
}

function renderRateSources() {
  const el = document.getElementById('rateSourceList');
  if (!el) return;
  el.innerHTML = LOAN_RATE_SOURCES.map(r =>
    `<li><a href="${r.url}" target="_blank" rel="noopener">${r.name}</a> <span class="ref-org">${r.org}</span></li>`
  ).join('');
}

/* 세법·규제 근거 아코디언 */
function renderLegalAccordion() {
  const wrap = document.getElementById('legalAccordion');
  if (!wrap) return;
  const order = ['loan', 'family', 'gift', 'acq', 'broker', 'toho'];
  wrap.innerHTML = order.map(k => {
    const item = LEGAL_BASIS[k];
    return `
      <div class="legal-item" data-key="${k}">
        <button class="legal-q">${item.title}<span class="legal-caret">＋</span></button>
        <div class="legal-a">${item.body}</div>
      </div>`;
  }).join('');
  wrap.querySelectorAll('.legal-q').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = btn.closest('.legal-item');
      item.classList.toggle('open');
    });
  });

  // '?' 버튼 → 해당 항목으로 스크롤 + 펼치기
  document.querySelectorAll('.legal-link').forEach(b => {
    b.addEventListener('click', (e) => {
      e.preventDefault();
      const key = b.dataset.legal;
      const item = wrap.querySelector(`.legal-item[data-key="${key}"]`);
      if (item) {
        item.classList.add('open');
        // 세법 설명이 접이식 <details> 안에 있으면 먼저 펼쳐야 스크롤이 보인다
        const fold = item.closest('details.budget-fold');
        if (fold) fold.open = true;
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });
}

function personInput(prefix, common) {
  const num = id => parseFloat(document.getElementById(id).value) || 0;
  const 억 = 1e8, 만 = 1e4;
  const product = LOAN_PRODUCTS.find(p => p.id === document.getElementById(prefix + 'Product').value) || LOAN_PRODUCTS[3];
  const chkEl = id => document.getElementById(id);
  return {
    cash: num(prefix + 'Cash') * 억,
    parentTotal: num(prefix + 'Parent') * 억,   // 부모 지원 총액 (증여/차용 분해는 recalcBudget에서 처리)
    useBasic: chkEl(prefix + 'BasicOn') ? chkEl(prefix + 'BasicOn').checked : true,
    marriage: chkEl(prefix + 'MarriageOn') ? chkEl(prefix + 'MarriageOn').checked : false,
    income: num(prefix + 'Income') * 만,
    netMonthly: num(prefix + 'NetMonthly') * 만,   // 실수령 월급(세후)
    otherMonthly: num(prefix + 'OtherDebt') * 만,  // 기타대출 월 원리금(DSR 차감)
    product,
    rate: (num(prefix + 'Rate') / 100) || product.rate,
    years: parseInt(document.getElementById(prefix + 'Years').value) || product.years,
    familyYears: parseInt(document.getElementById('familyYears').value) || 10,
  };
}

// 대출 시뮬레이터 슬라이더 상태: null이면 "한도 최대치 사용"(기존 기본 동작)
const loanOverrideState = { a: null, b: null };
// 무이자 차용 슬라이더 상태: null이면 "한도(2.17억 또는 공제 후 잔액) 최대치 자동 사용"
const familyLoanOverrideState = { a: null, b: null };

// 각자의 소득 기준 최대 대출 가능액(dsrLoan)에 맞춰 슬라이더 상한/기본값을 동기화
function syncLoanSlider(prefix, maxLoan) {
  const slider = document.getElementById(prefix + 'LoanOverride');
  const maxLabel = document.getElementById(prefix + 'LoanMax');
  if (!slider) return;
  const maxRounded = Math.max(0, Math.round(maxLoan));
  slider.max = maxRounded;
  if (loanOverrideState[prefix] == null || loanOverrideState[prefix] > maxRounded) {
    loanOverrideState[prefix] = maxRounded;
  }
  slider.value = loanOverrideState[prefix];
  if (maxLabel) maxLabel.textContent = `최대 ${won2eok(maxLoan)}`;
}

// 공제 적용 후 남은 금액과 무이자 한도(2.17억) 중 작은 값에 맞춰 슬라이더 상한/기본값을 동기화
function syncFamilyLoanSlider(prefix, parentTotal, common) {
  const slider = document.getElementById(prefix + 'FamilyLoanOverride');
  if (!slider) return 0;
  const maxLoan = maxFamilyLoanFor(parentTotal, common);
  const maxRounded = Math.max(0, Math.round(maxLoan));
  slider.max = maxRounded;
  if (familyLoanOverrideState[prefix] == null || familyLoanOverrideState[prefix] > maxRounded) {
    familyLoanOverrideState[prefix] = maxRounded;
  }
  slider.value = familyLoanOverrideState[prefix];
  return maxLoan;
}

function recalcBudget() {
  const chk = id => document.getElementById(id).checked;
  const 억 = 1e8;

  const common = {
    birth: chk('optBirth'),
    firstHome: chk('optFirstHome'),
    regulated: chk('optRegulated'),
    repay: document.getElementById('repayType').value,
  };
  const inA = personInput('a', common);
  const inB = personInput('b', common);

  // 무이자 차용 슬라이더 동기화 후, 사용자가 정한 차용액으로 부모지원 총액을 분해
  // (줄이면 그만큼 "그 외 증여"로 넘어가 세금이 발생 — 총액 3가지 항목은 항상 보존)
  // 기본공제/혼인공제는 각자(useBasic/marriage) 설정, 출산공제는 공통(birth) 설정을 함께 반영
  const optsA = { marriage: inA.marriage, birth: common.birth, useBasic: inA.useBasic };
  const optsB = { marriage: inB.marriage, birth: common.birth, useBasic: inB.useBasic };
  syncFamilyLoanSlider('a', inA.parentTotal, optsA);
  syncFamilyLoanSlider('b', inB.parentTotal, optsB);
  const splitA = splitParentSupport(inA.parentTotal, { ...optsA, familyLoanOverride: familyLoanOverrideState.a });
  const splitB = splitParentSupport(inB.parentTotal, { ...optsB, familyLoanOverride: familyLoanOverrideState.b });
  inA.gift = splitA.totalGift; inA.family = splitA.familyLoan; inA.parentSplit = splitA;
  inB.gift = splitB.totalGift; inB.family = splitB.familyLoan; inB.parentSplit = splitB;

  // 소득만 기준으로 한 개인 최대 대출한도(LTV/주택가와 무관)를 슬라이더에 반영
  syncLoanSlider('a', personDsrLoan(inA));
  syncLoanSlider('b', personDsrLoan(inB));
  inA.loanOverride = loanOverrideState.a;
  inB.loanOverride = loanOverrideState.b;

  const R = analyzeCouple(inA, inB, common);
  lastAnalysis = R;

  // 대출 슬라이더 하단 읽기값: 실제 반영된 대출액·월 원리금·총이자
  // (LTV·규제지역 6억 캡 등으로 슬라이더에서 요청한 금액보다 실제 대출액이 낮아질 수 있어
  //  그 차이가 있을 때는 이유를 바로 아래에 표시한다)
  const updateLoanOut = (prefix, P) => {
    const out = document.getElementById(prefix + 'LoanOut');
    if (!out) return;
    const pm = calcMonthlyPayment(P.loan, P.rate || 0.041, P.years || 40, common.repay);
    let html = `대출액 <b>${won2eok(P.loan)}</b> <span class="ls-sep">·</span> 월 원리금 <b>${won2man(pm.first)}</b> <span class="ls-sep">·</span> 총이자 ${won2eok(pm.totalInterest)}`;
    const requested = loanOverrideState[prefix];
    if (requested != null && requested - P.loan > 1000000) {   // 100만원 넘게 깎였으면 이유 표시
      html += `<div class="ls-limit-note">⚠️ 요청한 ${won2eok(requested)}보다 적게 실행됩니다 — 대출은 소득(DSR)뿐 아니라
        "주택가 × LTV"도 함께 넘을 수 없는데, 현재 한도가 ${R.loanBind} 기준이라 주택가 쪽에서 막혔습니다.
        ${R.regulated ? '규제지역 체크로 LTV가 낮아져(70%→40%) 실행 가능한 대출액이 줄어든 것입니다.' : ''}</div>`;
    }
    out.innerHTML = html;
  };
  updateLoanOut('a', R.A);
  updateLoanOut('b', R.B);

  // DSR 게이지 — 네이버 DSR 계산기처럼 (주담대 + 기타대출) 원리금 ÷ 연소득 vs 40% 규제선
  const renderDsrGauge = (prefix, P) => {
    const el = document.getElementById(prefix + 'DsrGauge');
    if (!el) return;
    if (!P.income || P.income <= 0) { el.innerHTML = ''; return; }
    const pct = (P.dsrRatio || 0) * 100;
    const over = pct > 40;
    const near = !over && pct > 32;
    const color = over ? 'var(--red)' : near ? 'var(--gold)' : 'var(--green)';
    const houseW = P.dsrHousingMonthly * 12 / P.income * 100;
    const otherW = P.dsrOtherMonthly * 12 / P.income * 100;
    el.innerHTML = `
      <div class="dsr-head"><span>📊 DSR ${pct.toFixed(0)}%</span>
        <span class="dsr-verdict" style="color:${color}">${over ? '한도 초과 ⚠️' : '40% 이내 ✓'}</span></div>
      <div class="dsr-bar">
        <div class="dsr-fill dsr-house" style="width:${Math.min(100, houseW)}%"></div>
        <div class="dsr-fill dsr-other" style="width:${Math.min(100 - houseW, otherW)}%"></div>
        <div class="dsr-limit" style="left:40%"></div>
      </div>
      <div class="dsr-legend">
        <span><i class="dsr-dot dsr-house"></i>주담대 ${won2man(P.dsrHousingMonthly)}/월</span>
        ${P.dsrOtherMonthly > 0 ? `<span><i class="dsr-dot dsr-other"></i>기타대출 ${won2man(P.dsrOtherMonthly)}/월</span>` : ''}
        <span class="dsr-limit-lbl">규제선 40%</span>
      </div>
      <div class="dsr-note">연소득 ${won2man(P.income)}의 40%(연 ${won2man(P.income * 0.4)})까지 원리금 상환이 허용됩니다.
        기타대출이 있으면 그만큼 주담대 한도가 줄어듭니다.
        <a href="https://search.naver.com/search.naver?query=DSR+계산기" target="_blank" rel="noopener">네이버 DSR 계산기로 교차확인 ↗</a></div>`;
  };
  renderDsrGauge('a', R.A);
  renderDsrGauge('b', R.B);

  // 혼인신고 여부 안내 — DSR/대출은 불변, 세대·증여·청약에서만 차이
  const marriedNote = document.getElementById('marriedNote');
  if (marriedNote) marriedNote.innerHTML = budgetMarried
    ? `💍 <b>부부 1세대</b>로 봅니다 — 함께 사는 집은 1주택, 생애최초·취득세 감면은 세대 기준 1회 적용. 부부 사이 자금 이동은 증여세 없이 자유롭습니다(10년 6억 공제).`
    : `👫 <b>각자 세대</b>로 봅니다 — 공동명의로 함께 살 순 있지만, ⚠️ 한쪽 돈으로 상대 지분을 채우면 <b>커플 간 증여세</b>가 생길 수 있습니다(부부 아님). 생애최초·청약 자격은 각자 세대 기준으로 따로 판단하세요.`;

  // 원리금균등 vs 원금균등 실제 숫자 비교 + 유리 판정
  const rc = document.getElementById('repayCompare');
  if (rc) {
    // 두 사람이 서로 다른 대출상품(금리·만기)을 쓸 수 있으므로 각자 계산해 합산한다.
    const sumRepay = (kind) => [R.A, R.B].reduce((acc, P) => {
      const m = calcMonthlyPayment(P.loan || 0, P.rate || 0.041, P.years || 40, kind);
      return { first: acc.first + m.first, totalInterest: acc.totalInterest + m.totalInterest };
    }, { first: 0, totalInterest: 0 });
    if (R.loan > 0) {
      const an = sumRepay('annuity');
      const li = sumRepay('linear');
      const cur = document.getElementById('repayType').value;
      const saveInterest = an.totalInterest - li.totalInterest;   // 원금균등이 아끼는 총이자
      rc.innerHTML = `
        <table class="rc-table">
          <tr><th></th><th>원리금균등</th><th>원금균등</th></tr>
          <tr><td>첫 달 상환</td><td>${won2man(an.first)}</td><td>${won2man(li.first)}</td></tr>
          <tr><td>총 이자</td><td>${won2eok(an.totalInterest)}</td><td>${won2eok(li.totalInterest)}</td></tr>
        </table>
        <div class="rc-verdict">💡 <b>총이자</b>는 원금균등이 <b style="color:var(--green)">${won2eok(saveInterest)}</b> 적지만,
          <b>초기 월부담</b>은 원리금균등이 <b>${won2man(li.first - an.first)}</b> 가볍습니다.
          <br>· 월급이 일정하고 <b>매달 같은 금액</b>이 편하면 → <b>원리금균등</b>
          <br>· 초기 여유가 있고 <b>총이자 절감</b>·조기상환 계획이면 → <b>원금균등</b>
          <span style="color:var(--text3)">(현재 선택: ${cur === 'linear' ? '원금균등' : '원리금균등'})</span></div>`;
    } else { rc.innerHTML = ''; }
  }

  // 자금 카드에는 간략 요약만: 기본/혼인공제는 체크박스 자체가 상태를 보여주므로,
  // 여기서는 무이자차용 슬라이더 값 표시 + 한 줄 결론(세금 유무)만 갱신한다.
  // 슬라이더는 정적 엘리먼트라 매번 새로 만들지 않고 값만 갱신한다(드래그 중 초기화 방지).
  // 자세한 계산 과정(공제 분해·세율·상환방식)은 아래 renderParentDetail에서 별도로 보여준다.
  const renderParentCompact = (prefix, P) => {
    const valEl = document.getElementById(prefix + 'FamilyLoanVal');
    const conclusionEl = document.getElementById(prefix + 'ParentConclusion');
    const slider = document.getElementById(prefix + 'FamilyLoanOverride');
    if (!conclusionEl) return;
    const S = P.parentSplit;
    if (!S || P.parentTotal <= 0) { conclusionEl.innerHTML = ''; if (valEl) valEl.textContent = ''; return; }

    const conclusion = S.extraGift > 0
      ? `그 외 증여 ${won2eok(S.extraGift)} → 세금 <b>${won2man(P.giftDetail.tax)}</b>`
      : `공제 범위 내 → 증여세 <b>0원</b>`;

    if (valEl && slider) valEl.textContent = `/ 최대 ${won2eok(Math.max(0, Math.round(slider.max)))}`;
    // 직접 입력 칸도 현재 반영값으로 동기화 — 단, 사용자가 입력 중일 땐 건드리지 않는다
    const numEl = document.getElementById(prefix + 'FamilyLoanNum');
    if (numEl && document.activeElement !== numEl) numEl.value = (S.familyLoan / 1e8).toFixed(2).replace(/\.?0+$/, '') || '0';
    conclusionEl.innerHTML = conclusion;
  };
  renderParentCompact('a', R.A);
  renderParentCompact('b', R.B);
  renderParentDetail(R, document.getElementById('familyYears').value);

  // 각자 카드 하단 요약 (각자 가용자금 + 소득 대비 상환 비중)
  const personSummary = (P, label) => {
    const burden = (P.burdenPct * 100).toFixed(0);
    const bc = P.burdenPct > 0.40 ? '#f87171' : P.burdenPct > 0.30 ? '#fbbf24' : '#34d399';
    return `
    <div class="ps-title">${label} 가용자금 <b>${won2eok(P.contrib)}</b></div>
    <div class="ps-rows">
      <span>현금 ${won2eok(P.cash)}</span><span>증여(세후) ${won2eok(P.netGift)}</span>
      <span>부모차용 ${won2eok(P.family)}</span><span>대출 ${won2eok(P.loan)}</span>
    </div>
    <div class="ps-month">월 상환 <b>${won2man(P.monthly)}</b> = 은행 ${won2man(P.bankMonthly)} + 부모 ${won2man(P.familyMonthly)}
      · 세후월급 ${won2man(P.netMonthly)}의 <b style="color:${bc}">${burden}%</b></div>`;
  };
  document.getElementById('aSummary').innerHTML = personSummary(R.A, '💼 내');
  document.getElementById('bSummary').innerHTML = personSummary(R.B, '💗 여자친구');

  document.getElementById('budgetOutput').innerHTML = `
    <div class="br-main">
      <div class="br-headline">
        <span class="br-label">둘이 합치면 — 최대 매수 가능 주택가</span>
        <span class="br-price">${won2eok(R.maxPrice)}</span>
      </div>
      <button class="price-apply br-apply" id="budgetApply">이 예산으로 지도 필터 →</button>
    </div>
    <div class="br-stats">
      <div class="br-stat"><span class="brk">💼 내 기여</span><span class="brv">${won2eok(R.A.contrib)}</span><span class="brs">자본+차용+대출 ${won2eok(R.A.loan)}</span></div>
      <div class="br-stat"><span class="brk">💗 여자친구 기여</span><span class="brv">${won2eok(R.B.contrib)}</span><span class="brs">자본+차용+대출 ${won2eok(R.B.loan)}</span></div>
      <div class="br-stat"><span class="brk">합산 은행대출</span><span class="brv">${won2eok(R.loan)}</span><span class="brs">${R.loanBind} · LTV ${(R.ltv*100).toFixed(0)}%</span></div>
      <div class="br-stat"><span class="brk">합산 월 상환액</span><span class="brv">${won2man(R.totalMonthly)}</span><span class="brs">나 ${won2man(R.A.monthly)} + 여친 ${won2man(R.B.monthly)}</span></div>
    </div>
    ${(() => {
      // 매수 자금 구성 시각화: 자기자본(초록) + 은행대출(파랑) 스택바 + 세금·비용 캡션
      const tot = R.ownEquity + R.loan;
      if (!(tot > 0)) return '';
      const wEq = R.ownEquity / tot * 100;
      const costPct = R.maxPrice > 0 ? ((R.acqTax + R.brokerFee) / R.maxPrice * 100).toFixed(1) : '0';
      return `
      <div class="fundbar-legend" style="margin-top:.9rem">
        <span>🟢 자기자본 ${won2eok(R.ownEquity)}</span><span>🔵 은행대출 ${won2eok(R.loan)}</span>
        <span style="margin-left:auto">= 매수가 ${won2eok(R.maxPrice)}</span>
      </div>
      <div class="fundbar">
        <div style="width:${wEq}%;background:var(--green)">${wEq >= 15 ? '자기자본' : ''}</div>
        <div style="width:${100 - wEq}%;background:var(--acc2)">${100 - wEq >= 15 ? '은행대출' : ''}</div>
      </div>
      <div class="fundbar-caption">이 외 별도로 나가는 돈: 취득세 ${won2man(R.acqTax)} + 중개보수 ${won2man(R.brokerFee)}
        <b>(매수가의 ${costPct}%)</b> — 전세엔 없는 비용입니다.</div>`;
    })()}
    ${R.warnings.length ? `<div class="br-warns">${R.warnings.map(w => `<div class="budget-warn">⚠️ ${w}</div>`).join('')}</div>` : ''}
  `;
  document.getElementById('budgetApply').addEventListener('click', () => {
    // 멀티 페이지 구조: 예산 결과를 URL 파라미터로 넘겨 지도 탐색 페이지에서 필터 적용
    const eok = R.maxPrice / 억;
    window.location.href = `/?pmax=${eok.toFixed(1)}`;
  });

  renderBudgetBreakdown(R);
  renderBudgetChart(R);
  renderFundFlow(R);
  renderRepayDetail(R);
  renderJeonseBudget(R);   // 전세 모드 결과 (항상 계산, 모드에 따라 표시만)
  saveBudgetInputs();       // 입력값을 저장 — 다음 방문 때 기본값이 됨
  lastBudgetR = R;          // 부모님용 설명 화면에서 재사용
  if (document.getElementById('giftViewOverlay')?.style.display !== 'none') renderGiftView(gvPerson);
}

/* ── 예산 입력값 영속화: 한 번 넣은 숫자가 다음 방문의 기본값이 된다 ──
   #secBudget 안의 모든 number/select/checkbox를 id 기준으로 저장하고,
   슬라이더는 값이 recalc에서 재계산되므로 상태 변수 3종을 따로 저장한다. */
// v2: 기본값(현금·소득·부모지원 등)을 갱신하며 옛 저장분을 무시하도록 키 버전 상향.
// 이 이후 사용자가 바꾼 값은 다시 이 키에 저장되어 다음 방문의 기본값이 된다.
const BUDGET_STORE_KEY = 'budgetInputs_v2';

function _budgetFormEls() {
  return document.querySelectorAll('#secBudget input:not([type="range"]), #secBudget select');
}
function saveBudgetInputs() {
  const els = {};
  _budgetFormEls().forEach(el => {
    if (!el.id || el.readOnly) return;
    els[el.id] = el.type === 'checkbox' ? el.checked : el.value;
  });
  localStorage.setItem(BUDGET_STORE_KEY, JSON.stringify({
    els,
    loan: loanOverrideState,
    familyLoan: familyLoanOverrideState,
    jTarget: jTargetState,
  }));
}
function restoreBudgetInputs() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(BUDGET_STORE_KEY) || 'null'); } catch (e) { return; }
  if (!saved) return;
  _budgetFormEls().forEach(el => {
    if (!el.id || !(el.id in (saved.els || {}))) return;
    if (el.type === 'checkbox') el.checked = !!saved.els[el.id];
    else el.value = saved.els[el.id];
  });
  if (saved.loan) Object.assign(loanOverrideState, saved.loan);
  if (saved.familyLoan) Object.assign(familyLoanOverrideState, saved.familyLoan);
  if (saved.jTarget != null) jTargetState = saved.jTarget;
}

/* ── 👨‍👩‍👧 부모님께 보여드리는 증여·차용 쉬운 설명 화면 ──────
   예산 계산 결과(R)를 그대로 써서, 지원금이 어떻게 나뉘고 세금·월 상환이
   얼마인지 큰 글씨 도식으로 보여준다. 인쇄(저장)도 지원. */
let lastBudgetR = null;
let gvPerson = 'a';

function renderGiftView(p) {
  const body = document.getElementById('gvBody');
  if (!body || !lastBudgetR) return;
  gvPerson = p;
  const P = lastBudgetR[p === 'a' ? 'A' : 'B'];
  const years = parseInt(document.getElementById('familyYears')?.value) || 10;
  const S = P.parentSplit;
  const who = p === 'a' ? '아들' : '딸';

  if (!S || P.parentTotal <= 0) {
    body.innerHTML = `<div class="gv-hero">이쪽 부모님 지원 금액이 0원으로 설정되어 있습니다 — 예산 화면에서 금액을 입력하면 여기에 설명이 나타납니다.</div>`;
    return;
  }
  const tax = S.extraGift > 0 ? P.giftDetail.tax : 0;

  const part = (icon, title, amount, note, cls) => `
    <div class="gv-part ${cls || ''}">
      <div class="gv-part-head"><span class="gv-part-icon">${icon}</span><span class="gv-part-title">${title}</span></div>
      <div class="gv-part-amt">${won2eok(amount)}</div>
      <div class="gv-part-note">${note}</div>
    </div>`;

  const parts = [];
  if (S.basicGift > 0) parts.push(part('🎁', '그냥 주시는 돈 ① 기본 공제', S.basicGift,
    `<b>세금 0원</b> — 부모가 성인 자녀에게 10년 동안 5천만원까지는 세금 없이 줄 수 있습니다.`));
  if (S.bonusGift > 0) parts.push(part('💒', '그냥 주시는 돈 ② 결혼 공제', S.bonusGift,
    `<b>세금 0원</b> — 혼인신고 전후 2년 안에 주시면 1억까지 추가로 비과세입니다 (2024년 신설).`));
  if (S.familyLoan > 0) parts.push(part('🤝', '빌려주시는 돈 (차용증 작성)', S.familyLoan,
    `<b>세금 0원</b> — 증여가 아니라 빚이라서 세금이 없습니다. 대신 ${who}이(가) 부모님께
     <b>매달 ${won2man(P.familyMonthly)}씩 ${years}년</b> 동안 실제로 갚습니다 (계좌이체 기록 유지).`));
  if (S.extraGift > 0) parts.push(part('📋', '그 외 증여 (과세)', S.extraGift,
    `공제 한도를 넘는 부분이라 증여세 <b>${won2man(P.giftDetail.tax)}</b>이 나옵니다.
     계산: 과세표준 ${won2eok(P.giftDetail.taxable)} × ${(P.giftDetail.rate * 100).toFixed(0)}% − 누진공제, 자진신고 3% 할인 적용.`, 'gv-taxed'));

  body.innerHTML = `
    <div class="gv-hero">
      부모님이 도와주시는 돈 <b class="gv-hero-amt">${won2eok(P.parentTotal)}</b><br>
      <span class="gv-hero-sub">아래처럼 나누면 증여세가 ${tax > 0 ? `<b>${won2man(tax)}</b>로 최소화됩니다` : '<b>0원</b>입니다'}</span>
    </div>

    <div class="gv-flow">
      <div class="gv-src">👪<br>부모님 지원<br><b>${won2eok(P.parentTotal)}</b></div>
      <div class="gv-arrow">➜</div>
      <div class="gv-parts">${parts.join('')}</div>
    </div>

    <div class="gv-summary">
      <div class="gv-stat"><span class="gv-sk">내야 하는 증여세</span><span class="gv-sv" style="color:${tax > 0 ? 'var(--red)' : 'var(--green)'}">${tax > 0 ? won2man(tax) : '0원'}</span></div>
      <div class="gv-stat"><span class="gv-sk">매달 부모님께 갚는 돈</span><span class="gv-sv">${won2man(P.familyMonthly)}</span></div>
      <div class="gv-stat"><span class="gv-sk">갚는 기간</span><span class="gv-sv">${S.familyLoan > 0 ? years + '년' : '—'}</span></div>
    </div>

    <div class="gv-notes">
      <div class="gv-note">📝 <b>차용증은 꼭 씁니다</b> — 금액·이자·상환 기간을 적고 공증(또는 내용증명·확정일자)을 받아두면 국세청 소명이 쉽습니다.</div>
      <div class="gv-note">🏦 <b>상환은 반드시 계좌이체로</b> — 매달 ${won2man(P.familyMonthly)}이 ${who} 통장에서 부모님 통장으로 자동이체되는 기록이 곧 증거입니다.</div>
      <div class="gv-note">⚖️ <b>무이자가 허용되는 이유</b> — 세법상 적정이자(연 4.6%)와의 차이가 연 1,000만원 미만이면 증여로 보지 않습니다. 빌리는 돈 ${won2eok(S.familyLoan)}은 이 범위 안입니다.</div>
      <div class="gv-note">👨‍💼 실행 전에 세무사 상담 한 번(10~20만원)을 권장드립니다 — 이 화면은 일반 규정 기준의 계산입니다.</div>
    </div>`;
}

function initGiftView() {
  const overlay = document.getElementById('giftViewOverlay');
  const openBtn = document.getElementById('giftViewOpen');
  if (!overlay || !openBtn) return;
  document.body.appendChild(overlay);   // 인쇄 시 오버레이만 남기기 위해 body 직속으로 이동

  openBtn.addEventListener('click', () => {
    overlay.style.display = '';
    document.body.classList.add('gift-open');
    renderGiftView(gvPerson);
  });
  document.getElementById('gvClose').addEventListener('click', () => {
    overlay.style.display = 'none';
    document.body.classList.remove('gift-open');
  });
  document.getElementById('gvPrint').addEventListener('click', () => window.print());
  document.querySelectorAll('#gvPersonToggle .legend-mode-btn').forEach(b =>
    b.addEventListener('click', () => {
      document.querySelectorAll('#gvPersonToggle .legend-mode-btn').forEach(x =>
        x.classList.toggle('active', x === b));
      renderGiftView(b.dataset.p);
    }));
}

/* ── 🔑 전세 자금 계획 — 매매와 분리된 비용 체계 ─────────────
   취득세·등기 없음. 자기자본(현금+부모지원 세후)과 전세대출로
   "최대 보증금"과 "목표 보증금 기준 여유자금"을 계산한다. */
function renderJeonseBudget(R) {
  const out = document.getElementById('jeonseOutput');
  if (!out) return;
  const 억 = 1e8, 만 = 1e4;
  const num = id => parseFloat(document.getElementById(id).value) || 0;

  // 자기자본 = (기여분 − 은행대출) 합 — 현금 + 부모지원(증여세 차감·차용 포함)
  const equity = (R.A.contrib - R.A.loan) + (R.B.contrib - R.B.loan);
  const product = JEONSE_LOAN_PRODUCTS.find(x => x.id === document.getElementById('jProduct').value) || JEONSE_LOAN_PRODUCTS[0];
  const rate = (num('jRate') / 100) || product.rate;
  const move = num('jMove') * 만;
  const insureOn = document.getElementById('jInsure').checked;

  const maxJ = maxJeonseBudget(equity, product, move);

  // 목표 보증금 슬라이더 동기화 (기본: 최대치의 90% — 여유자금이 보이도록)
  const slider = document.getElementById('jTarget');
  const maxRounded = Math.round(maxJ / 1e7) * 1e7;
  slider.max = maxRounded;
  if (jTargetState == null || jTargetState > maxRounded) jTargetState = Math.round(maxRounded * 0.9 / 1e7) * 1e7;
  slider.value = jTargetState;
  document.getElementById('jTargetMax').textContent = `최대 ${won2eok(maxJ)}`;
  const J = jTargetState;
  document.getElementById('jTargetOut').textContent = `${won2eok(J)} 전세를 구한다면?`;

  const loan = jeonseLoanFor(J, product);
  const selfNeed = Math.max(0, J - loan);
  const broker = calcJeonseBroker(J);
  const spare = equity - selfNeed - broker - move;

  const loanInterestM = loan * rate / 12;                       // 만기일시(이자만)
  const familyM = (R.A.familyMonthly || 0) + (R.B.familyMonthly || 0);
  const insureM = insureOn ? J * JEONSE_INSURE_RATE / 12 : 0;
  const totalM = loanInterestM + familyM + insureM;
  const netM = (R.A.netMonthly || 0) + (R.B.netMonthly || 0);
  const burden = netM > 0 ? (totalM / netM * 100) : 0;

  const wSelf = J > 0 ? (selfNeed / J * 100) : 0;
  const capNote = loan >= product.cap - 1 ? '상품 한도 도달' : `보증금의 ${(product.ratio * 100).toFixed(0)}%`;
  const warns = [];
  if (J > (product.condCapJ ?? Infinity)) warns.push(`${product.name}은 보증금 ${won2eok(product.condCapJ)} 이하만 가능 — 이 보증금에선 대출이 안 나옵니다. 상품을 바꿔보세요.`);
  if (spare < 0) warns.push(`목표 보증금이 자금을 ${won2eok(-spare)} 초과합니다 — 보증금을 낮추거나 대출 상품을 확인하세요.`);

  const row = (k, v, sub) => `<div class="jb-row"><span>${k}</span><span><b>${v}</b>${sub ? ` <small style="color:var(--text3)">${sub}</small>` : ''}</span></div>`;

  out.innerHTML = `
    <div class="br-main">
      <div class="br-headline">
        <span class="br-label">둘이 합치면 — 최대 전세 보증금</span>
        <span class="br-price">${won2eok(maxJ)}</span>
      </div>
      <button class="price-apply br-apply" id="jeonseApply">이 예산으로 전세 추천 보기 →</button>
    </div>

    <div class="fundbar-legend">
      <span>🟢 우리 돈 ${won2eok(selfNeed)}</span><span>🔵 전세대출 ${won2eok(loan)} <small>(${capNote})</small></span>
      <span style="margin-left:auto">= 목표 보증금 ${won2eok(J)}</span>
    </div>
    <div class="fundbar">
      <div style="width:${wSelf}%;background:var(--green)">${wSelf >= 15 ? '우리 돈' : ''}</div>
      <div style="width:${100 - wSelf}%;background:var(--acc2)">${100 - wSelf >= 15 ? '전세대출' : ''}</div>
    </div>

    <div class="br-stats" style="margin-top:.9rem">
      <div class="br-stat"><span class="brk">💰 남는 여유자금</span>
        <span class="brv" style="color:${spare >= 0 ? 'var(--green)' : 'var(--red)'}">${won2eok(spare)}</span>
        <span class="brs">자기자본 ${won2eok(equity)} 중 보증금·비용 제외</span></div>
      <div class="br-stat"><span class="brk">월 부담 합계</span><span class="brv">${won2man(totalM)}</span>
        <span class="brs">세후월급 합의 ${burden.toFixed(1)}%</span></div>
      <div class="br-stat"><span class="brk">전세대출 이자</span><span class="brv">${won2man(loanInterestM)}/월</span>
        <span class="brs">${(rate * 100).toFixed(2)}% 만기일시</span></div>
      <div class="br-stat"><span class="brk">부모 차용 상환</span><span class="brv">${won2man(familyM)}/월</span>
        <span class="brs">무이자 원금분할</span></div>
    </div>

    <div style="margin-top:1rem">
      <div class="budget-card-title" style="font-size:.92rem">🧾 전세에서 나가는 돈 (매매와 다릅니다)</div>
      ${row('중개보수 (임대차 요율)', won2man(broker), '1회')}
      ${row('이사·기타 비용', won2man(move), '1회')}
      ${insureOn ? row('전세보증금 반환보증 보험료', won2man(J * JEONSE_INSURE_RATE) + '/년', 'HUG 연 0.128%') : ''}
      ${row('취득세 · 등기비용', '<span class="jb-zero">0원 ✓</span>', '전세는 소유권 이전이 없어 없음')}
      ${row('보증금 ' + won2eok(J), '계약 종료 시 회수', '반환보증 가입 시 안전')}
    </div>
    ${warns.length ? `<div class="br-warns" style="margin-top:.8rem">${warns.map(w => `<div class="budget-warn">⚠️ ${w}</div>`).join('')}</div>` : ''}
  `;
  document.getElementById('jeonseApply')?.addEventListener('click', () => {
    // 전세 맞춤 1위 페이지의 예산 필터에 그대로 반영
    localStorage.setItem('jeonseBudget_v1', JSON.stringify({ min: null, max: +(maxJ / 억).toFixed(1) }));
    window.location.href = '/jeonse-top1';
  });
}

// 부모님 지원 상세: 기본공제 → 혼인·출산공제 → 무이자 차용 → 과세 증여 순 분해 +
// 증여세 계산식 + 무이자 차용 원리금 상환 방식을 사람별로 자세히 보여준다.
function renderParentDetail(R, familyYears) {
  const el = document.getElementById('parentDetail');
  if (!el) return;
  const years = parseInt(familyYears) || 10;

  const block = (P, label, color) => {
    const S = P.parentSplit;
    if (!S || P.parentTotal <= 0) return '';
    const gd = P.giftDetail;

    const parts = [];
    if (S.basicGift > 0) parts.push(`기본공제(직계존속→성년자녀·10년합산) ${won2eok(S.basicGift)}`);
    if (S.bonusGift > 0) parts.push(`혼인·출산공제 ${won2eok(S.bonusGift)}`);
    if (S.familyLoan > 0) parts.push(`무이자 차용 ${won2eok(S.familyLoan)}`);
    if (S.extraGift > 0) parts.push(`그 외 증여(과세) ${won2eok(S.extraGift)}`);
    const overMsg = P.familyOverLimit ? ` <span style="color:#f87171">(무이자 한도 ${won2eok(FAMILY_LOAN.MAX_NO_INTEREST)} 초과분은 과세 증여로 처리됨)</span>` : '';

    const taxLine = S.extraGift > 0
      ? `과세표준 ${won2eok(gd.taxable)} × 세율 ${(gd.rate * 100).toFixed(0)}% − 누진공제 ${won2man(gd.bracketDeduct)}
         = 산출세액 ${won2man(gd.grossTax)} → 신고세액공제 3% 적용 후 증여세 <b>${won2man(gd.tax)}</b>`
      : `과세표준 0원 → 증여세 없음`;

    const loanLine = S.familyLoan > 0
      ? `무이자 차용 ${won2eok(S.familyLoan)}은 빚이므로 상환해야 합니다 — 원금균등(무이자) ${years}년 분할,
         월 <b>${won2man(P.familyMonthly)}</b>씩 부모님께 갚습니다.
         (연 4.6% 적정이자 대비 이자 절감분이 연 1,000만원 미만이라 증여세 없음)`
      : '';

    return `
      <div class="pd-person">
        <div class="pd-head"><span class="pd-name" style="color:${color}">${label}</span>
          <span class="pd-total">부모 지원 ${won2eok(P.parentTotal)}</span></div>
        <div class="pd-parts">${parts.join(' + ')}${overMsg}</div>
        <div class="pd-line">🧾 ${taxLine}</div>
        ${loanLine ? `<div class="pd-line">👪 ${loanLine}</div>` : ''}
      </div>`;
  };

  const html = block(R.A, '💼 나', '#818cf8') + block(R.B, '💗 여자친구', '#f472b6');
  el.innerHTML = html || `<div class="empty-state" style="padding:1.2rem">부모 지원 총액을 입력하면 여기에 자세한 계산 과정이 표시됩니다.</div>`;
}

// 월 상환 상세: 누구에게 얼마가 나가고, 각자 월급 대비 몇 %인지
function renderRepayDetail(R) {
  const el = document.getElementById('repayDetail');
  if (!el) return;
  const row = (P, label, color) => {
    const burden = (P.burdenPct * 100).toFixed(0);
    const bc = P.burdenPct > 0.40 ? '#f87171' : P.burdenPct > 0.30 ? '#fbbf24' : '#34d399';
    const barW = Math.min(100, P.burdenPct * 100);
    return `
      <div class="rp-person">
        <div class="rp-head"><span class="rp-name" style="color:${color}">${label}</span>
          <span class="rp-total">${won2man(P.monthly)}/월</span></div>
        <div class="rp-lines">
          <div class="rp-line"><span>🏦 은행 대출 상환</span><b>${won2man(P.bankMonthly)}</b></div>
          <div class="rp-line"><span>👪 부모님께 원금 상환</span><b>${won2man(P.familyMonthly)}</b></div>
        </div>
        <div class="rp-burden">
          <div class="rp-bar"><div class="rp-fill" style="width:${barW}%;background:${bc}"></div></div>
          <div class="rp-burden-txt">실수령 월급 ${won2man(P.netMonthly)} 중 <b style="color:${bc}">${burden}%</b>가 상환에 쓰입니다</div>
        </div>
      </div>`;
  };
  const totalIncome = R.A.netMonthly + R.B.netMonthly;
  const totalBurden = totalIncome > 0 ? (R.totalMonthly / totalIncome * 100).toFixed(0) : 0;
  el.innerHTML = `
    <div class="rp-grid">
      ${row(R.A, '💼 나', '#818cf8')}
      ${row(R.B, '💗 여자친구', '#f472b6')}
    </div>
    <div class="rp-summary">
      합산 월 상환 <b>${won2man(R.totalMonthly)}</b> · 두 사람 실수령 월급 합 ${won2man(totalIncome)}의 <b>${totalBurden}%</b>
      <span class="rp-note">실제 세후 월급 대비 상환 부담률입니다 (대출한도 DSR은 별도로 세전 연소득 기준으로 계산됨)</span>
    </div>`;
}

// 자금 흐름: 전체 자금 → 세금·부대비용 차감 → 자기자본 + 부모 + 대출 = 최대 매수가
function renderFundFlow(R) {
  const el = document.getElementById('fundFlow');
  if (!el) return;
  const fees = R.acqTax + R.brokerFee + R.giftTax;
  const step = (icon, label, val, sub, cls='') =>
    `<div class="ff-step ${cls}"><span class="ff-ic">${icon}</span>
       <div class="ff-body"><div class="ff-label">${label}</div>${sub?`<div class="ff-sub">${sub}</div>`:''}</div>
       <div class="ff-val">${val}</div></div>`;

  el.innerHTML = `
    <div class="ff-parts ff-parts-2">
      ${step('💼', '나의 동원 자금', won2eok(R.A.cash + R.A.netGift + R.A.family + R.A.loan),
          `현금 ${won2eok(R.A.cash)} · 증여(세후) ${won2eok(R.A.netGift)} · 부모차용 ${won2eok(R.A.family)} · 대출 ${won2eok(R.A.loan)}`)}
      ${step('💗', '여자친구 동원 자금', won2eok(R.B.cash + R.B.netGift + R.B.family + R.B.loan),
          `현금 ${won2eok(R.B.cash)} · 증여(세후) ${won2eok(R.B.netGift)} · 부모차용 ${won2eok(R.B.family)} · 대출 ${won2eok(R.B.loan)}`)}
    </div>
    <div class="ff-arrow">▼ 세금·부대비용 차감</div>
    ${step('🧾', '세금·부대비용', '− ' + won2man(fees),
        `증여세 ${won2man(R.giftTax)} · 취득세 ${won2man(R.acqTax)} · 중개비 ${won2man(R.brokerFee)}`, 'ff-minus')}
    <div class="ff-arrow">▼ 실제 매수에 투입</div>
    <div class="ff-parts">
      ${step('🙋', '합산 자기자본', won2eok(R.ownEquity), '두 사람 현금+세후증여')}
      ${step('👪', '부모 무이자 차용', won2eok(R.familyTotal), `원금만 상환 ${won2man(R.A.familyMonthly + R.B.familyMonthly)}/월`)}
      ${step('🏦', '합산 은행 대출', won2eok(R.loan), `${R.loanBind} · LTV ${(R.ltv*100).toFixed(0)}%${R.regulated?' 규제지역':''}`)}
    </div>
    <div class="ff-arrow ff-arrow-eq">= 최대 매수 가능</div>
    ${step('🏠', '최대 매수 가능 주택가', won2eok(R.maxPrice), R.regulated?'토지거래허가/규제지역 기준':'수도권 비규제 기준', 'ff-total')}
  `;
}

function renderReferences() {
  const el = document.getElementById('referenceList');
  if (!el) return;
  el.innerHTML = REFERENCES.map(r =>
    `<li><a href="${r.url}" target="_blank" rel="noopener">${r.name}</a> <span class="ref-org">${r.org}</span></li>`
  ).join('');
}

function renderBudgetBreakdown(R) {
  document.getElementById('budgetBreakdown').innerHTML = `
    <div class="budget-row"><span>취득세 ${(R.acqRate*100).toFixed(1)}%</span><b>${won2man(R.acqTax)}</b></div>
    <div class="budget-row"><span>중개보수 (상한)</span><b>${won2man(R.brokerFee)}</b></div>
    <div class="budget-row"><span>증여세 합계 (나 ${won2man(R.A.giftTax)} + 여친 ${won2man(R.B.giftTax)})</span><b>${won2man(R.giftTax)}</b></div>
    <div class="budget-row"><span>세후 증여 실수령 합계</span><b>${won2eok(R.netGift)}</b></div>
    <div class="budget-row"><span>부모차용 합계 (무이자 한도 각 ${won2eok(FAMILY_LOAN.MAX_NO_INTEREST)})</span><b>${won2eok(R.familyTotal)}</b></div>
    <div class="budget-row"><span>적용 LTV</span><b>${(R.ltv*100).toFixed(0)}%${R.regulated?' (규제지역)':''}</b></div>
    <div class="budget-note" style="margin-top:.6rem">부모 무이자 차용은 각자 ${won2eok(FAMILY_LOAN.MAX_NO_INTEREST)}까지 증여세 없이 원금만 상환하면 됩니다(차용증+이체기록 필요). 부대비용(취득세+중개비) ${won2man(R.acqTax + R.brokerFee)}는 자금에서 먼저 차감됩니다.</div>
  `;
}

function renderBudgetChart(R) {
  const c = R.composition;
  const div = document.getElementById('budgetChart');
  if (!div) return;

  // Plotly 미로딩 시 CSS 스택 막대로 대체
  if (typeof Plotly === 'undefined') {
    const total = c.cashGift + c.family + c.loan || 1;
    const seg = [
      ['자기자금(현금+증여)', c.cashGift, '#818cf8'],
      ['부모 차용', c.family, '#a78bfa'], ['은행 대출', c.loan, '#fbbf24'],
    ];
    div.innerHTML = `
      <div class="fallback-bar">
        ${seg.map(([n,v,col]) => v > 0 ? `<div class="fb-seg" style="width:${v/total*100}%;background:${col}" title="${n}"></div>` : '').join('')}
      </div>
      <div class="fallback-legend">
        ${seg.map(([n,v,col]) => `<div class="fb-leg"><span class="fb-dot" style="background:${col}"></span>${n} ${won2eok(v)} (${(v/total*100).toFixed(0)}%)</div>`).join('')}
      </div>`;
    return;
  }
  Plotly.react(div, [{
    type: 'pie', hole: 0.55,
    labels: ['자기자금', '부모 차용', '은행 대출'],
    customdata: ['자기자금(현금+증여)', '부모 차용', '은행 대출'],
    values: [c.cashGift, c.family, c.loan],
    marker: { colors: ['#818cf8', '#a78bfa', '#fbbf24'] },
    textinfo: 'label+percent', textposition: 'inside', insidetextorientation: 'horizontal',
    textfont: { color: '#334155', size: 11 },
    hovertemplate: '%{customdata}: %{value:,.0f}원<extra></extra>',
  }], {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: '#333d4b' }, showlegend: false,
    margin: { t: 10, b: 10, l: 10, r: 10 },
    annotations: [{ text: `${won2eok(R.maxPrice)}`, showarrow: false, font: { size: 16, color: '#f1f5f9' } }],
  }, { responsive: true, displayModeBar: false });
}

function drawCommuteMarker(key) {
  const pt = commutePoints[key];
  if (!pt) return;
  if (commuteMarkers[key]) explorerMap.removeLayer(commuteMarkers[key]);
  const icon = L.divIcon({
    className: '',
    html: `<div class="work-pin">${key === 'A' ? '💼 나' : '💗 여친'}</div>`,
    iconSize: [64, 26], iconAnchor: [32, 13],
  });
  commuteMarkers[key] = L.marker(pt, { icon }).addTo(explorerMap);
}

// 모든 지도 공용: 두 직장(💼 나 / 💗 여친) 위치를 항상 보이게 표시.
// 탐색 지도는 위치 재지정 기능이 있어 drawCommuteMarker를 그대로 쓰고,
// 나머지 지도(동네별·전세·구별)는 이 함수로 읽기 전용 마커만 얹는다.
function addWorkMarkers(map) {
  if (!map) return;
  ['A', 'B'].forEach(key => {
    const pt = commutePoints[key];
    if (!pt) return;
    const icon = L.divIcon({
      className: '',
      html: `<div class="work-pin">${key === 'A' ? '💼 나' : '💗 여친'}</div>`,
      iconSize: [64, 26], iconAnchor: [32, 13],
    });
    L.marker(pt, { icon, interactive: false, zIndexOffset: 900 }).addTo(map);
  });
}

/* ── 커플 대중교통 안내 (지하철역 좌표 기반) ─────────────── */
let _stationsCache = null;
async function loadStations() {
  if (_stationsCache === null) {
    try { _stationsCache = (await fetchJSON('/api/stations')).stations || []; }
    catch { _stationsCache = []; }
  }
  return _stationsCache;
}

function nearestStationTo(lat, lng, stations) {
  let best = null, bd = Infinity;
  stations.forEach(s => {
    const d = haversineKm(lat, lng, s.lat, s.lng);
    if (d < bd) { bd = d; best = s; }
  });
  return best ? { ...best, km: bd } : null;
}

// 같은 이름 역의 모든 노선 (환승역이면 여러 개) — '01호선' → '1호선' 정리
function stationLines(stations, name) {
  return [...new Set(stations.filter(s => s.name === name && s.line)
    .map(s => s.line.replace(/^0/, '')))];
}

// 네이버 지도 대중교통 길찾기 딥링크 (pathType=1 = 대중교통)
function naverTransitUrl(fromName, fromLat, fromLng, toName, toLat, toLng) {
  return `https://map.naver.com/index.nhn?menu=route&pathType=1`
    + `&sname=${encodeURIComponent(fromName)}&sx=${fromLng}&sy=${fromLat}`
    + `&ename=${encodeURIComponent(toName)}&ex=${toLng}&ey=${toLat}`;
}

// 매물 → 각자 직장 대중교통 안내 HTML을 (비동기로) 채워 넣는다.
// 실제 노선 탐색 API 없이도: 단지 최근접역 → 직장 최근접역 + 공통 노선 여부로
// "어느 역에서 타서 어디서 내리는지"의 뼈대를 보여주고, 정확한 경로는
// 네이버 대중교통 길찾기 딥링크로 연결한다.
async function fillCommuteTransit(elId, apt) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (apt.lat == null || apt.lng == null) { el.innerHTML = ''; return; }
  const stations = await loadStations();
  if (!stations.length) { el.innerHTML = ''; return; }

  const fromSt = apt.nearest_station
    ? { name: apt.nearest_station, walkMin: apt.walk_min != null ? Math.round(apt.walk_min) : null }
    : (() => { const s = nearestStationTo(apt.lat, apt.lng, stations);
               return s ? { name: s.name, walkMin: Math.round(s.km * 1000 / 67) } : null; })();

  const WORKS = [
    { key: 'A', emoji: '💼', label: '내 직장' },
    { key: 'B', emoji: '💗', label: '여자친구 직장' },
  ];
  const rows = WORKS.map(w => {
    const pt = commutePoints[w.key];
    if (!pt) return '';
    const toSt = nearestStationTo(pt[0], pt[1], stations);
    const directKm = haversineKm(apt.lat, apt.lng, pt[0], pt[1]);
    const link = naverTransitUrl(apt.apt_name, apt.lat, apt.lng, w.label, pt[0], pt[1]);

    let steps;
    if (fromSt && toSt) {
      const fromLines = stationLines(stations, fromSt.name);
      const toLines = stationLines(stations, toSt.name);
      const common = fromLines.filter(l => toLines.includes(l));
      const rideNote = fromSt.name === toSt.name
        ? '같은 역 생활권'
        : common.length ? `${common.join('·')} 한 번에` : '환승 1회 이상 예상';
      const toWalk = Math.round(toSt.km * 1000 / 67);
      steps = `
        <span class="ct-step">🏠 단지</span><span class="ct-arrow">도보 ${fromSt.walkMin ?? '?'}분</span>
        <span class="ct-step ct-stn">🚇 ${fromSt.name}</span><span class="ct-arrow">${rideNote}</span>
        <span class="ct-step ct-stn">🚇 ${toSt.name}</span><span class="ct-arrow">도보 ${toWalk}분</span>
        <span class="ct-step">${w.emoji} 직장</span>`;
    } else {
      steps = `<span class="ct-step">🏠 단지</span><span class="ct-arrow">직선 ${directKm.toFixed(1)}km</span><span class="ct-step">${w.emoji} 직장</span>`;
    }
    return `
    <div class="ct-row">
      <div class="ct-head">
        <span class="ct-who">${w.emoji} ${w.label}</span>
        <span class="ct-dist">직선 ${directKm.toFixed(1)}km</span>
        <a class="ct-link" href="${link}" target="_blank" rel="noopener">네이버 길찾기 ↗</a>
      </div>
      <div class="ct-steps">${steps}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="ct-box">
      <div class="ct-title">🚇 우리 회사 가는 길 <span class="ct-note">역 기준 안내 · 정확한 경로는 길찾기에서</span></div>
      ${rows}
    </div>`;
}
const eokFmt = v => v == null ? '—' : (v/10000 >= 10 ? (v/10000).toFixed(1) : (v/10000).toFixed(2)).replace(/\.?0+$/,'') + '억';

async function renderExplorer() {
  if (!document.getElementById('explorerMap')) return;   // 지도 탐색 페이지 아님
  const data = await fetchJSON('/api/apartments');
  explorerApts = (data.apartments || []).filter(a => a.lat && a.lng);

  explorerMap = L.map('explorerMap', { center: [37.545, 126.99], zoom: 11 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 18
  }).addTo(explorerMap);

  document.querySelectorAll('.price-chip').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.price-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('priceMin').value = '';
      document.getElementById('priceMax').value = '';
      applyPriceFilter(+btn.dataset.min, +btn.dataset.max);
    });
  });
  document.getElementById('priceApply').addEventListener('click', () => {
    document.querySelectorAll('.price-chip').forEach(b => b.classList.remove('active'));
    const mn = parseFloat(document.getElementById('priceMin').value) || 0;
    const mx = parseFloat(document.getElementById('priceMax').value) || 9999;
    applyPriceFilter(mn, mx);
  });
  document.getElementById('explorerSort').addEventListener('change', () => {
    applyPriceFilter(explorerFilter.min, explorerFilter.max);
  });
  document.querySelectorAll('.legend-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.legend-mode-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      bubbleColorMode = btn.dataset.mode;
      applyPriceFilter(explorerFilter.min, explorerFilter.max);
    });
  });

  initCoupleTools();
  // 예산 플래너에서 넘어온 URL 파라미터(?pmax=12.5) 적용
  const usp = new URLSearchParams(location.search);
  const pmin = parseFloat(usp.get('pmin')) || 0;
  const pmax = parseFloat(usp.get('pmax')) || 9999;
  if (usp.has('pmax') || usp.has('pmin')) {
    document.querySelectorAll('.price-chip').forEach(b => b.classList.remove('active'));
    if (usp.has('pmin')) document.getElementById('priceMin').value = pmin;
    if (usp.has('pmax')) document.getElementById('priceMax').value = pmax;
  }
  applyPriceFilter(pmin, pmax);
}

function sortApts(list) {
  const mode = document.getElementById('explorerSort').value;
  const s = [...list];
  if (mode === 'priceAsc')  s.sort((a,b) => a.latest_price - b.latest_price);
  else if (mode === 'priceDesc') s.sort((a,b) => b.latest_price - a.latest_price);
  else if (mode === 'mdd')  s.sort((a,b) => (b.mdd ?? -99) - (a.mdd ?? -99));
  else if (mode === 'commute') s.sort((a,b) => {
    const ca = commuteInfo(a), cb = commuteInfo(b);
    return (ca ? ca.total : 1e9) - (cb ? cb.total : 1e9);
  });
  else s.sort((a,b) => b.composite_score - a.composite_score);
  return s;
}

// 버블 색상 기준: 'score'(종합점수 구간) 또는 'price'(가격대 구간)
let bubbleColorMode = 'score';

const SCORE_TIERS = [
  { cls: 'bubble-hot',  label: '60점 이상', test: v => v >= 60 },
  { cls: 'bubble-mid',  label: '55~60점',   test: v => v >= 55 },
  { cls: 'bubble-cool', label: '55점 미만', test: () => true },
];
// 지도 탐색 가격 필터 구간(8/12/16억)과 동일한 경계를 사용해 필터 칩과 헷갈리지 않게 함
const PRICE_TIERS = [
  { cls: 'bubble-p1', label: '8억 이하',   test: v => v <= 8 },
  { cls: 'bubble-p2', label: '8~12억',     test: v => v <= 12 },
  { cls: 'bubble-p3', label: '12~16억',    test: v => v <= 16 },
  { cls: 'bubble-p4', label: '16억 이상',  test: () => true },
];

function priceTierOf(a) {
  const eok = a.latest_price != null ? a.latest_price / 10000 : null;
  if (eok == null) return null;
  return PRICE_TIERS.find(t => t.test(eok)) || PRICE_TIERS[PRICE_TIERS.length - 1];
}

// 가격대 모드에서 "그 가격대 안에서의 순위"를 밝기로 표시하기 위한 percentile 계산.
// 필터와 무관하게 전체 단지(explorerApts) 기준으로 매겨야 필터를 바꿔도 밝기 의미가
// 안 변한다. key: apt_name+district → 0(그 가격대 1위)~1(그 가격대 꼴찌).
function priceTierRankPercentiles() {
  const groups = {};
  explorerApts.forEach(a => {
    const tier = priceTierOf(a);
    if (!tier) return;
    (groups[tier.cls] = groups[tier.cls] || []).push(a);
  });
  const pct = new Map();
  Object.values(groups).forEach(list => {
    list.sort((x, y) => (y.composite_score ?? 0) - (x.composite_score ?? 0));
    list.forEach((a, i) => {
      pct.set(`${a.district}|${a.apt_name}`, list.length > 1 ? i / (list.length - 1) : 0);
    });
  });
  return pct;
}

function bubbleClass(a) {
  if (bubbleColorMode === 'price') {
    const eok = a.latest_price != null ? a.latest_price / 10000 : null;
    if (eok == null) return 'bubble-cool';
    return (PRICE_TIERS.find(t => t.test(eok)) || PRICE_TIERS[PRICE_TIERS.length - 1]).cls;
  }
  const v = a.composite_score ?? 0;
  return (SCORE_TIERS.find(t => t.test(v)) || SCORE_TIERS[SCORE_TIERS.length - 1]).cls;
}

// 가격대 모드일 때만 쓰는 밝기값 — 같은 가격대 내 1위에 가까울수록 밝고(진하고),
// 꼴찌에 가까울수록 흐려진다. 점수 모드에서는 밝기 보정 없음(1).
function bubbleBrightness(a, pctMap) {
  if (bubbleColorMode !== 'price') return 1;
  const pct = pctMap.get(`${a.district}|${a.apt_name}`);
  if (pct == null) return 1;
  return 1.35 - 0.7 * pct;   // 1위 근처 1.35(밝음) → 꼴찌 근처 0.65(어두움)
}

function renderExplorerLegend() {
  if (bubbleColorMode === 'price') {
    document.getElementById('explorerLegend').innerHTML =
      PRICE_TIERS.map(t => `<span class="legend-chip"><span class="legend-dot ${t.cls}"></span>${t.label}</span>`).join('')
      + `<span class="legend-chip legend-hint">💡 같은 색 중에서도 <b>밝을수록</b> 그 가격대 내 종합점수 순위가 높습니다</span>`;
    return;
  }
  document.getElementById('explorerLegend').innerHTML = SCORE_TIERS.map(t =>
    `<span class="legend-chip"><span class="legend-dot ${t.cls}"></span>${t.label}</span>`
  ).join('');
}

function applyPriceFilter(minEok, maxEok) {
  explorerFilter = { min: minEok, max: maxEok };
  explorerMarkers.forEach(m => explorerMap.removeLayer(m));
  explorerMarkers = [];

  explorerVisible = sortApts(explorerApts.filter(a => {
    const p = a.latest_price != null ? a.latest_price / 10000 : null;
    return p != null && p >= minEok && p <= maxEok;
  }));

  renderExplorerLegend();
  const pctMap = bubbleColorMode === 'price' ? priceTierRankPercentiles() : null;

  explorerVisible.forEach(a => {
    const cls = bubbleClass(a);
    const brightness = bubbleBrightness(a, pctMap);
    const icon = L.divIcon({
      className: '',
      html: `<div class="apt-bubble ${cls}" style="filter:brightness(${brightness.toFixed(2)})">
               <span class="apt-bubble-name">${shortName(a.apt_name)}</span>
               <span class="apt-bubble-price">${eokFmt(a.latest_price)}</span>
             </div>`,
      iconSize: [72, 40], iconAnchor: [36, 40],
    });
    const m = L.marker([a.lat, a.lng], { icon });
    m.on('click', () => showAptDetail(a));
    m.addTo(explorerMap);
    explorerMarkers.push(m);
  });

  document.getElementById('explorerCount').textContent = `${explorerVisible.length}개 단지`;
  showAptList();
}

function showAptList() {
  const rows = explorerVisible.map((a, i) => `
    <div class="ep-list-row" data-idx="${i}">
      <div class="ep-list-rank">${i+1}</div>
      <div class="ep-list-main">
        <div class="ep-list-name">${a.apt_name}</div>
        <div class="ep-list-sub">${a.district} · ${a.build_year}년 · ${Math.round(a.area_exclusive)}㎡${(() => { const c = commuteInfo(a); return c ? ` · <span class="ep-commute">${c.label}</span>` : ''; })()}</div>
      </div>
      <div class="ep-list-right">
        <div class="ep-list-price">${eokFmt(a.latest_price)}</div>
        <div class="ep-list-score">${fmtScore(a.composite_score)}점</div>
      </div>
    </div>
  `).join('');

  document.getElementById('explorerPanel').innerHTML = `
    <div class="ep-list-head">단지 목록 <span class="ep-list-cnt">${explorerVisible.length}</span></div>
    <div class="ep-list">${rows || '<div class="explorer-panel-empty">조건에 맞는 단지가 없습니다</div>'}</div>
  `;

  document.querySelectorAll('.ep-list-row').forEach(el => {
    el.addEventListener('click', () => {
      const a = explorerVisible[+el.dataset.idx];
      explorerMap.setView([a.lat, a.lng], 15, { animate: true });
      showAptDetail(a);
    });
  });
}

function showAptDetail(a) {
  const eok = v => v != null ? (v/10000).toFixed(1) + '억' : '—';
  const ask = getAsk(a);
  const latestEok = a.latest_price != null ? a.latest_price / 10000 : null;
  const askDiff = (ask != null && latestEok) ? ((ask - latestEok) / latestEok * 100) : null;

  const axes = [
    ['가격방어', a.defense_score], ['유동성', a.liquidity_score], ['상승참여', a.upside_score],
    ['모멘텀', a.momentum_score], ['프리미엄', a.premium_score], ['규모연식', a.scale_score],
    ['교통', a.transit_score],
  ].filter(x => x[1] != null);
  const best = [...axes].sort((x,y) => y[1]-x[1]).slice(0,2);

  // 네이버부동산식: 목록은 그대로 두고, 옆 플로팅 카드(explorerDetail)에 상세를 연다.
  // (해당 요소가 없는 구버전 페이지에서는 기존처럼 목록 패널을 대체)
  const detailPanel = document.getElementById('explorerDetail');
  const targetEl = detailPanel || document.getElementById('explorerPanel');
  targetEl.innerHTML = `
    ${detailPanel ? '<button class="mpd-close" id="epBack" title="닫기">✕</button>' : '<button class="ep-back" id="epBack">← 목록으로</button>'}
    <div class="ep-head">
      <div class="ep-name">${a.apt_name}</div>
      <div class="ep-loc">${a.district} · ${a.build_year}년 준공 · 전용 ${Math.round(a.area_exclusive)}㎡ · 종합 ${a.rank}위</div>
    </div>
    <div class="ep-price-grid">
      <div class="ep-price"><span class="epv">${eok(a.latest_price)}</span><span class="epk">최신 실거래</span></div>
      <div class="ep-price"><span class="epv">${eok(a.peak_price)}</span><span class="epk">전고점</span></div>
      <div class="ep-price"><span class="epv" style="color:${a.mdd >= -15 ? '#34d399' : '#f87171'}">${a.mdd != null ? a.mdd.toFixed(1)+'%' : '—'}</span><span class="epk">MDD</span></div>
      <div class="ep-price"><span class="epv">${fmtScore(a.composite_score)}점</span><span class="epk">종합점수</span></div>
    </div>
    <div id="epReviewTags"></div>
    <div class="ep-tags">
      ${best.map(([n,v]) => `<span class="aptag aptag-good">${n} ${v.toFixed(0)}점</span>`).join('')}
      ${a.nearest_station ? `<span class="aptag">🚇 ${a.nearest_station} ${a.nearest_station_m}m</span>` : ''}
      ${(() => { const c = commuteInfo(a); return c ? `<span class="aptag" style="color:#f472b6">${c.label} (합계 ${c.total.toFixed(1)}km)</span>` : ''; })()}
      ${a.momentum_pct != null ? `<span class="aptag">최근 1년 추세 ${a.momentum_pct > 0 ? '+' : ''}${a.momentum_pct.toFixed(1)}%/년</span>` : ''}
    </div>
    <div class="ep-ask">
      <label class="ep-ask-label">💬 현재 호가/매도희망가 메모 (억)</label>
      <div class="ep-ask-row">
        <input type="number" id="epAskInput" step="0.1" min="0" placeholder="예: 12.5" value="${ask != null ? ask : ''}">
        <button id="epAskSave" class="price-apply">저장</button>
      </div>
      ${askDiff != null ? `<div class="ep-ask-diff">호가가 최신 실거래보다 <b style="color:${askDiff >= 0 ? '#fbbf24' : '#34d399'}">${askDiff >= 0 ? '+' : ''}${askDiff.toFixed(1)}%</b> ${askDiff >= 0 ? '높음' : '낮음'}</div>` : ''}
    </div>
    <div class="ep-links">
      <a class="ep-map" href="${naverMapUrl(a.district, a.apt_name, a.dong, a.lat, a.lng)}" target="_blank" rel="noopener">네이버 지도 ↗</a>
      <a class="ep-naver" href="${naverLandUrl(a.district, a.apt_name, a.dong, a.lat, a.lng)}" target="_blank" rel="noopener">네이버 부동산 ↗</a>
      <a class="ep-hogang" href="${hogangnonoUrl(a.district, a.apt_name, a.dong, a.lat, a.lng)}" target="_blank" rel="noopener">호갱노노 ↗</a>
    </div>
    <div id="epTransit"></div>
    <div class="ep-trades">
      <div class="ep-trades-head">
        📋 실거래 내역 <span class="ep-trades-note">국토부 raw data</span>
      </div>
      <div id="epTradesBody" class="ep-trades-body"><div class="skeleton" style="height:80px"></div></div>
    </div>
  `;

  if (detailPanel) detailPanel.style.display = 'block';
  fillCommuteTransit('epTransit', a);   // 🚇 우리 회사 가는 길 (비동기)
  fillReviewTags('epReviewTags', a.district, a.apt_name, true);   // 💬 점수 바로 아래 해시태그
  document.getElementById('epBack').addEventListener('click', () => {
    if (detailPanel) detailPanel.style.display = 'none';
    else showAptList();
  });
  document.getElementById('epAskSave').addEventListener('click', () => {
    const v = document.getElementById('epAskInput').value;
    if (v) localStorage.setItem(askKey(a), v);
    else localStorage.removeItem(askKey(a));
    showAptDetail(a);
  });

  // raw 거래내역 로드
  fetchJSON(`/api/trades?district=${encodeURIComponent(a.district)}&apt=${encodeURIComponent(a.apt_name)}`)
    .then(res => {
      const trades = res.trades || [];
      if (!trades.length) {
        document.getElementById('epTradesBody').innerHTML = '<div class="ep-trades-empty">거래 내역이 없습니다</div>';
        return;
      }
      document.getElementById('epTradesBody').innerHTML = `
        <table class="ep-trades-table">
          <thead><tr><th>계약일</th><th>가격</th><th>층</th><th>면적</th></tr></thead>
          <tbody>
            ${trades.slice(0, 30).map(t => `
              <tr>
                <td>${t.ym}${t.day ? '-' + String(t.day).padStart(2,'0') : ''}</td>
                <td class="ep-tr-price">${eokFmt(t.price)}</td>
                <td>${t.floor != null ? t.floor + '층' : '—'}</td>
                <td>${t.area}㎡</td>
              </tr>`).join('')}
          </tbody>
        </table>
        ${trades.length > 30 ? `<div class="ep-trades-more">최근 30건 표시 (전체 ${trades.length}건)</div>` : ''}
      `;
    })
    .catch(() => {
      document.getElementById('epTradesBody').innerHTML = '<div class="ep-trades-empty">로딩 실패</div>';
    });
}

/* ── 네비게이션 활성화 ──────────────────────────────────── */
/* ── 전세 전용 상세 모달 ──────────────────────────────────
   전세는 소유가 아니라 거주다 — 재건축 잠재력·상승참여·모멘텀 같은
   소유자(투자) 관점 축은 세입자 판단과 무관하므로 보여주지 않는다.
   전세 6축 + 우리 맞춤 4축 + 통근 안내만 표시. */
let _jeonseAll = null;

async function ensureJeonseData() {
  if (_jeonseAll) return _jeonseAll;
  const data = await fetchJSON('/api/jeonse');
  const ranking = (data && data.ranking) || [];
  if (ranking.length) computeJeonseLifestyle(ranking);
  _jeonseAll = ranking;
  return ranking;
}

/* ── 💬 단지별 실제 이야기 해시태그 (네이버 블로그·카페 언급 빈도) ──
   collect_reviews.py 산출 apt_reviews.json. 없으면 아무것도 그리지 않는다.
   태그 클릭 시 해당 키워드의 네이버 검색 결과로 이동해 원문을 볼 수 있다. */
let _reviewsAll = null;
async function ensureReviews() {
  if (_reviewsAll) return _reviewsAll;
  try { _reviewsAll = (await (await fetch('/api/reviews')).json()).apartments || {}; }
  catch (e) { _reviewsAll = {}; }
  return _reviewsAll;
}
async function fillReviewTags(elId, district, aptName, compact = false) {
  const el = document.getElementById(elId);
  if (!el) return;
  const all = await ensureReviews();
  const r = all[`${district}|${aptName}`];
  if (!r || !r.tags || !r.tags.length) { el.innerHTML = ''; return; }
  const chips = r.tags.map(([tag, cnt]) => {
    const q = encodeURIComponent(`${district} ${aptName} ${tag}`);
    return `<a class="rv-tag" href="https://search.naver.com/search.naver?query=${q}" target="_blank" rel="noopener">#${tag}<small>${cnt}</small></a>`;
  }).join('');
  if (compact) {
    // 점수 바로 아래 배치용: 제목 없이 태그 칩 + 출처 한 줄
    el.innerHTML = `
      <div class="rv-tags rv-tags-center">${chips}</div>
      <div class="rv-src-note">💬 네이버 블로그·카페 ${r.n_posts}건 언급 기반 · 태그 클릭 = 원문 보기</div>`;
    return;
  }
  el.innerHTML = `
    <div class="jz-axis-group-t" style="margin-top:1.2rem">💬 이 단지의 실제 이야기</div>
    <div class="rv-tags">${chips}</div>
    <div class="sub-foot" style="border-top:none;margin-top:.3rem">
      네이버 블로그·카페 검색 상위 ${r.n_posts}건에서 언급 빈도로 자동 요약한 태그입니다 (숫자 = 언급 글 수).
      광고·중개 글이 섞일 수 있으니 참고용으로만 보고, 태그를 누르면 원문 검색으로 이동합니다.</div>`;
}

async function openJeonseModal(district, aptName) {
  const overlay = document.getElementById('aptModalOverlay');
  const body = document.getElementById('aptModalBody');
  if (!overlay || !body) return;
  body.innerHTML = `<div class="skeleton" style="height:400px"></div>`;
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const list = await ensureJeonseData();
  const a = list.find(r => r.district === district && r.apt_name === aptName);
  if (!a) {   // 전세 데이터 없는 단지는 기존 매매 상세로 대체
    openApartmentModal(district, aptName);
    return;
  }
  const R = buildJeonseReasons(a);
  const axGroup = (metaList, getVal) => metaList.map(m => {
    const v = getVal(m) ?? 0;
    return `
    <div class="top1-ax-group">
      <div class="top1-axis-row">
        <span class="top1-ax-dot" style="background:${m.color}"></span>
        <span class="top1-ax-name">${m.key} <small style="color:var(--text3)">${m.w}%</small></span>
        <div class="top1-ax-bar"><div class="top1-ax-fill" style="width:${Math.min(100, v)}%;background:${m.color}"></div></div>
        <span class="top1-ax-val">${v.toFixed(0)}</span>
      </div>
      ${R[m.key] ? `<div class="top1-ax-reason">${R[m.key]}</div>` : ''}
    </div>`;
  }).join('');

  const eokv = v => v != null ? eokFmt(v) : '—';
  body.innerHTML = `
    <div class="top1-hero">
      <div class="top1-badge">🔑 전세 상세 — 세입자 관점</div>
      <h3 class="top1-name">${a.apt_name}</h3>
      <div class="top1-loc">${a.district} · ${a.build_year || '—'}년 준공 · 전용 ${Math.round(a.area_exclusive || 0)}㎡</div>
      <div class="top1-score-big">${(a.fit_total ?? a.jeonse_total).toFixed(1)}<span class="top1-score-unit">점</span></div>
      <div class="top1-loc" style="margin-top:.2rem">우리 맞춤 적합도 (가격 합리성 ${Math.round(a.jeonse_total)}점 포함)</div>
      <div id="jzReviewTags"></div>
      <div class="ep-links" style="justify-content:center;margin-top:.8rem">
        <a class="ep-map" href="${naverMapUrl(a.district, a.apt_name, a.dong, a.lat, a.lng)}" target="_blank" rel="noopener">네이버 지도 ↗</a>
        <a class="ep-naver" href="${naverLandUrl(a.district, a.apt_name, a.dong, a.lat, a.lng)}" target="_blank" rel="noopener">네이버 부동산 ↗</a>
        <a class="ep-hogang" href="${hogangnonoUrl(a.district, a.apt_name, a.dong, a.lat, a.lng)}" target="_blank" rel="noopener">호갱노노 ↗</a>
      </div>
    </div>

    <div class="top1-stats-grid">
      <div class="top1-stat"><div class="ts-val">${eokv(a.jeonse_median)}</div><div class="ts-key">전세 중앙값</div></div>
      <div class="top1-stat"><div class="ts-val">${a.jeonse_ratio != null ? Math.round(a.jeonse_ratio * 100) + '%' : '—'}</div><div class="ts-key">전세가율</div></div>
      <div class="top1-stat"><div class="ts-val">${eokv(a.jeonse_gap)}</div><div class="ts-key">갭 (매매−전세)</div></div>
      <div class="top1-stat"><div class="ts-val">${a._commute_km != null ? a._commute_km.toFixed(1) + 'km' : '—'}</div><div class="ts-key">두 직장 통근 합</div></div>
    </div>

    <div id="jzSafety"></div>

    <div class="jz-axis-group-t">🏠 우리 맞춤 4축 (통근·합리성·인프라·약속장소)</div>
    <div class="top1-axes">${axGroup(FIT_AXIS_META, m => m.get(a))}</div>

    <div class="jz-axis-group-t" style="margin-top:1.2rem">💰 가격 합리성 세부 6지표</div>
    <div class="top1-axes">${axGroup(JEONSE_AXIS_META, m => a[JEONSE_AX_KEY[m.key]])}</div>

    <div id="jzModalTransit"></div>

    <p class="explorer-note" style="margin-top:1rem">
      ※ 전세는 소유가 아닌 거주라, 재건축 잠재력·상승참여도 같은 <b>투자 관점 지표는 표시하지 않습니다</b>.
      <a href="#" id="jzToBuyView" style="color:var(--acc2)">매매(투자) 관점 상세 보기 →</a>
    </p>`;

  fillCommuteTransit('jzModalTransit', a);
  fillReviewTags('jzReviewTags', district, aptName, true);
  window.JeonseSafety?.renderCard('jzSafety', a);   // 🛡️ 전세 안전성 (additive 모듈, 없으면 무시)
  document.getElementById('jzToBuyView')?.addEventListener('click', (e) => {
    e.preventDefault();
    openApartmentModal(district, aptName);
  });
}

/* ── 동네별 추천 단지 상세 모달 ────────────────────────────── */
// "동네별 추천 단지" 목록의 아무 행이나 클릭하면 전체 1위와 같은 형식(레이더+축별
// 점수+통계+근거)으로 그 단지의 상세 점수를 모달로 보여준다.
async function openApartmentModal(district, aptName) {
  const overlay = document.getElementById('aptModalOverlay');
  const body = document.getElementById('aptModalBody');
  if (!overlay || !body) return;

  body.innerHTML = `<div class="skeleton" style="height:400px"></div>`;
  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  const { comp, mdd, ts } = await loadScoreData();
  const apt = (comp.ranking || []).find(r => r.district === district && r.apt_name === aptName);
  if (!apt) {
    body.innerHTML = `<div class="empty-state">데이터를 찾을 수 없습니다.</div>`;
    return;
  }
  const mddInfo = (mdd.ranking || []).find(r => r.apt_name === apt.apt_name && r.district === apt.district) || {};
  const aptTs = (ts.apartments || []).find(a => a.apt_name === apt.apt_name && a.district === apt.district);
  const sameDistrictRanked = comp.ranking
    .filter(r => r.district === apt.district)
    .sort((a, b) => b.composite_score - a.composite_score);
  const localRank = sameDistrictRanked.findIndex(r => r.apt_name === apt.apt_name) + 1;

  renderApartmentDetail('aptModalBody', 'aptModalRadar', 'aptModalPriceChart', apt, mddInfo, comp, aptTs, {
    badgeHtml: `📍 ${apt.district} 내 ${localRank || '—'}위`,
    extraInsight: [`<li>${apt.district} 내 ${sameDistrictRanked.length}개 분석 단지 중 ${localRank}위입니다</li>`],
  });

}

function closeApartmentModal() {
  const overlay = document.getElementById('aptModalOverlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
}

function initApartmentModal() {
  const list = document.getElementById('districtRankings');
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.drs-row');
      if (!row || e.target.closest('a')) return;   // 링크 클릭은 그대로 새 탭으로
      const entry = _rankingRowMap[Number(row.dataset.ridx)];
      if (entry) openApartmentModal(entry.district, entry.apt_name);
    });
  }
  document.getElementById('aptModalClose')?.addEventListener('click', closeApartmentModal);
  document.getElementById('aptModalOverlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'aptModalOverlay') closeApartmentModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeApartmentModal();
  });
}

function initNav() {
  // 멀티 페이지: active는 서버(base.html)가 지정. 앵커 링크가 없으면 스킵.
  if (!document.querySelector('.nav-link[href^="#"]')) return;
  const sections = ['secExplorer','secDistrict','secTop1','secScoring','secMap','secBudget','secAiRanking'];
  const links = document.querySelectorAll('.nav-link');
  const observer = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        links.forEach(l => l.classList.remove('active'));
        const idx = sections.indexOf(e.target.id);
        if (idx >= 0) links[idx]?.classList.add('active');
      }
    });
  }, { threshold: 0.3 });
  sections.forEach(id => {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  });
}

/* ── ⑦ AI 추천 매물 순위 ─────────────────────────────────── */
// 5개 축 색상 (기존 사이트 팔레트 재사용)
const AI_AXIS_META = [
  { key: '저평가도', color: '#4ade80' },
  { key: '유동성',   color: '#818cf8' },
  { key: '교통입지', color: '#f87171' },
  { key: '모멘텀',   color: '#a78bfa' },
  { key: '학군·생활', color: '#c084fc' },
  { key: '상품성',   color: '#fbbf24' },
];
const AI_AXIS_JSONKEY = { '저평가도':'undervalued','유동성':'liquidity','교통입지':'transit','모멘텀':'momentum','학군·생활':'school','상품성':'product' };
let _aiData = null;
let _aiShown = 10;
let _aiFilter = '';

async function renderAiRanking() {
  const listEl = document.getElementById('aiRankingList');
  if (!listEl) return;
  const data = await fetchJSON('/api/ai_ranking');
  if (!data || !data.ranking || !data.ranking.length) {
    listEl.innerHTML = `<div class="empty-state">AI 순위 데이터가 아직 없습니다.</div>`;
    document.getElementById('aiRankingMore').style.display = 'none';
    return;
  }
  _aiData = data;

  // 메타: 몇 개 축 기반인지 + 제외 축 고지
  const excluded = (data.excluded_axes || []).map(e => e.axis).join('·');
  document.getElementById('aiRankingMeta').innerHTML =
    ` 이번 버전은 <strong>${data.n_axes}개 축 기반</strong>입니다`
    + (excluded ? ` (데이터 부재로 <em>${excluded}</em> 축 제외).` : '.')
    + ` <span class="ai-method">방식: ${data.methodology_version}</span>`;

  // 구 필터 채우기 (기존 select 스타일 재사용)
  const sel = document.getElementById('aiDistrictFilter');
  if (sel && sel.options.length <= 1) {
    const dists = [...new Set(data.ranking.map(r => r.district))].sort();
    sel.innerHTML = `<option value="">전체 구</option>` + dists.map(d => `<option value="${d}">${d}</option>`).join('');
    sel.addEventListener('change', () => { _aiFilter = sel.value; _aiShown = 10; drawAiList(); });
  }
  document.getElementById('aiRankingMore').addEventListener('click', () => { _aiShown += 10; drawAiList(); });

  drawAiList();
}

function drawAiList() {
  const listEl = document.getElementById('aiRankingList');
  const rows = _aiFilter ? _aiData.ranking.filter(r => r.district === _aiFilter) : _aiData.ranking;
  const shown = rows.slice(0, _aiShown);

  document.getElementById('aiRankingCount').textContent = `${rows.length}개 단지`;
  listEl.innerHTML = shown.map(r => {
    const bars = AI_AXIS_META.map(m => {
      const v = r.axes[AI_AXIS_JSONKEY[m.key]] ?? 0;
      return `
        <div class="ai-ax">
          <span class="ai-ax-name">${m.key}</span>
          <div class="ai-ax-bar"><div class="ai-ax-fill" style="width:${Math.min(100,v)}%;background:${m.color}"></div></div>
          <span class="ai-ax-val">${v.toFixed(0)}</span>
        </div>`;
    }).join('');
    const hi = (r.highlights || []).map(h => `<li>${h}</li>`).join('');
    const meta = [r.district, r.build_year ? r.build_year + '년' : null, r.area_exclusive ? Math.round(r.area_exclusive) + '㎡' : null]
      .filter(Boolean).join(' · ');
    return `
    <div class="ai-card${r.low_confidence ? ' ai-card-low' : ''}">
      <div class="ai-card-head">
        <span class="ai-rank">${r.ai_rank}</span>
        <div class="ai-card-title">
          <div class="ai-name">${r.apt_name}${r.low_confidence ? ' <span class="conf-badge conf-low">표본 부족</span>' : ''}</div>
          <div class="ai-meta-sub">${meta}</div>
        </div>
        <div class="ai-score"><span class="ai-score-num">${r.ai_score.toFixed(0)}</span><span class="ai-score-unit">점</span></div>
      </div>
      <div class="ai-axes">${bars}</div>
      ${hi ? `<ul class="ai-highlights">${hi}</ul>` : ''}
    </div>`;
  }).join('');

  const moreBtn = document.getElementById('aiRankingMore');
  moreBtn.style.display = rows.length > _aiShown ? 'inline-flex' : 'none';
}

/* ── ⑦ 전세 합리성 (구별 지도 탐색) — v2 5축 ─────────────── */
// v1 감사에서 매매 종합점수(재건축·모멘텀 등 투자축)를 '품질'로 쓰는 바람에
// 40년차 재건축 후보가 상위를 휩쓸던 결함을 교정: 세입자 관점 거주가치로 교체.
const JEONSE_AXIS_META = [
  { key: '가성비',     w: 28, color: '#34d399',
    desc: '세입자 관점 거주가치(교통 25% + 직주근접 25% + 학군 20% + 연식·신축 30%) 대비 전세 ㎡당 가격이 쌀수록 높습니다. 재건축 잠재력 같은 투자 요소는 거주 품질이 아니므로 뺐습니다 — "이 거주 품질을 이 전세금에?"',
    metric: '거주가치(교통+직주+학군+연식) ÷ 전세 평단가 percentile' },
  { key: '전세저렴도', w: 12, color: '#818cf8',
    desc: '㎡당 전세금을 서울 전체(60%)와 같은 구 안(40%)에서 함께 비교합니다. 구 안에서 싼 전세인지도 반영해 "그 동네 기준 가성비"를 잡습니다.',
    metric: '㎡당 전세금 — 서울 percentile 60% + 구내 percentile 40%' },
  { key: '보증금안전', w: 25, color: '#a78bfa',
    desc: '깡통전세 위험은 "전세가율이 높은데 매매가까지 잘 빠지는 집"에서 커집니다. 전세가율 낮음에 더해 매매가 방어력·변동성, 그리고 6년간 그 단지 전세가가 실제로 얼마나 빠진 적 있는지(전세 MDD — 역전세의 실증 이력)까지 봅니다.',
    metric: '전세가율↓(45%) + 매매 방어력(20%) + 매매 변동성↓(15%) + 전세 MDD↓(20%)' },
  { key: '시세안정',   w: 10, color: '#f472b6',
    desc: '최근 3년(36개월) 전세가 추세(연율 %)의 진폭이 작을수록 좋습니다. 급등은 2년 뒤 재계약 부담, 급락은 역전세(보증금 미반환) 신호 — 양쪽 다 세입자에게 리스크입니다. 갱신 계약(5% 상한)은 시세 왜곡을 막기 위해 제외했습니다.',
    metric: '36개월 전세가 Theil-Sen 추세 |연율%| 작은 순 (신규 계약만)' },
  { key: '진입타이밍', w: 10, color: '#0a7cc2',
    desc: '지금 전세가율이 그 단지 6년 역사 밴드에서 낮은 자리면(역사적으로 싼 전세) 들어가기 좋은 타이밍입니다. 매매가 대비 전세가 상대적으로 저렴한 시점인지를 봅니다.',
    metric: '현 전세가율의 6년 월별 밴드 내 percentile 낮은 순' },
  { key: '전세유동성', w: 20, color: '#fbbf24',
    desc: '단지 규모 대비 전세 거래가 활발한지(회전율)를 중심으로 봅니다. 거래건수만 보면 대단지가 무조건 유리해지는 편향이 있어, 연환산 거래 ÷ 추정 세대수로 보정했습니다.',
    metric: '회전율(연환산 전세거래÷세대수) 60% + 거래건수 40%' },
];
const JEONSE_AX_KEY = { '가성비':'axis_value','전세저렴도':'axis_cheap','보증금안전':'axis_safety','시세안정':'axis_stability','진입타이밍':'axis_timing','전세유동성':'axis_liquidity' };

let jeonseMap = null, jeonseMarkers = [], jeonseByDistrict = {};
let jeonseMode = 'fit';   // 'fit'=우리 맞춤(통근·인프라·약속장소 포함) / 'price'=가격 합리성만
let jeonsePriceFilter = { min: 0, max: 9999 };   // 억 단위 (전세 중앙값 기준)

// 서울 주요 약속장소 (친구·데이트 자주 모이는 거점) — 접근성 축 계산용 고정 좌표
const SEOUL_MEETING_SPOTS = [
  { name: '강남역',   lat: 37.4979, lng: 127.0276 },
  { name: '홍대입구', lat: 37.5572, lng: 126.9245 },
  { name: '여의도',   lat: 37.5219, lng: 126.9245 },
  { name: '성수',     lat: 37.5445, lng: 127.0559 },
  { name: '잠실',     lat: 37.5133, lng: 127.1028 },
  { name: '광화문',   lat: 37.5709, lng: 126.9788 },
  { name: '용산·이태원', lat: 37.5349, lng: 126.9946 },
  { name: '건대입구', lat: 37.5405, lng: 127.0700 },
];

// 우리 맞춤 적합도 축 (가중치 합 100) — 사용자 우선순위: 회사 직주근접 > 인프라 > 약속장소,
// 가격 합리성은 전세 페이지의 기본 축이라 함께 유지.
const FIT_AXIS_META = [
  { key: '회사통근',   w: 30, color: '#f472b6', get: a => a.axis_commute,
    desc: '우리 두 직장(내 직장·여자친구 직장)까지의 직선거리 합이 가까울수록 높습니다. 직장 위치는 ①지도 탐색 페이지에서 바꿀 수 있고, 그 값이 여기에도 반영됩니다.' },
  { key: '가격합리성', w: 30, color: '#34d399', get: a => a.jeonse_total,
    desc: '앞의 6개 전세 지표(가성비·저렴도·보증금안전·시세안정·진입타이밍·유동성) 종합 점수입니다.' },
  { key: '인프라',     w: 22, color: '#818cf8', get: a => a.axis_infra,
    desc: '교통(지하철 접근성·역세권)과 학군·생활편의를 합산한 인프라 점수입니다.' },
  { key: '약속장소',   w: 18, color: '#fbbf24', get: a => a.axis_spot,
    desc: '강남·홍대·여의도·성수·잠실·광화문·이태원·건대 등 주요 약속장소까지 평균 거리가 가까울수록(도심 접근성) 높습니다.' },
];

function jeonseScoreOf(a) { return jeonseMode === 'fit' ? (a.fit_total ?? a.jeonse_total) : a.jeonse_total; }
function jeonseModeLabel() { return jeonseMode === 'fit' ? '적합도' : '합리성'; }

function jeonseBubbleClass(v) {
  if (v >= 70) return 'bubble-hot';   // 합리적/적합 (초록)
  if (v >= 55) return 'bubble-mid';
  return 'bubble-cool';
}

// 클라이언트 percentile-rank (0~100). lowIsGood면 낮은 값이 높은 점수.
function pctRankClient(vals, lowIsGood) {
  const idx = vals.map((v, i) => [v, i]).filter(x => x[0] != null && !Number.isNaN(x[0]));
  idx.sort((a, b) => a[0] - b[0]);
  const out = new Array(vals.length).fill(50);
  const n = idx.length;
  idx.forEach(([, i], rank) => {
    let p = n > 1 ? (rank / (n - 1)) * 100 : 50;
    out[i] = lowIsGood ? 100 - p : p;
  });
  return out;
}

// 생활 지표(회사 통근·인프라·약속장소)를 랭킹 전체에 계산해 각 레코드에 부여
function computeJeonseLifestyle(ranking) {
  const commuteKm = [], spotMeanKm = [];
  ranking.forEach(a => {
    const ci = (a.lat && a.lng) ? commuteInfo(a) : null;
    a._commute_km = ci ? ci.total : null;
    a._commute_label = ci ? ci.label : null;
    if (a.lat && a.lng) {
      let sum = 0, best = Infinity, bestName = '';
      SEOUL_MEETING_SPOTS.forEach(s => {
        const km = haversineKm(a.lat, a.lng, s.lat, s.lng);
        sum += km;
        if (km < best) { best = km; bestName = s.name; }
      });
      a._spot_mean_km = sum / SEOUL_MEETING_SPOTS.length;
      a._spot_min_km = best; a._spot_min_name = bestName;
    } else { a._spot_mean_km = null; a._spot_min_km = null; }
    commuteKm.push(a._commute_km);
    spotMeanKm.push(a._spot_mean_km);
    // 인프라 = 교통 60% + 학군·생활 40% (이미 0~100 percentile). 결측은 중립 50.
    const tr = a.transit_score, sc = a.school_score;
    a.axis_infra = Math.round(((tr != null ? tr : 50) * 0.6 + (sc != null ? sc : 50) * 0.4));
  });
  const cScore = pctRankClient(commuteKm, true);
  const sScore = pctRankClient(spotMeanKm, true);
  ranking.forEach((a, i) => {
    a.axis_commute = Math.round(cScore[i]);
    a.axis_spot = Math.round(sScore[i]);
    a.fit_total = +FIT_AXIS_META.reduce((s, m) => s + m.get(a) * m.w / 100, 0).toFixed(1);
  });
}

function buildJeonseReasons(r) {
  const pct = v => v != null ? Math.round(v) : null;   // axis는 이미 "높을수록 좋음" percentile
  const eok = v => v != null ? (v / 10000).toFixed(1) + '억' : '—';
  const ppm = r.jeonse_ppm != null ? Math.round(r.jeonse_ppm) : null;
  const jr = r.jeonse_ratio != null ? Math.round(r.jeonse_ratio * 100) : null;
  const inDist = r.jeonse_ppm_district_top_pct != null ? Math.round(r.jeonse_ppm_district_top_pct) : null;
  const R = {};

  // ① 가성비 — 거주가치(교통·직주·학군·연식) 서브지표를 실수치로 인용
  const age = r.build_year ? (2026 - Math.round(r.build_year)) : null;
  const lq = r.living_quality != null ? Math.round(r.living_quality) : null;
  const lqBits = [
    r.nearest_station ? `${r.nearest_station} 도보 ${Math.round(r.walk_min ?? 0)}분` : null,
    r.hub_min_km != null ? `${r.hub_nearest_name || '업무지구'} ${r.hub_min_km}km` : null,
    r.academy_within_1km != null ? `학원 ${r.academy_within_1km}곳` : null,
    age != null ? `${r.build_year}년식(${age}년차)` : null,
  ].filter(Boolean).join(' · ');
  R['가성비'] = `거주가치 ${lq ?? '—'}점(${lqBits})을 전세 ${eok(r.jeonse_median)}(㎡당 ${ppm}만원)에 — 가성비 상위 ${pct(r.axis_value)}%. 재건축 같은 투자 요소는 뺀 세입자 기준입니다.`;

  // ② 전세 저렴도 — 서울 + 구내 이중 비교
  R['전세저렴도'] = `㎡당 전세금 ${ppm}만원 — 서울 전체 상위 ${pct(r.axis_cheap)}%${inDist != null ? `, ${r.district} 안에서는 싼 순으로 ${inDist <= 50 ? '상위' : '하위'} ${inDist <= 50 ? inDist : 100 - inDist}%` : ''}.`;

  // ③ 보증금 안전 — 전세가율 + 매매 방어력 + 변동성
  const dfn = r.defense_score != null ? Math.round(r.defense_score) : null;
  const vol = r.price_vol_annual != null ? (r.price_vol_annual * 100).toFixed(1) : null;
  const jm = r.jeonse_mdd_pct != null ? r.jeonse_mdd_pct.toFixed(0) : null;
  const safetyBits = [
    jr != null ? `전세가율 ${jr}%` : null,
    dfn != null ? `매매가 방어력 ${dfn}점` : null,
    vol != null ? `연 변동성 ${vol}%` : null,
    jm != null ? `6년 전세 최대낙폭 ${jm}%` : null,
  ].filter(Boolean).join(' · ');
  R['보증금안전'] = r.axis_safety >= 60
    ? `${safetyBits} — 매매가가 보증금을 넉넉히, 안정적으로 받쳐줍니다(깡통전세 위험 낮음).`
    : r.axis_safety >= 40
      ? `${safetyBits} — 보통 수준의 보증금 안전성입니다.`
      : `${safetyBits} — 보증금 대비 매매가 여유가 적거나 매매가가 출렁이는 편이라 보증보험 가입을 권합니다.`;

  // ④ 시세 안정 — 전세가 추세 진폭
  const tr = r.jeonse_trend_pct;
  R['시세안정'] = tr != null
    ? (Math.abs(tr) < 4
        ? `최근 전세가 추세 연 ${tr >= 0 ? '+' : ''}${tr.toFixed(1)}%로 안정적 — 재계약·역전세 리스크가 작습니다.`
        : tr >= 4
          ? `최근 전세가가 연 +${tr.toFixed(1)}% 추세로 올라, 2년 뒤 재계약 때 인상 부담이 있을 수 있습니다.`
          : `최근 전세가가 연 ${tr.toFixed(1)}% 추세로 내려, 역전세(보증금 반환 지연) 가능성을 확인하세요.`)
    : '전세가 추세를 판단할 관측이 부족합니다(중립 처리).';

  // ④b 진입 타이밍 — 전세가율의 역사 밴드 내 위치
  const cycp = r.jeonse_ratio_now_pctile;
  R['진입타이밍'] = cycp != null
    ? (cycp <= 35
        ? `현 전세가율이 이 단지 6년 밴드에서 하위 ${Math.round(cycp)}% — 역사적으로 싼 전세 구간이라 진입 타이밍이 좋습니다.`
        : cycp >= 70
          ? `현 전세가율이 6년 밴드 상위 ${Math.round(100 - cycp)}% — 역사적으로 비싼 전세 구간이라 서두를 이유가 적습니다.`
          : `현 전세가율이 6년 밴드의 중간(${Math.round(cycp)}퍼센타일) 수준입니다.`)
    : '전세가율 역사 밴드를 만들 관측이 부족합니다(중립 처리).';

  // ⑤ 전세 유동성 — 회전율 중심 (대단지 편향 보정)
  const jturn = r.jeonse_turnover != null ? (r.jeonse_turnover * 100).toFixed(1) : null;
  R['전세유동성'] = `최근 18개월 전세 ${r.jeonse_count != null ? Math.round(r.jeonse_count) : '—'}건${jturn ? ` · 연 회전율 약 ${jturn}%` : ''} — `
    + (r.axis_liquidity >= 60 ? '규모 대비로도 매물이 꾸준히 돌아 구하기 쉽습니다.' : '거래가 잦지 않아 매물 대기가 필요할 수 있습니다.');

  // ── 우리 맞춤 생활 지표 ──
  R['회사통근'] = r._commute_label
    ? `우리 두 직장까지 ${r._commute_label} (합계 ${r._commute_km.toFixed(1)}km) — 통근 적합도 상위 ${pct(r.axis_commute)}%.`
    : '좌표 정보가 없어 통근 거리를 계산하지 못했습니다.';
  R['가격합리성'] = `가성비·저렴도·보증금안전·시세안정·진입타이밍·유동성 6개 지표 종합 ${Math.round(r.jeonse_total)}점.`;
  const stn = r.nearest_station ? `${r.nearest_station} 도보 ${r.walk_min != null ? Math.round(r.walk_min) : '?'}분` : '역 정보 없음';
  R['인프라'] = `${stn} · 교통 ${r.transit_score != null ? Math.round(r.transit_score) : '—'}점 / 학군·생활 ${r.school_score != null ? Math.round(r.school_score) : '—'}점 (인프라 종합 ${r.axis_infra}점).`;
  R['약속장소'] = r._spot_min_km != null
    ? `주요 약속장소까지 평균 ${r._spot_mean_km.toFixed(1)}km, 가장 가까운 ${r._spot_min_name} ${r._spot_min_km.toFixed(1)}km — 접근성 상위 ${pct(r.axis_spot)}%.`
    : '좌표 정보가 없어 약속장소 접근성을 계산하지 못했습니다.';
  return R;
}

async function renderJeonseExplorer() {
  if (!document.getElementById('jeonseMap')) return;   // 전세 페이지 아님
  await loadDistrictData();
  const data = await fetchJSON('/api/jeonse');
  const ranking = (data && data.ranking) || [];

  if (!ranking.length) {
    document.getElementById('jeonseDistrictChips').innerHTML =
      `<div class="empty-state">전세 데이터가 아직 없습니다. 전월세 수집 후 표시됩니다.</div>`;
    return;
  }

  // 생활 지표(회사 통근·인프라·약속장소) 계산 → 각 레코드에 fit_total 부여
  computeJeonseLifestyle(ranking);
  _jeonseAll = ranking;   // 전세 상세 모달 공용 캐시

  // 지표 설명 렌더 — 맞춤 4축(통근·합리성·인프라·약속장소) + 가격 합리성 4축
  const detail = document.getElementById('jeonseAxesDetail');
  if (detail) detail.innerHTML =
    `<div class="jz-axis-group-t">🏠 우리 맞춤 적합도 (통근·인프라·약속장소 포함)</div>`
    + FIT_AXIS_META.map(a => `
    <div class="axis-card">
      <div class="axis-card-header"><span class="axis-dot" style="background:${a.color}"></span>
        <span class="axis-name">${a.key}</span><span class="axis-weight-badge">${a.w}%</span></div>
      <p class="axis-desc">${a.desc}</p>
    </div>`).join('')
    + `<div class="jz-axis-group-t">💰 가격 합리성 세부 6지표</div>`
    + JEONSE_AXIS_META.map(a => `
    <div class="axis-card">
      <div class="axis-card-header"><span class="axis-dot" style="background:${a.color}"></span>
        <span class="axis-name">${a.key}</span><span class="axis-weight-badge">${a.w}%</span></div>
      <p class="axis-desc">${a.desc}</p>
      <div class="axis-meta"><div class="axis-metric"><b>측정 방법:</b> ${a.metric}</div></div>
    </div>`).join('');

  jeonseByDistrict = {};
  ranking.forEach(r => { (jeonseByDistrict[r.district] = jeonseByDistrict[r.district] || []).push(r); });

  jeonseMap = L.map('jeonseMap', { center: [37.545, 126.99], zoom: 11 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors', maxZoom: 18
  }).addTo(jeonseMap);
  addWorkMarkers(jeonseMap);   // 💼/💗 두 직장 항상 표시

  // 모드 토글 (우리 맞춤 / 가격 합리성만)
  const toggle = document.getElementById('jeonseModeToggle');
  if (toggle) toggle.querySelectorAll('.legend-mode-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      jeonseMode = btn.dataset.mode;
      toggle.querySelectorAll('.legend-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderJeonseChips();
      selectJeonseDistrict(jeonseCurrentDistrict);
    }));

  // 전세가 필터 (구 안에서 전세 예산대로 좁혀보기)
  initPriceFilterBar('jeonse', jeonsePriceFilter, () => selectJeonseDistrict(jeonseCurrentDistrict));

  renderJeonseChips();
  const want = new URLSearchParams(location.search).get('d');
  const first = jeonseChipOrder.includes(want) ? want : jeonseChipOrder[0];
  selectJeonseDistrict(first);
}

let jeonseChipOrder = [], jeonseCurrentDistrict = null;

function jeonseDistAvg(d) {
  const l = jeonseByDistrict[d];
  return l.reduce((s, r) => s + jeonseScoreOf(r), 0) / l.length;
}

function renderJeonseChips() {
  jeonseChipOrder = Object.keys(jeonseByDistrict).sort((a, b) => jeonseDistAvg(b) - jeonseDistAvg(a));
  const lbl = jeonseModeLabel();
  document.getElementById('jeonseDistrictChips').innerHTML = jeonseChipOrder.map(d => {
    const info = districtData.find(x => x.name === d) || {};
    return `<button class="rank-chip${d === jeonseCurrentDistrict ? ' active' : ''}" data-d="${d}">
      <span class="rank-chip-ic">${info.icon || '🏙️'}</span>${d}
      <span class="rank-chip-n">${lbl} ${Math.round(jeonseDistAvg(d))}</span>
    </button>`;
  }).join('');
  document.querySelectorAll('#jeonseDistrictChips .rank-chip').forEach(btn =>
    btn.addEventListener('click', () => selectJeonseDistrict(btn.dataset.d)));

  document.getElementById('jeonseLegend').innerHTML = [
    ['bubble-hot', `${lbl} 70+`], ['bubble-mid', '55~70'], ['bubble-cool', '55 미만'],
  ].map(([c, l]) => `<span class="legend-chip"><span class="legend-dot ${c}"></span>${l}</span>`).join('')
    + `<span class="legend-chip legend-hint">💡 버블 = 전세 중앙값 · 색 = ${lbl} 점수</span>`;
}

function selectJeonseDistrict(district) {
  jeonseCurrentDistrict = district;
  const full = jeonseByDistrict[district] || [];
  const isAll = jeonsePriceFilter.min <= 0 && jeonsePriceFilter.max >= 9999;
  const filtered = isAll ? full : full.filter(a => {
    const eok = a.jeonse_median != null ? a.jeonse_median / 10000 : null;
    return eok != null && eok >= jeonsePriceFilter.min && eok <= jeonsePriceFilter.max;
  });
  const list = [...filtered].sort((a, b) => jeonseScoreOf(b) - jeonseScoreOf(a));
  const info = districtData.find(x => x.name === district) || {};
  const color = info.color || '#34d399';
  const lbl = jeonseModeLabel();
  // 모드별 표시 축: fit=맞춤 4축(통근·합리성·인프라·약속장소), price=가격 5지표
  const axisSet = jeonseMode === 'fit'
    ? FIT_AXIS_META.map(m => ({ key: m.key, color: m.color, val: a => m.get(a) }))
    : JEONSE_AXIS_META.map(m => ({ key: m.key, color: m.color, val: a => a[JEONSE_AX_KEY[m.key]] }));

  document.querySelectorAll('#jeonseDistrictChips .rank-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.d === district));

  jeonseMarkers.forEach(m => jeonseMap.removeLayer(m));
  jeonseMarkers = [];
  const coordApts = list.filter(a => a.lat && a.lng);
  coordApts.forEach(a => {
    const icon = L.divIcon({
      className: '',
      html: `<div class="apt-bubble ${jeonseBubbleClass(jeonseScoreOf(a))}">
               <span class="apt-bubble-name">${shortName(a.apt_name)}</span>
               <span class="apt-bubble-price">${eokFmt(a.jeonse_median)}</span>
             </div>`,
      iconSize: [72, 40], iconAnchor: [36, 40],
    });
    const m = L.marker([a.lat, a.lng], { icon });
    m.on('click', () => openJeonseModal(a.district, a.apt_name));
    m.addTo(jeonseMap);
    jeonseMarkers.push(m);
  });
  if (coordApts.length) jeonseMap.fitBounds(L.latLngBounds(coordApts.map(a => [a.lat, a.lng])).pad(0.2));
  else if (info.center) jeonseMap.setView(info.center, 13);
  setTimeout(() => jeonseMap.invalidateSize(), 60);

  const avgJ = list.length ? Math.round(list.reduce((s, r) => s + jeonseScoreOf(r), 0) / list.length) : 0;
  const avgP = list.length ? list.reduce((s, r) => s + (r.jeonse_median || 0), 0) / list.length : null;
  document.getElementById('jeonseCount').textContent = isAll
    ? `${district} · 전세 ${list.length}개 · ${lbl} 평균 ${avgJ}`
    : `${district} · 전세가대 내 ${list.length}개 (전체 ${full.length}개)`;

  const rows = list.map((a, i) => {
    const R = buildJeonseReasons(a);
    const axes = axisSet.map(m =>
      `<span class="jz-ax"><i style="background:${m.color}"></i>${m.key} ${Math.round(m.val(a))}</span>`).join('');
    const reasonList = axisSet.map(m => `<div class="jz-reason"><b style="color:${m.color}">${m.key}</b> ${R[m.key]}</div>`).join('');
    const sc = jeonseScoreOf(a);
    return `
    <div class="rank-apt-row jz-row" data-i="${i}">
      <div class="rank-apt-rank" style="${i === 0 ? `color:${color}` : ''}">${i + 1}</div>
      <div class="rank-apt-main">
        <div class="rank-apt-name">${a.apt_name}</div>
        <div class="rank-apt-sub">전세 ${eokFmt(a.jeonse_median)} · ㎡당 ${Math.round(a.jeonse_ppm)}만 · 전세가율 ${Math.round(a.jeonse_ratio*100)}%${a._commute_km != null ? ` · 통근합 ${a._commute_km.toFixed(1)}km` : ''} ${window.JeonseSafety ? JeonseSafety.gradeBadge(a) : ''}</div>
        <div class="jz-axes">${axes}</div>
        <details class="jz-fold"><summary>왜 이 점수인가요?</summary>${reasonList}</details>
      </div>
      <div class="rank-apt-right">
        <div class="rank-apt-score" style="color:${sc>=70?color:'#6b7684'}">${sc.toFixed(0)}</div>
        <div class="rank-apt-sub" style="margin-top:.1rem">${lbl}</div>
      </div>
    </div>`;
  }).join('');

  const modeNote = jeonseMode === 'fit'
    ? `우리 직장 통근·인프라·약속장소 접근성 + 가격 합리성 종합`
    : `가격 합리성(가성비·전세평단가·보증금안전·전세유동성)만`;
  document.getElementById('jeonsePanel').innerHTML = `
    <div class="rank-dist-head" style="border-left:3px solid ${color}">
      <div class="rank-dist-title">${info.icon || '🏙️'} <b>${district}</b>
        <span class="rank-dist-tag">${lbl} 평균 ${avgJ}점</span></div>
      <div class="rank-dist-meta">전세 중앙값 평균 ${eokFmt(avgP)} · ${list.length}개 단지 · ${modeNote}</div>
    </div>
    <div class="ep-list-head">${jeonseMode === 'fit' ? '우리에게 맞는 전세' : '합리적 전세'} 순위 <span class="ep-list-cnt">${list.length}</span>
      <span class="rank-list-hint">펼치면 근거 · 이름 클릭 → 상세</span></div>
    <div class="rank-apt-list">${rows || '<div class="explorer-panel-empty">이 가격대의 전세 단지가 없어요.<br>필터를 넓혀보세요 🙂</div>'}</div>
  `;

  document.querySelectorAll('#jeonsePanel .jz-row').forEach(el => {
    el.querySelector('.rank-apt-name').addEventListener('click', (e) => {
      e.stopPropagation();
      const a = list[+el.dataset.i];
      if (a.lat && a.lng) jeonseMap.setView([a.lat, a.lng], 15, { animate: true });
      openJeonseModal(a.district, a.apt_name);
    });
  });
}

/* ── 전세 · 구별 순위 (매매 '동네별'의 전세 대칭 페이지) ───── */
let _jrMode = 'fit', _jrData = null;

async function renderJeonseRankings() {
  const el = document.getElementById('jeonseRankList');
  if (!el) return;   // 전세 구별 순위 페이지 아님
  await loadDistrictData();
  const data = await fetchJSON('/api/jeonse');
  const ranking = (data && data.ranking) || [];
  if (!ranking.length) { el.innerHTML = '<div class="empty-state">전세 데이터가 아직 없습니다.</div>'; return; }
  computeJeonseLifestyle(ranking);   // 통근·인프라·약속장소 → fit_total
  _jrData = ranking;
  _jeonseAll = ranking;   // 전세 상세 모달 공용 캐시

  document.querySelectorAll('#jrModeToggle .legend-mode-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      _jrMode = btn.dataset.mode;
      document.querySelectorAll('#jrModeToggle .legend-mode-btn').forEach(b => b.classList.toggle('active', b === btn));
      drawJeonseRankList();
    }));
  drawJeonseRankList();
}

function drawJeonseRankList() {
  const el = document.getElementById('jeonseRankList');
  const score = a => _jrMode === 'fit' ? a.fit_total : a.jeonse_total;
  const by = {};
  _jrData.forEach(r => { (by[r.district] = by[r.district] || []).push(r); });
  const groups = Object.keys(by).map(d => {
    const list = [...by[d]].sort((x, y) => score(y) - score(x));
    return {
      d, list,
      avg: list.reduce((s, r) => s + score(r), 0) / list.length,
      avgPrice: list.reduce((s, r) => s + (r.jeonse_median || 0), 0) / list.length,
    };
  }).sort((a, b) => b.avg - a.avg);

  el.innerHTML = groups.map((g, i) => {
    const info = districtData.find(x => x.name === g.d) || {};
    const top3 = g.list.slice(0, 3).map((a, j) => `
      <div class="jr-apt" data-d="${g.d}" data-a="${encodeURIComponent(a.apt_name)}" title="클릭하면 상세 점수">
        <span class="jr-apt-rank">${j + 1}</span>
        <span class="jr-apt-name">${a.apt_name}</span>
        <span class="jr-apt-price">${eokFmt(a.jeonse_median)}</span>
        <span class="jr-apt-score">${Math.round(score(a))}점</span>
      </div>`).join('');
    return `
    <div class="jr-card">
      <div class="jr-head">
        <span class="jr-rank">${i + 1}</span>
        <span class="jr-name">${info.icon || '🏙️'} ${g.d}</span>
        <span class="jr-meta">전세 평균 ${eokFmt(g.avgPrice)} · ${g.list.length}개</span>
        <span class="jr-score">${Math.round(g.avg)}<small>점</small></span>
      </div>
      ${top3}
      <a class="jr-maplink" href="/jeonse?d=${encodeURIComponent(g.d)}">지도에서 보기 →</a>
    </div>`;
  }).join('');
  el.querySelectorAll('.jr-apt').forEach(x =>
    x.addEventListener('click', () => openJeonseModal(x.dataset.d, decodeURIComponent(x.dataset.a))));
}

/* ── 전세 · 우리 맞춤 1위 (매매 '전체 1위'의 전세 대칭 페이지) ── */
async function renderJeonseTop1() {
  const el = document.getElementById('jeonseTop1Detail');
  if (!el) return;   // 우리 맞춤 전세 1위 페이지 아님
  await loadDistrictData();
  const data = await fetchJSON('/api/jeonse');
  const ranking = (data && data.ranking) || [];
  if (!ranking.length) { el.innerHTML = '<div class="empty-state">전세 데이터가 아직 없습니다.</div>'; return; }
  computeJeonseLifestyle(ranking);
  _jeonseAll = ranking;   // 전세 상세 모달 공용 캐시
  _jtRanking = ranking;
  initJtControls();
  drawJeonseTop1();
}

/* 사용자 설정: 예산 + 가중치 (브라우저에 저장) */
const JT_DEFAULT_W = { commute: 30, price: 30, infra: 22, spot: 18 };
const JT_AXIS = [   // 슬라이더 key ↔ FIT 축 매핑
  { k: 'commute', label: '회사통근',   color: '#f472b6', get: a => a.axis_commute },
  { k: 'price',   label: '가격합리성', color: '#34d399', get: a => a.jeonse_total },
  { k: 'infra',   label: '인프라',     color: '#818cf8', get: a => a.axis_infra },
  { k: 'spot',    label: '약속장소',   color: '#fbbf24', get: a => a.axis_spot },
];
let _jtRanking = null;
let jtW = { ...JT_DEFAULT_W, ...JSON.parse(localStorage.getItem('jeonseFitW_v1') || '{}') };
let jtBudget = JSON.parse(localStorage.getItem('jeonseBudget_v1') || '{"min":null,"max":null}');

function jtNormW() {   // 합 100%로 비례 정규화 (전부 0이면 기본값)
  const sum = JT_AXIS.reduce((s, m) => s + (jtW[m.k] || 0), 0);
  const base = sum > 0 ? jtW : JT_DEFAULT_W;
  const bs = JT_AXIS.reduce((s, m) => s + base[m.k], 0);
  const out = {};
  JT_AXIS.forEach(m => out[m.k] = base[m.k] / bs);
  return out;
}

function jtFitTotal(a, nw) {
  return JT_AXIS.reduce((s, m) => s + (m.get(a) ?? 50) * nw[m.k], 0);
}

function initJtControls() {
  // 저장된 값 복원
  JT_AXIS.forEach(m => {
    const sl = document.getElementById('jtw' + m.k[0].toUpperCase() + m.k.slice(1));
    if (sl) sl.value = jtW[m.k];
  });
  if (jtBudget.min != null) document.getElementById('jtBudgetMin').value = jtBudget.min;
  if (jtBudget.max != null) document.getElementById('jtBudgetMax').value = jtBudget.max;

  const onW = () => {
    JT_AXIS.forEach(m => {
      const sl = document.getElementById('jtw' + m.k[0].toUpperCase() + m.k.slice(1));
      if (sl) jtW[m.k] = +sl.value;
    });
    localStorage.setItem('jeonseFitW_v1', JSON.stringify(jtW));
    drawJeonseTop1();
  };
  JT_AXIS.forEach(m => {
    document.getElementById('jtw' + m.k[0].toUpperCase() + m.k.slice(1))
      ?.addEventListener('input', onW);
  });
  const onB = () => {
    const mn = parseFloat(document.getElementById('jtBudgetMin').value);
    const mx = parseFloat(document.getElementById('jtBudgetMax').value);
    jtBudget = { min: isNaN(mn) ? null : mn, max: isNaN(mx) ? null : mx };
    localStorage.setItem('jeonseBudget_v1', JSON.stringify(jtBudget));
    drawJeonseTop1();
  };
  document.getElementById('jtBudgetMin')?.addEventListener('change', onB);
  document.getElementById('jtBudgetMax')?.addEventListener('change', onB);
  document.getElementById('jtReset')?.addEventListener('click', () => {
    jtW = { ...JT_DEFAULT_W };
    jtBudget = { min: null, max: null };
    localStorage.removeItem('jeonseFitW_v1');
    localStorage.removeItem('jeonseBudget_v1');
    document.getElementById('jtBudgetMin').value = '';
    document.getElementById('jtBudgetMax').value = '';
    JT_AXIS.forEach(m => {
      const sl = document.getElementById('jtw' + m.k[0].toUpperCase() + m.k.slice(1));
      if (sl) sl.value = JT_DEFAULT_W[m.k];
    });
    drawJeonseTop1();
  });
}

function drawJeonseTop1() {
  const el = document.getElementById('jeonseTop1Detail');
  if (!el || !_jtRanking) return;
  const nw = jtNormW();

  // 슬라이더 옆 정규화 % 표시 갱신
  JT_AXIS.forEach(m => {
    const pctEl = document.getElementById('jtw' + m.k[0].toUpperCase() + m.k.slice(1) + 'Pct');
    if (pctEl) pctEl.textContent = Math.round(nw[m.k] * 100) + '%';
  });

  // 예산 필터 (전세 중앙값 기준, 억)
  const inBudget = a => {
    const eok = a.jeonse_median != null ? a.jeonse_median / 10000 : null;
    if (eok == null) return false;
    if (jtBudget.min != null && eok < jtBudget.min) return false;
    if (jtBudget.max != null && eok > jtBudget.max) return false;
    return true;
  };
  const pool = _jtRanking.filter(inBudget);
  const budgetLabel = (jtBudget.min != null || jtBudget.max != null)
    ? `예산 ${jtBudget.min ?? 0}~${jtBudget.max ?? '∞'}억 내 ${pool.length}개 매물`
    : `전체 ${pool.length}개 매물`;
  const hintEl = document.getElementById('jtBudgetHint');
  if (hintEl) hintEl.textContent = budgetLabel;

  if (!pool.length) {
    el.innerHTML = `<div class="empty-state">이 예산 범위의 전세 매물이 없어요.<br>범위를 넓혀보세요 🙂</div>`;
    const run0 = document.getElementById('jeonseTop1Runners');
    if (run0) run0.innerHTML = '';
    return;
  }

  const sorted = [...pool].sort((a, b) => jtFitTotal(b, nw) - jtFitTotal(a, nw));
  const w = sorted[0];
  const wScore = jtFitTotal(w, nw);
  const R = buildJeonseReasons(w);

  const axesHtml = JT_AXIS.map(m => {
    const meta = FIT_AXIS_META.find(x => x.key === m.label) || {};
    const v = m.get(w) ?? 0;
    return `
    <div class="top1-ax-group">
      <div class="top1-axis-row">
        <span class="top1-ax-dot" style="background:${m.color}"></span>
        <span class="top1-ax-name">${m.label} <small style="color:var(--text3)">${Math.round(nw[m.k] * 100)}%</small></span>
        <div class="top1-ax-bar"><div class="top1-ax-fill" style="width:${Math.min(100, v)}%;background:${m.color}"></div></div>
        <span class="top1-ax-val">${v.toFixed(0)}</span>
      </div>
      <div class="top1-ax-reason">${R[m.label] || meta.desc || ''}</div>
    </div>`;
  }).join('');

  el.innerHTML = `
    <div class="top1-hero">
      <div class="top1-badge">🔑 우리 맞춤 전세 1위 · ${budgetLabel}</div>
      <h3 class="top1-name">${w.apt_name}</h3>
      <div class="top1-loc">${w.district} · ${w.build_year || '—'}년 준공 · 전용 ${Math.round(w.area_exclusive || 0)}㎡</div>
      <div class="top1-score-big">${wScore.toFixed(1)}<span class="top1-score-unit">점</span></div>
      <div class="ep-links" style="justify-content:center;margin-top:.8rem">
        <a class="ep-map" href="${naverMapUrl(w.district, w.apt_name, w.dong, w.lat, w.lng)}" target="_blank" rel="noopener">네이버 지도 ↗</a>
        <a class="ep-naver" href="${naverLandUrl(w.district, w.apt_name, w.dong, w.lat, w.lng)}" target="_blank" rel="noopener">네이버 부동산 ↗</a>
        <a class="ep-hogang" href="${hogangnonoUrl(w.district, w.apt_name, w.dong, w.lat, w.lng)}" target="_blank" rel="noopener">호갱노노 ↗</a>
      </div>
    </div>
    <div class="top1-stats-grid">
      <div class="top1-stat"><div class="ts-val">${eokFmt(w.jeonse_median)}</div><div class="ts-key">전세 중앙값</div></div>
      <div class="top1-stat"><div class="ts-val">${w.jeonse_ratio != null ? Math.round(w.jeonse_ratio * 100) + '%' : '—'}</div><div class="ts-key">전세가율</div></div>
      <div class="top1-stat"><div class="ts-val">${w.jeonse_ppm != null ? Math.round(w.jeonse_ppm) + '만' : '—'}</div><div class="ts-key">㎡당 전세금</div></div>
      <div class="top1-stat"><div class="ts-val">${w._commute_km != null ? w._commute_km.toFixed(1) + 'km' : '—'}</div><div class="ts-key">두 직장 통근 합</div></div>
    </div>
    <div class="top1-axes" style="margin-top:1.2rem">${axesHtml}</div>
    <div id="jeonseTop1Transit"></div>`;
  fillCommuteTransit('jeonseTop1Transit', w);   // 🚇 우리 회사 가는 길

  // 2~5위 후보 (같은 조건 기준)
  const run = document.getElementById('jeonseTop1Runners');
  if (run) {
    run.innerHTML = sorted.slice(1, 5).map((a, i) => {
      const info = districtData.find(x => x.name === a.district) || {};
      return `
      <div class="jr-card jr-runner" data-d="${a.district}" data-a="${encodeURIComponent(a.apt_name)}" title="클릭하면 상세 점수">
        <div class="jr-head">
          <span class="jr-rank">${i + 2}</span>
          <span class="jr-name">${a.apt_name}</span>
          <span class="jr-score">${jtFitTotal(a, nw).toFixed(0)}<small>점</small></span>
        </div>
        <div class="jr-meta">${info.icon || ''} ${a.district} · 전세 ${eokFmt(a.jeonse_median)} · 통근합 ${a._commute_km != null ? a._commute_km.toFixed(1) + 'km' : '—'}</div>
      </div>`;
    }).join('');
    run.querySelectorAll('.jr-runner').forEach(x =>
      x.addEventListener('click', () => openJeonseModal(x.dataset.d, decodeURIComponent(x.dataset.a))));
  }
}

/* ── 🧱 빌라(연립·다세대) 동네 단위 분석 ─────────────────────
   src/villa_analysis.py 산출 villa.json 렌더. 건물별이 아니라 법정동 단위 —
   표본이 받쳐주는 지표만 보여주고, 개별 매물 한계는 caveat로 항상 노출한다. */
const VILLA_AXES = [
  ['afford', '가격 접근성', 'var(--green)'],
  ['liquidity', '유동성', 'var(--acc2)'],
  ['gap', '아파트 갭', 'var(--gold)'],
  ['trend', '가격 흐름', '#f472b6'],
  ['safety', '깡통 안전', 'var(--accent)'],
];
let _villaData = null;
let _villaDist = '전체';
let _villaMap = null;
let _villaMarkers = [];
let _villaMarkerByKey = {};

// 카드 클릭 → 지도에서 해당 위치로 이동 + 팝업 (링크·접이식 클릭은 제외)
function focusVillaOnMap(el) {
  const lat = parseFloat(el.dataset.lat), lng = parseFloat(el.dataset.lng);
  if (!_villaMap || isNaN(lat)) return;
  document.getElementById('villaMap')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  try {
    _villaMap.setView([lat, lng], 15, { animate: true });
    _villaMarkerByKey[el.dataset.zkey || el.dataset.key]?.openPopup();
  } catch (e) { /* 지도 스텁/미로드 환경 무시 */ }
}
function wireVillaCardClicks(containerId) {
  document.querySelectorAll(`#${containerId} .vl-card`).forEach(card =>
    card.addEventListener('click', (e) => {
      if (e.target.closest('a, details, summary, button, input')) return;
      focusVillaOnMap(card);
    }));
}

/* 동네 지도: 원 크기=거래량, 색=종합점수, 빨간 테두리=깡통 위험. 필터와 연동 */
function ensureVillaMap() {
  const el = document.getElementById('villaMap');
  if (!el || typeof L === 'undefined') return null;
  if (!_villaMap) {
    _villaMap = L.map('villaMap', { center: [37.552, 126.99], zoom: 11 });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 18,
    }).addTo(_villaMap);
    addWorkMarkers(_villaMap);   // 💼/💗 두 직장 항상 표시
  }
  return _villaMap;
}

function renderVillaMap(rows) {
  if (!ensureVillaMap()) return;
  try {
    _villaMarkers.forEach(m => _villaMap.removeLayer(m));
    _villaMarkers = [];
    _villaMarkerByKey = {};

    const pts = [];
    rows.forEach(d => {
      if (d.lat == null || d.lng == null) return;
      const sc = d.total ?? 0;
      const fill = sc >= 70 ? '#03a552' : sc >= 50 ? '#f59e0b' : '#94a3b8';
      const r = Math.max(7, Math.min(22, 6 + Math.sqrt(d.n_trades_12m || 0) * 0.55));
      const m = L.circleMarker([d.lat, d.lng], {
        radius: r, fillColor: fill, fillOpacity: 0.55, weight: d.jeonse_danger ? 3 : 1.5,
        color: d.jeonse_danger ? '#e5484d' : '#ffffff',
      }).addTo(_villaMap);
      m.bindPopup(`<b>${d.district} ${d.dong}</b> · ${(d.total ?? 0).toFixed(0)}점<br>
        중위 ${d.median_amount_eok}억 (${d.median_area}㎡) · 12개월 ${d.n_trades_12m}건<br>
        ${d.jeonse_ratio != null ? `전세가율 ${(d.jeonse_ratio * 100).toFixed(0)}%${d.jeonse_danger ? ' ⚠️' : ''}<br>` : ''}
        <a href="#" class="vl-popup-link" data-key="${d.district}|${encodeURIComponent(d.dong)}">아래 카드에서 자세히 ↓</a>`);
      m.on('popupopen', e => {
        e.popup.getElement()?.querySelector('.vl-popup-link')?.addEventListener('click', ev => {
          ev.preventDefault();
          const card = document.querySelector(`.vl-card[data-key="${ev.target.dataset.key}"]`);
          if (card) {
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('vl-flash');
            setTimeout(() => card.classList.remove('vl-flash'), 1600);
          }
        });
      });
      _villaMarkers.push(m);
      _villaMarkerByKey[`${d.district}|${encodeURIComponent(d.dong)}`] = m;
      pts.push([d.lat, d.lng]);
    });
    if (pts.length && _villaDist !== '전체') _villaMap.fitBounds(L.latLngBounds(pts).pad(0.2));
    else if (pts.length) _villaMap.setView([37.552, 126.99], 11);
  } catch (e) { console.error('villaMap', e); el.style.display = 'none'; }
}

function villaCard(d) {
  const sc = d.total ?? 0;
  const scColor = sc >= 70 ? 'var(--green)' : sc >= 50 ? 'var(--gold)' : 'var(--text3)';
  const axes = VILLA_AXES.map(([k, label, color]) => {
    const v = d['ax_' + k];
    if (v == null) return `<div class="vl-ax"><span class="vlk">${label}</span><div class="vl-bar"><div style="width:0"></div></div><span class="vlv" style="color:var(--text3)">—</span></div>`;
    return `<div class="vl-ax"><span class="vlk">${label}</span><div class="vl-bar"><div style="width:${v}%;background:${color}"></div></div><span class="vlv">${v.toFixed(0)}</span></div>`;
  }).join('');

  const chips = [];
  chips.push(`<span>🧾 12개월 ${d.n_trades_12m}건${d.liq_chg_pct != null ? ` (전년 ${d.liq_chg_pct > 0 ? '+' : ''}${d.liq_chg_pct.toFixed(0)}%)` : ''}</span>`);
  if (d.trend_pct_yr != null) chips.push(`<span style="color:${d.trend_pct_yr >= 0 ? 'var(--green)' : 'var(--red)'}">📈 ${d.trend_pct_yr > 0 ? '+' : ''}${d.trend_pct_yr.toFixed(1)}%/년</span>`);
  if (d.apt_gap != null) chips.push(`<span>🏢 아파트의 ${(d.apt_gap * 100).toFixed(0)}% 가격</span>`);
  if (d.jeonse_ratio != null) chips.push(`<span style="color:${d.jeonse_danger ? 'var(--red)' : 'inherit'}">🔑 전세가율 ${(d.jeonse_ratio * 100).toFixed(0)}%</span>`);
  if (d.median_age != null) chips.push(`<span>🏚️ 평균 ${d.median_age.toFixed(0)}년차</span>`);

  const badges = [];
  if (d.jeonse_danger) badges.push(`<span class="vl-badge vl-danger">⚠️ 깡통 위험권 (전세가율 80%+)</span>`);
  if (d.new_share != null && d.new_share >= 0.4) badges.push(`<span class="vl-badge vl-warn">🏗️ 신축 거래 ${(d.new_share * 100).toFixed(0)}% — 신축 고평가 주의</span>`);

  const trades = (d.recent_trades || []).map(t =>
    `<tr><td>${t.ym.slice(0, 4)}.${t.ym.slice(4)}</td><td>${t.name || '—'}</td><td>${t.area}㎡${t.floor != null ? ` · ${t.floor}층` : ''}</td><td>${t.build_year || '—'}년</td><td><b>${t.amount}억</b></td></tr>`).join('');

  return `
  <div class="vl-card vl-clickable" data-key="${d.district}|${encodeURIComponent(d.dong)}"
       ${d.lat != null ? `data-lat="${d.lat}" data-lng="${d.lng}"` : ''} title="카드를 누르면 지도에서 위치를 보여줍니다">
    <div class="vl-head">
      <span class="vl-rank">${d.rank}</span>
      <div class="vl-title">
        <div class="vl-name">${d.district} ${d.dong}</div>
        <div class="vl-meta">중위 <b>${d.median_amount_eok}억</b> · 전용 ${d.median_area}㎡ · 평당 ${d.py_price}억</div>
      </div>
      <span class="vl-score" style="color:${scColor}">${sc.toFixed(0)}<small>점</small></span>
    </div>
    <div class="vl-axes">${axes}</div>
    <div class="vl-chips">${chips.join('')}</div>
    ${badges.length ? `<div class="vl-badges">${badges.join('')}</div>` : ''}
    <details class="jz-fold" style="margin-top:.5rem">
      <summary>최근 실거래 · 지표 근거</summary>
      <table class="sub-table" style="margin-top:.5rem">
        <tr><th>계약</th><th>건물</th><th>면적·층</th><th>준공</th><th>가격</th></tr>${trades}
      </table>
      <div class="sub-detail-note" style="margin-top:.5rem">
        <b>가격 접근성</b>은 ㎡당 매매가(낮을수록↑), <b>유동성</b>은 최근 12개월 거래량(많을수록 되팔기 쉬움),
        <b>아파트 갭</b>은 같은 구 아파트 ㎡당가 대비 빌라 가격(쌀수록 할인·재개발 여지↑),
        <b>가격 흐름</b>은 36개월 추세, <b>깡통 안전</b>은 빌라 전세가율(80% 이상이면 역전세·전세사기 위험권)입니다.
        모두 이 동네 실거래만으로 계산한 서울 전체 동네 중 백분위(0~100)입니다.</div>
    </details>
  </div>`;
}

function renderVillaList() {
  const d = _villaData;
  const list = document.getElementById('villaList');
  const sortKey = document.getElementById('villaSort').value;
  const maxEok = parseFloat(document.getElementById('villaMaxEok').value) || null;
  const asc = ['ppm2', 'apt_gap', 'jeonse_ratio'].includes(sortKey);

  let rows = d.dongs.filter(x => _villaDist === '전체' || x.district === _villaDist);
  if (maxEok) rows = rows.filter(x => x.median_amount_eok <= maxEok);
  rows = [...rows].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av == null) return 1;
    if (bv == null) return -1;
    return asc ? av - bv : bv - av;
  });

  document.getElementById('villaSummary').textContent =
    `기준 ${d.period_12m.replace('~', ' ~ ')} · 표본 충분 동네 ${d.n_dongs}개 중 ${rows.length}개 표시 · 실거래 ${d.n_trades_used.toLocaleString()}건 사용`;
  list.innerHTML = rows.map(villaCard).join('') ||
    `<div class="sub-note">조건에 맞는 동네가 없습니다 — 예산 상한이나 구 필터를 풀어보세요.</div>`;
  wireVillaCardClicks('villaList');
  renderVillaMap(rows);
}

/* ── 🧱 정비구역 3박자 뷰 ──────────────────────────────
   '쉬운 상식'의 3박자(자리·사업성·이해관계)를 그대로 축으로 쓰는 구역 채점.
   villa_zones.json(src/zone_analysis.py) 렌더. 동뷰와 지도를 공유한다. */
const ZONE_AXES = [
  ['ax_place', '🅰 좋은 자리', 'var(--green)', '주변 아파트의 교통·업무지구·학군 + 구 아파트 시세(완공 후 가치)'],
  ['ax_biz', '🅱 사업성', 'var(--gold)', '종전 평형(클수록 ↑) + 아파트 갭(빌라가 쌀수록 ↑) — 용적률은 데이터 확보 시 추가'],
  ['ax_align', '🅲 맞는 이해관계', 'var(--acc2)', '거래 면적의 균일함(평형 구성이 비슷할수록 ↑)'],
];
let _zoneData = null;
let _zoneDist = '전체';
let _villaView = 'zone';

function zoneTierColor(i) {
  // 목록 순위(현재 정렬 기준)로 티어 색: TOP10 주황 / 11~20 초록 / 21~50 파랑 / 나머지 회색
  if (i < 10) return '#ff7426';
  if (i < 20) return '#03a552';
  if (i < 50) return '#6c8cf5';
  return '#94a3b8';
}

function zoneStageTl(z, steps) {
  return steps.map((s, i) => {
    const on = z.stage_idx >= 0 && i <= z.stage_idx;
    const cur = i === z.stage_idx;
    return `<span class="zn-step ${on ? 'on' : ''} ${cur ? 'cur' : ''}" title="${s}">${cur ? s : ''}</span>`;
  }).join('<span class="zn-step-line"></span>');
}

/* 플로팅 상세 패널 — 점수의 세부 근거를 전부 보여준다 */
const CONF_META = {
  high:   { label: '높음', color: '#03a552', dot: '<span style="color:#03a552">●</span>' },
  medium: { label: '보통', color: '#f59e0b', dot: '<span style="color:#f59e0b">●</span>' },
  low:    { label: '낮음', color: '#94a3b8', dot: '<span style="color:#94a3b8">●</span>' },
};

// 신뢰도 배너: 점수를 뒷받침하는 3박자 근거가 각각 실측/추정/없음 중 무엇인지 밝힌다
function zoneConfBanner(z) {
  const cm = CONF_META[z.confidence] || CONF_META.medium;
  const src = (ok, part, none, cond) => cond === 'ok' ? `<b style="color:var(--green)">${ok}</b>`
    : cond === 'part' ? `<b style="color:var(--gold)">${part}</b>` : `<span style="color:var(--text3)">${none}</span>`;
  const place = src('동 실측', '', '구 평균 추정', z.ev_dong_hit ? 'ok' : 'none');
  const biz = src('용적률 실데이터', '', '용적률 미확보(시세만)', z.far_plan != null ? 'ok' : 'none');
  const align = src('실거래 기반', '계획 세대 추정', '데이터 없음',
    z.align_src === 'trades' ? 'ok' : z.align_src === 'plan' ? 'part' : 'none');
  const headline = z.confidence === 'high' ? '3박자 모두 실데이터로 뒷받침됩니다.'
    : z.confidence === 'low' ? `근거가 제한적입니다(축 ${z.conf_axes}/3) — 점수를 액면 그대로 믿지 마세요.`
    : '일부 축은 추정치입니다 — 아래 출처를 확인하세요.';
  return `
    <div class="zd-conf" style="border-color:${cm.color}">
      <div class="zd-conf-head"><span class="conf-dot" style="background:${cm.color}"></span>
        근거 신뢰도 <b style="color:${cm.color}">${cm.label}</b> · 실데이터 축 ${z.conf_axes}/3</div>
      <div class="zd-conf-note">${headline}</div>
      <div class="zd-conf-srcs">🅰 자리 ${place} · 🅱 사업성 ${biz} · 🅲 이해관계 ${align}</div>
    </div>`;
}

function showZoneDetail(z) {
  const el = document.getElementById('zoneDetail');
  if (!el || !_zoneData) return;
  const steps = _zoneData.stage_steps || [];
  const axes = ZONE_AXES.map(([k, label, color]) => {
    const v = z[k];
    return `<div class="vl-ax zn-ax"><span class="vlk">${label}</span>
      <div class="vl-bar"><div style="width:${v ?? 0}%;background:${color}"></div></div>
      <span class="vlv">${v != null ? v.toFixed(0) : '—'}</span></div>`;
  }).join('');

  const basis = z.ev_dong_hit
    ? `같은 동 분석 아파트 ${z.ev_n_apts}개 실측 기준`
    : `${z.gu} 평균 기준 (동 단위 표본 부족)`;
  const cv = z.align_cv;
  const cvLabel = cv == null ? null : cv <= 0.25 ? '균일 — 이해관계 갈등 적음' : cv <= 0.4 ? '보통' : '혼재 — 1인 1표 갈등 소지';

  const row = (k, v) => v ? `<div class="jb-row"><span>${k}</span><span><b>${v}</b></span></div>` : '';
  const q = encodeURIComponent(`${z.gu} ${z.addr || z.name}`);

  el.innerHTML = `
    <button class="mpd-close" id="zoneDetailClose">✕</button>
    <div class="ep-head">
      <div class="ep-name">${z.name} <span class="zn-type ${(z.type || '').includes('재건축') ? 'zn-re' : 'zn-rd'}">${z.type || '정비사업'}</span></div>
      <div class="ep-loc">${z.gu}${z.addr ? ' ' + z.addr : ''} · 3박자 ${z.total != null ? z.total.toFixed(0) : '—'}점 (전체 ${z.rank}위)</div>
    </div>
    <div class="zn-tl" style="margin:.5rem 0 .7rem">${zoneStageTl(z, steps)}</div>
    ${zoneConfBanner(z)}
    <div class="vl-axes">${axes}</div>

    <div class="zd-sec">🅰 자리 — 왜 이 점수인가</div>
    ${row('가까운 업무지구', z.ev_hub_name ? `${z.ev_hub_name} · 평균 ${z.ev_hub_km}km` : null)}
    ${row('역세권 점수', z.ev_transit != null ? `${z.ev_transit}점 / 100` : null)}
    ${row('학군 점수', z.ev_school != null ? `${z.ev_school}점 / 100` : null)}
    ${row('구 아파트 평당가 (완공 후 가치)', z.ev_gu_apt_py != null ? `${z.ev_gu_apt_py}억/평` : null)}
    <div class="sub-foot" style="border-top:none;margin-top:.2rem">근거: ${basis}</div>

    <div class="zd-sec">🅱 사업성 — 숫자로</div>
    ${row('종전 평형 (일대 빌라 거래 중앙값)', z.biz_area != null ? `전용 ${z.biz_area}㎡ ${z.biz_area >= 55 ? '· 초소형 함정 없음 ✓' : z.biz_area < 40 ? '· ⚠️ 소형 위주 — 일반분양 여력 주의' : ''}` : null)}
    ${row('아파트 갭', z.biz_gap != null ? `주변 아파트의 ${(z.biz_gap * 100).toFixed(0)}% 가격` : null)}
    ${row('중위 빌라가 · 거래량', z.villa_amt != null ? `${z.villa_amt}억 · 12개월 ${z.n_trades_12m}건` : null)}
    ${row('가격 흐름', z.ev_trend != null ? `${z.ev_trend > 0 ? '+' : ''}${z.ev_trend.toFixed(1)}%/년` : null)}
    ${z.use_zone ? row('용도지역 (땅의 족보)', `${z.use_zone}${z.far_limit ? ` · 조례 기본한도 ${z.far_limit}%` : ''}`) : ''}
    ${z.far_plan != null ? row('계획 용적률', `<b style="color:var(--accent)">${z.far_plan}%</b>${z.far_limit ? ` (기본한도 ${z.far_limit}% 대비 ${z.far_plan > z.far_limit ? '+' : ''}${(z.far_plan - z.far_limit).toFixed(0)}%p — 정비사업 완화 적용)` : ''}`) : ''}
    ${z.bcr != null || z.floors != null ? row('건폐율 · 층수', `${z.bcr != null ? '건폐율 ' + z.bcr + '%' : ''}${z.floors != null ? ' · 최고 지상 ' + z.floors + '층' : ''}`) : ''}
    ${z.units_sale != null ? row('계획 세대수', `분양 ${z.units_sale.toLocaleString()}세대${z.units_rental != null ? ' + 임대 ' + z.units_rental.toLocaleString() + '세대' : ''}`) : ''}
    ${z.land_area_z != null ? row('대지면적', `${Math.round(z.land_area_z).toLocaleString()}㎡ (약 ${Math.round(z.land_area_z / 3.3058).toLocaleString()}평)`) : ''}
    ${z.owners != null || z.tenants != null ? row('토지등소유자 · 세입자', `${z.owners != null ? '소유자 ' + z.owners.toLocaleString() + '명' : ''}${z.tenants != null ? ' · 세입자 ' + z.tenants.toLocaleString() + '명' : ''}`) : ''}
    ${z.far_plan == null ? `<div class="jb-row"><span>용적률 (사업개요)</span><span><b>아직 미확보</b></span></div>
    <div class="sub-foot" style="border-top:none;margin-top:.2rem">이 구역의 사업개요가 정비몽땅에 아직 없거나 수집 전입니다 — 서울 조례 한도 참고: 2종 일반주거 200% · 3종 250% · 준주거 400%.
      <a href="https://cleanup.seoul.go.kr/cleanup/bsnssttus/lscrMainIndx.do" target="_blank" rel="noopener">정비몽땅 ↗</a></div>` : ''}

    <div class="zd-sec">🅲 이해관계 — 평형 구성</div>
    ${row('거래 평형 편차', cv != null ? `±${(cv * 100).toFixed(0)}% → ${cvLabel}` : null)}
    ${cv == null && z.align_hhi != null ? row('계획 평형 쏠림 (폴백)', `${z.align_hhi <= 0.45 ? '고른 구성' : z.align_hhi <= 0.6 ? '보통' : '한 평형 집중'} — 사업개요의 계획 세대 구성 기준(종전 아님)`) : ''}
    ${z.ev_jeonse_ratio != null ? row('동네 빌라 전세가율', `${(z.ev_jeonse_ratio * 100).toFixed(0)}%${z.ev_jeonse_danger ? ' ⚠️ 깡통 위험권' : ''}`) : ''}
    ${z.ev_new_share != null && z.ev_new_share >= 0.3 ? row('신축 거래 비중', `${(z.ev_new_share * 100).toFixed(0)}% — 쪼개기·고평가 주의`) : ''}

    <div class="ep-links" style="margin-top:.8rem">
      <a class="ep-map" href="https://map.naver.com/p/search/${q}" target="_blank" rel="noopener">네이버 지도 ↗</a>
      <a class="ep-naver" href="https://search.naver.com/search.naver?query=${encodeURIComponent(z.name)}" target="_blank" rel="noopener">뉴스 검색 ↗</a>
      <a class="ep-hogang" href="https://cleanup.seoul.go.kr/cleanup/bsnssttus/lscrMainIndx.do" target="_blank" rel="noopener">정비몽땅 ↗</a>
    </div>
    <div class="sub-foot" style="margin-top:.6rem">⚠️ 물딱지·권리산정기준일·다물권은 데이터 밖 — 매수 검토 전 ${z.gu}청 정비사업과 확인 필수.</div>`;
  el.style.display = 'block';
  document.getElementById('zoneDetailClose').addEventListener('click', () => { el.style.display = 'none'; });
  if (_villaMap && z.lat != null) {
    document.querySelector('.villa-map-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    try { _villaMap.setView([z.lat, z.lng], 14, { animate: true }); } catch (e) {}
  }
}

function renderZoneMarkers(rows) {
  if (!ensureVillaMap()) return;
  try {
    _villaMarkers.forEach(m => _villaMap.removeLayer(m));
    _villaMarkers = [];
    _villaMarkerByKey = {};
    rows.forEach((z, i) => {
      if (z.lat == null) return;
      const m = L.circleMarker([z.lat, z.lng], {
        radius: i < 10 ? 12 : i < 20 ? 10 : 8,
        fillColor: zoneTierColor(i), fillOpacity: 0.8, weight: 1.5, color: '#ffffff',
      }).addTo(_villaMap);
      m.on('click', () => showZoneDetail(z));
      m.bindTooltip?.(`${i + 1}. ${z.name.slice(0, 18)}`, { direction: 'top' });
      _villaMarkers.push(m);
    });
  } catch (e) { console.error('zoneMarkers', e); }
}

let _zoneTier = parseInt(localStorage.getItem('zoneTier_v1') || '20');
let _zoneHiConf = localStorage.getItem('zoneHiConf_v1') === '1';

function renderZoneList() {
  const d = _zoneData;
  const listEl = document.getElementById('zoneList');
  if (!d || !listEl) return;
  const sortKey = document.getElementById('zoneSort').value;
  const typ = document.getElementById('zoneTypeSel').value;
  let rows = d.zones.filter(z => _zoneDist === '전체' || z.gu === _zoneDist);
  if (typ !== '전체') rows = rows.filter(z => (z.type || '').includes(typ));
  if (_zoneHiConf) rows = rows.filter(z => z.confidence === 'high');   // 신뢰도 높음만
  rows = [...rows].sort((a, b) => {
    if (sortKey === 'stage_idx') return (a.stage_idx ?? 99) - (b.stage_idx ?? 99);
    if (sortKey === 'stage_desc') return (b.stage_idx ?? -1) - (a.stage_idx ?? -1);
    const av = a[sortKey], bv = b[sortKey];
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });
  const shown = _zoneTier > 0 ? rows.slice(0, _zoneTier) : rows;

  document.getElementById('zoneSummary').innerHTML =
    `정비구역 ${rows.length}곳 중 <b>${shown.length}곳</b> 표시 · ` +
    `<span style="color:#ff7426">● TOP 10</span> <span style="color:#03a552">● 11~20</span> ` +
    `<span style="color:#6c8cf5">● 21~50</span> · 신뢰도 ${CONF_META.high.dot}높음 ${CONF_META.medium.dot}보통 ${CONF_META.low.dot}낮음 · 행을 누르면 상세`;

  listEl.innerHTML = shown.map((z, i) => {
    const cm = CONF_META[z.confidence] || CONF_META.medium;
    return `
    <div class="zr-row" data-i="${i}">
      <span class="zr-rank" style="background:${zoneTierColor(i)}">${i + 1}</span>
      <div class="zr-main">
        <div class="zr-name">${z.name}</div>
        <div class="zr-sub"><span class="conf-dot" style="background:${cm.color}" title="근거 신뢰도: ${cm.label}"></span>${z.gu} · ${z.type || '정비사업'} · ${z.stage || '단계 미상'}${z.villa_amt != null ? ` · 중위 ${z.villa_amt}억` : ''}</div>
      </div>
      <span class="zr-score" style="color:${zoneTierColor(i)}">${z.total != null ? z.total.toFixed(0) : '—'}<small>점</small></span>
    </div>`;
  }).join('') || `<div class="sub-note">조건에 맞는 구역이 없습니다 — 신뢰도 필터를 풀어보세요.</div>`;
  listEl.querySelectorAll('.zr-row').forEach(r =>
    r.addEventListener('click', () => showZoneDetail(shown[+r.dataset.i])));

  renderZoneMarkers(shown);
}

async function renderVillaZones() {
  const listEl = document.getElementById('zoneList');
  if (!listEl) return false;
  const d = await (await fetch('/api/villa_zones')).json();
  if (!d.zones || !d.zones.length) {
    listEl.innerHTML = `
    <div class="budget-card" style="grid-column:1/-1">
      <div class="budget-card-title">정비구역 데이터 수집 대기 중</div>
      <div class="sub-note" style="line-height:1.7">
        서울시 정비사업 공개 목록(정비몽땅)에서 구역 목록을 자동 수집하도록 준비되어 있습니다 —
        GitHub Actions의 <b>「빌라 실거래 수집」</b> 워크플로가 다음 실행 때 채웁니다.
        더 풍부한 필드(면적·계획 용적률)를 원하면 <b>서울 열린데이터광장(data.seoul.go.kr) 인증키</b>를
        Secret <code>SEOUL_API_KEY</code>로 등록해 주세요 (선택).</div>
    </div>`;
    return false;
  }
  _zoneData = d;
  document.getElementById('zoneCaveat').textContent = '⚠️ ' + (d.caveat || '');
  const dists = ['전체', ...[...new Set(d.zones.map(z => z.gu).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'))];
  const box = document.getElementById('zoneDistChips');
  box.innerHTML = dists.map(x => `<button class="price-chip ${x === _zoneDist ? 'active' : ''}" data-d="${x}">${x}</button>`).join('');
  box.querySelectorAll('.price-chip').forEach(c => c.addEventListener('click', () => {
    _zoneDist = c.dataset.d;
    box.querySelectorAll('.price-chip').forEach(x => x.classList.toggle('active', x.dataset.d === _zoneDist));
    renderZoneList();
  }));
  document.getElementById('zoneSort').addEventListener('input', renderZoneList);
  document.getElementById('zoneTypeSel').addEventListener('input', renderZoneList);
  // TOP 10 / 20 / 50 / 전체 티어 칩
  const tierBox = document.getElementById('zoneTierChips');
  tierBox.querySelectorAll('.price-chip').forEach(c => {
    c.classList.toggle('active', +c.dataset.n === _zoneTier);
    c.addEventListener('click', () => {
      _zoneTier = +c.dataset.n;
      localStorage.setItem('zoneTier_v1', String(_zoneTier));
      tierBox.querySelectorAll('.price-chip').forEach(x => x.classList.toggle('active', x === c));
      renderZoneList();
    });
  });
  // 신뢰도 높음만 보기 토글
  const hc = document.getElementById('zoneHiConf');
  if (hc) {
    hc.checked = _zoneHiConf;
    hc.addEventListener('change', () => {
      _zoneHiConf = hc.checked;
      localStorage.setItem('zoneHiConf_v1', _zoneHiConf ? '1' : '0');
      renderZoneList();
    });
  }
  renderZoneList();
  return true;
}

function applyVillaView(view) {
  _villaView = view === 'dong' ? 'dong' : 'zone';
  localStorage.setItem('villaView_v1', _villaView);
  document.querySelectorAll('#villaViewToggle .legend-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === _villaView));
  document.getElementById('villaZoneView').style.display = _villaView === 'zone' ? '' : 'none';
  document.getElementById('villaDongView').style.display = _villaView === 'dong' ? '' : 'none';
  const legend = document.getElementById('villaMapLegend');
  if (legend) legend.style.display = _villaView === 'dong' ? '' : 'none';
  if (_villaView === 'dong') renderVillaList(); else renderZoneList();
}

async function renderVilla() {
  const list = document.getElementById('villaList');
  if (!list) return;
  const d = await (await fetch('/api/villa')).json();
  if (!d.dongs || !d.dongs.length) {
    list.innerHTML = `
    <div class="budget-card" style="grid-column:1/-1">
      <div class="budget-card-title">아직 빌라 데이터가 없습니다</div>
      <div class="sub-note" style="line-height:1.7">
        공공데이터포털(data.go.kr)에서 아래 두 API를 <b>기존 국토부 키 그대로</b> 활용신청하면 됩니다 (자동승인·무료):<br>
        ① <b>국토교통부_연립다세대 매매 실거래가 자료</b><br>
        ② <b>국토교통부_연립다세대 전월세 실거래가 자료</b><br>
        신청 후 GitHub Actions의 <b>「빌라 실거래 수집」</b> 워크플로를 실행하면 수집(78개월치, 1~2회 실행) →
        동네 분석까지 자동으로 채워집니다.</div>
    </div>`;
    return;
  }
  _villaData = d;
  document.getElementById('villaCaveat').textContent = '⚠️ ' + (d.caveat || '');

  // 구 칩
  const dists = ['전체', ...[...new Set(d.dongs.map(x => x.district))].sort((a, b) => a.localeCompare(b, 'ko'))];
  const chipBox = document.getElementById('villaDistChips');
  chipBox.innerHTML = dists.map(x =>
    `<button class="price-chip ${x === _villaDist ? 'active' : ''}" data-d="${x}">${x}</button>`).join('');
  chipBox.querySelectorAll('.price-chip').forEach(c => c.addEventListener('click', () => {
    _villaDist = c.dataset.d;
    chipBox.querySelectorAll('.price-chip').forEach(x => x.classList.toggle('active', x.dataset.d === _villaDist));
    renderVillaList();
  }));
  document.getElementById('villaSort').addEventListener('input', renderVillaList);
  document.getElementById('villaMaxEok').addEventListener('input', renderVillaList);

  // 구역(3박자) 뷰 + 전환 토글 — 구역 데이터 없으면 동뷰로 자동 전환
  const hasZones = await renderVillaZones();
  document.querySelectorAll('#villaViewToggle .legend-mode-btn').forEach(b =>
    b.addEventListener('click', () => applyVillaView(b.dataset.view)));
  const savedView = localStorage.getItem('villaView_v1');
  applyVillaView(hasZones ? (savedView || 'zone') : 'dong');
}

/* ── 🏔️ 성북구 심화 — 300세대+ 전수 단지 (지도 탐색 스타일) ──
   collect_seongbuk.py 산출(/api/seongbuk). 버블 색=경사도, 아래 숫자=최근가.
   목록/버블 클릭 → 플로팅 상세(경사·주차·복도·시세·장단점·로드뷰). */
let _sbData = null, _sbMap = null, _sbMarkers = [], _sbSlope = 'all', _sbVisible = [];

function _sbSlopeColor(s) {
  if (s == null) return '#9ca3af';
  return s < 3 ? '#16a34a' : s < 6 ? '#f59e0b' : s < 10 ? '#ef4444' : '#b91c1c';
}
const _sbEok = m => m == null ? '—' : (m / 10000).toFixed(m >= 100000 ? 0 : 1) + '억';
// 시세 표시 통일: 최근 12개월 중위가 → 없으면 마지막 20건 중위가(≈ 표시, 기준 시점 병기)
function _sbPrice(c) {
  if (c.med_12m) return { v: c.med_12m, ppm2: c.ppm2_12m, stale: false, ym: null };
  if (c.med_any) return { v: c.med_any, ppm2: c.ppm2_any, stale: true, ym: c.any_ym };
  return null;
}

function _sbFiltered() {
  const maxEok = parseFloat(document.getElementById('sbMaxEok')?.value) || 0;
  return (_sbData.complexes || []).filter(c => {
    const s = c.slope_pct;
    if (_sbSlope === 'flat' && !(s != null && s < 3)) return false;
    if (_sbSlope === 'mild' && !(s != null && s >= 3 && s < 6)) return false;
    if (_sbSlope === 'hill' && !(s != null && s >= 6)) return false;
    if (maxEok > 0 && c.med_12m && c.med_12m > maxEok * 10000) return false;
    return true;
  });
}

function _sbSort(rows) {
  const mode = document.getElementById('sbSort').value;
  const key = {
    households: c => -(c.households || 0),
    ppm2:       c => c.ppm2_12m ?? 1e9,
    priceAsc:   c => c.med_12m ?? 1e12,
    slope:      c => c.slope_pct ?? 1e9,
    build_year: c => -(c.build_year || 0),
    trend:      c => -(c.trend_pct ?? -1e9),
    n12:        c => -(c.n_12m || 0),
  }[mode] || (c => -(c.households || 0));
  return [...rows].sort((a, b) => key(a) - key(b));
}

function renderSb() {
  _sbVisible = _sbSort(_sbFiltered());
  document.getElementById('sbCount').textContent = `${_sbVisible.length}개 단지`;

  // 버블 마커
  try {
    _sbMarkers.forEach(m => _sbMap.removeLayer(m));
    _sbMarkers = [];
    _sbVisible.forEach((c, i) => {
      if (c.lat == null) return;
      const p = _sbPrice(c);
      const sub = p ? (p.stale ? '≈' : '') + _sbEok(p.v) : `${(c.households || 0).toLocaleString()}세대`;
      const icon = L.divIcon({
        className: '',
        html: `<div class="apt-bubble" style="background:${_sbSlopeColor(c.slope_pct)}">
                 <span class="apt-bubble-name">${shortName(c.name)}</span>
                 <span class="apt-bubble-price">${sub}</span>
               </div>`,
        iconSize: [72, 40], iconAnchor: [36, 40],
      });
      const m = L.marker([c.lat, c.lng], { icon });
      m.on('click', () => showSbDetail(c));
      m.addTo(_sbMap);
      _sbMarkers.push(m);
    });
  } catch (e) { /* 지도 스텁 환경 무시 */ }

  // 목록 패널
  const rows = _sbVisible.map((c, i) => `
    <div class="ep-list-row" data-idx="${i}">
      <div class="ep-list-rank">${i + 1}</div>
      <div class="ep-list-main">
        <div class="ep-list-name">${c.name}</div>
        <div class="ep-list-sub">${c.dong || ''} · ${(c.households || 0).toLocaleString()}세대${c.build_year ? ` · ${c.build_year}년` : ''}${c.slope_pct != null ? ` · <span style="color:${_sbSlopeColor(c.slope_pct)}">⛰${c.slope_pct}%</span>` : ''}</div>
      </div>
      <div class="ep-list-right">${(() => {
        const p = _sbPrice(c);
        if (!p) return `<div class="ep-list-price">—</div><div class="ep-list-score">거래이력 없음</div>`;
        return `<div class="ep-list-price">${p.stale ? '≈' : ''}${_sbEok(p.v)}</div>
          <div class="ep-list-score">${p.stale ? `${p.ym} 마지막` : Math.round(p.ppm2).toLocaleString() + '만/㎡'}</div>`;
      })()}</div>
    </div>`).join('');
  document.getElementById('sbPanel').innerHTML = `
    <div class="ep-list-head">단지 목록 <span class="ep-list-cnt">${_sbVisible.length}</span></div>
    <div class="ep-list">${rows || '<div class="explorer-panel-empty">조건에 맞는 단지가 없습니다</div>'}</div>`;
  document.querySelectorAll('#sbPanel .ep-list-row').forEach(el =>
    el.addEventListener('click', () => {
      const c = _sbVisible[+el.dataset.idx];
      if (c.lat != null) { try { _sbMap.setView([c.lat, c.lng], 15, { animate: true }); } catch (e) {} }
      showSbDetail(c);
    }));
}

function showSbDetail(c) {
  const panel = document.getElementById('sbDetail');
  if (!panel) return;
  const meta = [
    c.dong, c.build_year ? `${c.build_year}년 준공` : null,
    c.dong_cnt ? `${c.dong_cnt}개동` : null, c.hall_type || null, c.heat || null,
    c.main_area ? `주력 ${Math.round(c.main_area)}㎡` : null,
  ].filter(Boolean).join(' · ');
  const slope = c.slope_pct != null
    ? `<span class="sb-slope" style="background:${_sbSlopeColor(c.slope_pct)}1a;color:${_sbSlopeColor(c.slope_pct)}">⛰ ${c.slope_label} ${c.slope_pct}%${c.elevation_m != null ? ` · 고도 ${c.elevation_m}m` : ''}</span>`
    : `<span class="sb-slope" style="color:var(--text3)">⛰ 경사 데이터 수집 대기</span>`;
  panel.innerHTML = `
    <button class="mpd-close" id="sbDetailClose" title="닫기">✕</button>
    <div class="ep-head">
      <div class="ep-name">${c.name}${c.hh_source === 'estimated' ? ' <span class="sb-est">추정</span>' : ''}</div>
      <div class="ep-loc">${meta}</div>
    </div>
    <div class="ep-price-grid">
      <div class="ep-price"><span class="epv">${(c.households || 0).toLocaleString()}</span><span class="epk">세대수</span></div>
      ${(() => {
        const p = _sbPrice(c);
        if (!p) return `<div class="ep-price"><span class="epv">—</span><span class="epk">거래이력 없음</span></div>`;
        return `<div class="ep-price"><span class="epv">${p.stale ? '≈' : ''}${_sbEok(p.v)}</span><span class="epk">${p.stale ? `중위가 (${p.ym} 기준)` : '최근 12개월 중위가'}</span></div>`;
      })()}
      <div class="ep-price"><span class="epv">${c.parking && c.households ? (c.parking / c.households).toFixed(1) + '대' : '—'}</span><span class="epk">주차/세대</span></div>
      <div class="ep-price"><span class="epv" style="color:${(c.trend_pct ?? 0) >= 0 ? 'var(--green)' : 'var(--red)'}">${c.trend_pct != null ? (c.trend_pct >= 0 ? '+' : '') + c.trend_pct + '%' : '—'}</span><span class="epk">1년 추세</span></div>
    </div>
    <div class="sb-slope-row" style="margin:.3rem 0 .5rem">${slope}</div>
    <div id="sbReviewTags"></div>
    <div class="ep-tags">
      ${c.subway_station ? `<span class="aptag">🚇 ${c.subway_station}${c.subway_walk ? ` 도보 ${c.subway_walk}` : ''}</span>` : ''}
      ${c.n_12m ? `<span class="aptag">최근 12개월 거래 ${c.n_12m}건</span>` : '<span class="aptag">최근 12개월 실거래 없음</span>'}
      ${c.ppm2_12m ? `<span class="aptag">㎡가 ${Math.round(c.ppm2_12m).toLocaleString()}만</span>` : ''}
    </div>
    ${c.pros?.length ? `<div class="sb-pc sb-pros"><div class="sb-pc-t">👍 장점</div><ul>${c.pros.map(p => `<li>${p}</li>`).join('')}</ul></div>` : ''}
    ${c.cons?.length ? `<div class="sb-pc sb-cons" style="margin-top:.4rem"><div class="sb-pc-t">👎 단점</div><ul>${c.cons.map(p => `<li>${p}</li>`).join('')}</ul></div>` : ''}
    <div class="ep-links" style="margin-top:.6rem">
      ${c.lat != null ? `<a class="ep-map" href="https://map.kakao.com/link/roadview/${c.lat},${c.lng}" target="_blank" rel="noopener">📷 로드뷰 ↗</a>` : ''}
      <a class="ep-naver" href="https://m.land.naver.com/search/result/${encodeURIComponent('성북구 ' + c.name)}" target="_blank" rel="noopener">네이버 부동산 ↗</a>
      <a class="ep-hogang" href="https://map.kakao.com/link/map/${encodeURIComponent(c.name)},${c.lat ?? 37.6},${c.lng ?? 127.02}" target="_blank" rel="noopener">카카오맵 ↗</a>
    </div>`;
  panel.style.display = 'block';
  document.getElementById('sbDetailClose').addEventListener('click', () => {
    panel.style.display = 'none';
  });
  fillSbReviewTags(c);   // 💬 실제 이야기 해시태그 (비동기)
}

// 리뷰 태그는 K-apt 이름 또는 실거래 이름으로 키가 잡혀 있을 수 있어 둘 다 시도
async function fillSbReviewTags(c) {
  const all = await ensureReviews();
  const key = [c.name, c.trade_name].find(n => n && all[`성북구|${n}`]?.tags?.length);
  if (key) fillReviewTags('sbReviewTags', '성북구', key, true);
  else { const el = document.getElementById('sbReviewTags'); if (el) el.innerHTML = ''; }
}

async function renderSeongbuk() {
  const mapEl = document.getElementById('sbMap');
  if (!mapEl) return;
  const d = await (await fetch('/api/seongbuk')).json();
  if (!d.complexes || !d.complexes.length) {
    document.getElementById('sbPanel').innerHTML = `<div class="ep-list-head">아직 데이터가 없습니다 —
      GitHub Actions 「성북구 심화 수집」 실행 필요</div>`;
    return;
  }
  _sbData = d;
  const note = document.getElementById('sbSourceNote');
  if (note) note.innerHTML = d.kapt_ok
    ? `✅ 세대수·주차·복도유형: <b>K-apt 공동주택관리정보</b> 공식값 · 시세: 국토부 실거래가 · 갱신 ${d.updated}`
    : `⚠️ 세대수는 <b>거래량 기반 추정치</b>입니다 (K-apt 연동 대기) · 갱신 ${d.updated}`;

  if (typeof L !== 'undefined' && !_sbMap) {
    _sbMap = L.map('sbMap', { center: [37.6015, 127.025], zoom: 13 });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors', maxZoom: 18,
    }).addTo(_sbMap);
    addWorkMarkers(_sbMap);
  }

  document.querySelectorAll('#sbSlopeChips .price-chip').forEach(chip =>
    chip.addEventListener('click', () => {
      _sbSlope = chip.dataset.s;
      document.querySelectorAll('#sbSlopeChips .price-chip').forEach(x =>
        x.classList.toggle('active', x.dataset.s === _sbSlope));
      renderSb();
    }));
  document.getElementById('sbSort').addEventListener('input', renderSb);
  document.getElementById('sbMaxEok').addEventListener('change', renderSb);
  document.getElementById('sbPriceApply')?.addEventListener('click', renderSb);
  renderSb();
}


/* ── 📋 청약 자격 진단 ─────────────────────────────────────
   「주택공급에 관한 규칙」의 일반 기준을 단순화한 클라이언트 계산.
   순위 판정(국민·민영) + 가점 84점 + 특별공급 5종을 입력값으로 실시간 판정.
   소득 기준(도시근로자 월평균소득)은 매년 갱신 — 아래 표는 근사치이며 공고문이 우선. */

// 도시근로자 가구원수별 월평균소득 100% (만원/월, 세전 — 2024년 기준 근사)
const SUB_INCOME_BASE = { 2: 650, 3: 720, 4: 820 };
// 민영주택 청약 예치금 (서울 기준, 만원)
const SUB_DEPOSIT_TABLE = [
  { area: '85㎡ 이하', need: 300 }, { area: '102㎡ 이하', need: 600 },
  { area: '135㎡ 이하', need: 1000 }, { area: '모든 면적', need: 1500 },
];
// 지역별 1순위 요건: 통장 가입기간(년) / 납입횟수
const SUB_FIRST_RANK_REQ = { reg: [2, 24], seoul: [1, 12], metro: [1, 12], etc: [0.5, 6] };

function subReadProfile() {
  const num = id => parseFloat(document.getElementById(id).value) || 0;
  const chk = id => document.getElementById(id).checked;
  const val = id => document.getElementById(id).value;
  return {
    age: num('subAge'), marital: val('subMarital'), marriedYears: num('subMarriedYears'),
    region: val('subRegion'), householder: chk('subHouseholder'),
    noHouseYears: num('subNoHouseYears'), everOwned: chk('subEverOwned'),
    householdOwns: chk('subHouseholdOwns'), won5y: chk('subWon5y'), tax5y: chk('subTax5y'),
    accountYears: num('subAccountYears'), payments: num('subPayments'), deposit: num('subDeposit'),
    dependents: num('subDependents'), children: num('subChildren'),
    familySize: parseInt(val('subFamilySize')), income: num('subIncome'),
    dual: chk('subDual'), newborn: chk('subNewborn'), elderly: chk('subElderly'),
  };
}

// 가점제 84점: 무주택기간(32) + 부양가족(35) + 통장 가입기간(17)
function subGajeom(p) {
  const noHousePts = p.everOwned && p.noHouseYears <= 0 ? 0
    : p.noHouseYears < 1 ? 2 : Math.min(32, 2 + 2 * Math.floor(p.noHouseYears));
  const depPts = 5 + 5 * Math.min(6, p.dependents);
  const accPts = p.accountYears < 0.5 ? 1 : Math.min(17, 2 + Math.floor(p.accountYears));
  return { noHousePts, depPts, accPts, total: noHousePts + depPts + accPts };
}

function subBadge(state) {
  // ok=해당 유력 / part=조건 일부 미충족 / no=미해당
  const m = { ok: ['해당 유력', 'var(--green)'], part: ['일부 미충족', 'var(--gold)'], no: ['미해당', 'var(--text3)'] };
  const [t, c] = m[state];
  return `<span class="sub-badge" style="--sb:${c}">${state === 'ok' ? '✓ ' : state === 'part' ? '△ ' : '✕ '}${t}</span>`;
}

// 판정행: 제목 + 배지 + 이유 목록 + ＋접이식 상세
function subRow(title, state, reasons, detailHtml) {
  return `
  <details class="jz-fold sub-item">
    <summary><span class="sub-item-title">${title}</span>${subBadge(state)}</summary>
    <div class="sub-item-body">
      <ul class="sub-reasons">${reasons.map(r => `<li>${r}</li>`).join('')}</ul>
      ${detailHtml || ''}
    </div>
  </details>`;
}

function subCheck(cond, okMsg, noMsg) { return { ok: cond, msg: cond ? `✓ ${okMsg}` : `✕ ${noMsg}` }; }

/* ── 나/여자친구 프로필 분리 저장 ──
   입력 폼은 하나를 공유하고, 사람 전환 시 현재 값을 스냅샷으로 저장한 뒤
   상대 프로필을 복원한다. localStorage 'subProfiles_v2' = {person, A:{id:값}, B:{id:값}} */
let subPerson = 'A';
let subProfiles = { A: null, B: null };
let subDefaultSnap = null;   // 최초 폼 기본값 — 아직 입력 안 한 사람에게 사용

function subFormEls() {
  return document.querySelectorAll('.sub-inputs input, .sub-inputs select');
}
function subSnapshot() {
  const snap = {};
  subFormEls().forEach(el => { if (el.id) snap[el.id] = el.type === 'checkbox' ? el.checked : el.value; });
  return snap;
}
function subRestore(snap) {
  subFormEls().forEach(el => {
    if (!el.id || !(el.id in snap)) return;
    if (el.type === 'checkbox') el.checked = !!snap[el.id]; else el.value = snap[el.id];
  });
}
function subSave() {
  subProfiles[subPerson] = subSnapshot();
  localStorage.setItem('subProfiles_v2', JSON.stringify({ person: subPerson, A: subProfiles.A, B: subProfiles.B }));
}
function applySubPerson(person) {
  if (person !== 'A' && person !== 'B') return;
  if (person !== subPerson) subSave();                       // 떠나는 사람 값 보존
  subPerson = person;
  document.querySelectorAll('#subPersonToggle .legend-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.person === subPerson));
  subRestore(subProfiles[subPerson] || subDefaultSnap || {});
  renderSubscription();
}

function renderSubscription() {
  const p = subReadProfile();
  document.getElementById('subMarriedYearsWrap').style.display = p.marital === 'married' ? '' : 'none';
  const who = subPerson === 'A' ? '💼 나' : '💗 여자친구';
  const whoShort = subPerson === 'A' ? '나' : '여친';
  subSave();

  const isReg = p.region === 'reg';
  const [reqY, reqN] = SUB_FIRST_RANK_REQ[p.region];
  const noHouseSelf = !(p.everOwned && p.noHouseYears <= 0);       // 본인·배우자 현재 무주택
  const noHouseHousehold = noHouseSelf && !p.householdOwns;        // 무주택 세대
  const married = p.marital !== 'single';

  /* ── ① 순위 판정 ── */
  const minCheck = subCheck(p.accountYears >= reqY, `통장 가입 ${p.accountYears}년 ≥ ${reqY}년`, `통장 가입 ${p.accountYears}년 < ${reqY}년 (${((reqY - p.accountYears) * 12).toFixed(0)}개월 더 필요)`);
  const payCheck = subCheck(p.payments >= reqN, `납입 ${p.payments}회 ≥ ${reqN}회`, `납입 ${p.payments}회 < ${reqN}회`);
  const depositOk = SUB_DEPOSIT_TABLE.filter(d => p.deposit >= d.need);
  const depCheck = subCheck(depositOk.length > 0, `예치금 ${p.deposit}만원 → ${depositOk[depositOk.length - 1]?.area || ''}까지 청약 가능`, `예치금 ${p.deposit}만원 < 300만원 (85㎡ 이하 최소 기준)`);
  const regChecks = isReg ? [
    subCheck(p.householder, '세대주 요건 충족', '규제지역은 세대주만 1순위'),
    subCheck(!p.won5y, '5년 내 세대 당첨 없음', '규제지역은 5년 내 당첨 세대 1순위 제외'),
  ] : [];
  const gukminReg = isReg ? [...regChecks, subCheck(noHouseHousehold, '무주택 세대 요건 충족', '규제지역 국민주택은 무주택 세대만 1순위')] : [];

  const minRank1 = minCheck.ok && depCheck.ok && regChecks.every(c => c.ok);
  const gukRank1 = minCheck.ok && payCheck.ok && gukminReg.every(c => c.ok);

  document.getElementById('subRankCard').innerHTML = `
    <div class="budget-card-title">🎯 ${who} · 순위 판정 — ${isReg ? '규제지역' : p.region === 'etc' ? '지방' : '수도권'} 기준</div>
    <div class="sub-rank-badges">
      <div class="sub-rank ${gukRank1 ? 'on' : ''}"><span class="sr-k">국민주택 (공공분양)</span><span class="sr-v">${gukRank1 ? '1순위 ✓' : '2순위'}</span></div>
      <div class="sub-rank ${minRank1 ? 'on' : ''}"><span class="sr-k">민영주택 (민간분양)</span><span class="sr-v">${minRank1 ? '1순위 ✓' : '2순위'}</span></div>
    </div>
    <div class="sub-foot">1순위는 "당첨"이 아니라 <b>입장권</b>입니다 — 서울 인기 단지는 1순위에서 마감되므로, 2순위면 사실상 기회가 오지 않습니다. 국민주택=LH·SH 등 공공분양(시세보다 저렴, 소득요건 있음), 민영주택=래미안·자이 같은 민간 브랜드 분양입니다.</div>
    ${subRow('국민주택 1순위 요건 자세히', gukRank1 ? 'ok' : 'part',
      [minCheck.msg, payCheck.msg, ...gukminReg.map(c => c.msg)],
      `<div class="sub-detail-note">국민주택(LH·SH 공공분양)은 <b>납입 인정 횟수·금액</b>이 핵심입니다.
       월 납입 인정 상한은 25만원 — 같은 1순위끼리는 <b>저축총액(전용 40㎡ 초과)</b> 순으로 당첨자를 가립니다.
       서울 인기 단지 당첨선은 통상 저축총액 2,000만원 이상(월 10만원씩 약 17년)으로 형성됩니다.</div>`)}
    ${subRow('민영주택 1순위 요건 자세히', minRank1 ? 'ok' : 'part',
      [minCheck.msg, depCheck.msg, ...regChecks.map(c => c.msg),
       `예치금 기준(서울): ${SUB_DEPOSIT_TABLE.map(d => `${d.area} ${d.need}만`).join(' · ')}`],
      `<div class="sub-detail-note">민영주택은 납입 횟수 대신 <b>지역별 예치금</b>만 채우면 됩니다 —
       공고일 전날까지 일시 예치도 인정되므로, 큰 평수를 노린다면 공고 전에 예치금을 미리 채워두세요.
       1순위 안에서는 <b>가점제 또는 추첨제</b>로 당첨자를 뽑습니다(아래 비율표 참고).</div>`)}
  `;

  /* ── ② 가점 84점 ── */
  const g = subGajeom(p);
  const seg = (label, pts, max, color) => `
    <div class="sub-gauge-row">
      <span class="sgk">${label}</span>
      <div class="sub-gauge"><div style="width:${pts / max * 100}%;background:${color}"></div></div>
      <span class="sgv">${pts}<small>/${max}</small></span>
    </div>`;
  document.getElementById('subScoreCard').innerHTML = `
    <div class="budget-card-title">📐 ${who} · 청약 가점 — <b style="color:${g.total >= 60 ? 'var(--green)' : g.total >= 40 ? 'var(--gold)' : 'var(--accent)'}">${g.total}점</b> / 84점</div>
    ${seg('무주택 기간', g.noHousePts, 32, 'var(--green)')}
    ${seg('부양가족', g.depPts, 35, 'var(--acc2)')}
    ${seg('통장 가입기간', g.accPts, 17, 'var(--gold)')}

    <div class="sub-cutline-wrap">
      <div class="sub-cutline-title">서울 당첨선 위에서 내 위치</div>
      <div class="sub-cutline">
        <div class="scl-zone" style="width:${40 / 84 * 100}%;background:rgba(148,163,184,.35)"></div>
        <div class="scl-zone" style="width:${20 / 84 * 100}%;background:rgba(245,158,11,.4)"></div>
        <div class="scl-zone" style="width:${24 / 84 * 100}%;background:rgba(3,165,82,.45)"></div>
        <div class="scl-marker" style="left:${Math.min(99, g.total / 84 * 100)}%"><span>${whoShort} ${g.total}점</span></div>
      </div>
      <div class="sub-cutline-labels">
        <span style="width:${40 / 84 * 100}%">~40점 · 추첨제 위주</span>
        <span style="width:${20 / 84 * 100}%">40~60 · 비인기 가점 가능</span>
        <span style="width:${24 / 84 * 100}%">60+ · 인기단지 가점권</span>
      </div>
      <div class="sub-foot">구간은 최근 서울 민영 가점제 당첨선 분포의 통상 범위입니다 — 단지·평형마다 다르므로 방향 감각용으로만 보세요.</div>
    </div>
    ${subRow('배점표 · 내 점수 올리는 법', g.total >= 60 ? 'ok' : g.total >= 40 ? 'part' : 'no',
      [`무주택: 1년 미만 2점 → 1년마다 +2점 → 15년 이상 32점 <b>(만 30세 또는 혼인신고일부터 기산)</b>`,
       `부양가족: 기본 5점 + 1명당 5점 (배우자·자녀·3년 이상 동거 직계존속) — 최대 35점`,
       `통장: 6개월 미만 1점 → 1년마다 +1점 → 15년 이상 17점`],
      `<div class="sub-detail-note">서울 민영 가점제 당첨선은 인기 단지 <b>60점대 후반</b>, 비인기 <b>40~50점대</b>가 일반적입니다.
       신혼·젊은 세대는 가점이 구조적으로 낮으므로 <b>추첨제 물량과 특별공급</b>이 현실적인 길입니다.
       가장 빠른 +점수는 부양가족(자녀 1명 = +5점)이고, 무주택·통장 기간은 시간만이 해결합니다.</div>`)}
  `;

  /* ── ③ 특별공급 ── */
  const base100 = SUB_INCOME_BASE[p.familySize] || SUB_INCOME_BASE[4];
  const incomePct = base100 > 0 ? p.income / base100 * 100 : 0;
  const pctStr = `${incomePct.toFixed(0)}%`;
  const accMin = subCheck(p.accountYears >= 0.5 && p.payments >= 6, '통장 6개월·6회 이상', '통장 6개월·6회 미만');

  const items = [];
  { // 신혼부부
    const inYears = p.marital === 'pre' || (p.marital === 'married' && p.marriedYears <= 7);
    const incCap = p.dual ? 160 : 140;
    const cs = [
      subCheck(inYears, p.marital === 'pre' ? '예비신혼(1년 내 혼인신고 예정) 인정' : `혼인 ${p.marriedYears}년 ≤ 7년`, p.marital === 'single' ? '미혼은 대상 아님' : '혼인 7년 초과'),
      subCheck(noHouseHousehold, '무주택 세대', '무주택 세대 아님'),
      accMin,
      subCheck(incomePct <= incCap, `소득 ${pctStr} ≤ ${incCap}% (${p.dual ? '맞벌이' : '외벌이'} 기준)`, `소득 ${pctStr} > ${incCap}% — 단, 추첨제 물량은 ${p.dual ? 200 : 160}%까지 허용`),
    ];
    items.push(['💑 신혼부부 특별공급', cs,
      `<div class="sub-detail-note">민영 기준 소득: 우선공급 100%(맞벌이 120%) · 일반공급 140%(160%) · <b>추첨 물량 160%(200%)</b>.
       같은 신혼 특공 안에서는 ① 자녀 있는 가구 우선 ② 자녀 수 순입니다.
       <b>예비신혼</b>은 입주 전까지 혼인신고를 증명해야 하며, 혼인신고일 기준 7년이 지나면 대상에서 빠지니
       특공을 노린다면 혼인신고 시점도 전략입니다. 2세 이하 자녀가 있으면 <b>신생아 우선공급</b>이 먼저 배정됩니다.</div>`]);
  }
  { // 생애최초
    const cs = [
      subCheck(!p.everOwned, '본인·배우자 생애 무주택', '주택 소유 이력이 있으면 영구 미해당'),
      subCheck(married || p.children > 0, '혼인 중 또는 자녀 있음 (미혼 1인가구는 추첨 물량만)', '혼인·자녀 요건 미충족 — 추첨 물량만 신청 가능'),
      subCheck(p.tax5y, '소득세 5년 이상 납부', '소득세 5년 납부 요건 미충족'),
      accMin,
      subCheck(incomePct <= 130, `소득 ${pctStr} ≤ 130%`, `소득 ${pctStr} > 130% — 추첨 물량은 160%까지`),
    ];
    items.push(['🌱 생애최초 특별공급', cs,
      `<div class="sub-detail-note">한 번이라도 집을 소유했다면 <b>영구히 대상 제외</b>인 대신, 요건만 맞으면 100% 추첨이라
       가점이 낮은 젊은 부부에게 가장 승률 높은 통로입니다. 국민주택은 저축액 600만원 이상 요건이 추가됩니다.</div>`]);
  }
  { // 신생아
    const cs = [subCheck(p.newborn, '2세 이하 자녀(임신 포함) 있음', '2세 이하 자녀 없음'), subCheck(noHouseHousehold, '무주택 세대', '무주택 세대 아님')];
    items.push(['👶 신생아 우선·특별공급', cs,
      `<div class="sub-detail-note">2024년 신설 — 공공분양(뉴:홈)에 연 3만호 수준 별도 배정, 민영 신혼 특공에서도 우선 배정.
       출산 가구엔 <b>신생아 특례대출(최저 1%대)</b>도 연계되어 자금 측면에서도 가장 유리합니다.</div>`]);
  }
  { // 다자녀
    const cs = [subCheck(p.children >= 2, `미성년 자녀 ${p.children}명 ≥ 2명`, '미성년 자녀 2명 미만'), subCheck(noHouseHousehold, '무주택 세대', '무주택 세대 아님'), accMin];
    items.push(['👨‍👩‍👧‍👦 다자녀 특별공급', cs,
      `<div class="sub-detail-note">2024년부터 <b>3자녀 → 2자녀</b>로 완화. 자녀 수·무주택 기간 등 배점표로 경쟁하며 소득 기준은 120%(맞벌이 200%)입니다.</div>`]);
  }
  { // 노부모
    const cs = [subCheck(p.elderly, '65세 이상 직계존속 3년 이상 부양', '부양 요건 미충족'), subCheck(p.householder, '세대주', '세대주만 가능'), subCheck(noHouseHousehold, '무주택 세대 (부양 존속 포함)', '무주택 세대 아님')];
    items.push(['👵 노부모 부양 특별공급', cs,
      `<div class="sub-detail-note">부모님을 3년 이상 같은 세대로 모시는 세대주 대상 — 부양가족 가점(+10점)과도 겹쳐 가점제에서도 강력합니다.</div>`]);
  }

  document.getElementById('subSpecialCard').innerHTML = `
    <div class="budget-card-title">⭐ ${who} · 특별공급 — 일반공급과 경쟁하지 않는 별도 물량</div>
    <div class="sub-note">특공은 <b>세대당 평생 1회</b>. 소득 ${pctStr} = 부부합산 ${p.income}만원 ÷ 도시근로자 ${p.familySize}인 가구 월평균소득 약 ${base100}만원 (2024 근사, 공고문 우선)</div>
    ${items.map(([t, cs, note]) => {
      const okN = cs.filter(c => c.ok).length;
      const state = okN === cs.length ? 'ok' : okN >= cs.length - 1 ? 'part' : 'no';
      return subRow(t, state, cs.map(c => c.msg), note);
    }).join('')}
  `;

  /* ── ④ 가점제/추첨제 비율 ── */
  document.getElementById('subRatioBody').innerHTML = `
    <table class="sub-table">
      <tr><th>지역</th><th>전용 85㎡ 이하</th><th>전용 85㎡ 초과</th></tr>
      <tr><td>규제지역 (강남3구·용산)</td><td>가점 40% · 추첨 60%</td><td>가점 80% · 추첨 20%</td></tr>
      <tr><td>그 외 수도권·서울</td><td>가점 40% · 추첨 60%</td><td>추첨 100%</td></tr>
    </table>
    <div class="sub-detail-note">내 가점 <b>${g.total}점</b> 기준:
      ${g.total >= 60 ? '가점제로도 승부 가능한 점수입니다 — 85㎡ 초과 규제지역(가점 80%)이 오히려 유리할 수 있습니다.'
        : '가점제 당첨선(서울 60점대)에는 부족합니다 — <b>85㎡ 이하 추첨제 60% 물량 + 특별공급</b>에 집중하는 것이 확률적으로 맞습니다. 추첨제도 무주택자에게 물량의 75%를 우선 배정하므로 무주택 유지가 중요합니다.'}</div>
  `;
}

/* 기기 간 공유: 프로필을 URL-safe base64로 링크에 담아 전달.
   상대 기기에서 ?sync=… 로 열면 localStorage에 이관 후 URL을 정리한다. */
function subEncodeShare(obj) {
  return btoa(unescape(encodeURIComponent(JSON.stringify(obj))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function subDecodeShare(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(decodeURIComponent(escape(atob(b64))));
}

async function initSubscription() {
  if (!document.getElementById('subRankCard')) return;

  // 공유 링크로 진입한 경우: 담겨온 두 사람 프로필을 먼저 저장
  try {
    const sync = new URLSearchParams(location.search).get('sync');
    if (sync) {
      const obj = subDecodeShare(sync);
      if (obj && (obj.A || obj.B)) {
        localStorage.setItem('subProfiles_v2', JSON.stringify({ person: obj.person === 'B' ? 'B' : 'A', A: obj.A || null, B: obj.B || null }));
      }
      history.replaceState(null, '', location.pathname);   // 주소창에서 개인정보 제거
    }
  } catch (e) { /* 잘못된 링크 — 무시하고 기존 저장분 사용 */ }

  // 공유 링크 생성 버튼
  const shareBtn = document.getElementById('subShareBtn');
  if (shareBtn) shareBtn.addEventListener('click', async () => {
    subSave();
    const url = `${location.origin}/subscription?sync=${subEncodeShare({ person: subPerson, A: subProfiles.A, B: subProfiles.B })}`;
    const urlEl = document.getElementById('subShareUrl');
    urlEl.value = url;
    document.getElementById('subShareCopy').style.display = '';
    document.getElementById('subShareFoot').style.display = '';
    try { await navigator.clipboard.writeText(url); shareBtn.textContent = '복사됨 ✓'; }
    catch (e) { urlEl.select(); shareBtn.textContent = '길게 눌러 복사'; }
    setTimeout(() => { shareBtn.textContent = '공유 링크 만들기'; }, 2500);
  });
  const copyBtn = document.getElementById('subShareCopy');
  if (copyBtn) copyBtn.addEventListener('click', async () => {
    const urlEl = document.getElementById('subShareUrl');
    try { await navigator.clipboard.writeText(urlEl.value); copyBtn.textContent = '✓'; }
    catch (e) { urlEl.select(); }
    setTimeout(() => { copyBtn.textContent = '복사'; }, 2000);
  });

  // 폼 기본값 스냅샷 — 아직 입력하지 않은 사람을 열 때 사용
  subDefaultSnap = subSnapshot();

  // 저장된 프로필 복원 (v2: 나/여자친구 분리, v1 구버전은 '나'로 이관)
  try {
    let saved = JSON.parse(localStorage.getItem('subProfiles_v2') || 'null');
    if (!saved) {
      const v1 = JSON.parse(localStorage.getItem('subProfile_v1') || 'null');
      if (v1) {
        // v1 키(age 등) → 폼 id(subAge 등) 이관
        const snap = {};
        Object.entries(v1).forEach(([k, v]) => { snap['sub' + k.charAt(0).toUpperCase() + k.slice(1)] = v; });
        saved = { person: 'A', A: snap, B: null };
        localStorage.removeItem('subProfile_v1');
      }
    }
    if (saved) {
      subProfiles.A = saved.A || null;
      subProfiles.B = saved.B || null;
      subPerson = saved.person === 'B' ? 'B' : 'A';
      subRestore(subProfiles[subPerson] || subDefaultSnap);
      document.querySelectorAll('#subPersonToggle .legend-mode-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.person === subPerson));
    }
  } catch (e) { /* 무시 — 기본값 사용 */ }

  document.querySelectorAll('#subPersonToggle .legend-mode-btn').forEach(b =>
    b.addEventListener('click', () => applySubPerson(b.dataset.person)));
  document.querySelectorAll('#secSubscription input, #secSubscription select').forEach(el =>
    el.addEventListener('input', renderSubscription));
  renderSubscription();

  // 실시간 공고 (청약홈 API 수집분 — 없으면 안내만)
  const list = document.getElementById('subNoticeList');
  try {
    const d = await (await fetch('/api/subscriptions')).json();
    const items = d.items || [];
    if (items.length) {
      list.innerHTML = `<div class="sub-note">업데이트: ${d.updated || '—'} · 접수 중이거나 예정인 서울 공고</div>` +
        items.map(n => `
        <div class="jb-row"><span><b>${n.name}</b> <small style="color:var(--text3)">${n.addr || ''}</small></span>
          <span>${n.rcept_bgn || ''} ~ ${n.rcept_end || ''} ${n.url ? `<a href="${n.url}" target="_blank" rel="noopener">공고 ↗</a>` : ''}</span></div>`).join('');
    } else {
      list.innerHTML = `<div class="sub-note">아직 공고 데이터가 없습니다 — 공공데이터포털에서
        <b>「한국부동산원_주택청약 분양정보 조회 서비스」</b> API를 활용신청하고
        GitHub Secret <code>APPLY_HOME_API_KEY</code>에 등록하면, 매 수집 때 서울 분양 공고가 자동으로 여기에 표시됩니다.
        그 전에도 <a href="https://www.applyhome.co.kr" target="_blank" rel="noopener">청약홈 ↗</a>에서 직접 확인할 수 있습니다.</div>`;
    }
  } catch (e) { list.innerHTML = ''; }
}

/* ── 📰 부동산 뉴스 쉽게 읽기 ──────────────────────────────
   collect_news.py 산출 news.json. 기사(네이버) + 테마 해설(본 서비스). */
let _newsData = null;
let _newsTheme = '전체';

function newsCard(n) {
  const link = n.link || '#';
  return `
  <div class="news-card">
    <div class="news-head"><span class="news-emoji">${n.emoji || '🏠'}</span>
      <span class="news-theme">${n.theme || '부동산'}</span>
      <span class="news-date">${n.date || ''}</span></div>
    <a class="news-title" href="${link}" target="_blank" rel="noopener">${n.title} ↗</a>
    ${n.summary ? `<div class="news-summary">${n.summary}</div>` : ''}
    ${(n.context || n.explainer) ? `<div class="news-context">🔑 ${n.context || n.explainer}</div>` : ''}
  </div>`;
}

function renderNewsList() {
  const d = _newsData, list = document.getElementById('newsList');
  if (!d || !list) return;
  const rows = _newsTheme === '전체' ? d.items : d.items.filter(n => n.theme === _newsTheme);
  document.getElementById('newsSummary').innerHTML =
    `업데이트 ${d.updated || '—'} · ${rows.length}건 · 제목·요약은 네이버 뉴스, ` +
    `<b style="color:var(--acc2)">💡 해설은 본 서비스</b>가 붙였습니다`;
  list.innerHTML = rows.map(newsCard).join('') || `<div class="sub-note">해당 주제 뉴스가 없습니다.</div>`;
}

async function renderNews() {
  const list = document.getElementById('newsList');
  if (!list) return;
  const d = await (await fetch('/api/news')).json();
  if (!d.items || !d.items.length) {
    list.innerHTML = `
    <div class="budget-card">
      <div class="budget-card-title">뉴스 데이터 준비 중</div>
      <div class="sub-note" style="line-height:1.7">네이버 뉴스 검색으로 부동산 기사를 매일 모으도록 준비돼 있습니다 —
        <code>NAVER_CLIENT_ID/SECRET</code>(리뷰 태그와 동일 키)가 설정돼 있으면
        다음 수집 때 자동으로 채워집니다.</div>
    </div>`;
    return;
  }
  _newsData = d;
  const themes = ['전체', ...Object.keys(d.themes || {})];
  const box = document.getElementById('newsThemeChips');
  box.innerHTML = themes.map(t =>
    `<button class="price-chip ${t === _newsTheme ? 'active' : ''}" data-t="${t}">${t}${t !== '전체' && d.themes[t] ? ` <small>${d.themes[t]}</small>` : ''}</button>`).join('');
  box.querySelectorAll('.price-chip').forEach(c => c.addEventListener('click', () => {
    _newsTheme = c.dataset.t;
    box.querySelectorAll('.price-chip').forEach(x => x.classList.toggle('active', x.dataset.t === _newsTheme));
    renderNewsList();
  }));
  renderNewsList();
}

/* ── 초기화 ─────────────────────────────────────────────── */
(async function init() {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error(fn.name, e); } };
  initNav();
  await safe(renderScoring);
  await safe(initBudgetPlanner);
  await safe(initSubscription);
  await safe(renderVilla);
  await safe(renderSeongbuk);
  await safe(renderNews);
  // 각 섹션을 독립 실행 — 한 곳(예: 지도 CDN)이 실패해도 나머지는 정상 렌더
  await safe(renderExplorer);
  await safe(renderMap);
  await safe(renderDistrictRankings);
  await safe(renderTop1);
  await safe(renderAiRanking);
  await safe(renderJeonseExplorer);
  await safe(renderJeonseRankings);
  await safe(renderJeonseTop1);
  initApartmentModal();
})();
