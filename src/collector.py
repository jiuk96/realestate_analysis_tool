"""
국토교통부 아파트매매 실거래자료 API 수집기
- 구(법정동코드) × 월(YYYYMM) 조합으로 페이징 수집
- Parquet 체크포인트: 이미 수집된 구+월은 스킵
- Rate limit 대응 exponential backoff 재시도
"""

import os
import time
import logging
from pathlib import Path
from typing import Optional

import requests
import pandas as pd
from dotenv import load_dotenv
from tqdm import tqdm

import sys
sys.path.insert(0, str(Path(__file__).parent.parent))
import config

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

RAW_DIR = Path(__file__).parent.parent / "data" / "raw"
RAW_DIR.mkdir(parents=True, exist_ok=True)

API_URL = "http://apis.data.go.kr/1613000/RTMSDataSvcAptTrade/getRTMSDataSvcAptTrade"


def _month_range(start: str, end: str) -> list[str]:
    """'202001' ~ '202512' 형태의 월 목록 생성"""
    months = []
    y, m = int(start[:4]), int(start[4:])
    ey, em = int(end[:4]), int(end[4:])
    while (y, m) <= (ey, em):
        months.append(f"{y}{m:02d}")
        m += 1
        if m > 12:
            m, y = 1, y + 1
    return months


def _checkpoint_path(district_code: str, ym: str) -> Path:
    return RAW_DIR / f"{district_code}_{ym}.parquet"


def _fetch_one_page(api_key: str, district_code: str, ym: str, page: int) -> dict:
    """API 단일 페이지 호출 (재시도 포함)"""
    params = {
        "serviceKey": api_key,
        "LAWD_CD":    district_code,
        "DEAL_YMD":   ym,
        "pageNo":     page,
        "numOfRows":  config.MAX_PAGE_SIZE,
        "resultType": "json",
    }
    for attempt in range(config.API_RETRY_COUNT):
        try:
            resp = requests.get(API_URL, params=params, timeout=30)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            wait = config.API_RETRY_BACKOFF ** attempt
            log.warning(f"재시도 {attempt+1}/{config.API_RETRY_COUNT} ({wait:.0f}s 대기): {e}")
            time.sleep(wait)
    raise RuntimeError(f"API 호출 실패: {district_code} {ym} page={page}")


def _parse_items(raw_json: dict) -> tuple[list[dict], int]:
    """응답 JSON에서 거래 항목과 전체 건수 추출"""
    try:
        body       = raw_json["response"]["body"]
        total_count = int(body.get("totalCount", 0))
        items       = body.get("items", {})
        if not items:
            return [], total_count
        item_list = items.get("item", [])
        if isinstance(item_list, dict):   # 단건일 때 dict로 오는 경우
            item_list = [item_list]
        return item_list, total_count
    except (KeyError, TypeError) as e:
        log.error(f"응답 파싱 오류: {e} / 응답: {str(raw_json)[:200]}")
        return [], 0


def _collect_district_month(api_key: str, district_code: str, ym: str) -> pd.DataFrame:
    """한 구 × 한 달치 전체 페이지 수집 후 DataFrame 반환"""
    save_path = _checkpoint_path(district_code, ym)
    if save_path.exists():
        return pd.read_parquet(save_path)

    all_items = []
    page = 1
    while True:
        raw = _fetch_one_page(api_key, district_code, ym, page)
        items, total = _parse_items(raw)
        all_items.extend(items)

        if not items or len(all_items) >= total:
            break
        page += 1
        time.sleep(0.2)   # API 과부하 방지 최소 딜레이

    if not all_items:
        df = pd.DataFrame()
    else:
        df = pd.DataFrame(all_items)
        df = _normalize_columns(df)
        df["district_code"] = district_code
        df["deal_ym"]        = ym

    df.to_parquet(save_path, index=False)
    return df


def _normalize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """컬럼명 정리 + 타입 캐스팅 (메모리 최적화)"""
    rename_map = {
        "aptNm":        "apt_name",
        "buildYear":    "build_year",
        "dealAmount":   "deal_amount",   # '80,000' 형태 문자열
        "dealDay":      "deal_day",
        "dealMonth":    "deal_month",
        "dealYear":     "deal_year",
        "dong":         "dong",
        "excluUseAr":   "area_exclusive",
        "floor":        "floor",
        "jibun":        "jibun",
        "sggCd":        "sgg_code",
        "umdNm":        "umd_name",
        "rgstDate":     "reg_date",
        "cdealType":    "deal_type",     # 직거래 여부 등
        "bonbun":       "bonbun",
    }
    df = df.rename(columns={k: v for k, v in rename_map.items() if k in df.columns})

    # 거래금액: '80,000' → 숫자(만원)
    if "deal_amount" in df.columns:
        df["deal_amount"] = (
            df["deal_amount"].astype(str).str.replace(",", "").str.strip()
        )
        df["deal_amount"] = pd.to_numeric(df["deal_amount"], errors="coerce")

    # 수치형 다운캐스팅 (메모리 절약)
    for col in ["build_year", "deal_year", "deal_month", "deal_day", "floor"]:
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce")
            df[col] = pd.to_numeric(df[col], downcast="integer")

    if "area_exclusive" in df.columns:
        df["area_exclusive"] = pd.to_numeric(df["area_exclusive"], errors="coerce").astype("float32")

    # 카테고리형 (메모리 절약)
    for col in ["apt_name", "dong", "umd_name", "deal_type"]:
        if col in df.columns:
            df[col] = df[col].astype("category")

    return df


def collect_all(districts: Optional[dict] = None) -> pd.DataFrame:
    """
    설정된 구 목록 × 전체 기간 수집.
    districts: {'마포구': '11440', ...} 형태, None이면 config.DISTRICTS 사용
    """
    api_key = os.getenv("MOLIT_API_KEY")
    if not api_key:
        raise EnvironmentError(
            "MOLIT_API_KEY 환경변수가 없습니다.\n"
            ".env 파일에 MOLIT_API_KEY=발급받은키 를 추가해주세요."
        )

    districts = districts or config.DISTRICTS
    months    = _month_range(config.START_YEAR_MONTH, config.END_YEAR_MONTH)

    tasks = [(name, code, ym) for name, code in districts.items() for ym in months]
    log.info(f"수집 대상: {len(districts)}개 구 × {len(months)}개월 = {len(tasks)}회 API 호출 (체크포인트 스킵 포함)")

    frames = []
    for name, code, ym in tqdm(tasks, desc="데이터 수집"):
        try:
            df = _collect_district_month(api_key, code, ym)
            if not df.empty:
                df["district_name"] = name
                frames.append(df)
        except Exception as e:
            log.error(f"{name} {ym} 수집 실패: {e}")

    if not frames:
        log.warning("수집된 데이터가 없습니다.")
        return pd.DataFrame()

    combined = pd.concat(frames, ignore_index=True)
    log.info(f"수집 완료: 총 {len(combined):,}건")
    return combined


if __name__ == "__main__":
    df = collect_all()
    if not df.empty:
        print(df.dtypes)
        print(df.head())
        print(f"\n메모리 사용량: {df.memory_usage(deep=True).sum() / 1024**2:.1f} MB")
