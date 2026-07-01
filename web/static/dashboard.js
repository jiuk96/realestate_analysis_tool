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

  // 구별 폴리곤 + 마커
  districtData.forEach(d => {
    const poly = DISTRICT_POLYGONS[d.name];
    if (!poly) return;
    const color = d.has_data ? (d.color || '#38bdf8') : '#475569';
    const bounds = poly.map(p => [p[0], p[1]]);
    const rect = L.rectangle(
      [[Math.min(...poly.map(p=>p[0])), Math.min(...poly.map(p=>p[1]))],
       [Math.max(...poly.map(p=>p[0])), Math.max(...poly.map(p=>p[1]))]],
      {
        color: color,
        weight: 2,
        fillColor: color,
        fillOpacity: d.has_data ? 0.35 : 0.12
      }
    );

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

    const popupContent = d.has_data
      ? `<div class="map-popup"><b>${d.name}</b><br>
          분석 완료 ✓<br>
          단지 수: ${d.apt_count}개<br>
          최우수: ${d.top_apt_name || '—'}<br>
          최고점: ${d.top_score != null ? d.top_score.toFixed(1) : '—'}점</div>`
      : `<div class="map-popup"><b>${d.name}</b><br>데이터 수집 예정</div>`;

    rect.bindPopup(popupContent);
    marker.bindPopup(popupContent);

    rect.on('click', () => scrollToDistrict(d.name));
    marker.on('click', () => scrollToDistrict(d.name));

    rect.addTo(seoulMap);
    marker.addTo(seoulMap);
    mapLayers[d.name] = { rect, marker };
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
    { key: '거래지속성', weight: 30, color: '#38bdf8',
      desc: '2020~2026년 전 기간에 걸쳐 꾸준히 거래가 이루어졌는지 측정합니다. 거래가 끊기지 않는 단지는 수요가 안정적이라는 신호입니다.',
      metric: '활성 월수 / 전체 기간', example: '72개월 중 60개월 거래 → 높은 점수' },
    { key: '가격방어력', weight: 25, color: '#34d399',
      desc: '2022~2023년 하락장에서 최고점 대비 얼마나 덜 떨어졌는지(MDD)를 측정합니다. MDD가 0에 가까울수록 우량 단지입니다.',
      metric: 'MDD(%) = (최저-최고)/최고 × 100', example: 'MDD -15% vs -35% → 방어력 차이 큼' },
    { key: '상승참여도', weight: 20, color: '#fbbf24',
      desc: '2021년 상승장에서 시장 평균 대비 얼마나 많이 올랐는지를 측정합니다. 하락에 강하면서 상승에도 참여해야 진정한 우량 단지입니다.',
      metric: '단지 상승률 / 구 평균 상승률', example: '구 평균 30% 상승 시 단지 45% → 높은 참여도' },
    { key: '교통', weight: 12, color: '#a78bfa',
      desc: '지하철역까지의 접근성을 기준으로 평가합니다. 역세권 단지는 수요가 안정적으로 유지됩니다.',
      metric: '인근 지하철역 수 / 도보 거리', example: '도보 5분 이내 역세권 → 최고 점수' },
    { key: '인프라', weight: 8, color: '#fb923c',
      desc: '대형마트, 병원, 공원 등 생활편의시설의 밀집도를 측정합니다. 인프라가 풍부한 단지는 실거주 수요가 견고합니다.',
      metric: '반경 1km 내 편의시설 수', example: '이마트+병원+공원 → 높은 인프라 점수' },
    { key: '학군', weight: 5, color: '#f472b6',
      desc: '초중고 학군 품질을 평가합니다. 학군은 실거주 가족의 핵심 수요이며 가격 하방을 지지하는 요인입니다.',
      metric: '인근 학교 학업성취도 지수', example: '학업성취도 상위 20% 학교 인접 → 가점' },
  ];

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
    const apts = byDistrict[district].slice(0, 5);
    const distInfo = districtData.find(d => d.name === district) || {};
    const color = distInfo.color || '#38bdf8';

    const rows = apts.map((a, i) => {
      const axes = [
        { name: '거래지속성', val: a.continuity_score, w: 30 },
        { name: '가격방어', val: a.mdd_score, w: 25 },
        { name: '상승참여', val: a.recovery_score, w: 20 },
        { name: '교통', val: a.transport_score, w: 12 },
        { name: '인프라', val: a.infra_score, w: 8 },
        { name: '학군', val: a.school_score, w: 5 },
      ].filter(x => x.val != null);

      const best = axes.reduce((a,b) => (a.val||0) > (b.val||0) ? a : b, {});
      const worst = axes.reduce((a,b) => (a.val||0) < (b.val||0) ? a : b, {});

      return `
      <div class="apt-rank-row ${i===0?'apt-rank-top':''}">
        <div class="apt-rank-num" style="color:${i===0?color:'#64748b'}">${i+1}</div>
        <div class="apt-rank-info">
          <div class="apt-rank-name">${a.apt_name}</div>
          <div class="apt-rank-tags">
            ${best.name ? `<span class="aptag aptag-good">강점: ${best.name}</span>` : ''}
            ${worst.name ? `<span class="aptag aptag-bad">약점: ${worst.name}</span>` : ''}
            ${a.mdd != null ? `<span class="aptag">MDD ${a.mdd.toFixed(1)}%</span>` : ''}
          </div>
        </div>
        <div class="apt-rank-score" style="color:${i===0?color:'#94a3b8'}">${fmtScore(a.composite_score)}<span class="apt-rank-unit">점</span></div>
      </div>`;
    }).join('');

    return `
    <div class="district-rank-block">
      <div class="drb-header" style="border-left:4px solid ${color}">
        <span class="drb-icon">${distInfo.icon||'🏙️'}</span>
        <span class="drb-name">${district}</span>
        <span class="drb-count">${byDistrict[district].length}개 단지 분석</span>
      </div>
      <div class="apt-rank-list">${rows}</div>
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
    { name: '거래지속성', val: top.continuity_score, w: 30, color: '#38bdf8' },
    { name: '가격방어력', val: top.mdd_score, w: 25, color: '#34d399' },
    { name: '상승참여도', val: top.recovery_score, w: 20, color: '#fbbf24' },
    { name: '교통', val: top.transport_score, w: 12, color: '#a78bfa' },
    { name: '인프라', val: top.infra_score, w: 8, color: '#fb923c' },
    { name: '학군', val: top.school_score, w: 5, color: '#f472b6' },
  ];

  // 레이더 차트 (Plotly)
  const radarLabels = axes.map(a => a.name);
  const radarVals = axes.map(a => a.val != null ? Math.min(100, a.val) : 0);

  document.getElementById('top1Detail').innerHTML = `
    <div class="top1-hero">
      <div class="top1-badge">🏆 전체 종합 1위</div>
      <h3 class="top1-name">${top.apt_name}</h3>
      <div class="top1-loc">${top.district} ${distInfo.icon||''}</div>
      <div class="top1-score-big">${fmtScore(top.composite_score)}<span class="top1-score-unit">점</span></div>
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
        ${top.mdd_score >= 70 ? '<li>하락장에서 가격 방어력이 매우 뛰어납니다</li>' : ''}
        ${top.continuity_score >= 70 ? '<li>6년간 꾸준한 거래가 이어진 수요 안정 단지입니다</li>' : ''}
        ${top.recovery_score >= 70 ? '<li>상승장에서도 시장 평균을 웃도는 상승률을 기록했습니다</li>' : ''}
        ${top.transport_score >= 70 ? '<li>역세권 입지로 교통 접근성이 우수합니다</li>' : ''}
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

/* ── 네비게이션 활성화 ──────────────────────────────────── */
function initNav() {
  const sections = ['secMap','secScoring','secDistrict','secTop1'];
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
  initNav();
  renderScoring();
  await renderMap();
  await renderDistrictRankings();
  await renderTop1();
})();
