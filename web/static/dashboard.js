import {
  LOAN_PRODUCTS, analyzeCouple, won2eok, won2man, calcMonthlyPayment, personDsrLoan,
  splitParentSupport, maxFamilyLoanFor,
  LEGAL_BASIS, FAMILY_LOAN, REFERENCES, LOAN_RATE_SOURCES, GIFT_TAX_TABLE,
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
async function renderMap() {
  const data = await fetchJSON('/api/districts');
  districtData = data.districts;

  // 히어로 통계 업데이트: 서울 전체 25개 구 중 몇 개가 수집·분석 완료됐는지 표시
  // (나머지는 GitHub Actions로 계속 수집 진행 중 — 완료되는 대로 자동으로 숫자가 올라감)
  const districtsEl = document.getElementById('statDistricts');
  if (districtsEl) {
    districtsEl.textContent = `${data.districts_with_data}/${data.total_districts}`;
  }

  try {
    const q = await fetchJSON('/api/quality');
    document.getElementById('statRaw').textContent  = q.total_raw.toLocaleString() + '건';
    document.getElementById('statApts').textContent = q.total_apts != null
      ? q.total_apts + '개' : districtData.filter(d=>d.has_data).reduce((s,d)=>s+d.apt_count,0) + '개';
  } catch(e) {}

  // Leaflet 지도 초기화
  if (!seoulMap) {
    seoulMap = L.map('seoulMap', { center: [37.555, 126.975], zoom: 11, zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap contributors',
      maxZoom: 18
    }).addTo(seoulMap);
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
        const color = d.has_data ? (d.color || '#38bdf8') : '#475569';
        return { color, weight: 2, fillColor: color, fillOpacity: d.has_data ? 0.35 : 0.12 };
      },
      onEachFeature: (f, layer) => {
        const d = districtData.find(x => x.name === f.properties.name);
        if (!d) return;
        layer.bindTooltip(popupFor(d), { sticky: true, direction: 'top', className: 'district-tooltip' });
        layer.on('click', () => scrollToDistrict(d.name));
        layer.on('mouseover', () => layer.setStyle({ fillOpacity: 0.55 }));
        layer.on('mouseout', () => layer.setStyle({ fillOpacity: d.has_data ? 0.35 : 0.12 }));
        mapLayers[d.name] = mapLayers[d.name] || {};
        mapLayers[d.name].rect = layer;
      }
    }).addTo(seoulMap);
  }

  // 구 라벨 마커 (+ GeoJSON 실패 시 사각형 폴리곤 폴백)
  districtData.forEach(d => {
    const poly = DISTRICT_POLYGONS[d.name];
    if (!poly) return;
    const color = d.has_data ? (d.color || '#38bdf8') : '#475569';

    if (!geo || !geo.features) {
      const rect = L.rectangle(
        [[Math.min(...poly.map(p=>p[0])), Math.min(...poly.map(p=>p[1]))],
         [Math.max(...poly.map(p=>p[0])), Math.max(...poly.map(p=>p[1]))]],
        { color, weight: 2, fillColor: color, fillOpacity: d.has_data ? 0.35 : 0.12 }
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
    const icon = L.divIcon({
      className: '',
      html: `<div class="map-label ${d.has_data ? 'map-label-data' : ''}">${d.name.replace('구','')}</div>`,
      iconSize: [60, 24],
      iconAnchor: [30, 12]
    });
    const marker = L.marker(center, { icon });
    marker.bindTooltip(popupFor(d), { sticky: true, direction: 'top', className: 'district-tooltip' });
    marker.on('click', () => scrollToDistrict(d.name));
    marker.addTo(seoulMap);
    mapLayers[d.name] = mapLayers[d.name] || {};
    mapLayers[d.name].marker = marker;
  });

  // 구 카드 그리드
  renderDistrictCards(districtData);
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
          `<div class="age-row"><span class="age-label">${k}</span><div class="age-bar"><div class="age-fill" style="width:${v}%;background:${d.color||'#38bdf8'}"></div></div><span class="age-val">${v}%</span></div>`
        ).join('')
      : '';

    return `
    <div class="district-card" id="card-${d.name}" onclick="highlightDistrict('${d.name}')">
      <div class="card-header" style="border-left:4px solid ${d.color||'#38bdf8'}">
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
  const axes = [
    { key: '가격방어력', weight: 25, color: '#34d399',
      desc: '전체 수집 기간 중 겪었던 가장 큰 하락(MDD)이 얼마나 작았는지와, 그 저점 이후 얼마나 회복했는지를 함께 봅니다. 신고가를 갱신한 단지는 가점을 받습니다.',
      metric: 'MDD(60%) + 회복률(40%)', example: 'MDD -12% & 전고점 회복 → 최상위 방어력' },
    { key: '거래유동성', weight: 20, color: '#38bdf8',
      desc: '전 기간에 걸쳐 거래가 꾸준했는지, 특히 하락장에서도 거래가 유지됐는지 측정합니다. 팔고 싶을 때 팔리는 단지가 진짜 우량 단지입니다.',
      metric: '거래 공백률 + 하락기 유지율 + 변동계수', example: '하락장에도 매달 거래 체결 → 높은 점수' },
    { key: '상승참여도', weight: 15, color: '#fbbf24',
      desc: '2021년 상승장에서 얼마나 올랐는지를 측정합니다. 하락에 강하면서 상승에도 참여해야 진정한 우량 단지입니다.',
      metric: '(고점가 − 2020년 기저가) / 기저가', example: '기저 대비 +50% 상승 → 높은 참여도' },
    { key: '회복모멘텀', weight: 15, color: '#a78bfa',
      desc: '최근 12개월 가격 추세를 측정합니다. 하락 후 다시 오르는 단지와 바닥에 머무는 단지를 구분하는 핵심 지표입니다.',
      metric: '최근 12개월 가격 추세 (연율화 %)', example: '최근 1년간 연 +8% 추세 → 강한 모멘텀' },
    { key: '입지프리미엄', weight: 15, color: '#fb923c',
      desc: '단위면적(m²)당 가격 수준입니다. 교통·학군·인프라 가치는 이미 시장가격에 반영되어 있어, 평단가가 가장 객관적인 입지 지표입니다.',
      metric: 'm²당 고점 거래가 percentile', example: '평단가 상위 10% → 시장이 인정한 입지' },
    { key: '규모', weight: 8, color: '#f472b6',
      desc: '총 거래량으로 단지 규모(세대수)를 가늠합니다. 대단지는 매물·수요가 풍부해 환금성이 높습니다.',
      metric: '총 거래 건수 percentile', example: '1,000+ 거래 대단지 → 높은 환금성' },
    { key: '교통', weight: 10, color: '#f87171',
      desc: '단지 좌표에서 가장 가까운 지하철역까지의 도보거리(직선거리 기반)와 반경 1km 내 역 수(더블역세권)를 평가합니다.',
      metric: '최근접역 도보 분(80%) + 1km 내 역 수(20%)', example: '도보 5분 역세권 + 더블역세권 → 최고점' },
    { key: '재건축잠재력', weight: 8, color: '#22d3ee',
      desc: '준공 후 경과 연수를 기준으로 재건축·리모델링 가능성을 평가합니다. 재건축 안전진단 연한(준공 30년)에 가까울수록 미래가치 상승 잠재력이 큽니다.',
      metric: '준공연도 기준 재건축 연한(30년) 근접도', example: '준공 30년 경과 → 재건축 추진 가능 구간' },
  ];

  // 실제 사용된 가중치를 API에서 받아 반영 (교통 축은 좌표 데이터 있을 때만)
  fetchJSON('/api/composite_score').then(cs => {
    const w = cs.weights || {};
    const active = axes.filter(a => w[a.key] != null).map(a => ({ ...a, weight: Math.round(w[a.key] * 100) }));
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
}

/* ── ③ 동네별 우수 아파트 ─────────────────────────────────── */
// 동네별 추천 목록 행 클릭 시 (구, 단지명)을 조회하기 위한 인덱스 (renderDistrictRankings에서 채움)
let _rankingRowMap = [];

async function renderDistrictRankings() {
  const { comp: data } = await loadScoreData();
  const ranking = data.ranking || [];
  _rankingRowMap = [];

  // 구별 그룹핑
  const byDistrict = {};
  ranking.forEach(r => {
    if (!byDistrict[r.district]) byDistrict[r.district] = [];
    byDistrict[r.district].push(r);
  });

  const districts = Object.keys(byDistrict).sort();
  const container = document.getElementById('districtRankings');

  if (districts.length === 0) {
    container.innerHTML = `<div class="empty-state">분석 데이터가 없습니다. 데이터 수집 후 다시 시도해주세요.</div>`;
    return;
  }

  container.innerHTML = districts.map(district => {
    const apts = byDistrict[district].slice(0, 3);
    const distInfo = districtData.find(d => d.name === district) || {};
    const color = distInfo.color || '#38bdf8';

    const rows = apts.map((a, i) => {
      const axes = [
        ['가격방어', a.defense_score], ['유동성', a.liquidity_score], ['상승참여', a.upside_score],
        ['모멘텀', a.momentum_score], ['프리미엄', a.premium_score], ['규모', a.scale_score],
        ['교통', a.transit_score], ['재건축', a.redevelop_score],
      ].filter(x => x[1] != null);
      const best = axes.reduce((p,c) => c[1] > p[1] ? c : p, ['', -1]);

      // apt_name에 특수문자가 있어도 안전하도록, 클릭 시 조회할 (구, 단지명)은
      // 인덱스로 저장해두고 클릭 핸들러에서 _rankingRowMap을 통해 꺼내 쓴다.
      const ridx = _rankingRowMap.push({ district: a.district, apt_name: a.apt_name }) - 1;

      return `
      <div class="drs-row" data-ridx="${ridx}" title="클릭하면 상세 점수를 볼 수 있습니다">
        <span class="drs-rank" style="${i===0?`color:${color}`:''}">${i+1}</span>
        <div class="drs-mid">
          <div class="drs-name">${a.apt_name}</div>
          <div class="drs-meta">${a.mdd != null ? 'MDD ' + a.mdd.toFixed(1) + '%' : ''} · ${best[0]} 강점</div>
        </div>
        <span class="drs-score" style="${i===0?`color:${color}`:''}">${fmtScore(a.composite_score)}</span>
        <span class="drs-links">
          <a href="${naverMapUrl(a.district, a.apt_name, a.dong, a.lat, a.lng)}" target="_blank" rel="noopener" class="drs-lk drs-lk-m" title="네이버 지도">지</a>
          <a href="${naverLandUrl(a.district, a.apt_name, a.dong, a.lat, a.lng, a.naver_id)}" target="_blank" rel="noopener" class="drs-lk drs-lk-n" title="네이버 부동산">부</a>
          <a href="${hogangnonoUrl(a.district, a.apt_name, a.dong, a.lat, a.lng)}" target="_blank" rel="noopener" class="drs-lk drs-lk-h" title="호갱노노">호</a>
        </span>
      </div>`;
    }).join('');

    return `
    <div class="drs-block">
      <div class="drs-head" style="border-left:3px solid ${color}">
        <span>${distInfo.icon||'🏙️'} <b>${district}</b></span>
        <span class="drs-count">${byDistrict[district].length}개 분석</span>
      </div>
      ${rows}
    </div>`;
  }).join('');
}

/* ── ④ 전체 1위 단지 상세 ──────────────────────────────────── */
// 8개 채점 축 → 레이더/막대에 쓸 공통 배열 (전체 1위·동네별 추천 상세 모달 공용)
function buildApartmentAxes(apt) {
  return [
    { name: '가격방어력', val: apt.defense_score, w: 25, color: '#34d399' },
    { name: '거래유동성', val: apt.liquidity_score, w: 20, color: '#38bdf8' },
    { name: '상승참여도', val: apt.upside_score, w: 15, color: '#fbbf24' },
    { name: '회복모멘텀', val: apt.momentum_score, w: 15, color: '#a78bfa' },
    { name: '입지프리미엄', val: apt.premium_score, w: 13, color: '#fb923c' },
    { name: '규모', val: apt.scale_score, w: 7, color: '#f472b6' },
    { name: '교통', val: apt.transit_score, w: 10, color: '#f87171' },
    { name: '재건축잠재력', val: apt.redevelop_score, w: 8, color: '#22d3ee' },
  ].filter(a => a.val != null);
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

  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="top1-hero">
      <div class="top1-badge">${badgeHtml}</div>
      <h3 class="top1-name">${apt.apt_name}</h3>
      <div class="top1-loc">${apt.district} ${distInfo.icon||''}</div>
      <div class="top1-score-big">${fmtScore(apt.composite_score)}<span class="top1-score-unit">점</span></div>
      <div class="ep-links" style="justify-content:center;margin-top:.8rem">
        <a class="ep-map" href="${naverMapUrl(apt.district, apt.apt_name, apt.dong, apt.lat, apt.lng)}" target="_blank" rel="noopener">네이버 지도 ↗</a>
        <a class="ep-naver" href="${naverLandUrl(apt.district, apt.apt_name, apt.dong, apt.lat, apt.lng, apt.naver_id)}" target="_blank" rel="noopener">네이버 부동산 ↗</a>
        <a class="ep-hogang" href="${hogangnonoUrl(apt.district, apt.apt_name, apt.dong, apt.lat, apt.lng)}" target="_blank" rel="noopener">호갱노노 ↗</a>
      </div>
    </div>

    <div class="top1-body">
      <div class="top1-radar" id="${radarId}"></div>
      <div class="top1-axes">
        ${axes.map(a => `
          <div class="top1-axis-row">
            <span class="top1-ax-dot" style="background:${a.color}"></span>
            <span class="top1-ax-name">${a.name}</span>
            <div class="top1-ax-bar">
              <div class="top1-ax-fill" style="width:${Math.min(100,a.val||0)}%;background:${a.color}"></div>
            </div>
            <span class="top1-ax-val">${a.val != null ? a.val.toFixed(1) : '—'}</span>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="top1-stats-grid">
      <div class="top1-stat"><div class="ts-val">${mddInfo.peak_price != null ? (mddInfo.peak_price/10000).toFixed(1)+'억' : '—'}</div><div class="ts-key">최고 거래가</div></div>
      <div class="top1-stat"><div class="ts-val" style="color:#34d399">${mddInfo.mdd != null ? mddInfo.mdd.toFixed(1)+'%' : '—'}</div><div class="ts-key">MDD (최대낙폭)</div></div>
      <div class="top1-stat"><div class="ts-val">${mddInfo.total_trades != null ? mddInfo.total_trades.toLocaleString()+'건' : '—'}</div><div class="ts-key">총 거래 건수</div></div>
      <div class="top1-stat"><div class="ts-val">${apt.active_months != null ? apt.active_months+'개월' : '—'}</div><div class="ts-key">활성 거래 기간</div></div>
    </div>

    <div class="top1-insight">
      <div class="insight-title">왜 이 점수인가요?</div>
      <ul class="insight-list">${buildApartmentInsights(apt, comp, extraInsight)}</ul>
    </div>

    <div id="${priceChartId}" class="top1-price-chart" style="height:260px"></div>
  `;

  // 레이더 차트 렌더링
  const radarFull = [...radarVals, radarVals[0]];
  const radarFull2 = [...radarLabels, radarLabels[0]];
  Plotly.newPlot(radarId, [{
    type: 'scatterpolar',
    r: radarFull,
    theta: radarFull2,
    fill: 'toself',
    fillcolor: 'rgba(56,189,248,0.2)',
    line: { color: '#38bdf8', width: 2 },
    marker: { color: '#38bdf8', size: 6 },
    name: apt.apt_name
  }], {
    polar: {
      radialaxis: { visible: true, range: [0, 100], color: '#475569', gridcolor: '#334155' },
      angularaxis: { color: '#94a3b8' },
      bgcolor: 'transparent'
    },
    paper_bgcolor: 'transparent',
    plot_bgcolor: 'transparent',
    font: { color: '#e2e8f0', family: 'sans-serif', size: 12 },
    margin: { t: 20, b: 20, l: 40, r: 40 },
    showlegend: false
  }, { responsive: true, displayModeBar: false });

  // 가격 추이 차트 (있는 경우)
  if (aptTs && aptTs.monthly) {
    renderPriceChart(priceChartId, aptTs);
  }
}

async function renderTop1() {
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

function renderPriceChart(chartId, aptTs) {
  const months = aptTs.monthly.map(m => m.ym);
  const prices = aptTs.monthly.map(m => m.median != null ? +(m.median/10000).toFixed(2) : null);

  Plotly.newPlot(chartId, [{
    x: months, y: prices,
    type: 'scatter', mode: 'lines+markers',
    line: { color: '#38bdf8', width: 2 },
    marker: { color: '#38bdf8', size: 4 },
    name: '월별 중앙값(억)',
    connectgaps: false
  }], {
    xaxis: { color: '#94a3b8', gridcolor: '#1e293b' },
    yaxis: { color: '#94a3b8', gridcolor: '#1e293b', ticksuffix: '억' },
    paper_bgcolor: 'transparent',
    plot_bgcolor: '#0f172a',
    font: { color: '#e2e8f0' },
    margin: { t: 20, b: 50, l: 60, r: 20 },
    showlegend: false,
    shapes: [
      { type: 'rect', xref: 'x', yref: 'paper', x0: '202101', x1: '202112', y0: 0, y1: 1,
        fillcolor: 'rgba(251,191,36,0.08)', line: { width: 0 } },
      { type: 'rect', xref: 'x', yref: 'paper', x0: '202207', x1: '202306', y0: 0, y1: 1,
        fillcolor: 'rgba(248,113,113,0.08)', line: { width: 0 } },
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

// 검색어 생성: 이름이 충분히 고유하면 이름만으로(가장 잘 잡힘), 흔한 단지명이거나
// 너무 짧으면 지역(동 우선, 없으면 구)을 앞에 붙여 구분한다.
// dong이 대부분 비어 있어 "구 + 풀네임"으로만 검색하면 0건이 자주 나므로,
// 고유한 브랜드명은 지역 없이 이름만 넘겨 매칭 확률을 높인다.
function naverSearchTerm(district, aptName, dong) {
  const name = normalizeAptName(aptName);
  const core = name.replace(/\s+/g, '');   // 공백 제거한 순수 글자 길이로 고유성 판단
  const isCommon = COMMON_APT_NAMES.has(core) || core.length <= 4;
  if (isCommon) {
    const area = dong || district || '';
    return `${area} ${name}`.trim();
  }
  return name;
}

// 네이버 지도(위치 확인). 좌표 중심으로 열어 항상 정확한 위치 표시.
function naverMapUrl(district, aptName, dong, lat, lng) {
  const label = encodeURIComponent(normalizeAptName(aptName));
  if (lat && lng) return `https://map.naver.com/p?lat=${lat}&lng=${lng}&title=${label}&level=2`;
  return `https://map.naver.com/p/search/${encodeURIComponent(naverSearchTerm(district, aptName, dong))}`;
}

// 네이버 부동산(매물). 단지 고유번호(resolve_naver_ids.py로 수집)가 있으면 검색을
// 건너뛰고 단지 페이지로 바로 연결 — 검색 0건/오매칭 없이 항상 정확히 열린다.
// 번호가 없으면 이름 검색으로 폴백(고유명은 이름만, 흔한 이름은 지역+이름).
function naverLandUrl(district, aptName, dong, lat, lng, naverId) {
  if (naverId) return `https://m.land.naver.com/complex/info/${naverId}`;
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
  initProductSelect('a');
  initProductSelect('b');

  // 모든 입력에 반응형 바인딩 (입력 즉시 재계산)
  ['aCash','aParent','aIncome','aNetMonthly','aRate','aYears','aBasicOn','aMarriageOn',
   'bCash','bParent','bIncome','bNetMonthly','bRate','bYears','bBasicOn','bMarriageOn',
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
  });

  renderLegalAccordion();
  renderReferences();
  renderRateSources();
  renderGiftTaxTable();
  recalcBudget();
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

    if (valEl && slider) valEl.textContent = `${won2eok(S.familyLoan)} / ${won2eok(Math.max(0, Math.round(slider.max)))}`;
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
    ${R.warnings.length ? `<div class="br-warns">${R.warnings.map(w => `<div class="budget-warn">⚠️ ${w}</div>`).join('')}</div>` : ''}
  `;
  document.getElementById('budgetApply').addEventListener('click', () => {
    const eok = R.maxPrice / 억;
    document.querySelectorAll('.price-chip').forEach(b => b.classList.remove('active'));
    document.getElementById('priceMin').value = '';
    document.getElementById('priceMax').value = eok.toFixed(1);
    applyPriceFilter(0, eok);
    document.getElementById('secExplorer').scrollIntoView({ behavior: 'smooth' });
  });

  renderBudgetBreakdown(R);
  renderBudgetChart(R);
  renderFundFlow(R);
  renderRepayDetail(R);
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

  const html = block(R.A, '💼 나', '#38bdf8') + block(R.B, '💗 여자친구', '#f472b6');
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
      ${row(R.A, '💼 나', '#38bdf8')}
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
      ['자기자금(현금+증여)', c.cashGift, '#38bdf8'],
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
    marker: { colors: ['#38bdf8', '#a78bfa', '#fbbf24'] },
    textinfo: 'label+percent', textposition: 'inside', insidetextorientation: 'horizontal',
    textfont: { color: '#0f172a', size: 11 },
    hovertemplate: '%{customdata}: %{value:,.0f}원<extra></extra>',
  }], {
    paper_bgcolor: 'transparent', plot_bgcolor: 'transparent',
    font: { color: '#e2e8f0' }, showlegend: false,
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
const eokFmt = v => v == null ? '—' : (v/10000 >= 10 ? (v/10000).toFixed(1) : (v/10000).toFixed(2)).replace(/\.?0+$/,'') + '억';

async function renderExplorer() {
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

  initCoupleTools();
  applyPriceFilter(0, 9999);
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

function applyPriceFilter(minEok, maxEok) {
  explorerFilter = { min: minEok, max: maxEok };
  explorerMarkers.forEach(m => explorerMap.removeLayer(m));
  explorerMarkers = [];

  explorerVisible = sortApts(explorerApts.filter(a => {
    const p = a.latest_price != null ? a.latest_price / 10000 : null;
    return p != null && p >= minEok && p <= maxEok;
  }));

  explorerVisible.forEach(a => {
    const cls = a.composite_score >= 60 ? 'bubble-hot' : a.composite_score >= 55 ? 'bubble-mid' : 'bubble-cool';
    const icon = L.divIcon({
      className: '',
      html: `<div class="apt-bubble ${cls}">
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

  document.getElementById('explorerPanel').innerHTML = `
    <button class="ep-back" id="epBack">← 목록으로</button>
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
      <a class="ep-naver" href="${naverLandUrl(a.district, a.apt_name, a.dong, a.lat, a.lng, a.naver_id)}" target="_blank" rel="noopener">네이버 부동산 ↗</a>
      <a class="ep-hogang" href="${hogangnonoUrl(a.district, a.apt_name, a.dong, a.lat, a.lng)}" target="_blank" rel="noopener">호갱노노 ↗</a>
    </div>
    <div class="ep-trades">
      <div class="ep-trades-head">
        📋 실거래 내역 <span class="ep-trades-note">국토부 raw data</span>
      </div>
      <div id="epTradesBody" class="ep-trades-body"><div class="skeleton" style="height:80px"></div></div>
    </div>
  `;

  document.getElementById('epBack').addEventListener('click', showAptList);
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
  const sections = ['secExplorer','secBudget','secMap','secScoring','secDistrict','secTop1'];
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

/* ── 초기화 ─────────────────────────────────────────────── */
(async function init() {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error(fn.name, e); } };
  initNav();
  await safe(renderScoring);
  await safe(initBudgetPlanner);
  // 각 섹션을 독립 실행 — 한 곳(예: 지도 CDN)이 실패해도 나머지는 정상 렌더
  await safe(renderExplorer);
  await safe(renderMap);
  await safe(renderDistrictRankings);
  await safe(renderTop1);
  initApartmentModal();
})();
