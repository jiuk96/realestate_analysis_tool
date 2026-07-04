"""
종합 입지 점수 산출 모듈 — 전 축 실거래 데이터 기반
─────────────────────────────────────────────────────
축                   비중   산출 근거
① 가격 방어력        25%  - 하락장 MDD(60%) + 회복률(40%, 신고가 가점)
② 거래 유동성        20%  - 거래 공백률 + 하락기 유지율 + 변동계수
③ 상승 참여도        15%  - 상승기 수익률
④ 회복 모멘텀        15%  - 최근 12개월 가격 추세 (연율화)
⑤ 입지 프리미엄      15%  - m²당 고점가 percentile (시장가에 내재된 입지가치)
⑥ 규모·연식         10%  - 거래규모(대단지 프리미엄) + 준공연도

data/static/apt_locations.json (geocode_apts.py로 생성) 캐시가 있으면
⑦ 교통 접근성 10%가 활성화되고 비중이 재배분됨:
   방어 25 / 유동성 20 / 상승 15 / 모멘텀 12 / 프리미엄 10 / 규모 8 / 교통 10

정규화: percentile-rank (이상치에 견고). 각 축 0~100.
"""

import json
import logging
import numpy as np
import pandas as pd

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
import config

log = logging.getLogger(__name__)

# ── 축별 기본 가중치(상대적 중요도) ──────────────────────────
# 데이터가 있어야만 활성화되는 축(교통·전세가율)이 있으므로, 실제 계산 시에는
# "있는 축만" 남겨 합이 1이 되도록 재정규화한다(compute_composite_score).
# 이렇게 하면 축을 추가/제거해도 나머지 비중이 자동으로 맞춰진다.
AXIS_WEIGHTS = {
    "defense":   0.20,   # 가격 방어력 (하락장 MDD + 회복 + 안정성)
    "jeonse":    0.09,   # 전세가율 (하방 지지력 — 전세 데이터 있을 때만)
    "liquidity": 0.16,   # 거래 유동성 (꾸준함 + 회전율) — 규모 축 통합분 반영
    "upside":    0.10,   # 상승 참여도
    "momentum":  0.10,   # 회복 모멘텀
    "premium":   0.09,   # 입지 프리미엄 (최신가 기준 평단가)
    "transit":   0.08,   # 교통 접근성 (지하철 실측 좌표 있을 때만)
    "hub":       0.07,   # 직주근접 (3대 업무지구 최단거리 — 좌표 있을 때만)
    "school":    0.05,   # 학군 (초품아+학원가 프록시 — 학교 데이터 있을 때만)
    "redevelop": 0.06,   # 재건축 잠재력 (준공연도 기반)
}
# ⚠️ '규모' 축은 제거됨 — 유동성 축과 스피어만 +0.79로 같은 신호(거래건수)에
# 이중 가중을 주고 있었다. 규모 정보는 회전율(거래÷세대수)로 유동성에 이미 반영.

# 각 축 점수 컬럼명 (fillna 기본값과 함께 사용)
AXIS_SCORE_COL = {
    "defense": "defense_score", "jeonse": "jeonse_score", "liquidity": "liquidity_score",
    "upside": "upside_score", "momentum": "momentum_score", "premium": "premium_score",
    "transit": "transit_score", "hub": "hub_score", "school": "school_score",
    "redevelop": "redevelop_score",
}

# 한글 라벨 (composite_score.json weights 표시용)
AXIS_KR = {
    "defense": "가격방어력", "jeonse": "전세가율", "liquidity": "거래유동성",
    "upside": "상승참여도", "momentum": "회복모멘텀", "premium": "입지프리미엄",
    "transit": "교통", "hub": "직주근접", "school": "학군",
    "redevelop": "재건축잠재력",
}

# 하위호환용(기존 build_data가 import) — 전세·교통 없는 기본 구성
WEIGHTS = {k: v for k, v in AXIS_WEIGHTS.items() if k not in ("transit", "jeonse")}
WEIGHTS_TRANSIT = {k: v for k, v in AXIS_WEIGHTS.items() if k != "jeonse"}

TRANSIT_CACHE = Path(__file__).parent.parent / "data" / "static" / "apt_locations.json"
SCHOOLS_CACHE = Path(__file__).parent.parent / "data" / "static" / "schools.json"
WALK_M_PER_MIN = 67   # 성인 평균 보속 약 4km/h


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """두 좌표 간 직선거리(km). geocode_apts.haversine_m과 동일 공식."""
    R = 6371.0
    p1, p2 = np.radians(lat1), np.radians(lat2)
    dp = np.radians(lat2 - lat1)
    dl = np.radians(lng2 - lng1)
    a = np.sin(dp / 2) ** 2 + np.cos(p1) * np.cos(p2) * np.sin(dl / 2) ** 2
    return R * 2 * np.arcsin(np.sqrt(a))

# 재건축 판단 기준 연도 (준공 후 30년이 재건축 안전진단 연한)
CURRENT_YEAR = 2026
REDEV_LEGAL_AGE = 30


def _pct_rank(s: pd.Series, low_is_good: bool = False) -> pd.Series:
    """percentile-rank 정규화 → 0~100. 이상치가 스케일을 왜곡하지 않음."""
    if s.nunique() <= 1:
        return pd.Series([50.0] * len(s), index=s.index)
    r = s.rank(pct=True) * 100
    return 100 - r if low_is_good else r


# ── ① 가격 방어력 ─────────────────────────────────────────────

def _price_defense(mdd_df: pd.DataFrame, monthly: pd.DataFrame) -> pd.DataFrame:
    """
    MDD(50%) + 회복률(30%) + 가격 안정성(20%, 연율화 변동성 낮을수록 좋음).
    회복률 = (최신가 - trough) / (peak - trough)
    1.0 초과(신고가 갱신)는 1.2까지 인정해 완전회복 단지에 가점.

    ⚠️ 생존 편향 보정: 2022~2023 하락장을 데이터로 겪지 않은 단지(2024년 이후
    첫 거래된 신축 등)는 MDD가 0%로 잡혀도 "방어력이 좋다"는 근거가 될 수 없다.
    이런 단지는 방어력 점수를 중립(50)으로 처리해, 하락을 실제로 견뎌낸 단지와
    구분한다(downturn_experienced 플래그, analyzer.detect_peak_trough에서 계산).
    """
    latest = (
        monthly.sort_values("deal_date")
        .groupby(["district_name", "apt_name"], observed=True)
        .last()
        .reset_index()[["district_name", "apt_name", "smoothed_price"]]
        .rename(columns={"smoothed_price": "latest_price"})
    )
    df = mdd_df.merge(latest, on=["district_name", "apt_name"], how="left")

    spread = df["peak_price"] - df["trough_price"]
    df["recovery_rate"] = np.where(
        spread > 0,
        ((df["latest_price"] - df["trough_price"]) / spread).clip(0, 1.2),
        0.5,
    )

    # 가격 안정성(연율화 변동성): 월간 수익률 std × √12.
    # MDD는 "최악의 한 번"만 보지만, 변동성은 "평소에 얼마나 출렁이는가"를 잡는다 —
    # 같은 MDD라도 평소 변동이 작은 단지가 실거주자에게 심리적·재무적으로 안전하다.
    vol_rows = []
    for (d, a), grp in monthly.sort_values("deal_date").groupby(["district_name", "apt_name"], observed=True):
        ret = grp["smoothed_price"].pct_change().dropna()
        vol = float(ret.std() * np.sqrt(12)) if len(ret) >= 5 else np.nan
        vol_rows.append({"district_name": d, "apt_name": a, "price_vol_annual": vol})
    df = df.merge(pd.DataFrame(vol_rows), on=["district_name", "apt_name"], how="left")

    df["score_mdd"]      = _pct_rank(df["mdd_pct"], low_is_good=False)  # mdd_pct는 음수, 0에 가까울수록(클수록) 우수
    df["score_recovery"] = _pct_rank(df["recovery_rate"])
    # 변동성 결측(관측 부족)은 중립 50 — 다른 단지와의 비교에서 불이익 없도록
    df["score_vol"]      = _pct_rank(df["price_vol_annual"], low_is_good=True).fillna(50.0)

    # MDD 50% + 회복률 30% + 가격 안정성 20%
    df["defense_score"] = df["score_mdd"] * 0.5 + df["score_recovery"] * 0.3 + df["score_vol"] * 0.2

    # 하락장 미경험 단지의 "가짜 0% MDD"만 중립(50) 처리한다.
    # 단, 실제로 유의미한 하락(예: -5% 초과)을 데이터에서 보인 단지는 그 하락이
    # 진짜 방어력 증거이므로 (설령 표준 하락장 창과 어긋나더라도) 점수를 유지한다.
    # → 조건: 하락장 미경험 AND MDD가 거의 평평(> -5%)  ⇒ 검증되지 않은 것으로 보고 중립.
    if "downturn_experienced" in df.columns:
        untested_flat = (~df["downturn_experienced"].fillna(True).astype(bool)) & (df["mdd_pct"] > -5.0)
        n_neutral = int(untested_flat.sum())
        df.loc[untested_flat, "defense_score"] = 50.0
        if n_neutral:
            log.info(f"방어력 중립 처리(하락장 미경험 + MDD 평탄): {n_neutral}개 단지")

    return df[["district_name", "apt_name", "defense_score", "mdd_pct", "recovery_rate", "price_vol_annual"]]


# ── ② 거래 유동성 ─────────────────────────────────────────────

def _liquidity(monthly: pd.DataFrame, households: pd.DataFrame | None = None) -> pd.DataFrame:
    """
    A. 거래 공백률 (30%) : 전체 기간 중 거래 없는 달 비율 → 낮을수록 좋음 (꾸준함)
    B. 하락기 유지율 (25%): 하락기 월평균 거래 / 상승기 월평균 거래
    C. 변동계수 (20%)     : 거래량 std/mean → 낮을수록 꾸준함
    D. 회전율 (25%)       : 연간 거래건수 ÷ 추정세대수 → 규모 대비 얼마나 활발히
                           거래되는지(거래 '강도'). 공백률·유지율·변동계수는 모두
                           '꾸준함'만 보고 '강도'를 못 잡는다 — 매달 1건이든 10건이든
                           공백률은 만점이라, 매물이 자주 나와 빨리 팔리는 진짜
                           환금성이 반영되지 않았다. households가 없으면 이 축은
                           생략하고 나머지 3개 비중을 재정규화한다.
    """
    all_periods = pd.period_range(
        start=config.START_YEAR_MONTH, end=config.END_YEAR_MONTH, freq="M"
    )
    total_months = len(all_periods)
    span_years = total_months / 12.0

    rise_start = pd.Period(config.PEAK_START,   freq="M")
    rise_end   = pd.Period(config.PEAK_END,     freq="M")
    fall_start = pd.Period(config.TROUGH_START, freq="M")
    fall_end   = pd.Period(config.TROUGH_END,   freq="M")

    hh_map = {}
    if households is not None and not households.empty:
        hh_map = {(r["district_name"], r["apt_name"]): r["est_households"]
                  for _, r in households.iterrows()}

    rows = []
    for (district_name, apt_name), grp in monthly.groupby(["district_name", "apt_name"], observed=True):
        active_months = grp["deal_date"].nunique()
        gap_ratio = 1 - (active_months / total_months)

        rise_tc = grp[(grp["deal_date"] >= rise_start) & (grp["deal_date"] <= rise_end)]["trade_count"].mean()
        fall_tc = grp[(grp["deal_date"] >= fall_start) & (grp["deal_date"] <= fall_end)]["trade_count"].mean()
        if pd.isna(rise_tc) or rise_tc == 0:
            retention = 0.5
        else:
            retention = min(float(fall_tc if not pd.isna(fall_tc) else 0) / rise_tc, 1.5)

        tc_mean = grp["trade_count"].mean()
        tc_std  = grp["trade_count"].std()
        cv = (tc_std / tc_mean) if tc_mean > 0 else 1.0

        # 회전율: (연평균 59㎡ 거래건수) / 추정세대수.  세대수 추정치가 없으면 NaN.
        total_trades = grp["trade_count"].sum()
        hh = hh_map.get((district_name, apt_name))
        turnover = (total_trades / span_years) / hh if hh and hh > 0 else np.nan

        rows.append({
            "district_name": district_name,
            "apt_name": apt_name,
            "gap_ratio": gap_ratio,
            "retention": retention,
            "cv": cv,
            "turnover": turnover,
            "active_months": active_months,
        })

    lq = pd.DataFrame(rows)
    if lq.empty:
        return lq

    base = (
        _pct_rank(lq["gap_ratio"], low_is_good=True) * 0.30 +
        _pct_rank(lq["retention"])                   * 0.25 +
        _pct_rank(lq["cv"], low_is_good=True)        * 0.20
    )
    if lq["turnover"].notna().any():
        # 회전율 결측 단지는 중립(50)으로 채워 다른 축만으로 불이익받지 않게 함
        turnover_score = _pct_rank(lq["turnover"]).fillna(50.0)
        lq["liquidity_score"] = base + turnover_score * 0.25
    else:
        # 회전율을 전혀 못 구하면(세대수 정보 없음) 3개 축을 100%로 재정규화
        lq["liquidity_score"] = base / 0.75
    return lq[["district_name", "apt_name", "liquidity_score", "gap_ratio", "retention", "cv", "turnover", "active_months"]]


# ── ②b 전세가율 (하방 지지력) ─────────────────────────────────

def _jeonse_support(jeonse: pd.DataFrame | None) -> pd.DataFrame | None:
    """
    전세가율 수준(70%) + 전세가 추세(30%).
    - 수준: 전세 중앙값 / 매매 중앙값 (전용 59㎡). 높을수록 실거주 수요가
      시세를 떠받쳐 하락기 방어력이 강하다('하방 지지선').
    - 추세: 월별 전세 중앙값의 Theil-Sen 연율화 기울기(%). 전세는 투기 수요가
      없는 순수 실수요 가격이라, 전세가 오르는 단지는 지지선 자체가 올라가는
      중이라는 선행 신호다.
    build_data에서 전월세 실거래로 계산한 df를 받는다. 없으면 None(축 비활성).

    입력 컬럼: district_name, apt_name, jeonse_ratio (0~1), jeonse_median(만원),
              jeonse_count, jeonse_trend_pct(연율 %, 결측 가능), jeonse_gap(만원)
    """
    if jeonse is None or jeonse.empty:
        return None
    df = jeonse.copy()
    # 전세가율은 보통 0.4~0.9. 이상치(1.0 초과 등 데이터 오류)는 상한 클립.
    df["jeonse_ratio"] = df["jeonse_ratio"].clip(0, 1.0)
    level_score = _pct_rank(df["jeonse_ratio"])
    if "jeonse_trend_pct" in df.columns and df["jeonse_trend_pct"].notna().any():
        trend = pd.to_numeric(df["jeonse_trend_pct"], errors="coerce")
        # 추세 결측(관측 부족)은 중립 50 — 수준 점수만으로 평가되게 함
        trend_score = _pct_rank(trend).fillna(50.0)
        df["jeonse_score"] = level_score * 0.7 + trend_score * 0.3
    else:
        df["jeonse_score"] = level_score
    log.info(f"전세가율 축 활성: {len(df)}개 단지")
    cols = ["district_name", "apt_name", "jeonse_score", "jeonse_ratio", "jeonse_median", "jeonse_count"]
    for extra in ("jeonse_trend_pct", "jeonse_gap"):
        if extra in df.columns:
            cols.append(extra)
    return df[cols]


# ── ③ 상승 참여도 ─────────────────────────────────────────────

def _upside_participation(mdd_df: pd.DataFrame, monthly: pd.DataFrame) -> pd.DataFrame:
    """상승기 수익률 = (peak - 2020년 초 기저가) / 기저가"""
    base_window = pd.Period(
        str(int(config.START_YEAR_MONTH[:4]) + 1) + config.START_YEAR_MONTH[4:],
        freq="M"
    )

    rows = []
    for (district_name, apt_name), grp in monthly.groupby(["district_name", "apt_name"], observed=True):
        grp = grp.sort_values("deal_date")

        base_data = grp[grp["deal_date"] <= base_window]["smoothed_price"]
        base_price = base_data.median() if len(base_data) >= 1 else grp["smoothed_price"].iloc[0]

        mdd_row = mdd_df[(mdd_df["district_name"] == district_name) & (mdd_df["apt_name"] == apt_name)]
        peak_price = mdd_row["peak_price"].iloc[0] if not mdd_row.empty else grp["smoothed_price"].max()

        upside_pct = (peak_price - base_price) / base_price * 100 if base_price > 0 else 0
        rows.append({"district_name": district_name, "apt_name": apt_name, "upside_pct": upside_pct})

    up = pd.DataFrame(rows)
    if up.empty:
        return up
    up["upside_score"] = _pct_rank(up["upside_pct"])
    return up[["district_name", "apt_name", "upside_score", "upside_pct"]]


# ── ④ 회복 모멘텀 ─────────────────────────────────────────────

def _theil_sen_slope(x: np.ndarray, y: np.ndarray) -> float:
    """Theil-Sen 기울기: 모든 점 쌍의 기울기 중앙값.
    OLS(polyfit)는 관측이 적을 때 이상거래 한 달에 기울기가 통째로 끌려가지만,
    중앙값 기반이라 최대 29%의 이상치까지 견딘다(모멘텀의 강건성 확보)."""
    slopes = []
    n = len(x)
    for i in range(n):
        for j in range(i + 1, n):
            if x[j] != x[i]:
                slopes.append((y[j] - y[i]) / (x[j] - x[i]))
    return float(np.median(slopes)) if slopes else 0.0


def _recovery_momentum(monthly: pd.DataFrame) -> pd.DataFrame:
    """
    최근 12개월(데이터 마지막 시점 기준) 스무딩 가격의 추세.
    연율화 기울기(%/년) = slope × 12 / 평균가 × 100.
    하락 후 다시 오르는 단지와 바닥에 머무는 단지를 구분.

    강건화: ① 관측 6개월 미만이면 판단 보류가 아니라 먼저 윈도우를 18개월로
    넓혀 재시도한다(저유동 단지 구제 — 표본의 23%가 중립 처리되던 것을 축소).
    18개월로도 6개 미만이면 그때 중립(중앙값) 처리.
    ② OLS 대신 Theil-Sen(쌍별 기울기의 중앙값)을 사용해 이상거래 한 달이
    추세 전체를 왜곡하지 못하게 한다.
    """
    end = monthly["deal_date"].max()
    MIN_OBS = 6
    WINDOWS = (12, 18)   # 순서대로 시도

    rows = []
    for (district_name, apt_name), grp in monthly.groupby(["district_name", "apt_name"], observed=True):
        momentum_pct = np.nan
        for win in WINDOWS:
            start = end - (win - 1)
            w = grp[(grp["deal_date"] >= start)].sort_values("deal_date")
            if len(w) < MIN_OBS:
                continue
            x = (w["deal_date"] - start).apply(lambda p: p.n).to_numpy(dtype=float)
            y = w["smoothed_price"].to_numpy(dtype=float)
            slope = _theil_sen_slope(x, y)           # 원/월
            mean_price = y.mean()
            momentum_pct = round(slope * 12 / mean_price * 100, 2) if mean_price > 0 else 0.0
            break
        rows.append({"district_name": district_name, "apt_name": apt_name, "momentum_pct": momentum_pct})

    mo = pd.DataFrame(rows)
    if mo.empty:
        return mo
    n_neutral = int(mo["momentum_pct"].isna().sum())
    if n_neutral:
        log.info(f"모멘텀 중립 처리(12→18개월 확장에도 관측 {MIN_OBS}개월 미만): {n_neutral}개 단지")
    # 데이터 부족 단지는 중립(중앙값)으로
    mo["momentum_pct"] = mo["momentum_pct"].fillna(mo["momentum_pct"].median())
    mo["momentum_score"] = _pct_rank(mo["momentum_pct"])
    return mo[["district_name", "apt_name", "momentum_score", "momentum_pct"]]


# ── ⑤ 입지 프리미엄 ───────────────────────────────────────────

def _location_premium(mdd_df: pd.DataFrame, monthly: pd.DataFrame) -> pd.DataFrame:
    """
    주력 면적 m²당 '최신가' percentile.
    교통·학군·인프라 가치는 시장가격에 이미 반영되어 있으므로(헤도닉 원리)
    단위면적당 가격이 가장 객관적인 입지 지표.

    ⚠️ 예전엔 고점가(peak_price) 기준이었는데, 감사 결과 고점 시점이 단지마다
    달랐다(323개는 2021년, 21개는 2025~26년 신고가). 서로 다른 시대의 가격을
    한 줄에 세우면 2021년 이후 시장 전체 상승분만큼 비교가 왜곡되므로,
    모든 단지가 같은 시점인 '최신 스무딩가' 기준으로 교체했다.
    """
    latest = (
        monthly.sort_values("deal_date")
        .groupby(["district_name", "apt_name"], observed=True)["smoothed_price"]
        .last().rename("latest_for_premium").reset_index()
    )
    df = mdd_df[["district_name", "apt_name", "area_exclusive"]].merge(
        latest, on=["district_name", "apt_name"], how="left")
    df["price_per_m2"] = df["latest_for_premium"] / df["area_exclusive"]
    df["premium_score"] = _pct_rank(df["price_per_m2"])
    df["price_per_m2"] = df["price_per_m2"].round(1)
    return df[["district_name", "apt_name", "premium_score", "price_per_m2"]]


# ── ⑥ 규모 (거래량) ──────────────────────────────────────────

def _scale(mdd_df: pd.DataFrame, monthly: pd.DataFrame) -> pd.DataFrame:
    """
    총 거래건수 — 정보용으로만 병합하고 더 이상 점수 축으로 쓰지 않는다.
    감사 결과 scale_score와 liquidity_score의 상관이 +0.79로, 같은 신호
    (거래건수)에 사실상 이중 가중을 주고 있었다. 규모 정보는 유동성 축의
    회전율(거래÷세대수)에 이미 정규화되어 들어가므로 별도 축은 제거.
    """
    vol = (
        monthly.groupby(["district_name", "apt_name"], observed=True)["trade_count"]
        .sum()
        .reset_index()
        .rename(columns={"trade_count": "total_trades"})
    )
    df = mdd_df[["district_name", "apt_name"]].merge(vol, on=["district_name", "apt_name"], how="left")
    df["total_trades"] = df["total_trades"].fillna(0)
    return df[["district_name", "apt_name", "total_trades"]]


# ── 재건축 잠재력 (준공연도 기반) ─────────────────────────────

def _redev_score_from_age(age: float) -> float:
    """
    준공 후 경과연수(age) → 재건축 잠재력 0~100.
    재건축 안전진단 연한은 준공 30년. 연한에 가까울수록/넘길수록 높은 점수.
    신축은 재건축과 무관하므로 낮음(신축 상품성은 다른 축에서 평가).
    """
    if age >= 35:   return 100.0   # 재건축 사업 본격 추진 가능 구간
    if age >= 30:   return 90.0    # 안전진단 연한 도래
    if age >= 27:   return 72.0    # 연한 임박
    if age >= 22:   return 52.0    # 중기 (리모델링/향후 재건축)
    if age >= 17:   return 32.0
    if age >= 12:   return 18.0
    return 8.0                     # 신축 — 재건축 무관


def _redevelopment(mdd_df: pd.DataFrame) -> pd.DataFrame:
    """준공연도 → 재건축 잠재력 점수 (절대 기준)."""
    df = mdd_df[["district_name", "apt_name", "build_year"]].copy()
    df["apt_age"] = (CURRENT_YEAR - df["build_year"].astype(float)).clip(lower=0)
    df["redevelop_score"] = df["apt_age"].apply(_redev_score_from_age)
    df["apt_age"] = df["apt_age"].round().astype(int)
    return df[["district_name", "apt_name", "redevelop_score", "apt_age"]]


# ── ⑦ 교통 접근성 (실측, 캐시 있을 때만) ─────────────────────

def _transit_access(mdd_df: pd.DataFrame) -> pd.DataFrame | None:
    """
    geocode_apts.py가 만든 캐시에서 최근접역 거리 → 교통 점수.
    도보 분(80%) + 역세권 밀도(1km 내 역 수, 20%).
    캐시가 없거나 매칭되는 단지가 없으면 None (교통 축 비활성).
    """
    if not TRANSIT_CACHE.exists():
        return None
    cache = json.loads(TRANSIT_CACHE.read_text(encoding="utf-8"))

    rows = []
    for _, r in mdd_df.iterrows():
        e = cache.get(f"{r['district_name']}|{r['apt_name']}")
        if e and e.get("nearest_station_m") is not None:
            rows.append({
                "district_name": r["district_name"],
                "apt_name": r["apt_name"],
                "walk_min": round(e["nearest_station_m"] / WALK_M_PER_MIN, 1),
                "nearest_station": e.get("nearest_station"),
                "nearest_station_m": e["nearest_station_m"],
                "stations_within_1km": e.get("stations_within_1km", 0),
            })
        elif e and e.get("lat"):
            # 좌표는 있으나 반경 1.5km 내 역 없음 → 최저권 취급 (도보 25분)
            rows.append({
                "district_name": r["district_name"],
                "apt_name": r["apt_name"],
                "walk_min": 25.0,
                "nearest_station": None,
                "nearest_station_m": None,
                "stations_within_1km": 0,
            })

    if not rows:
        return None

    tr = pd.DataFrame(rows)
    tr["transit_score"] = (
        _pct_rank(tr["walk_min"], low_is_good=True)   * 0.80 +
        _pct_rank(tr["stations_within_1km"].astype(float)) * 0.20
    )
    log.info(f"교통 축 활성: {len(tr)}/{len(mdd_df)}개 단지 실측 반영")
    return tr[["district_name", "apt_name", "transit_score", "walk_min", "nearest_station", "nearest_station_m", "stations_within_1km"]]


# ── ⑧ 직주근접 (3대 업무지구 최단거리, 좌표 있을 때만) ────────

def _hub_access(mdd_df: pd.DataFrame) -> pd.DataFrame | None:
    """
    각 단지 좌표에서 서울 3대 업무지구(GBD/CBD/YBD)까지 직선거리를 재
    가장 가까운 업무지구까지의 거리를 직주근접 점수로 환산(가까울수록 높음).
    좌표 캐시(apt_locations.json)가 없거나 매칭 단지가 없으면 None(축 비활성).

    실제 서울 집값을 가장 크게 가르는 축이 직주근접이라, '입지프리미엄'(가격에
    내재)과 별개로 물리적 근접성을 명시적으로 반영한다.
    """
    if not TRANSIT_CACHE.exists():
        return None
    cache = json.loads(TRANSIT_CACHE.read_text(encoding="utf-8"))
    hubs = config.BUSINESS_HUBS

    rows = []
    for _, r in mdd_df.iterrows():
        e = cache.get(f"{r['district_name']}|{r['apt_name']}")
        if not (e and e.get("lat") and e.get("lng")):
            continue
        dists = {code: _haversine_km(e["lat"], e["lng"], h["lat"], h["lng"])
                 for code, h in hubs.items()}
        nearest = min(dists, key=dists.get)
        rows.append({
            "district_name": r["district_name"],
            "apt_name": r["apt_name"],
            "hub_min_km": round(dists[nearest], 1),
            "hub_nearest": nearest,
            "hub_nearest_name": hubs[nearest]["name"],
            "hub_gbd_km": round(dists["GBD"], 1),
            "hub_cbd_km": round(dists["CBD"], 1),
            "hub_ybd_km": round(dists["YBD"], 1),
        })

    if not rows:
        return None
    hb = pd.DataFrame(rows)
    hb["hub_score"] = _pct_rank(hb["hub_min_km"], low_is_good=True)
    log.info(f"직주근접 축 활성: {len(hb)}/{len(mdd_df)}개 단지 (3대 업무지구 최단거리)")
    return hb[["district_name", "apt_name", "hub_score", "hub_min_km", "hub_nearest",
               "hub_nearest_name", "hub_gbd_km", "hub_cbd_km", "hub_ybd_km"]]


# ── ⑨ 학군 (초품아 + 학원가 밀집도, 공개 데이터 프록시) ───────

def _school(mdd_df: pd.DataFrame) -> pd.DataFrame | None:
    """
    공개 데이터로 얻을 수 있는 두 프록시로 학군 매력을 근사한다:
      ① 초품아: 가장 가까운 초등학교 직선거리(가까울수록 좋음, 50%)
      ② 학원가 밀집도: 반경 1km 내 학원 수(많을수록 좋음, 50%)
    schools.json(collect_schools.py가 Overpass에서 수집)과 좌표 캐시가
    모두 있어야 활성화된다. 없으면 None(축 비활성).

    ⚠️ 학업성취도·특목고 진학률·명문중 배정 데이터는 비공개라 반영 불가.
    "초등학교 근접 + 학원가 밀집"이라는 정량 프록시일 뿐, 학군 우열을
    단정하지 않는다(UI에도 그대로 고지).
    """
    if not (SCHOOLS_CACHE.exists() and TRANSIT_CACHE.exists()):
        return None
    schools = json.loads(SCHOOLS_CACHE.read_text(encoding="utf-8"))
    elem = schools.get("elementary", [])
    academy = schools.get("academy", [])
    if not elem:
        return None
    cache = json.loads(TRANSIT_CACHE.read_text(encoding="utf-8"))

    elem_lat = np.array([s["lat"] for s in elem], dtype=float)
    elem_lng = np.array([s["lng"] for s in elem], dtype=float)
    aca_lat = np.array([s["lat"] for s in academy], dtype=float) if academy else np.array([])
    aca_lng = np.array([s["lng"] for s in academy], dtype=float) if academy else np.array([])
    radius_km = config.SCHOOL_ACADEMY_RADIUS_M / 1000.0
    cap_m = config.SCHOOL_ELEM_CAP_M

    rows = []
    for _, r in mdd_df.iterrows():
        e = cache.get(f"{r['district_name']}|{r['apt_name']}")
        if not (e and e.get("lat") and e.get("lng")):
            continue
        lat, lng = e["lat"], e["lng"]
        ed = _haversine_km(lat, lng, elem_lat, elem_lng)
        nearest_elem_m = int(min(ed.min() * 1000, cap_m))
        if len(aca_lat):
            ad = _haversine_km(lat, lng, aca_lat, aca_lng)
            academy_cnt = int((ad <= radius_km).sum())
        else:
            academy_cnt = 0
        rows.append({
            "district_name": r["district_name"],
            "apt_name": r["apt_name"],
            "nearest_elem_m": nearest_elem_m,
            "academy_within_1km": academy_cnt,
        })

    if not rows:
        return None
    sk = pd.DataFrame(rows)
    elem_score = _pct_rank(sk["nearest_elem_m"], low_is_good=True)        # 가까울수록 ↑
    aca_score = _pct_rank(sk["academy_within_1km"].astype(float))         # 많을수록 ↑
    sk["school_score"] = elem_score * 0.5 + aca_score * 0.5
    log.info(f"학군 축 활성: {len(sk)}/{len(mdd_df)}개 단지 (초품아+학원가 프록시)")
    return sk[["district_name", "apt_name", "school_score", "nearest_elem_m", "academy_within_1km"]]


# ── 종합 점수 합산 ────────────────────────────────────────────

def compute_composite_score(
    mdd_df: pd.DataFrame,
    monthly: pd.DataFrame,
    households: pd.DataFrame | None = None,
    jeonse: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """
    종합 입지 점수 계산 (0~100).
    데이터가 있어야만 활성화되는 축(교통·전세가율)은 있을 때만 포함되고,
    포함된 축들의 가중치는 합이 1이 되도록 자동 재정규화된다.
    """
    dfn = _price_defense(mdd_df, monthly)
    lq  = _liquidity(monthly, households)
    ups = _upside_participation(mdd_df, monthly)
    mo  = _recovery_momentum(monthly)
    pr  = _location_premium(mdd_df, monthly)
    sc  = _scale(mdd_df, monthly)
    rd  = _redevelopment(mdd_df)
    tr  = _transit_access(mdd_df)
    hb  = _hub_access(mdd_df)
    sk  = _school(mdd_df)
    je  = _jeonse_support(jeonse)

    base_cols = ["apt_name", "district_name", "build_year", "area_exclusive"]
    if "downturn_experienced" in mdd_df.columns:
        base_cols.append("downturn_experienced")
    df = mdd_df[base_cols].copy()
    parts = [dfn, lq, ups, mo, pr, sc, rd]
    if tr is not None:
        parts.append(tr)
    if hb is not None:
        parts.append(hb)
    if sk is not None:
        parts.append(sk)
    if je is not None:
        parts.append(je)
    for part in parts:
        df = df.merge(part, on=["district_name", "apt_name"], how="left")

    # 실제 계산에 쓸 축 = 점수 컬럼이 존재하는 축만. 가중치를 그 축들로 재정규화.
    active_axes = [ax for ax, col in AXIS_SCORE_COL.items() if col in df.columns]
    wsum = sum(AXIS_WEIGHTS[ax] for ax in active_axes)
    weights = {ax: AXIS_WEIGHTS[ax] / wsum for ax in active_axes}

    # 재건축은 데이터가 항상 있으나 결측 시 20(신축 취급), 나머지는 결측 시 50(중립)
    fill_default = {ax: (20.0 if ax == "redevelop" else 50.0) for ax in active_axes}

    df["composite_score"] = 0.0
    for ax in active_axes:
        col = AXIS_SCORE_COL[ax]
        df["composite_score"] += df[col].fillna(fill_default[ax]) * weights[ax]

    df.attrs["weights_used"] = weights

    df = df.sort_values("composite_score", ascending=False).reset_index(drop=True)
    df["rank"] = df.index + 1

    log.info(f"종합 점수 계산 완료: {len(df)}개 단지 (활성 축 {len(active_axes)}개: {active_axes})")
    return df
