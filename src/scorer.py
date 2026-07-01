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

정규화: percentile-rank (이상치에 견고). 각 축 0~100.
"""

import logging
import numpy as np
import pandas as pd

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
import config

log = logging.getLogger(__name__)

WEIGHTS = {
    "defense":   0.25,   # 가격 방어력
    "liquidity": 0.20,   # 거래 유동성
    "upside":    0.15,   # 상승 참여도
    "momentum":  0.15,   # 회복 모멘텀
    "premium":   0.15,   # 입지 프리미엄
    "scale":     0.10,   # 규모·연식
}


def _pct_rank(s: pd.Series, low_is_good: bool = False) -> pd.Series:
    """percentile-rank 정규화 → 0~100. 이상치가 스케일을 왜곡하지 않음."""
    if s.nunique() <= 1:
        return pd.Series([50.0] * len(s), index=s.index)
    r = s.rank(pct=True) * 100
    return 100 - r if low_is_good else r


# ── ① 가격 방어력 ─────────────────────────────────────────────

def _price_defense(mdd_df: pd.DataFrame, monthly: pd.DataFrame) -> pd.DataFrame:
    """
    MDD(60%) + 회복률(40%).
    회복률 = (최신가 - trough) / (peak - trough)
    1.0 초과(신고가 갱신)는 1.2까지 인정해 완전회복 단지에 가점.
    """
    latest = (
        monthly.sort_values("deal_date")
        .groupby("apt_name", observed=True)
        .last()
        .reset_index()[["apt_name", "smoothed_price"]]
        .rename(columns={"smoothed_price": "latest_price"})
    )
    df = mdd_df.merge(latest, on="apt_name", how="left")

    spread = df["peak_price"] - df["trough_price"]
    df["recovery_rate"] = np.where(
        spread > 0,
        ((df["latest_price"] - df["trough_price"]) / spread).clip(0, 1.2),
        0.5,
    )

    df["score_mdd"]      = _pct_rank(df["mdd_pct"], low_is_good=False)  # mdd_pct는 음수, 0에 가까울수록(클수록) 우수
    df["score_recovery"] = _pct_rank(df["recovery_rate"])

    df["defense_score"] = df["score_mdd"] * 0.6 + df["score_recovery"] * 0.4
    return df[["apt_name", "defense_score", "mdd_pct", "recovery_rate"]]


# ── ② 거래 유동성 ─────────────────────────────────────────────

def _liquidity(monthly: pd.DataFrame) -> pd.DataFrame:
    """
    A. 거래 공백률 (40%) : 전체 기간 중 거래 없는 달 비율 → 낮을수록 좋음
    B. 하락기 유지율 (35%): 하락기 월평균 거래 / 상승기 월평균 거래
    C. 변동계수 (25%)     : 거래량 std/mean → 낮을수록 꾸준함
    """
    all_periods = pd.period_range(
        start=config.START_YEAR_MONTH, end=config.END_YEAR_MONTH, freq="M"
    )
    total_months = len(all_periods)

    rise_start = pd.Period(config.PEAK_START,   freq="M")
    rise_end   = pd.Period(config.PEAK_END,     freq="M")
    fall_start = pd.Period(config.TROUGH_START, freq="M")
    fall_end   = pd.Period(config.TROUGH_END,   freq="M")

    rows = []
    for apt_name, grp in monthly.groupby("apt_name", observed=True):
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

        rows.append({
            "apt_name": apt_name,
            "gap_ratio": gap_ratio,
            "retention": retention,
            "cv": cv,
            "active_months": active_months,
        })

    lq = pd.DataFrame(rows)
    if lq.empty:
        return lq

    lq["liquidity_score"] = (
        _pct_rank(lq["gap_ratio"], low_is_good=True) * 0.40 +
        _pct_rank(lq["retention"])                   * 0.35 +
        _pct_rank(lq["cv"], low_is_good=True)        * 0.25
    )
    return lq[["apt_name", "liquidity_score", "gap_ratio", "retention", "cv", "active_months"]]


# ── ③ 상승 참여도 ─────────────────────────────────────────────

def _upside_participation(mdd_df: pd.DataFrame, monthly: pd.DataFrame) -> pd.DataFrame:
    """상승기 수익률 = (peak - 2020년 초 기저가) / 기저가"""
    base_window = pd.Period(
        str(int(config.START_YEAR_MONTH[:4]) + 1) + config.START_YEAR_MONTH[4:],
        freq="M"
    )

    rows = []
    for apt_name, grp in monthly.groupby("apt_name", observed=True):
        grp = grp.sort_values("deal_date")

        base_data = grp[grp["deal_date"] <= base_window]["smoothed_price"]
        base_price = base_data.median() if len(base_data) >= 1 else grp["smoothed_price"].iloc[0]

        mdd_row = mdd_df[mdd_df["apt_name"] == apt_name]
        peak_price = mdd_row["peak_price"].iloc[0] if not mdd_row.empty else grp["smoothed_price"].max()

        upside_pct = (peak_price - base_price) / base_price * 100 if base_price > 0 else 0
        rows.append({"apt_name": apt_name, "upside_pct": upside_pct})

    up = pd.DataFrame(rows)
    if up.empty:
        return up
    up["upside_score"] = _pct_rank(up["upside_pct"])
    return up[["apt_name", "upside_score", "upside_pct"]]


# ── ④ 회복 모멘텀 ─────────────────────────────────────────────

def _recovery_momentum(monthly: pd.DataFrame) -> pd.DataFrame:
    """
    최근 12개월(데이터 마지막 시점 기준) 스무딩 가격의 선형 추세.
    연율화 기울기(%/년) = slope × 12 / 평균가 × 100.
    하락 후 다시 오르는 단지와 바닥에 머무는 단지를 구분.
    """
    end = monthly["deal_date"].max()
    start = end - 11

    rows = []
    for apt_name, grp in monthly.groupby("apt_name", observed=True):
        w = grp[(grp["deal_date"] >= start)].sort_values("deal_date")
        if len(w) < 3:
            rows.append({"apt_name": apt_name, "momentum_pct": np.nan})
            continue
        x = (w["deal_date"] - start).apply(lambda p: p.n).to_numpy(dtype=float)
        y = w["smoothed_price"].to_numpy(dtype=float)
        slope = np.polyfit(x, y, 1)[0]           # 원/월
        mean_price = y.mean()
        momentum_pct = slope * 12 / mean_price * 100 if mean_price > 0 else 0
        rows.append({"apt_name": apt_name, "momentum_pct": round(momentum_pct, 2)})

    mo = pd.DataFrame(rows)
    if mo.empty:
        return mo
    # 데이터 부족 단지는 중립(중앙값)으로
    mo["momentum_pct"] = mo["momentum_pct"].fillna(mo["momentum_pct"].median())
    mo["momentum_score"] = _pct_rank(mo["momentum_pct"])
    return mo[["apt_name", "momentum_score", "momentum_pct"]]


# ── ⑤ 입지 프리미엄 ───────────────────────────────────────────

def _location_premium(mdd_df: pd.DataFrame) -> pd.DataFrame:
    """
    주력 면적 m²당 고점가 percentile.
    교통·학군·인프라 가치는 시장가격에 이미 반영되어 있으므로(헤도닉 원리)
    단위면적당 가격이 가장 객관적인 입지 지표.
    """
    df = mdd_df[["apt_name", "peak_price", "area_exclusive"]].copy()
    df["price_per_m2"] = df["peak_price"] / df["area_exclusive"]
    df["premium_score"] = _pct_rank(df["price_per_m2"])
    df["price_per_m2"] = df["price_per_m2"].round(1)
    return df[["apt_name", "premium_score", "price_per_m2"]]


# ── ⑥ 규모·연식 ──────────────────────────────────────────────

def _scale_age(mdd_df: pd.DataFrame, monthly: pd.DataFrame) -> pd.DataFrame:
    """
    거래규모(70%) : 총 거래건수 percentile — 세대수(대단지 프리미엄)의 프록시
    연식(30%)     : 준공연도 percentile — 신축일수록 상품성 우위
    """
    vol = (
        monthly.groupby("apt_name", observed=True)["trade_count"]
        .sum()
        .reset_index()
        .rename(columns={"trade_count": "total_trades"})
    )
    df = mdd_df[["apt_name", "build_year"]].merge(vol, on="apt_name", how="left")
    df["total_trades"] = df["total_trades"].fillna(0)

    df["scale_score"] = (
        _pct_rank(df["total_trades"]) * 0.70 +
        _pct_rank(df["build_year"].astype(float)) * 0.30
    )
    return df[["apt_name", "scale_score", "total_trades"]]


# ── 종합 점수 합산 ────────────────────────────────────────────

def compute_composite_score(
    mdd_df: pd.DataFrame,
    monthly: pd.DataFrame,
) -> pd.DataFrame:
    """
    종합 입지 점수 계산 (0~100).
    반환 컬럼:
        apt_name, district_name, build_year, area_exclusive,
        composite_score, rank,
        defense_score, liquidity_score, upside_score,
        momentum_score, premium_score, scale_score,
        mdd_pct, recovery_rate, upside_pct, momentum_pct,
        price_per_m2, total_trades, gap_ratio, retention, active_months
    """
    dfn = _price_defense(mdd_df, monthly)
    lq  = _liquidity(monthly)
    ups = _upside_participation(mdd_df, monthly)
    mo  = _recovery_momentum(monthly)
    pr  = _location_premium(mdd_df)
    sc  = _scale_age(mdd_df, monthly)

    df = mdd_df[["apt_name", "district_name", "build_year", "area_exclusive"]].copy()
    for part in (dfn, lq, ups, mo, pr, sc):
        df = df.merge(part, on="apt_name", how="left")

    df["composite_score"] = (
        df["defense_score"].fillna(50)   * WEIGHTS["defense"]   +
        df["liquidity_score"].fillna(50) * WEIGHTS["liquidity"] +
        df["upside_score"].fillna(50)    * WEIGHTS["upside"]    +
        df["momentum_score"].fillna(50)  * WEIGHTS["momentum"]  +
        df["premium_score"].fillna(50)   * WEIGHTS["premium"]   +
        df["scale_score"].fillna(50)     * WEIGHTS["scale"]
    )

    df = df.sort_values("composite_score", ascending=False).reset_index(drop=True)
    df["rank"] = df.index + 1

    log.info(f"종합 점수 계산 완료: {len(df)}개 단지")
    return df
