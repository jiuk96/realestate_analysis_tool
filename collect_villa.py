"""
국토교통부 연립·다세대(빌라) 매매 + 전월세 실거래자료 수집기
─────────────────────────────────────────────────────
아파트 수집기(src/collector.py, collect_rent.py)와 동일한 국토부 서비스의
'연립다세대' 엔드포인트를 쓴다 — 인증키·요청 방식·rate limit 대응이 모두 같다.

- 매매: 구(법정동코드) × 월(YYYYMM) 전 기간(2020~) → data/villa_trade/*.parquet
- 전월세: 최근 30개월(전세가율용)          → data/villa_rent/*.parquet
- 체크포인트: 이미 수집된 구+월은 스킵, 최근 2개월은 늦은 신고 반영 위해 재수집

빌라는 아파트와 달리 단지 단위 분석이 불가능(거래 희소)하므로, 하류 분석
(src/villa_analysis.py)은 법정동(동네) 단위로 집계한다.

실행: python collect_villa.py
  - MOLIT_API_KEY 필요 (아파트와 동일 키). data.go.kr에서
    「국토교통부_연립다세대 매매 실거래가 자료」와
    「국토교통부_연립다세대 전월세 실거래가 자료」 활용신청이 되어 있어야 한다.
"""

import os
import time
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed, CancelledError
from datetime import date
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

TRADE_DIR = ROOT / "data" / "villa_trade"
RENT_DIR = ROOT / "data" / "villa_rent"
TRADE_DIR.mkdir(parents=True, exist_ok=True)
RENT_DIR.mkdir(parents=True, exist_ok=True)

TRADE_URL = "http://apis.data.go.kr/1613000/RTMSDataSvcRHTrade/getRTMSDataSvcRHTrade"
RENT_URL = "http://apis.data.go.kr/1613000/RTMSDataSvcRHRent/getRTMSDataSvcRHRent"

PAGE_SIZE = 1000
RENT_MONTHS_BACK = 30       # 전세가율은 최근 12개월만 쓰므로 30개월이면 충분
REFRESH_RECENT_MONTHS = 2   # 신고 지연(계약 후 30일) 보정
WORKERS = 4
TIME_BUDGET_SEC = 45 * 60   # 매매+전월세 합산 예산 — 남은 조합은 다음 실행이 이어받음


class VillaApiForbidden(Exception):
    """403 — 활용신청 미승인/미반영. 재시도해도 안 풀리므로 즉시 전체 중단."""
    pass


def _fetch_page(url_base: str, api_key: str, code: str, ym: str, page: int) -> dict:
    url = (f"{url_base}?serviceKey={api_key}&LAWD_CD={code}&DEAL_YMD={ym}"
           f"&pageNo={page}&numOfRows={PAGE_SIZE}")
    for attempt in range(config.API_RETRY_COUNT):
        try:
            resp = requests.get(url, timeout=30)
            if resp.status_code == 403:
                raise VillaApiForbidden(f"403 Forbidden: {code} {ym} — 연립다세대 활용신청 반영 전일 수 있습니다.")
            resp.raise_for_status()
            return _xml_response_to_dict(resp.content)
        except VillaApiForbidden:
            raise
        except Exception as e:
            wait = config.API_RETRY_BACKOFF ** attempt
            log.warning(f"재시도 {attempt+1}/{config.API_RETRY_COUNT} ({wait:.0f}s): {e}")
            time.sleep(wait)
    raise RuntimeError(f"빌라 API 실패: {code} {ym} p={page}")


def _normalize(df: pd.DataFrame, kind: str) -> pd.DataFrame:
    rename = {
        "mhouseNm": "bldg_name", "buildYear": "build_year",
        "dealAmount": "amount", "deposit": "deposit", "monthlyRent": "monthly_rent",
        "excluUseAr": "area_exclusive", "contractType": "contract_type",
        "dealYear": "deal_year", "dealMonth": "deal_month", "dealDay": "deal_day",
        "umdNm": "umd_name", "jibun": "jibun", "floor": "floor",
        "cdealType": "cancel_type",
    }
    df = df.rename(columns={k: v for k, v in rename.items() if k in df.columns})
    for col in ("amount", "deposit", "monthly_rent"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col].astype(str).str.replace(",", "").str.strip(), errors="coerce")
    for col in ("build_year", "deal_year", "deal_month", "deal_day", "floor"):
        if col in df.columns:
            df[col] = pd.to_numeric(df[col], errors="coerce", downcast="integer")
    if "area_exclusive" in df.columns:
        df["area_exclusive"] = pd.to_numeric(df["area_exclusive"], errors="coerce").astype("float32")
    for col in ("bldg_name", "umd_name"):
        if col in df.columns:
            df[col] = df[col].astype("category")
    return df


def _collect_month(url_base: str, out_dir: Path, kind: str,
                   api_key: str, code: str, ym: str, force: bool = False) -> pd.DataFrame:
    path = out_dir / f"{code}_{ym}.parquet"
    if path.exists() and not force:
        return pd.read_parquet(path)
    items, page = [], 1
    while True:
        raw = _fetch_page(url_base, api_key, code, ym, page)
        page_items, total = _parse_items(raw)
        items.extend(page_items)
        if not page_items or len(items) >= total:
            break
        page += 1
        time.sleep(0.2)
    if not items:
        df = pd.DataFrame()
    else:
        df = _normalize(pd.DataFrame(items), kind)
        df["district_code"] = code
        df["deal_ym"] = ym
    df.to_parquet(path, index=False)
    return df


def _diagnose(name: str, url_base: str, api_key: str) -> bool:
    """이 키로 해당 엔드포인트가 호출 가능한지 1건 요청으로 자가진단."""
    code = next(iter(config.DISTRICTS.values()))
    url = f"{url_base}?serviceKey={api_key}&LAWD_CD={code}&DEAL_YMD=202601&pageNo=1&numOfRows=1"
    try:
        resp = requests.get(url, timeout=30)
    except Exception as e:
        log.warning(f"[진단] {name} 연결 실패: {e}")
        return False
    head = resp.text[:300].replace("\n", " ")
    log.info(f"[진단] {name} 응답: HTTP {resp.status_code} / {head}")
    if resp.status_code == 403:
        log.error(f"[진단] ⚠️ {name} 403 — data.go.kr에서 「국토교통부_연립다세대 {name} 실거래가 자료」"
                  f" 활용신청·승인 상태를 확인해주세요 (승인 후 반영까지 수 분~몇 시간).")
        return False
    if resp.status_code != 200:
        return False
    up = resp.text.upper()
    if "NOT_REGISTERED" in up or ("SERVICE_KEY" in up and "ERROR" in up):
        log.error(f"[진단] ⚠️ 이 키로 연립다세대 {name} API가 활용신청되어 있지 않습니다.")
        return False
    ok = "<item>" in resp.text or "totalCount" in resp.text
    if ok:
        log.info(f"[진단] ✅ {name} 정상 — 수집 시작")
    return ok


def _run(kind: str, url_base: str, out_dir: Path, api_key: str,
         months: list, deadline: float) -> None:
    today_ym = f"{date.today().year}{date.today().month:02d}"
    past = [m for m in months if m <= today_ym]
    refresh = set(past[-REFRESH_RECENT_MONTHS:])
    tasks = [(n, c, ym) for n, c in config.DISTRICTS.items() for ym in months]
    n_new = sum(1 for _, c, ym in tasks
                if not (out_dir / f"{c}_{ym}.parquet").exists() or ym in refresh)
    log.info(f"빌라 {kind} 대상: {len(config.DISTRICTS)}구 × {len(months)}개월 = {len(tasks)}회 "
             f"(이번에 받을 것 ~{n_new}회)")

    n, stop, left, done = 0, False, 0, 0
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(_collect_month, url_base, out_dir, kind, api_key, c, ym, ym in refresh): (nm, ym)
                for nm, c, ym in tasks}
        for fut in tqdm(as_completed(futs), total=len(futs), desc=f"빌라 {kind}", miniters=25):
            nm, ym = futs[fut]
            done += 1
            if not stop and time.monotonic() > deadline:
                stop = True
                left = len(tasks) - done
                log.warning(f"[시간 예산 소진] 남은 ~{left}개는 다음 실행이 체크포인트에서 이어받습니다.")
                for f in futs:
                    f.cancel()
            try:
                n += len(fut.result())
            except CancelledError:
                pass
            except VillaApiForbidden as e:
                if not stop:
                    stop = True
                    log.error(f"[중단] {e}")
                    for f in futs:
                        f.cancel()
            except Exception as e:
                log.error(f"{nm} {ym} 실패: {e}")
    log.info(f"빌라 {kind} 종료 (이번 실행 {n:,}건, 미처리 ~{left}개)")


def main():
    api_key = os.getenv("MOLIT_API_KEY")
    if not api_key:
        raise EnvironmentError("MOLIT_API_KEY 환경변수가 없습니다 (아파트와 동일 키).")

    deadline = time.monotonic() + TIME_BUDGET_SEC
    all_months = _month_range(config.START_YEAR_MONTH, config.END_YEAR_MONTH)

    if _diagnose("매매", TRADE_URL, api_key):
        _run("매매", TRADE_URL, TRADE_DIR, api_key, all_months, deadline)
    else:
        log.error("연립다세대 매매 API가 막혀 있어 건너뜁니다 — 활용신청 후 재실행하세요.")

    if _diagnose("전월세", RENT_URL, api_key):
        _run("전월세", RENT_URL, RENT_DIR, api_key, all_months[-RENT_MONTHS_BACK:], deadline)
    else:
        log.error("연립다세대 전월세 API가 막혀 있어 건너뜁니다 — 활용신청 후 재실행하세요.")


if __name__ == "__main__":
    main()
