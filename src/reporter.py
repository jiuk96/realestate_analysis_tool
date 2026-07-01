"""콘솔 리포트 출력"""

import pandas as pd


def print_report(mdd_df: pd.DataFrame, top_df: pd.DataFrame, traits: dict) -> None:
    W = 62
    print("\n" + "═" * W)
    print("  서울 아파트 하락장 방어력 분석 리포트".center(W))
    print("  대상: 마포구 / 용산구 / 성동구  |  2020~2025".center(W))
    print("═" * W)

    print("\n【 전체 단지 MDD 순위 (하락폭 적은 순) 】")
    print(f"  {'순위':<4} {'단지명':<22} {'구':<8} {'MDD':>7}  {'고점월':<9} {'저점월'}")
    print("  " + "─" * 58)
    for i, row in mdd_df.sort_values("mdd_pct", ascending=False).reset_index(drop=True).iterrows():
        marker = " ★" if row["apt_name"] in top_df["apt_name"].values else ""
        print(f"  {i+1:<4} {str(row['apt_name']):<22} {str(row['district_name']):<8} "
              f"{row['mdd_pct']:>6.1f}%  {str(row['peak_date']):<9} {str(row['trough_date'])}{marker}")

    print(f"\n  ★ = 방어력 상위 10% 단지\n")

    print("【 방어력 상위 10% 공통 특성 】")
    if traits:
        top_yr  = traits.get("평균_준공연도", {}).get("top", "N/A")
        all_yr  = traits.get("평균_준공연도", {}).get("all", "N/A")
        top_mdd = traits.get("평균_MDD", {}).get("top", "N/A")
        all_mdd = traits.get("평균_MDD", {}).get("all", "N/A")
        diff    = round(top_mdd - all_mdd, 2) if isinstance(top_mdd, float) else "N/A"
        top_dist = traits.get("구별_분포", {}).get("top", {})
        top_area = traits.get("주력_면적", {}).get("top", "N/A")

        print(f"  평균 준공연도 : {top_yr}년  (전체 평균 {all_yr}년)")
        print(f"  평균 MDD      : {top_mdd}%  (전체 평균 {all_mdd}%,  {diff:+.1f}%p 방어)")
        print(f"  주력 지역     : {', '.join(f'{k}({v}개)' for k, v in top_dist.items())}")
        print(f"  대표 전용면적 : {top_area}㎡")

    print("\n" + "═" * W + "\n")
