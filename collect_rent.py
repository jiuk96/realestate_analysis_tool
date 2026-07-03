"""
국토교통부 아파트 전월세 실거래자료 수집기 (전세가율 산출용)
─────────────────────────────────────────────────────
매매 수집기(src/collector.py)와 동일한 국토부 서비스의 '전월세' 엔드포인트를
쓴다 — 인증키·요청 방식·rate limit 대응이 모두 같아 안정적이다.

- 구(법정동코드) × 월(YYYYMM) 조합으로 페이징 수집
- data/rent/*.parquet 체크포인트: 이미 수집된 구+월은 스킵 (증분)
- 전세만 필요하므로 월세>0(월세·반전세)은 저장 단계에서 제외하지 않고 다
  저장하되, 전세가율 계산 시 월세=0(순수 전세)만 사용한다.

실행: python collect_rent.py
  - MOLIT_API_KEY 필요 (매매 수집과 동일 키). GitHub Actions에서 실행.
"""

import os
import time
import logging
from pathlib import Path

import requests
import pandas as pd
from dotenv import load_dotenv
from tqdm import tqdm

import sys
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "src"))
import config
from src.collector import _month_range, _xml_response_to_dict, _parse_items

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

RENT_DIR = ROOT / "data" / "rent"
RENT_DIR.mkdir(parents=True, exist_ok=True)

RENT_API_URL = "http://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent"


def _fetch_rent_page(api_key: str, district_code: str, ym: str, page: int) -> dict:
    url = (
        f"{RENT_API_URL}?serviceKey={api_key}"
        f"&LAWD_CD={district_code}&DEAL_YMD={ym}"
        f"&pageNo={page}&numOfRows={config.MAX_PAGE_SIZE}"
    )
    for attempt in range(config.API_RETRY_COUNT):
        try:
            resp = requests.get(url, timeout=30)
            resp.raise_for_status()
            return _xml_response_to_dict(resp.content)
        except Exception as e:
            wait = config.API_RETRY_BACKOFF ** attempt
            log.warning(f"재시도 {attempt+1}/{config.API_RETRY_COUNT} ({wait:.0f}s): {e}")
            time.sleep(wait)
    raise RuntimeError(f"전월세 API 실패: {district_code} {ym} p={page}")


def _normalize_rent(df: pd.DataFrame) -> pd.DataFrame:
    rename = {
        "aptNm": "apt_name", "buildYear": "build_year",
        "deposit": "deposit", "monthlyRent": "monthly_rent",
        "excluUseAr": "area_exclusive",
        "dealYear": "deal_year", "dealMonth": "deal_month", "dealDay": "deal_day",
        "umdNm": "umd_name", "jibun": "jibun", "floor": "floor",
    }
    df = df.rename(columns={k: v for k, v in rename.items() if k in df.columns})

    for col in ("deposit", "monthly_rent"):
        if col in df.columns:
            df[col] = df[col].astype(str).str.replace(",", "").str.strip()
            df[col] = pd.to_numeric(df[col], errors="coerce")
    for col in ("build_year", "deal_year", "deal_month", "deal_day", "floor"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce", downcast="integer")
    if "area_exclusive" in df.columns:
        df["area_exclusive"] = pd.to_numeric(df["area_exclusive"], errors="coerce").astype("float32")
    for col in ("apt_name", "umd_name"):
        if col in df.columns:
            df[col] = df[col].astype("category")
    return df


def _collect_rent_month(api_key: str, code: str, ym: str) -> pd.DataFrame:
    path = RENT_DIR / f"{code}_{ym}.parquet"
    if path.exists():
        return pd.read_parquet(path)

    items, page = [], 1
    while True:
        raw = _fetch_rent_page(api_key, code, ym, page)
        page_items, total = _parse_items(raw)
        items.extend(page_items)
        if not page_items or len(items) >= total:
            break
        page += 1
        time.sleep(0.2)

    if not items:
        df = pd.DataFrame()
    else:
        df = _normalize_rent(pd.DataFrame(items))
        df["district_code"] = code
        df["deal_ym"] = ym
    df.to_parquet(path, index=False)
    return df


def main():
    api_key = os.getenv("MOLIT_API_KEY")
    if not api_key:
        raise EnvironmentError("MOLIT_API_KEY 환경변수가 없습니다 (매매 수집과 동일 키).")

    months = _month_range(config.START_YEAR_MONTH, config.END_YEAR_MONTH)
    tasks = [(name, code, ym) for name, code in config.DISTRICTS.items() for ym in months]
    log.info(f"전월세 수집 대상: {len(config.DISTRICTS)}개 구 × {len(months)}개월 = {len(tasks)}회 (체크포인트 스킵 포함)")

    n = 0
    for name, code, ym in tqdm(tasks, desc="전월세 수집"):
        try:
            df = _collect_rent_month(api_key, code, ym)
            n += len(df)
        except Exception as e:
            log.error(f"{name} {ym} 실패: {e}")
    log.info(f"전월세 수집 완료 (누적 {n:,}건, data/rent/)")


if __name__ == "__main__":
    main()
