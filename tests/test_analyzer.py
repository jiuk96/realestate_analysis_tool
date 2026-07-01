"""
analyzer 단위 테스트 (API 키 불필요)
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pandas as pd
from tests.fixtures import make_sample_df
from src.preprocessor import run as preprocess
from src.analyzer import build_monthly_median, detect_peak_trough, extract_top_defenders, derive_common_traits, run as analyze


def get_clean_df():
    return preprocess(make_sample_df())


def test_monthly_median_smoothing():
    df = get_clean_df()
    monthly = build_monthly_median(df)
    assert "smoothed_price" in monthly.columns
    assert (monthly["trade_count"] >= 2).all(), "거래 1건 월은 제거되어야 함"
    assert monthly["smoothed_price"].isnull().sum() == 0


def test_detect_peak_trough_structure():
    df = get_clean_df()
    monthly = build_monthly_median(df)
    mdd_df = detect_peak_trough(monthly)
    assert not mdd_df.empty
    required = {"apt_name", "peak_date", "peak_price", "trough_date", "trough_price", "mdd_pct"}
    assert required.issubset(mdd_df.columns)


def test_mdd_is_negative():
    """최고점 이후 하락 → MDD는 반드시 음수"""
    df = get_clean_df()
    monthly = build_monthly_median(df)
    mdd_df = detect_peak_trough(monthly)
    assert (mdd_df["mdd_pct"] <= 0).all(), f"MDD 양수 존재: {mdd_df[mdd_df['mdd_pct'] > 0]}"


def test_peak_before_trough():
    df = get_clean_df()
    monthly = build_monthly_median(df)
    mdd_df = detect_peak_trough(monthly)
    assert (mdd_df["peak_date"] < mdd_df["trough_date"]).all(), "최고점이 최저점보다 앞서야 함"


def test_top_defenders_count():
    df = get_clean_df()
    monthly = build_monthly_median(df)
    mdd_df = detect_peak_trough(monthly)
    top_df = extract_top_defenders(mdd_df, top_pct=0.5)   # 50%로 테스트
    assert len(top_df) >= 1
    # 상위 단지의 MDD가 전체 평균보다 작은지 (0에 가까운지) 확인
    assert top_df["mdd_pct"].mean() >= mdd_df["mdd_pct"].mean()


def test_common_traits():
    df = get_clean_df()
    monthly = build_monthly_median(df)
    mdd_df = detect_peak_trough(monthly)
    top_df = extract_top_defenders(mdd_df, top_pct=0.5)
    traits = derive_common_traits(top_df, mdd_df)
    assert "평균_준공연도" in traits
    assert "평균_MDD" in traits
    assert "구별_분포" in traits


def test_full_pipeline():
    df = get_clean_df()
    mdd_df, top_df, traits = analyze(df)
    assert not mdd_df.empty
    assert not top_df.empty
    assert isinstance(traits, dict)
    print(f"\n  전체 단지: {len(mdd_df)}개 | 방어력 상위 10%: {len(top_df)}개")
    print(f"  전체 평균 MDD: {mdd_df['mdd_pct'].mean():.1f}%")
    print(f"  상위 단지 MDD: {top_df['mdd_pct'].mean():.1f}%")
    for apt, row in mdd_df.iterrows():
        print(f"  [{row['apt_name']}] 최고점: {row['peak_date']} {row['peak_price']:,}만원 → "
              f"최저점: {row['trough_date']} {row['trough_price']:,}만원  MDD: {row['mdd_pct']:.1f}%")


if __name__ == "__main__":
    test_monthly_median_smoothing()
    print("✓ 월별 중앙가 스무딩 테스트")
    test_detect_peak_trough_structure()
    print("✓ 최고점/최저점 구조 테스트")
    test_mdd_is_negative()
    print("✓ MDD 음수 검증")
    test_peak_before_trough()
    print("✓ 최고점 < 최저점 순서 검증")
    test_top_defenders_count()
    print("✓ 방어력 상위 단지 추출 테스트")
    test_common_traits()
    print("✓ 공통 특성 도출 테스트")
    test_full_pipeline()
    print("✓ 전체 분석 파이프라인 테스트")
    print("\n모든 analyzer 테스트 통과!")
