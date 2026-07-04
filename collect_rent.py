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
from concurrent.futures import ThreadPoolExecutor, as_completed, CancelledError
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

# 전월세는 매매보다 건수가 많아 페이지가 여러 번 돈다 — 100건/페이지로는 조합당
# ~5초씩 걸려 전체 2.6시간이 나왔다(실측). 국토부 API는 numOfRows 1000까지
# 허용하므로 크게 잡아 요청 횟수를 1/10로 줄인다.
RENT_PAGE_SIZE = 1000

# 전세가율 계산은 최근 18개월만 사용 — 넉넉히 최근 30개월만 수집한다.
# 25개 구 × 30개월 = 750회 (78개월 전체의 1950회 대비 ~40%).
RENT_MONTHS_BACK = 30

# 동시 요청 수. 국토부 API가 요청당 느려 순차로는 오래 걸린다. 과하면 429가
# 날 수 있어 보수적으로 4로 둔다(백오프가 있어 429가 나도 실패하진 않음).
WORKERS = 4

# GitHub Actions 스텝 타임아웃(60분)에 걸리면 job이 실패해 그때까지 모은
# 체크포인트가 커밋되지 못하고 통째로 날아간다(실제 발생). 스텝 타임아웃보다
# 먼저 스스로 정상 종료해 뒷단계(커밋·푸시)가 돌게 하고, 남은 조합은 다음
# 실행이 체크포인트에서 이어받는다.
TIME_BUDGET_SEC = 50 * 60


class RentApiForbidden(Exception):
    """403 Forbidden — 활용신청/승인 문제로 재시도해도 풀리지 않는 오류.
    네트워크 일시 오류와 달리 즉시 전파해 호출부에서 전체 수집을 중단시킨다."""
    pass


def _fetch_rent_page(api_key: str, district_code: str, ym: str, page: int) -> dict:
    url = (
        f"{RENT_API_URL}?serviceKey={api_key}"
        f"&LAWD_CD={district_code}&DEAL_YMD={ym}"
        f"&pageNo={page}&numOfRows={RENT_PAGE_SIZE}"
    )
    for attempt in range(config.API_RETRY_COUNT):
        try:
            resp = requests.get(url, timeout=30)
            if resp.status_code == 403:
                # 권한 문제(활용신청 미승인/미반영)는 재시도해도 절대 안 풀린다 —
                # 1950개 구×월 조합마다 5번씩 재시도하며 몇 시간을 낭비하지 않도록
                # 여기서 즉시 예외를 던져 상위에서 전체 수집을 멈추게 한다.
                raise RentApiForbidden(
                    f"403 Forbidden: {district_code} {ym} — 활용신청이 아직 반영되지 않았을 수 있습니다."
                )
            resp.raise_for_status()
            return _xml_response_to_dict(resp.content)
        except RentApiForbidden:
            raise
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


def _diagnose(api_key: str) -> bool:
    """전월세 API가 이 키로 호출 가능한지 첫 요청으로 확인해 로그에 남긴다.
    True(정상)/False(막힘) 반환 — 막혔으면 호출부가 전체 수집을 건너뛰어
    1950개 조합 × 5회 재시도로 몇 시간을 낭비하지 않게 한다."""
    code = next(iter(config.DISTRICTS.values()))
    url = (f"{RENT_API_URL}?serviceKey={api_key}&LAWD_CD={code}"
           f"&DEAL_YMD={config.END_YEAR_MONTH}&pageNo=1&numOfRows=1")
    try:
        resp = requests.get(url, timeout=30)
    except Exception as e:
        log.warning(f"[진단] 전월세 API 연결 실패: {e}")
        return False

    head = resp.text[:400].replace("\n", " ")
    log.info(f"[진단] 전월세 API 응답: HTTP {resp.status_code} / {head}")

    if resp.status_code == 403:
        log.error(
            "[진단] ⚠️ HTTP 403 Forbidden — 활용신청이 승인은 됐지만 아직 반영 전이거나,\n"
            "        신청한 API가 '아파트 전월세'가 맞는지(매매와 이름이 비슷해 헷갈리기 쉬움)\n"
            "        다시 확인이 필요합니다. data.go.kr 마이페이지 > 활용신청 현황에서\n"
            "        '국토교통부_아파트 전월세 실거래가' 승인 상태를 확인해주세요.\n"
            "        보통 승인 후 반영까지 짧게는 수 분, 길게는 몇 시간 걸릴 수 있습니다."
        )
        return False
    if resp.status_code != 200:
        log.error(f"[진단] ⚠️ 예상치 못한 응답(HTTP {resp.status_code}) — 원인 파악 필요.")
        return False
    low = resp.text.upper()
    if ("NOT_REGISTERED" in low) or ("SERVICE_KEY" in low and "ERROR" in low):
        log.error("[진단] ⚠️ 이 인증키로 '아파트 전월세' API가 활용신청되어 있지 않은 것 같습니다.\n"
                  "        data.go.kr → '국토교통부_아파트 전월세 실거래가' 검색 → 활용신청 후 재실행하세요.")
        return False
    if "<item>" in resp.text or "totalCount" in resp.text:
        log.info("[진단] ✅ 전월세 API 정상 호출 가능 — 수집을 시작합니다.")
        return True
    log.warning("[진단] 응답 형태를 알 수 없습니다 — 위 head를 참고해 원인 파악이 필요합니다.")
    return False


def main():
    api_key = os.getenv("MOLIT_API_KEY")
    if not api_key:
        raise EnvironmentError("MOLIT_API_KEY 환경변수가 없습니다 (매매 수집과 동일 키).")

    if not _diagnose(api_key):
        log.error("전월세 API 호출이 막혀 있어 수집을 건너뜁니다. 위 진단 메시지를 확인해주세요. "
                   "(전세가율 축은 다음 실행에서 다시 시도됩니다)")
        return

    # 전세가율은 '최근 18개월' 전세 중앙값만 쓰므로, 2020년부터 78개월을 다 받을
    # 필요가 없다. 넉넉히 최근 RENT_MONTHS_BACK개월만 수집해 요청 수를 1/3로 줄인다
    # (국토부 API가 요청당 ~3~4초로 느려, 개월 수가 전체 소요시간을 좌우함).
    all_months = _month_range(config.START_YEAR_MONTH, config.END_YEAR_MONTH)
    months = all_months[-RENT_MONTHS_BACK:]
    tasks = [(name, code, ym) for name, code in config.DISTRICTS.items() for ym in months]
    log.info(f"전월세 수집 대상: {len(config.DISTRICTS)}개 구 × 최근 {len(months)}개월"
             f"({months[0]}~{months[-1]}) = {len(tasks)}회 (체크포인트 스킵 포함)")

    # 국토부 API가 요청당 ~3~4초로 느려 순차 처리는 750회에 ~50분이 걸린다.
    # 각 (구,월)이 서로 다른 parquet 파일을 쓰므로 스레드 안전 — 소수 동시요청으로
    # 벽시계 시간을 크게 줄인다. 429가 나면 _fetch_rent_page의 백오프가 처리한다.
    start = time.monotonic()
    n = 0
    left = 0
    done = 0
    stop = False
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(_collect_rent_month, api_key, code, ym): (name, ym)
                for name, code, ym in tasks}
        for fut in tqdm(as_completed(futs), total=len(futs), desc="전월세 수집", miniters=25):
            name, ym = futs[fut]
            done += 1
            if not stop and time.monotonic() - start > TIME_BUDGET_SEC:
                stop = True
                left = len(tasks) - done
                log.warning(f"[시간 예산 소진] {TIME_BUDGET_SEC//60}분 경과 — 남은 ~{left}개는 "
                            f"다음 실행이 체크포인트에서 이어받습니다. (지금까지 수집분은 정상 커밋됨)")
                for f in futs:
                    f.cancel()
            try:
                df = fut.result()
                n += len(df)
            except CancelledError:
                pass
            except RentApiForbidden as e:
                if not stop:
                    stop = True
                    log.error(f"[중단] {e}\n권한 문제는 재시도해도 안 풀려 남은 조합을 건너뜁니다.")
                    for f in futs:
                        f.cancel()
            except Exception as e:
                log.error(f"{name} {ym} 실패: {e}")
    log.info(f"전월세 수집 종료 (이번 실행 {n:,}건, 미처리 ~{left}개 조합, data/rent/)")


if __name__ == "__main__":
    main()
