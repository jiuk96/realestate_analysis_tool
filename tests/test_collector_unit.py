"""
API 키 없이 collector 내부 함수를 단위 테스트
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent))

from src.collector import _month_range, _parse_items, _normalize_columns
import pandas as pd


def test_month_range_count():
    months = _month_range("202001", "202012")
    assert len(months) == 12
    assert months[0] == "202001"
    assert months[-1] == "202012"


def test_month_range_cross_year():
    months = _month_range("202011", "202102")
    assert months == ["202011", "202012", "202101", "202102"]


def test_parse_items_single():
    raw = {
        "response": {
            "body": {
                "totalCount": 1,
                "items": {"item": {"aptNm": "테스트아파트", "dealAmount": "80,000"}},
            }
        }
    }
    items, total = _parse_items(raw)
    assert total == 1
    assert len(items) == 1
    assert items[0]["aptNm"] == "테스트아파트"


def test_parse_items_empty():
    raw = {"response": {"body": {"totalCount": 0, "items": {}}}}
    items, total = _parse_items(raw)
    assert items == []
    assert total == 0


def test_normalize_columns_amount():
    df = pd.DataFrame([{"aptNm": "래미안", "dealAmount": "80,000", "buildYear": "2010", "excluUseAr": "84.5"}])
    result = _normalize_columns(df)
    assert result["deal_amount"].iloc[0] == 80000.0
    assert result["apt_name"].dtype.name == "category"
    assert result["area_exclusive"].dtype == "float32"


if __name__ == "__main__":
    test_month_range_count()
    test_month_range_cross_year()
    test_parse_items_single()
    test_parse_items_empty()
    test_normalize_columns_amount()
    print("모든 단위 테스트 통과!")
