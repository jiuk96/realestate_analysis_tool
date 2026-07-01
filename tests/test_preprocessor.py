"""
preprocessor 단위 테스트 (API 키 불필요)
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

import pandas as pd
from tests.fixtures import make_sample_df
from src.preprocessor import compute_penalties, filter_transactions, filter_apartments, add_date_column, run


def test_penalty_floor():
    df = make_sample_df()
    df = compute_penalties(df)
    floor1 = df[df["floor"] == 1]
    assert (floor1["p_floor"] == 2).all(), "1층은 벌점 2점이어야 함"


def test_penalty_direct_deal():
    df = make_sample_df()
    df = compute_penalties(df)
    # 주입한 극단 저가 거래는 직거래 의심 벌점 3점 이상
    low_price = df[df["deal_amount"] == 10000]
    assert (low_price["p_direct"] >= 3).all(), "극단 저가는 직거래 벌점 3점 이상"


def test_filter_removes_outliers():
    df = make_sample_df()
    df = compute_penalties(df)
    before = len(df)
    df_filtered = filter_transactions(df)
    assert len(df_filtered) < before, "이상치 거래가 제거되어야 함"


def test_filter_removes_small_apt():
    df = make_sample_df()
    df = compute_penalties(df)
    df_filtered = filter_apartments(df)
    assert "소규모빌라" not in df_filtered["apt_name"].cat.categories or \
           "소규모빌라" not in df_filtered["apt_name"].values, \
           "세대수 미달 단지는 제거되어야 함"


def test_add_date_column():
    df = make_sample_df()
    df = add_date_column(df)
    assert "deal_date" in df.columns
    assert hasattr(df["deal_date"].iloc[0], "month")


def test_full_pipeline():
    df = make_sample_df()
    result = run(df)
    assert len(result) > 0, "파이프라인 결과가 비어있음"
    assert "deal_date" in result.columns
    assert "소규모빌라" not in result["apt_name"].values
    print(f"\n  파이프라인 결과: {len(result):,}건, {result['apt_name'].nunique()}개 단지")


if __name__ == "__main__":
    test_penalty_floor()
    print("✓ 1층 벌점 테스트")
    test_penalty_direct_deal()
    print("✓ 직거래 의심 벌점 테스트")
    test_filter_removes_outliers()
    print("✓ 이상치 거래 제거 테스트")
    test_filter_removes_small_apt()
    print("✓ 소규모 단지 제거 테스트")
    test_add_date_column()
    print("✓ 날짜 컬럼 테스트")
    test_full_pipeline()
    print("✓ 전체 파이프라인 테스트")
    print("\n모든 preprocessor 테스트 통과!")
