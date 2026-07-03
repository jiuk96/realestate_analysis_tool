"""
MDD(Maximum Drawdown) 계산 및 하락장 방어력 분석
- 단지별 최고점/최저점 월 자동 탐지
- MDD(%) 계산 및 방어력 상위 10% 추출
- 공통 특성 도출 (연식, 구, 세대수 추정)
"""

import logging
import numpy as np
import pandas as pd

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
import config

log = logging.getLogger(__name__)


# ── 1. 월별 중앙가 시계열 생성 ────────────────────────────────

def build_monthly_median(df: pd.DataFrame) -> pd.DataFrame:
    """
    단지 × 면적 그룹별 월별 중앙 거래가 산출.
    단지마다 주력 면적이 달라 비교가 왜곡되므로, 전 단지를 동일 평형
    (전용 59㎡ = 18평대, config.TARGET_AREA_MIN~MAX)으로 통일한다.
    해당 평형대 거래 중 최다 면적을 각 단지의 대표 타입으로 사용하며,
    이 평형대 거래가 없는 단지는 분석에서 제외된다.
    반환: [apt_name, deal_date, median_price, area_exclusive, district_name, build_year]
    """
    # 전용 59㎡대(18평)만 남김 — 전 단지 동일 평형 비교
    df = df[
        (df["area_exclusive"] >= config.TARGET_AREA_MIN) &
        (df["area_exclusive"] <= config.TARGET_AREA_MAX)
    ].copy()

    # 59㎡대 안에서 단지별 최다 거래 면적을 대표 타입으로 선정
    dominant_area = (
        df.groupby(["apt_name", "area_exclusive"], observed=True)
        .size()
        .reset_index(name="cnt")
        .sort_values("cnt", ascending=False)
        .drop_duplicates("apt_name")
        [["apt_name", "area_exclusive"]]
    )

    df = df.merge(dominant_area, on=["apt_name", "area_exclusive"], how="inner")

    monthly = (
        df.groupby(["apt_name", "deal_date"], observed=True)
        .agg(
            median_price   = ("deal_amount", "median"),
            trade_count    = ("deal_amount", "count"),
            district_name  = ("district_name", "first"),
            build_year     = ("build_year", "first"),
            area_exclusive = ("area_exclusive", "first"),
        )
        .reset_index()
    )

    # 거래가 1건뿐인 월은 노이즈가 크므로 제외
    monthly = monthly[monthly["trade_count"] >= 2].copy()

    # 3개월 이동 중앙값으로 스무딩 (단기 스파이크 완화)
    monthly = monthly.sort_values(["apt_name", "deal_date"])
    monthly["smoothed_price"] = (
        monthly.groupby("apt_name", observed=True)["median_price"]
        .transform(lambda s: s.rolling(3, min_periods=1, center=True).median())
    )

    return monthly


# ── 2. 최고점 / 최저점 탐지 ───────────────────────────────────

def _period_to_str(p) -> str:
    return str(p) if p is not None else "N/A"


def detect_peak_trough(monthly: pd.DataFrame) -> pd.DataFrame:
    """
    단지별 최고점(peak)과 최저점(trough) 탐지.

    1차: config 하드코딩 구간 내에서 탐지
         - peak:   PEAK_START ~ PEAK_END
         - trough: TROUGH_START ~ TROUGH_END
    2차: 구간 내 데이터가 3개월 미만이면 전체 기간으로 확장 탐지

    반환: [apt_name, peak_date, peak_price, trough_date, trough_price,
           mdd_pct, district_name, build_year, area_exclusive]
    """
    peak_start   = pd.Period(config.PEAK_START,   freq="M")
    peak_end     = pd.Period(config.PEAK_END,     freq="M")
    trough_start = pd.Period(config.TROUGH_START, freq="M")
    trough_end   = pd.Period(config.TROUGH_END,   freq="M")

    results = []

    for apt_name, grp in monthly.groupby("apt_name", observed=True):
        grp = grp.sort_values("deal_date")

        # 최고점 탐지
        peak_window = grp[(grp["deal_date"] >= peak_start) & (grp["deal_date"] <= peak_end)]
        if len(peak_window) < 3:
            peak_window = grp   # 구간 데이터 부족 → 전체 기간 사용
        if peak_window.empty:
            continue
        peak_row = peak_window.loc[peak_window["smoothed_price"].idxmax()]

        # 최저점 탐지 (최고점 이후 구간만)
        trough_window = grp[
            (grp["deal_date"] >= trough_start) &
            (grp["deal_date"] <= trough_end) &
            (grp["deal_date"] > peak_row["deal_date"])
        ]
        if len(trough_window) < 3:
            trough_window = grp[grp["deal_date"] > peak_row["deal_date"]]
        if trough_window.empty:
            continue
        trough_row = trough_window.loc[trough_window["smoothed_price"].idxmin()]

        peak_price   = peak_row["smoothed_price"]
        trough_price = trough_row["smoothed_price"]

        if peak_price <= 0:
            continue

        mdd_pct = (trough_price - peak_price) / peak_price * 100  # 음수

        results.append({
            "apt_name":      apt_name,
            "peak_date":     peak_row["deal_date"],
            "peak_price":    round(peak_price),
            "trough_date":   trough_row["deal_date"],
            "trough_price":  round(trough_price),
            "mdd_pct":       round(mdd_pct, 2),
            "district_name": peak_row["district_name"],
            "build_year":    peak_row["build_year"],
            "area_exclusive": round(float(peak_row["area_exclusive"]), 1),  # float32 꼬리자리 제거
        })

    result_df = pd.DataFrame(results)
    log.info(f"MDD 계산 완료: {len(result_df)}개 단지")
    return result_df


# ── 3. 방어력 상위 단지 추출 ──────────────────────────────────

def extract_top_defenders(mdd_df: pd.DataFrame, top_pct: float = 0.10) -> pd.DataFrame:
    """
    MDD가 작은(하락폭이 적은) 상위 top_pct 단지 추출.
    mdd_pct는 음수이므로 값이 클수록(0에 가까울수록) 방어력이 높음.
    """
    if mdd_df.empty:
        return mdd_df

    threshold = mdd_df["mdd_pct"].quantile(1 - top_pct)
    top = mdd_df[mdd_df["mdd_pct"] >= threshold].copy()
    top = top.sort_values("mdd_pct", ascending=False)
    log.info(f"방어력 상위 {top_pct*100:.0f}%: {len(top)}개 단지 (MDD ≥ {threshold:.1f}%)")
    return top


# ── 4. 공통 특성 도출 ─────────────────────────────────────────

def derive_common_traits(top_df: pd.DataFrame, full_df: pd.DataFrame) -> dict:
    """
    상위 방어 단지와 전체 단지의 특성 비교.
    반환: {특성명: {top: 값, all: 값}} 형태의 dict
    """
    if top_df.empty or full_df.empty:
        return {}

    traits = {}

    # 평균 연식
    traits["평균_준공연도"] = {
        "top": round(top_df["build_year"].mean(), 1),
        "all": round(full_df["build_year"].mean(), 1),
    }

    # 구별 분포
    traits["구별_분포"] = {
        "top": top_df["district_name"].value_counts().to_dict(),
        "all": full_df["district_name"].value_counts().to_dict(),
    }

    # 평균 MDD
    traits["평균_MDD"] = {
        "top": round(top_df["mdd_pct"].mean(), 2),
        "all": round(full_df["mdd_pct"].mean(), 2),
    }

    # 면적 분포
    traits["주력_면적"] = {
        "top": top_df["area_exclusive"].median(),
        "all": full_df["area_exclusive"].median(),
    }

    return traits


# ── 5. 전체 분석 파이프라인 ───────────────────────────────────

def run(df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, dict]:
    """
    preprocessor.run() 결과를 받아 분석 완료된 결과 반환.

    반환:
        mdd_df   - 전체 단지 MDD 결과
        top_df   - 방어력 상위 10% 단지
        traits   - 공통 특성 dict
    """
    log.info("분석 시작...")
    monthly = build_monthly_median(df)
    mdd_df  = detect_peak_trough(monthly)

    if mdd_df.empty:
        log.warning("MDD 계산 결과가 없습니다.")
        return mdd_df, pd.DataFrame(), {}

    top_df = extract_top_defenders(mdd_df)
    traits = derive_common_traits(top_df, mdd_df)

    return mdd_df, top_df, traits
