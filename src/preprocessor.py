"""
벌점 시스템 + 이상치 필터 + 500세대 추정 필터
수집된 원본 DataFrame을 받아 분석에 적합한 정제 데이터를 반환
"""

import logging
import numpy as np
import pandas as pd

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))
import config

log = logging.getLogger(__name__)


# ── 1. 벌점 계산 ──────────────────────────────────────────────

def _penalty_floor(df: pd.DataFrame) -> pd.Series:
    """1층 거래: +2점"""
    return (df["floor"] == 1).astype("int8") * 2


def _penalty_missing(df: pd.DataFrame) -> pd.Series:
    """핵심 컬럼 결측: +2점"""
    missing = df[["deal_amount", "area_exclusive", "floor"]].isnull().any(axis=1)
    return missing.astype("int8") * 2


def _penalty_direct_deal(df: pd.DataFrame) -> pd.Series:
    """
    직거래 의심: 단지×면적 그룹 월별 중앙값 대비 60% 이하 → +3점
    cdealType 컬럼이 있으면 명시적 직거래도 추가 +1점
    """
    penalty = pd.Series(0, index=df.index, dtype="int8")

    group_median = (
        df.groupby(["apt_name", "area_exclusive", "deal_ym"], observed=True)["deal_amount"]
        .transform("median")
    )
    low_ratio = df["deal_amount"] < group_median * config.DIRECT_DEAL_RATIO
    penalty += low_ratio.astype("int8") * 3

    if "deal_type" in df.columns:
        is_direct = df["deal_type"].astype(str).str.contains("직거래", na=False)
        penalty += is_direct.astype("int8") * 1

    return penalty


def _penalty_zscore(df: pd.DataFrame) -> pd.Series:
    """
    단지×면적 그룹 내 z-score 이상치: 절댓값 > 3.0 → +2점
    그룹 내 거래 건수 < 3이면 z-score 계산 불가 → 0점
    """
    penalty = pd.Series(0, index=df.index, dtype="int8")

    def zscore_penalty(group: pd.Series) -> pd.Series:
        if len(group) < 3:
            return pd.Series(0, index=group.index, dtype="int8")
        z = (group - group.mean()) / (group.std() + 1e-9)
        return (z.abs() > config.OUTLIER_ZSCORE_THRESHOLD).astype("int8") * 2

    result = df.groupby(["apt_name", "area_exclusive"], observed=True)["deal_amount"].transform(zscore_penalty)
    penalty += result.fillna(0).astype("int8")
    return penalty


def compute_penalties(df: pd.DataFrame) -> pd.DataFrame:
    """
    모든 벌점을 합산해 'penalty' 컬럼 추가.
    반환: 원본 df에 penalty 컬럼이 붙은 DataFrame
    """
    df = df.copy()
    df["p_floor"]   = _penalty_floor(df)
    df["p_missing"] = _penalty_missing(df)
    df["p_direct"]  = _penalty_direct_deal(df)
    df["p_zscore"]  = _penalty_zscore(df)
    df["penalty"]   = df[["p_floor", "p_missing", "p_direct", "p_zscore"]].sum(axis=1).astype("int8")
    return df


# ── 2. 거래 레벨 필터 ──────────────────────────────────────────

def filter_transactions(df: pd.DataFrame) -> pd.DataFrame:
    """
    벌점 임계값 초과 거래 제거.
    제거 통계를 로그로 출력.
    """
    before = len(df)
    df = df[df["penalty"] < config.PENALTY_THRESHOLD].copy()
    after = len(df)
    pct = (before - after) / before * 100 if before > 0 else 0
    log.info(f"거래 필터: {before:,}건 → {after:,}건 (제거 {before-after:,}건, {pct:.1f}%)")
    return df


# ── 3. 단지 레벨 필터 (500세대 추정 + 불량 단지 제거) ─────────

def _estimate_households(df: pd.DataFrame) -> pd.DataFrame:
    """
    실거래 건수로 세대수를 역산하는 휴리스틱:
    6년치 데이터에서 동일 단지 거래 건수 ÷ 6 × 10 ≈ 연간 회전율 10% 가정
    → 추정 세대수 = 총 거래건수 / 6 * 10
    실제 세대수 데이터가 있으면 교체 가능한 컬럼 구조
    """
    trade_count = (
        df.groupby("apt_name", observed=True)["deal_amount"]
        .count()
        .rename("trade_count")
        .reset_index()
    )
    trade_count["est_households"] = (trade_count["trade_count"] / 6 * 10).round().astype(int)
    return trade_count


def filter_apartments(df: pd.DataFrame) -> pd.DataFrame:
    """
    1) 추정 세대수 500 미만 단지 제거
    2) 단지 전체 거래 중 벌점 제거 비율 > 30% 단지 제거
    """
    # 벌점 제거 비율 계산 (compute_penalties 이전 원본 건수 필요하므로 컬럼으로 기록)
    if "penalty" not in df.columns:
        raise ValueError("compute_penalties() 를 먼저 실행해주세요.")

    total_per_apt   = df.groupby("apt_name", observed=True)["penalty"].count().rename("total_trades")
    removed_per_apt = (
        df[df["penalty"] >= config.PENALTY_THRESHOLD]
        .groupby("apt_name", observed=True)["penalty"].count()
        .rename("removed_trades")
    )
    quality = pd.concat([total_per_apt, removed_per_apt], axis=1).fillna(0)
    quality["remove_ratio"] = quality["removed_trades"] / quality["total_trades"]

    # 세대수 추정 (필터 전 전체 df 기준)
    hh = _estimate_households(df)
    quality = quality.merge(hh[["apt_name", "est_households"]], on="apt_name", how="left")

    # 조건 적용 (merge 후 apt_name 컬럼 기준으로 필터)
    valid_apts = quality.loc[
        (quality["est_households"] >= config.MIN_HOUSEHOLDS) &
        (quality["remove_ratio"] <= 0.30),
        "apt_name"
    ].values

    before = df["apt_name"].nunique()
    df = df[df["apt_name"].isin(valid_apts)].copy()
    after = df["apt_name"].nunique()
    log.info(
        f"단지 필터: {before}개 → {after}개 단지 "
        f"(세대수 미달 또는 데이터 불량 제거)"
    )
    return df


# ── 4. 날짜 컬럼 정규화 ────────────────────────────────────────

def add_date_column(df: pd.DataFrame) -> pd.DataFrame:
    """deal_year / deal_month → deal_date (Period[M]) 컬럼 추가"""
    df = df.copy()
    df["deal_date"] = pd.to_datetime(
        df["deal_year"].astype(str) + df["deal_month"].astype(str).str.zfill(2),
        format="%Y%m"
    ).dt.to_period("M")
    return df


# ── 5. 전체 파이프라인 ─────────────────────────────────────────

def run(df: pd.DataFrame) -> pd.DataFrame:
    """
    collector.collect_all() 결과를 받아 분석 준비 완료된 DataFrame 반환.
    단계: 벌점 계산 → 거래 필터 → 단지 필터 → 날짜 컬럼 추가
    """
    log.info(f"전처리 시작: {len(df):,}건, {df['apt_name'].nunique()}개 단지")
    df = compute_penalties(df)
    df = filter_apartments(df)   # 단지 필터는 제거 전 비율 계산이 필요해 먼저
    df = filter_transactions(df)
    df = add_date_column(df)

    # 불필요 벌점 세부 컬럼 정리
    df = df.drop(columns=["p_floor", "p_missing", "p_direct", "p_zscore"], errors="ignore")
    log.info(f"전처리 완료: {len(df):,}건, {df['apt_name'].nunique()}개 단지 남음")
    return df
