import {
  LOAN_PRODUCTS, analyzeFinance, won2eok, won2man,
  LEGAL_BASIS, FAMILY_LOAN,
} from './financeCalculator.js';

/* ── 유틸 ──────────────────────────────────────────────── */
async function fetchJSON(url) {
  const r = await fetch(url);
  return r.json();
}

const fmt = n => n != null ? n.toLocaleString() : '—';
const fmtScore = v => v != null ? v.toFixed(1) : '—';

/* ── 서울 14개 구 GeoJSON 근사 폴리곤 (simplified bounds) ── */
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
};

/* ── 전역 상태 ──────────────────────────────────────────── */
let districtData = [];
let seoulMap = null;
let mapLayers = {};

/* ── ① 지도 + 구별 카드 ──────────────────────────────────── */
async function renderMap() {
  const data = await fetchJSON('/api/districts');
  districtData = data.districts;

  // 히어로 통계 업데이트
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

  const popupFor = d => d.has_data
    ? `<div class="map-popup"><b>${d.name}</b><br>
        분석 완료 ✓<br>
        단지 수: ${d.apt_count}개<br>
        최우수: ${d.top_apt_name || '—'}<br>
        최고점: ${d.top_score != null ? d.top_score.toFixed(1) : '—'}점</div>`
    : `<div class="map-popup"><b>${d.name}</b><br>데이터 수집 예정</div>`;

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
        layer.bindPopup(popupFor(d));
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
      rect.bindPopup(popupFor(d));
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
    marker.bindPopup(popupFor(d));
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
        <p class="card-desc">${d.description || d.character || ''}</p>
        ${famousStr ? `<div class="card-famous">📍 ${famousStr}</div>` : ''}
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
      desc: '2022~2023년 하락장에서 최고점 대비 얼마나 덜 떨어졌는지(MDD)와, 저점 이후 얼마나 회복했는지를 함께 봅니다. 신고가를 갱신한 단지는 가점을 받습니다.',
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
    { key: '규모·연식', weight: 10, color: '#f472b6',
      desc: '거래 규모(대단지 프리미엄)와 준공연도를 반영합니다. 대단지는 환금성이 높고, 신축은 상품 경쟁력이 있습니다.',
      metric: '총 거래량(70%) + 준공연도(30%)', example: '1,000+ 거래 대단지 & 2010년대 준공 → 가점' },
    { key: '교통', weight: 10, color: '#f87171',
      desc: '단지 좌표에서 가장 가까운 지하철역까지의 도보거리(직선거리 기반)와 반경 1km 내 역 수(더블역세권)를 평가합니다.',
      metric: '최근접역 도보 분(80%) + 1km 내 역 수(20%)', example: '도보 5분 역세권 + 더블역세권 → 최고점' },
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
async function renderDistrictRankings() {
  const data = await fetchJSON('/api/composite_score');
  const ranking = data.ranking || [];

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
        ['모멘텀', a.momentum_score], ['프리미엄', a.premium_score], ['규모·연식', a.scale_score],
        ['교통', a.transit_score],
      ].filter(x => x[1] != null);
      const best = axes.reduce((p,c) => c[1] > p[1] ? c : p, ['', -1]);

      return `
      <div class="drs-row">
        <span class="drs-rank" style="${i===0?`color:${color}`:''}">${i+1}</span>
        <div class="drs-mid">
          <div class="drs-name">${a.apt_name}</div>
          <div class="drs-meta">${a.mdd != null ? 'MDD ' + a.mdd.toFixed(1) + '%' : ''} · ${best[0]} 강점</div>
        </div>
        <span class="drs-score" style="${i===0?`color:${color}`:''}">${fmtScore(a.composite_score)}</span>
        <span class="drs-links">
          <a href="${naverLandUrl(a.district, a.apt_name, a.dong, a.lat, a.lng)}" target="_blank" rel="noopener" class="drs-lk drs-lk-n" title="네이버 지도">N</a>
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
async function renderTop1() {
  const [comp, mdd, ts] = await Promise.all([
    fetchJSON('/api/composite_score'),
    fetchJSON('/api/mdd_ranking'),
    fetchJSON('/api/timeseries'),
  ]);

  const top = comp.ranking?.[0];
  if (!top) {
    document.getElementById('top1Detail').innerHTML = `<div class="empty-state">데이터 없음</div>`;
    return;
  }

  const mddInfo = (mdd.ranking||[]).find(r => r.apt_name === top.apt_name) || {};
  const distInfo = districtData.find(d => d.name === top.district) || {};
  const color = distInfo.color || '#38bdf8';

  const axes = [
    { name: '가격방어력', val: top.defense_score, w: 25, color: '#34d399' },
    { name: '거래유동성', val: top.liquidity_score, w: 20, color: '#38bdf8' },
    { name: '상승참여도', val: top.upside_score, w: 15, color: '#fbbf24' },
    { name: '회복모멘텀', val: top.momentum_score, w: 15, color: '#a78bfa' },
    { name: '입지프리미엄', val: top.premium_score, w: 15, color: '#fb923c' },
    { name: '규모·연식', val: top.scale_score, w: 10, color: '#f472b6' },
    { name: '교통', val: top.transit_score, w: 10, color: '#f87171' },
  ].filter(a => a.val != null);

  // 레이더 차트 (Plotly)
  const radarLabels = axes.map(a => a.name);
  const radarVals = axes.map(a => a.val != null ? Math.min(100, a.val) : 0);

  document.getElementById('top1Detail').innerHTML = `
    <div class="top1-hero">
      <div class="top1-badge">🏆 전체 종합 1위</div>
      <h3 class="top1-name">${top.apt_name}</h3>
      <div class="top1-loc">${top.district} ${distInfo.icon||''}</div>
      <div class="top1-score-big">${fmtScore(top.composite_score)}<span class="top1-score-unit">점</span></div>
      <div class="ep-links" style="justify-content:center;margin-top:.8rem">
        <a class="ep-naver" href="${naverLandUrl(top.district, top.apt_name, top.dong, top.lat, top.lng)}" target="_blank" rel="noopener">네이버 지도/부동산 ↗</a>
        <a class="ep-hogang" href="${hogangnonoUrl(top.district, top.apt_name, top.dong, top.lat, top.lng)}" target="_blank" rel="noopener">호갱노노 ↗</a>
      </div>
    </div>

    <div class="top1-body">
      <div class="top1-radar" id="top1Radar"></div>
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
      <div class="top1-stat"><div class="ts-val">${top.active_months != null ? top.active_months+'개월' : '—'}</div><div class="ts-key">활성 거래 기간</div></div>
    </div>

    <div class="top1-insight">
      <div class="insight-title">왜 1위인가요?</div>
      <ul class="insight-list">
        ${top.defense_score >= 70 ? '<li>하락장에서 가격 방어력이 매우 뛰어나고 회복도 빠릅니다</li>' : ''}
        ${top.liquidity_score >= 70 ? '<li>6년간 꾸준한 거래가 이어진 환금성 높은 단지입니다</li>' : ''}
        ${top.upside_score >= 70 ? '<li>상승장에서도 시장 평균을 웃도는 상승률을 기록했습니다</li>' : ''}
        ${top.momentum_score >= 70 ? '<li>최근 12개월 가격 추세가 뚜렷한 상승 흐름입니다</li>' : ''}
        ${top.premium_score >= 70 ? '<li>단위면적당 가격 상위권 — 시장이 인정한 입지입니다</li>' : ''}
        ${top.transit_score >= 70 && top.nearest_station ? `<li>${top.nearest_station} 도보 ${Math.round(top.walk_min)}분 거리의 역세권 단지입니다</li>` : ''}
        <li>${top.district} 내 ${comp.ranking.filter(r=>r.district===top.district).length}개 단지 중 종합 1위를 차지했습니다</li>
        <li>6가지 분석 축에서 균형 잡힌 고득점을 기록했습니다</li>
      </ul>
    </div>
  `;

  // 레이더 차트 렌더링
  const radarFull = [...radarVals, radarVals[0]];
  const radarFull2 = [...radarLabels, radarLabels[0]];
  Plotly.newPlot('top1Radar', [{
    type: 'scatterpolar',
    r: radarFull,
    theta: radarFull2,
    fill: 'toself',
    fillcolor: 'rgba(56,189,248,0.2)',
    line: { color: '#38bdf8', width: 2 },
    marker: { color: '#38bdf8', size: 6 },
    name: top.apt_name
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
  const aptTs = (ts.apartments || []).find(a => a.apt_name === top.apt_name);
  if (aptTs && aptTs.monthly) {
    renderPriceChart(aptTs);
  }
}

function renderPriceChart(aptTs) {
  const months = aptTs.monthly.map(m => m.ym);
  const prices = aptTs.monthly.map(m => m.median != null ? +(m.median/10000).toFixed(2) : null);

  const existing = document.getElementById('top1PriceChart');
  if (!existing) {
    const chartDiv = document.createElement('div');
    chartDiv.id = 'top1PriceChart';
    chartDiv.className = 'top1-price-chart';
    chartDiv.style.height = '260px';
    document.getElementById('top1Detail').appendChild(chartDiv);
  }

  Plotly.newPlot('top1PriceChart', [{
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

// 단지명을 네이버 검색에 맞게 정규화 (괄호·동번호·시공사 병기 제거)
function normalizeAptName(name) {
  if (NAVER_ALIAS[name]) return NAVER_ALIAS[name];
  return name
    .replace(/\([^)]*\)/g, '')       // (삼성), (336), (200-0) 등 괄호 제거
    .replace(/\d+동\s*~\s*\d+동/g, '') // 101동~116동 동범위 제거
    .replace(/,/g, ' ')              // 쉼표 → 공백
    .replace(/e-편한세상/gi, 'e편한세상')
    .replace(/이편한세상/g, 'e편한세상')
    .replace(/\s+/g, ' ')
    .trim();
}

// 네이버 지도 링크. 좌표가 있으면 좌표 중심으로 열어(이름 매칭 실패 무관)
// 항상 정확한 위치를 보여주고, 좌표가 없을 때만 이름 검색으로 폴백한다.
function naverLandUrl(district, aptName, dong, lat, lng) {
  const label = encodeURIComponent(normalizeAptName(aptName));
  if (lat && lng) return `https://map.naver.com/p?lat=${lat}&lng=${lng}&title=${label}&level=2`;
  const area = dong || district;
  return `https://map.naver.com/p/search/${encodeURIComponent(`${area} ${normalizeAptName(aptName)}`.trim())}`;
}

// 호갱노노 링크. 좌표가 있으면 좌표 중심 지도로, 없으면 이름 검색.
function hogangnonoUrl(district, aptName, dong, lat, lng) {
  if (lat && lng) return `https://hogangnono.com/?zoom=16&lat=${lat}&lng=${lng}`;
  const area = dong || district;
  return `https://hogangnono.com/search/${encodeURIComponent(`${area} ${normalizeAptName(aptName)}`.trim())}`;
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
let selectedLoan = LOAN_PRODUCTS[3];   // 기본: 일반 주담대
let lastAnalysis = null;

function initBudgetPlanner() {
  const wrap = document.getElementById('loanProducts');
  wrap.innerHTML = LOAN_PRODUCTS.map(p => `
    <label class="loan-product ${p.id === selectedLoan.id ? 'active' : ''}" data-id="${p.id}">
      <div class="lp-head"><input type="radio" name="loanP" ${p.id === selectedLoan.id ? 'checked' : ''}> <b>${p.name}</b>
        <span class="lp-rate">${(p.rate*100).toFixed(2)}%</span></div>
      <div class="lp-note">${p.note}</div>
    </label>
  `).join('');
  const setRateYears = () => {
    document.getElementById('loanRate').value = (selectedLoan.rate * 100).toFixed(2);
    document.getElementById('loanYears').value = selectedLoan.years;
  };
  setRateYears();

  wrap.querySelectorAll('.loan-product').forEach(el => {
    el.addEventListener('click', () => {
      selectedLoan = LOAN_PRODUCTS.find(p => p.id === el.dataset.id);
      wrap.querySelectorAll('.loan-product').forEach(x => x.classList.toggle('active', x === el));
      el.querySelector('input').checked = true;
      setRateYears();
      recalcBudget();
    });
  });

  // 모든 입력에 반응형 바인딩 (입력 즉시 재계산)
  ['myCash','gfCash','myGift','gfGift','coupleIncome','loanRate','loanYears',
   'repayType','optMarriage','optBirth','optFirstHome','optRegulated',
   'familyLoan','familyYears'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('input', recalcBudget);
    if (el) el.addEventListener('change', recalcBudget);
  });

  renderLegalAccordion();
  recalcBudget();
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
        item.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  });
}

function recalcBudget() {
  const num = id => parseFloat(document.getElementById(id).value) || 0;
  const chk = id => document.getElementById(id).checked;
  const 억 = 1e8, 만 = 1e4;

  const input = {
    myCash: num('myCash') * 억,
    gfCash: num('gfCash') * 억,
    myGift: num('myGift') * 억,
    gfGift: num('gfGift') * 억,
    marriage: chk('optMarriage'),
    birth: chk('optBirth'),
    income: num('coupleIncome') * 만,
    product: selectedLoan,
    rate: num('loanRate') / 100 || selectedLoan.rate,
    years: parseInt(document.getElementById('loanYears').value) || selectedLoan.years,
    repay: document.getElementById('repayType').value,
    firstHome: chk('optFirstHome'),
    familyLoan: num('familyLoan') * 억,
    familyYears: parseInt(document.getElementById('familyYears').value) || 10,
    regulated: chk('optRegulated'),
  };

  const R = analyzeFinance(input);
  lastAnalysis = R;

  const dsrPct = (R.dsrRatio * 100).toFixed(0);
  const dsrColor = R.dsrRatio > 0.40 ? '#f87171' : R.dsrRatio > 0.30 ? '#fbbf24' : '#34d399';

  document.getElementById('budgetOutput').innerHTML = `
    <div class="br-main">
      <div class="br-headline">
        <span class="br-label">최대 매수 가능 주택가</span>
        <span class="br-price">${won2eok(R.maxPrice)}</span>
      </div>
      <button class="price-apply br-apply" id="budgetApply">이 예산으로 지도 필터 →</button>
    </div>
    <div class="br-stats">
      <div class="br-stat"><span class="brk">자기자본</span><span class="brv">${won2eok(R.ownEquity)}</span><span class="brs">현금+세후증여</span></div>
      <div class="br-stat"><span class="brk">은행 대출</span><span class="brv">${won2eok(R.loan)}</span><span class="brs">${selectedLoan.name} · ${R.loanBind}</span></div>
      <div class="br-stat"><span class="brk">부모 차용</span><span class="brv">${won2eok(R.familyLoan)}</span><span class="brs">무이자 · 원금 ${won2man(R.familyMonthly)}/월</span></div>
      <div class="br-stat"><span class="brk">총 월 상환액</span><span class="brv">${won2man(R.totalMonthly)}</span><span class="brs">은행+부모, DSR <b style="color:${dsrColor}">${dsrPct}%</b></span></div>
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
}

function renderBudgetBreakdown(R) {
  document.getElementById('budgetBreakdown').innerHTML = `
    <div class="budget-row"><span>취득세 ${(R.acqRate*100).toFixed(1)}%${R.acqDiscount>0?' (생애최초 감면)':''}</span><b>${won2man(R.acqTax)}</b></div>
    <div class="budget-row"><span>중개보수 (상한)</span><b>${won2man(R.brokerFee)}</b></div>
    <div class="budget-row"><span>증여세 합계</span><b>${won2man(R.giftTax)}</b></div>
    <div class="budget-row"><span>세후 증여 실수령</span><b>${won2eok(R.netGift)}</b></div>
    <div class="budget-row"><span>부모차용 간주이자(연 4.6%)</span><b>${won2man(R.familyDeemedInterest)} ${R.familyOverLimit?'<small style="color:#f87171">한도초과</small>':'<small style="color:#34d399">비과세</small>'}</b></div>
    <div class="budget-row"><span>은행 대출이자 (만기까지)</span><b>${won2eok(R.totalInterest)}</b></div>
    <div class="budget-row"><span>실투입 자기자본</span><b>${won2eok(R.cashUsed)}</b></div>
    <div class="budget-note" style="margin-top:.6rem">부모 무이자 차용은 ${won2eok(FAMILY_LOAN.MAX_NO_INTEREST)}까지 증여세 없이 원금만 갚으면 됩니다. 부대비용(취득세+중개비) ${won2man(R.acqTax + R.brokerFee)}는 자금에서 먼저 차감됩니다.</div>
  `;
}

function renderBudgetChart(R) {
  const c = R.composition;
  const div = document.getElementById('budgetChart');
  if (!div) return;

  // Plotly 미로딩 시 CSS 스택 막대로 대체
  if (typeof Plotly === 'undefined') {
    const total = c.cash + c.gift + c.family + c.loan || 1;
    const seg = [
      ['현금', c.cash, '#38bdf8'], ['세후 증여', c.gift, '#34d399'],
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
    labels: ['현금', '세후 증여', '부모 차용', '은행 대출'],
    values: [c.cash, c.gift, c.family, c.loan],
    marker: { colors: ['#38bdf8', '#34d399', '#a78bfa', '#fbbf24'] },
    textinfo: 'label+percent', textfont: { color: '#0f172a', size: 12 },
    hovertemplate: '%{label}: %{value:,.0f}원<extra></extra>',
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
        <div class="ep-list-sub">${a.district} · ${a.build_year}년 · ${a.area_exclusive}㎡${(() => { const c = commuteInfo(a); return c ? ` · <span class="ep-commute">${c.label}</span>` : ''; })()}</div>
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
      <div class="ep-loc">${a.district} · ${a.build_year}년 준공 · 전용 ${a.area_exclusive}㎡ · 종합 ${a.rank}위</div>
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
      <a class="ep-naver" href="${naverLandUrl(a.district, a.apt_name, a.dong, a.lat, a.lng)}" target="_blank" rel="noopener">네이버 지도/부동산 ↗</a>
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
})();
