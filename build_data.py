"""
전체 분석 파이프라인 - data/raw/*.parquet → data/processed/*.json
"""
import sys, json, warnings
warnings.filterwarnings('ignore')
sys.path.insert(0, '.')
import pandas as pd
import numpy as np
from pathlib import Path

from src.preprocessor import run as preprocess_run
from src.analyzer import run as analyzer_run, build_monthly_median
from src.scorer import compute_composite_score, WEIGHTS, WEIGHTS_TRANSIT
from config import DISTRICTS, MIN_HOUSEHOLDS

CODE2NAME = {v: k for k, v in DISTRICTS.items()}
OUT = Path('data/processed')


def _clean(obj):
    """nan/NaT → None, Period → str"""
    if isinstance(obj, float) and obj != obj:
        return None
    if isinstance(obj, dict):
        return {k: _clean(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_clean(i) for i in obj]
    if hasattr(obj, 'isoformat'):
        return str(obj)
    return obj


def save(name, data):
    path = OUT / name
    path.write_text(json.dumps(_clean(data), ensure_ascii=False, default=str), encoding='utf-8')
    print(f'  저장: {name}')


# ── 1. 로드 ──────────────────────────────────────────────────
print('=== 1. 데이터 로드 ===')
raw_dir = Path('data/raw')
dfs = [pd.read_parquet(f) for f in sorted(raw_dir.glob('*.parquet'))]
df_raw = pd.concat(dfs, ignore_index=True)
df_raw['district_name'] = df_raw['district_code'].astype(str).map(CODE2NAME)
print(f'  원본: {len(df_raw):,}건')

# ── 2. 전처리 ─────────────────────────────────────────────────
print('=== 2. 전처리 ===')
df = preprocess_run(df_raw)
print(f'  정제: {len(df):,}건, {df["apt_name"].nunique()}개 단지')

# ── 3. 분석 (MDD) ─────────────────────────────────────────────
print('=== 3. MDD 분석 ===')
mdd_df, top_df, traits = analyzer_run(df)
print(f'  분석 단지: {len(mdd_df)}개')
for dist, cnt in mdd_df['district_name'].value_counts().items():
    print(f'    {dist}: {cnt}개')

# ── 4. 월별 시계열 ────────────────────────────────────────────
print('=== 4. 시계열 구성 ===')
monthly = build_monthly_median(df)

# 극소표본 제외: 대표평형(59㎡) 거래가 6년간 5건 미만이면 사실상 모든 축이
# 중립(50) 채움으로 만들어진 '유령 점수'가 된다(예: 대치팰리스 59㎡ 1건).
# 신뢰도 배지로 가려질 수준이 아니므로 분석 대상에서 아예 제외한다.
_MIN_REP_TRADES = 5
_cnt = monthly.groupby(['district_name', 'apt_name'], observed=True)['trade_count'].sum()
_ok = set(_cnt[_cnt >= _MIN_REP_TRADES].index)
_before = len(mdd_df)
mdd_df = mdd_df[mdd_df.apply(lambda r: (r['district_name'], r['apt_name']) in _ok, axis=1)].copy()
monthly = monthly[monthly.apply(lambda r: (r['district_name'], r['apt_name']) in _ok, axis=1)].copy()
_dropped = _before - len(mdd_df)
if _dropped:
    print(f'  대표평형 거래 {_MIN_REP_TRADES}건 미만 제외: {_dropped}개 단지 → {len(mdd_df)}개')

# ── 4b. 전세가율 (전월세 데이터 있을 때만) ────────────────────
def compute_jeonse_ratio(monthly_df):
    """data/rent/*.parquet(collect_rent.py 수집, 2020~ 전체)에서 전용 59㎡ 전세 통계.
    - 전세가율·중앙값·건수: 최근 18개월 (최신 시세)
    - 전세 추세: 최근 36개월 Theil-Sen (창 확대로 노이즈 축소)
    - 전세 MDD: 전 기간(78개월) 월별 전세 중앙값의 최대 낙폭 — 역전세 실증 이력
    - 전세가율 사이클: 현 전세가율이 그 단지 역사 밴드에서 몇 percentile인지
      (낮을수록 역사적으로 싼 전세 = 진입 타이밍 유리)
    데이터 없으면 None."""
    rent_dir = Path('data/rent')
    files = sorted(rent_dir.glob('*.parquet')) if rent_dir.exists() else []
    if not files:
        print('  (전월세 데이터 없음 — 전세가율 축 비활성. collect_rent.py 수집 후 활성화됨)')
        return None
    rent = pd.concat([pd.read_parquet(f) for f in files], ignore_index=True)
    rent['district_name'] = rent['district_code'].astype(str).map(CODE2NAME)
    # 순수 전세(월세 0) + 전용 59㎡대만
    import config as _cfg
    rent = rent[(rent.get('monthly_rent', 0).fillna(0) == 0) &
                (rent['area_exclusive'] >= _cfg.TARGET_AREA_MIN) &
                (rent['area_exclusive'] <= _cfg.TARGET_AREA_MAX)].copy()
    # 갱신 계약 제외: 계약갱신(청구권)은 인상 5% 상한에 묶여 시장가를 반영하지
    # 못한다 — 신규가와 섞이면 월 중앙값이 이중분포가 되어 전세 시세·추세·MDD가
    # 통째로 왜곡된다(감사에서 -78% 가짜 MDD 발견). 명시적 '갱신'만 제외하고,
    # 표기 공란(제도 도입 전 2020~21 데이터)은 유지한다.
    if 'contractType' in rent.columns:
        n0 = len(rent)
        rent = rent[rent['contractType'].fillna('') != '갱신']
        print(f'  갱신계약 제외: {n0:,} → {len(rent):,}건 (신규+미표기만 시세로 사용)')
    # 보증금 이상치 제거: 0원(오기재)·3천만원 미만은 서울 59㎡ 전세로 비현실적 —
    # 월 중앙값에 섞이면 전세 MDD가 -100% 같은 가짜 낙폭을 만든다.
    n0 = len(rent)
    rent = rent[pd.to_numeric(rent['deposit'], errors='coerce').fillna(0) >= 3000]
    if n0 - len(rent):
        print(f'  보증금 이상치(<3천만원) 제외: {n0 - len(rent):,}건')
    if rent.empty:
        return None
    # 단지별 특수계약 제거: 그 단지 전체 중앙값의 절반 미만 보증금은 시장 전세가
    # 아니라 공공지원 민간임대·보증부 특수계약이다(감사에서 7억대 단지에 9,599만원
    # 동일가 5건 발견 — 가짜 전세 MDD -79%의 원인). 단지 자체 기준이라 진짜
    # 하락장 낙폭(-30~40%)은 걸러지지 않는다.
    rent['deposit'] = pd.to_numeric(rent['deposit'], errors='coerce')
    apt_med = rent.groupby(['district_name', 'apt_name'], observed=True)['deposit'].transform('median')
    n0 = len(rent)
    rent = rent[rent['deposit'] >= apt_med * 0.5]
    if n0 - len(rent):
        print(f'  특수계약 의심(단지 중앙값 절반 미만) 제외: {n0 - len(rent):,}건')

    rent['ym'] = rent['deal_year'].astype(str) + rent['deal_month'].astype(str).str.zfill(2)
    all_yms = sorted(rent['ym'].unique())

    # ── 최신 시세 (최근 18개월): 전세 중앙값·건수·전세가율 ──────
    recent18 = set(all_yms[-18:])
    recent = rent[rent['ym'].isin(recent18)]
    jeonse_med = (recent.groupby(['district_name', 'apt_name'], observed=True)['deposit']
                  .median().rename('jeonse_median').reset_index())
    jeonse_cnt = (recent.groupby(['district_name', 'apt_name'], observed=True)['deposit']
                  .count().rename('jeonse_count').reset_index())

    m = monthly_df.copy()
    m['ym'] = m['deal_date'].astype(str).str.replace('-', '')
    recent_m = sorted(m['ym'].unique())[-18:]
    sale_med = (m[m['ym'].isin(recent_m)]
                .groupby(['district_name', 'apt_name'], observed=True)['median_price']
                .median().rename('sale_median').reset_index())

    # ── 장기 시계열 (전 기간): 월별 전세 중앙값 ────────────────
    from src.scorer import _theil_sen_slope
    import numpy as np
    jm = (rent.groupby(['district_name', 'apt_name', 'ym'], observed=True)['deposit']
          .median().reset_index().sort_values('ym'))
    # 매매 월별 스무딩가 맵 (전세가율 사이클용)
    sale_map = {(r['district_name'], r['apt_name'], r['ym']): r['smoothed_price']
                for _, r in m.iterrows()}

    trend36_cut = all_yms[-36] if len(all_yms) >= 36 else all_yms[0]
    long_rows = []
    for (d, a), grp in jm.groupby(['district_name', 'apt_name'], observed=True):
        grp = grp.sort_values('ym')
        row = {'district_name': d, 'apt_name': a,
               'jeonse_trend_pct': np.nan, 'jeonse_mdd_pct': np.nan,
               'jeonse_ratio_now_pctile': np.nan}

        # ① 추세: 최근 36개월 창 (관측 5개월 이상)
        w = grp[grp['ym'] >= trend36_cut]
        if len(w) >= 5:
            x = np.arange(len(w), dtype=float)
            y = w['deposit'].to_numpy(dtype=float)
            slope = _theil_sen_slope(x, y)
            if y.mean() > 0:
                row['jeonse_trend_pct'] = round(slope * 12 / y.mean() * 100, 2)

        # ② 전세 MDD: 전 기간, 3개월 이동중앙값 스무딩 후 고점 대비 최대 낙폭.
        #    실제로 전세가가 크게 빠진 이력 = 역전세(보증금 반환 압박)의 실증 증거.
        if len(grp) >= 12:
            s = grp['deposit'].rolling(3, min_periods=1).median()
            dd = (s - s.cummax()) / s.cummax() * 100
            row['jeonse_mdd_pct'] = round(float(dd.min()), 1)

        # ③ 전세가율 사이클: 월별 (전세 중앙값 ÷ 매매 스무딩가) 시계열에서
        #    현(최근 6개월 평균) 비율이 역사적으로 몇 percentile인지.
        ratios = [(ym, dep / sale_map[(d, a, ym)])
                  for ym, dep in zip(grp['ym'], grp['deposit'])
                  if sale_map.get((d, a, ym), 0) and sale_map[(d, a, ym)] > 0]
        if len(ratios) >= 12:
            vals = np.array([r for _, r in ratios])
            cur = np.mean([r for ym, r in ratios[-6:]])
            row['jeonse_ratio_now_pctile'] = round(float((vals <= cur).mean() * 100), 0)

        long_rows.append(row)
    longstats = pd.DataFrame(long_rows)

    j = jeonse_med.merge(jeonse_cnt, on=['district_name', 'apt_name']) \
                  .merge(sale_med, on=['district_name', 'apt_name'], how='inner')
    j = j[(j['sale_median'] > 0) & (j['jeonse_count'] >= 2)]   # 전세 2건 이상만 신뢰
    if j.empty:
        return None
    j = j.merge(longstats, on=['district_name', 'apt_name'], how='left')
    j['jeonse_ratio'] = j['jeonse_median'] / j['sale_median']
    j['jeonse_gap'] = j['sale_median'] - j['jeonse_median']   # 갭 금액(만원) — 매매가−전세가
    n_trend = int(j['jeonse_trend_pct'].notna().sum())
    n_mdd = int(j['jeonse_mdd_pct'].notna().sum())
    n_cyc = int(j['jeonse_ratio_now_pctile'].notna().sum())
    print(f'  전세가율 계산: {len(j)}개 단지 (중앙값 {j["jeonse_ratio"].median():.1%}, '
          f'추세36M {n_trend} · 전세MDD {n_mdd} · 사이클 {n_cyc}개)')
    return j[['district_name', 'apt_name', 'jeonse_ratio', 'jeonse_median', 'jeonse_count',
              'jeonse_trend_pct', 'jeonse_gap', 'jeonse_mdd_pct', 'jeonse_ratio_now_pctile']]

print('=== 4b. 전세가율 ===')
jeonse = compute_jeonse_ratio(monthly)

# ── 5. 종합 점수 ──────────────────────────────────────────────
print('=== 5. 종합 점수 계산 ===')
# 유동성 축의 '회전율' 계산에 쓸 추정세대수 (전 평형 거래 기준, preprocessor와 동일 로직)
from src.preprocessor import _estimate_households
households = _estimate_households(df)
score_df = compute_composite_score(mdd_df, monthly, households, jeonse)
weights_used = dict(score_df.attrs.get('weights_used', {}))   # rename 전에 보존
score_df = score_df.rename(columns={'district_name': 'district'})
# mdd 컬럼 추가 (dashboard.js에서 a.mdd 참조)
if 'mdd_pct' in score_df.columns and 'mdd' not in score_df.columns:
    score_df['mdd'] = score_df['mdd_pct']

# 데이터 신뢰도 배지: 59㎡ 대표평형 관측이 얇은 단지는 점수의 불확실성이 크다는
# 것을 사용자에게 정직하게 표시 (high=충분 / mid=보통 / low=주의)
def _confidence(r):
    am = r.get('active_months') or 0
    tt = r.get('total_trades') or 0
    if am >= 24 and tt >= 40:
        return 'high'
    if am < 12 or tt < 15:
        return 'low'
    return 'mid'
score_df['data_confidence'] = score_df.apply(_confidence, axis=1)
print('  데이터 신뢰도:', score_df['data_confidence'].value_counts().to_dict())

# 구내 상대 평단가: 서울 전체 percentile(입지프리미엄 축)은 강남권이 몰표를 받으므로,
# "그 구 안에서 상위 몇 %인지"를 함께 보여줘 동네 안에서의 위상을 알 수 있게 한다.
if 'price_per_m2' in score_df.columns:
    score_df['premium_in_district_top_pct'] = (
        score_df.groupby('district')['price_per_m2']
        .rank(pct=True, ascending=False) * 100
    ).round(0)
print(f'  상위 10:')
print(score_df[['apt_name', 'district', 'composite_score']].head(10).to_string(index=False))

# ── 6. JSON 저장 ──────────────────────────────────────────────
print('=== 6. JSON 저장 ===')

# quality.json
save('quality.json', {
    'total_raw': len(df_raw),
    'total_clean': len(df),
    'total_apts': len(mdd_df),
    'penalty_removed': len(df_raw) - len(df),
    'filter_rate_pct': round((1 - len(df)/len(df_raw))*100, 1),
    'data_source': '국토교통부 실거래가 공개시스템',
    'collection_period': '2020.01 ~ 2026.06',
    'target_districts': list(DISTRICTS.keys()),
    'min_households': MIN_HOUSEHOLDS,
    'smoothing': '3개월 이동 중앙값',
    'outlier_method': 'z-score > 3.0 제거',
    'representative_area': '전용 59㎡ (18평)',
})

# pipeline.json
_mdd_keys = pd.MultiIndex.from_frame(mdd_df[['district_name', 'apt_name']])
stages = [
    {'label': '원본 거래', 'count': len(df_raw), 'desc': 'API 수집 전체'},
    {'label': '필터 후', 'count': len(df), 'desc': '벌점 5점 미만'},
    {'label': f'{MIN_HOUSEHOLDS}세대+', 'count': len(df[pd.MultiIndex.from_frame(df[['district_name', 'apt_name']]).isin(_mdd_keys)]),
     'desc': '대단지 기준 (대장아파트 일부 예외 포함)'},
]
penalty_rules = [
    {'rule': '1층', 'score': 2, 'reason': '1층 거래는 시세보다 낮아 가격 왜곡 가능'},
    {'rule': '직거래', 'score': 3, 'reason': '직거래는 비정상 가격 포함 가능성'},
    {'rule': '이상치(z>3)', 'score': 2, 'reason': '통계적 이상 거래'},
    {'rule': '결측', 'score': 2, 'reason': '핵심 필드 누락'},
]
save('pipeline.json', {'stages': stages, 'penalty_rules': penalty_rules, 'apt_counts': {}})

# mdd_ranking.json
mdd_out = mdd_df.rename(columns={'district_name': 'district', 'mdd_pct': 'mdd'})
_trades_by_key = df.groupby(['district_name', 'apt_name']).size()
mdd_out['total_trades'] = mdd_out.apply(
    lambda r: _trades_by_key.get((r['district'], r['apt_name']), 0), axis=1
)
save('mdd_ranking.json', {'ranking': mdd_out.sort_values('mdd', ascending=False).to_dict('records')})

# composite_score.json
# 실제로 사용된(재정규화된) 가중치를 그대로 반영 — 축 활성 여부에 따라 달라진다.
from src.scorer import AXIS_KR
weights = {AXIS_KR.get(k, k): round(v, 4) for k, v in weights_used.items()}
# 네이버 검색 정확도용 법정동(洞) 병합 (apt_locations 캐시가 있으면)
_locpath = Path('data/static/apt_locations.json')
if _locpath.exists():
    _loc = json.loads(_locpath.read_text(encoding='utf-8'))
    def _locget(r, k):
        return (_loc.get(f"{r['district']}|{r['apt_name']}") or {}).get(k)
    score_df['dong'] = score_df.apply(lambda r: _locget(r, 'dong'), axis=1)
    score_df['lat'] = score_df.apply(lambda r: _locget(r, 'lat'), axis=1)
    score_df['lng'] = score_df.apply(lambda r: _locget(r, 'lng'), axis=1)
save('composite_score.json', {'ranking': score_df.to_dict('records'), 'weights': weights})

# jeonse.json — 전세 합리성 점수 (매매 종합점수의 전세 버전, v2 5축)
from src.jeonse_scorer import compute_jeonse_score, JEONSE_AXIS_KR
jscore_df, jweights = compute_jeonse_score(score_df, households)   # 회전율용 세대수 전달
if not jscore_df.empty:
    # 지도용 좌표 병합 (apt_locations 캐시)
    if _locpath.exists():
        jscore_df['lat'] = jscore_df.apply(lambda r: _locget(r, 'lat'), axis=1)
        jscore_df['lng'] = jscore_df.apply(lambda r: _locget(r, 'lng'), axis=1)
        jscore_df['dong'] = jscore_df.apply(lambda r: _locget(r, 'dong'), axis=1)
    keep = ['jeonse_rank', 'district', 'apt_name', 'jeonse_total', 'composite_score',
            'axis_value', 'axis_cheap', 'axis_safety', 'axis_stability', 'axis_timing', 'axis_liquidity',
            'living_quality', 'jeonse_turnover', 'jeonse_mdd_pct', 'jeonse_ratio_now_pctile',
            'jeonse_median', 'jeonse_ppm', 'jeonse_ratio', 'jeonse_gap', 'jeonse_count',
            'jeonse_trend_pct', 'jeonse_ppm_district_top_pct', 'area_exclusive',
            'build_year', 'lat', 'lng', 'dong', 'data_confidence',
            # 근거 문구·맞춤 적합도용 — 교통·학군·역세권 + 보증금 안전 서브지표
            'transit_score', 'school_score', 'academy_within_1km', 'stations_within_1km',
            'nearest_station', 'walk_min', 'hub_score', 'hub_min_km', 'hub_nearest_name',
            'defense_score', 'price_vol_annual', 'mdd']
    keep = [c for c in keep if c in jscore_df.columns]
    jweights_kr = {JEONSE_AXIS_KR.get(k, k): round(v, 3) for k, v in jweights.items()}
    save('jeonse.json', {
        'ranking': jscore_df[keep].to_dict('records'),
        'weights': jweights_kr,
        'total_apts': len(jscore_df),
    })
else:
    print('  (전세 데이터 없음 — jeonse.json 생략)')

# timeseries.json
# ⚠️ "현대"·"삼성"처럼 여러 구에 겹치는 단지명이 있어 district까지 함께 키로 써야
# 서로 다른 단지의 시계열이 하나로 합쳐지지 않는다.
apt_list = []
for (district_name, apt_name), grp in monthly.groupby(['district_name', 'apt_name']):
    g = grp.sort_values('deal_date')
    # median=스무딩 가격(라인용), raw=해당 월 실제 중앙 거래가, vol=월 거래 건수(거래량 바용)
    records = g[['deal_date', 'smoothed_price', 'median_price', 'trade_count']].rename(
        columns={'deal_date': 'ym', 'smoothed_price': 'median', 'median_price': 'raw', 'trade_count': 'vol'}
    ).to_dict('records')
    for r in records:
        r['ym'] = str(r['ym'])
        r['vol'] = int(r['vol']) if r['vol'] == r['vol'] else 0
        r['raw'] = round(float(r['raw'])) if r['raw'] == r['raw'] else None
    apt_list.append({'district': district_name, 'apt_name': apt_name, 'monthly': records})
save('timeseries.json', {'apartments': apt_list})

# traits.json
save('traits.json', traits if isinstance(traits, dict) else {})

# trades.json — 단지별 최근 실거래 내역 (상세 페이지 raw data 조회용)
analyzed = set(zip(score_df['district'], score_df['apt_name']))
tr = df[df.apply(lambda r: (r['district_name'], r['apt_name']) in analyzed, axis=1)].copy()
tr = tr.sort_values('deal_date', ascending=False)
trades = {}
for (dist, apt), grp in tr.groupby(['district_name', 'apt_name'], observed=True):
    recent = grp.head(60)
    trades[f'{dist}|{apt}'] = [
        {
            'ym': str(r['deal_date']),
            'day': int(r['deal_day']) if str(r['deal_day']).strip().isdigit() else None,
            'price': int(r['deal_amount']),
            'floor': int(r['floor']) if str(r['floor']).strip().lstrip('-').isdigit() else None,
            'area': round(float(r['area_exclusive']), 2),
        }
        for _, r in recent.iterrows()
    ]
save('trades.json', trades)

# district_info.json: 가격대·has_data를 실데이터로 갱신
info_path = OUT / 'district_info.json'
if info_path.exists():
    info = json.loads(info_path.read_text(encoding='utf-8'))
    latest_by_key = {}
    for a in apt_list:
        if a['monthly']:
            latest_by_key[(a['district'], a['apt_name'])] = a['monthly'][-1]['median']
    by_dist = {}
    for _, r in score_df.iterrows():
        p = latest_by_key.get((r['district'], r['apt_name']))
        if p:
            by_dist.setdefault(r['district'], []).append(p / 10000)
    for name, meta in info.items():
        prices = by_dist.get(name)
        meta['has_data'] = bool(prices)
        if prices:
            meta['price_low'] = round(min(prices))
            meta['price_high'] = round(max(prices))
    info_path.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding='utf-8')
    print('  갱신: district_info.json (실거래 최신가 기반 가격대)')

print()
print('=== 완료 ===')
print(f'분석 구: {sorted(score_df["district"].unique())}')
print(f'총 단지: {len(score_df)}개')
