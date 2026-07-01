"""
종합 입지 점수 산출 모듈
─────────────────────────────────────────────────────
축                   비중
① 거래 지속성        30%  - 시장 무관 꾸준한 거래 여부
② 가격 방어력        25%  - 하락장 MDD + 회복률
③ 상승 참여도        20%  - 상승기 수익률
④ 교통              12%  - 가장 가까운 지하철 도보 거리
⑤ 인프라             8%  - 편의시설(마트·병원·공원) 밀집도
⑥ 학군               5%  - 초등·중학 배정 품질 + 학원가
"""

import logging
import numpy as np
import pandas as pd

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
import config

log = logging.getLogger(__name__)


# ── 교통/인프라/학군 정적 테이블 ──────────────────────────────
# subway_min : 가장 가까운 지하철역 도보 분
# infra      : 편의시설 밀집도 점수 (1~10)
# school     : 학군 점수 (1~10)
# 키: (apt_name, district_name)

_STATIC_SCORES: dict[tuple[str, str], dict] = {
    # ── 마포구 ─────────────────────────────────────────────────
    ("마포래미안푸르지오4단지", "마포구"): {"subway_min": 4, "infra": 8, "school": 7},
    ("우성",                   "마포구"): {"subway_min": 5, "infra": 7, "school": 6},
    ("현대",                   "마포구"): {"subway_min": 6, "infra": 7, "school": 6},

    # ── 성동구 ─────────────────────────────────────────────────
    ("센트라스",               "성동구"): {"subway_min": 5, "infra": 9, "school": 8},
    ("래미안 옥수 리버젠",     "성동구"): {"subway_min": 3, "infra": 7, "school": 7},
    ("이편한세상금호파크힐스", "성동구"): {"subway_min": 5, "infra": 7, "school": 7},
    ("신금호파크자이",         "성동구"): {"subway_min": 6, "infra": 7, "school": 7},
    ("텐즈힐(1단지)",          "성동구"): {"subway_min": 7, "infra": 8, "school": 7},
    ("행당한진타운",           "성동구"): {"subway_min": 4, "infra": 7, "school": 6},
    ("대림e-편한세상",         "성동구"): {"subway_min": 4, "infra": 7, "school": 6},
    ("서울숲 한신 더 휴",      "성동구"): {"subway_min": 8, "infra": 8, "school": 6},
    ("신동아",                 "성동구"): {"subway_min": 6, "infra": 6, "school": 6},
    ("두산",                   "성동구"): {"subway_min": 5, "infra": 6, "school": 6},
    ("현대",                   "성동구"): {"subway_min": 5, "infra": 7, "school": 6},
    ("벽산",                   "성동구"): {"subway_min": 7, "infra": 6, "school": 6},
    ("우성",                   "성동구"): {"subway_min": 8, "infra": 7, "school": 6},
    ("옥수파크힐스101동~116동","성동구"): {"subway_min": 3, "infra": 7, "school": 7},

    # ── 용산구 ─────────────────────────────────────────────────
    ("한가람",                 "용산구"): {"subway_min": 4, "infra": 8, "school": 8},
    ("신동아",                 "용산구"): {"subway_min": 5, "infra": 7, "school": 7},
    ("우성",                   "용산구"): {"subway_min": 4, "infra": 8, "school": 8},
}

_DEFAULT_STATIC = {"subway_min": 10, "infra": 5, "school": 5}


def _get_static(apt_name: str, district: str) -> dict:
    return _STATIC_SCORES.get((apt_name, district), _DEFAULT_STATIC)


def _subway_score(minutes: float) -> float:
    """도보 분 → 0~10점 (짧을수록 고점)"""
    if minutes <= 3:   return 10.0
    if minutes <= 5:   return 8.5
    if minutes <= 8:   return 7.0
    if minutes <= 12:  return 5.0
    if minutes <= 15:  return 3.0
    return 1.0


# ── ① 거래 지속성 ──────────────────────────────────────────────

def _transaction_consistency(monthly: pd.DataFrame) -> pd.DataFrame:
    """
    단지별 거래 지속성 점수 계산 (0~100).

    지표 3가지 → 동일 가중치로 합산:
    A. 거래 공백률     : 72개월 중 거래 0건 달의 비율 → 낮을수록 좋음
    B. 하락기 거래 유지율: (하락기 월평균) / (상승기 월평균)
    C. 거래량 변동계수  : std/mean → 낮을수록 꾸준함
    """
    # 전체 72개월 범위 (모든 단지 공통 기준)
    all_periods = pd.period_range(
        start=config.START_YEAR_MONTH, end=config.END_YEAR_MONTH, freq="M"
    )
    total_months = len(all_periods)

    # 상승기 / 하락기 정의
    rise_start   = pd.Period(config.PEAK_START,   freq="M")
    rise_end     = pd.Period(config.PEAK_END,     freq="M")
    fall_start   = pd.Period(config.TROUGH_START, freq="M")
    fall_end     = pd.Period(config.TROUGH_END,   freq="M")

    rows = []
    for apt_name, grp in monthly.groupby("apt_name", observed=True):
        grp = grp.sort_values("deal_date")

        # A. 공백률
        active_months = grp["deal_date"].nunique()
        gap_ratio     = 1 - (active_months / total_months)

        # B. 하락기 거래 유지율
        rise_tc = grp[
            (grp["deal_date"] >= rise_start) & (grp["deal_date"] <= rise_end)
        ]["trade_count"].mean()
        fall_tc = grp[
            (grp["deal_date"] >= fall_start) & (grp["deal_date"] <= fall_end)
        ]["trade_count"].mean()
        if pd.isna(rise_tc) or rise_tc == 0:
            retention = 0.5
        else:
            retention = min(float(fall_tc if not pd.isna(fall_tc) else 0) / rise_tc, 1.5)

        # C. 변동계수 (월별 trade_count)
        tc_mean = grp["trade_count"].mean()
        tc_std  = grp["trade_count"].std()
        cv = (tc_std / tc_mean) if tc_mean > 0 else 1.0

        rows.append({
            "apt_name":     apt_name,
            "gap_ratio":    gap_ratio,
            "retention":    retention,
            "cv":           cv,
            "active_months": active_months,
        })

    tc_df = pd.DataFrame(rows)
    if tc_df.empty:
        return tc_df

    # 정규화 → 0~10점
    def _minmax(s, low_is_good=True):
        mn, mx = s.min(), s.max()
        if mx == mn:
            return pd.Series([5.0] * len(s), index=s.index)
        norm = (s - mn) / (mx - mn)
        return (1 - norm) * 10 if low_is_good else norm * 10

    tc_df["score_gap"]       = _minmax(tc_df["gap_ratio"],  low_is_good=True)
    tc_df["score_retention"] = _minmax(tc_df["retention"],  low_is_good=False)
    tc_df["score_cv"]        = _minmax(tc_df["cv"],          low_is_good=True)

    tc_df["consistency_score"] = (
        tc_df["score_gap"]       * 0.40 +
        tc_df["score_retention"] * 0.35 +
        tc_df["score_cv"]        * 0.25
    )
    return tc_df[["apt_name", "consistency_score", "gap_ratio", "retention", "cv", "active_months"]]


# ── ② 가격 방어력 ─────────────────────────────────────────────

def _price_resilience(mdd_df: pd.DataFrame, monthly: pd.DataFrame) -> pd.DataFrame:
    """
    MDD + 회복률 → 0~10점.
    회복률 = (최신가 - trough) / (peak - trough)  클수록 회복 빠름
    """
    # 최신 스무딩 가격
    latest = (
        monthly.sort_values("deal_date")
        .groupby("apt_name", observed=True)
        .last()
        .reset_index()[["apt_name", "smoothed_price"]]
        .rename(columns={"smoothed_price": "latest_price"})
    )
    df = mdd_df.merge(latest, on="apt_name", how="left")

    # 회복률 (0~1 클립)
    spread = df["peak_price"] - df["trough_price"]
    df["recovery_rate"] = np.where(
        spread > 0,
        ((df["latest_price"] - df["trough_price"]) / spread).clip(0, 1),
        0.5,
    )

    def _minmax(s, low_is_good=False):
        mn, mx = s.min(), s.max()
        if mx == mn:
            return pd.Series([5.0] * len(s), index=s.index)
        norm = (s - mn) / (mx - mn)
        return (1 - norm) * 10 if low_is_good else norm * 10

    df["score_mdd"]      = _minmax(df["mdd_pct"],       low_is_good=True)   # 덜 빠질수록 고점
    df["score_recovery"] = _minmax(df["recovery_rate"],  low_is_good=False)

    df["resilience_score"] = df["score_mdd"] * 0.6 + df["score_recovery"] * 0.4
    return df[["apt_name", "resilience_score", "mdd_pct", "recovery_rate"]]


# ── ③ 상승 참여도 ─────────────────────────────────────────────

def _upside_participation(mdd_df: pd.DataFrame, monthly: pd.DataFrame) -> pd.DataFrame:
    """
    상승기(PEAK_START~PEAK_END) 수익률 → 0~10점.
    수익률 = (peak - 시작가) / 시작가
    """
    rise_start = pd.Period(config.PEAK_START, freq="M")
    base_window = pd.Period(
        str(int(config.START_YEAR_MONTH[:4]) + 1) + config.START_YEAR_MONTH[4:],
        freq="M"
    )

    rows = []
    for apt_name, grp in monthly.groupby("apt_name", observed=True):
        grp = grp.sort_values("deal_date")

        # 기저가: 2020년 초 6개월 중앙값
        base_data = grp[grp["deal_date"] <= base_window]["smoothed_price"]
        base_price = base_data.median() if len(base_data) >= 1 else grp["smoothed_price"].iloc[0]

        # 최고가 (peak 구간)
        mdd_row = mdd_df[mdd_df["apt_name"] == apt_name]
        peak_price = mdd_row["peak_price"].iloc[0] if not mdd_row.empty else grp["smoothed_price"].max()

        upside_pct = (peak_price - base_price) / base_price * 100 if base_price > 0 else 0
        rows.append({"apt_name": apt_name, "upside_pct": upside_pct})

    up_df = pd.DataFrame(rows)
    if up_df.empty:
        return up_df

    mn, mx = up_df["upside_pct"].min(), up_df["upside_pct"].max()
    if mx > mn:
        up_df["upside_score"] = (up_df["upside_pct"] - mn) / (mx - mn) * 10
    else:
        up_df["upside_score"] = 5.0

    return up_df[["apt_name", "upside_score", "upside_pct"]]


# ── ④⑤⑥ 교통·인프라·학군 ───────────────────────────────────────

def _location_scores(mdd_df: pd.DataFrame) -> pd.DataFrame:
    """정적 테이블에서 교통/인프라/학군 점수 조회"""
    rows = []
    for _, row in mdd_df.iterrows():
        static = _get_static(str(row["apt_name"]), str(row["district_name"]))
        rows.append({
            "apt_name":      row["apt_name"],
            "subway_score":  _subway_score(static["subway_min"]),
            "infra_score":   float(static["infra"]),
            "school_score":  float(static["school"]),
            "subway_min":    static["subway_min"],
        })
    return pd.DataFrame(rows)


# ── 종합 점수 합산 ────────────────────────────────────────────

WEIGHTS = {
    "consistency": 0.30,
    "resilience":  0.25,
    "upside":      0.20,
    "subway":      0.12,
    "infra":       0.08,
    "school":      0.05,
}


def compute_composite_score(
    mdd_df: pd.DataFrame,
    monthly: pd.DataFrame,
) -> pd.DataFrame:
    """
    종합 입지 점수 계산.
    반환 컬럼:
        apt_name, district_name, composite_score(0~100),
        consistency_score, resilience_score, upside_score,
        subway_score, infra_score, school_score,
        mdd_pct, upside_pct, recovery_rate, subway_min,
        gap_ratio, retention, active_months
    """
    tc   = _transaction_consistency(monthly)
    res  = _price_resilience(mdd_df, monthly)
    ups  = _upside_participation(mdd_df, monthly)
    loc  = _location_scores(mdd_df)

    df = mdd_df[["apt_name", "district_name", "build_year", "area_exclusive"]].copy()
    df = (
        df
        .merge(tc,  on="apt_name", how="left")
        .merge(res, on="apt_name", how="left")
        .merge(ups, on="apt_name", how="left")
        .merge(loc, on="apt_name", how="left")
    )

    # 각 축 점수 0~10 → 가중 합산 → 0~100
    df["composite_score"] = (
        df["consistency_score"].fillna(5) * WEIGHTS["consistency"] +
        df["resilience_score"].fillna(5)  * WEIGHTS["resilience"]  +
        df["upside_score"].fillna(5)      * WEIGHTS["upside"]      +
        df["subway_score"].fillna(5)      * WEIGHTS["subway"]      +
        df["infra_score"].fillna(5)       * WEIGHTS["infra"]       +
        df["school_score"].fillna(5)      * WEIGHTS["school"]
    ) * 10  # 0~10 → 0~100

    df = df.sort_values("composite_score", ascending=False).reset_index(drop=True)
    df["rank"] = df.index + 1

    log.info(f"종합 점수 계산 완료: {len(df)}개 단지")
    return df
