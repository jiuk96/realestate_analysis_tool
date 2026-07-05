"""
공공데이터포털 학원 좌표 수집 (학군 '학원가 밀집도' 축 정밀화)
─────────────────────────────────────────────────────
소상공인시장진흥공단_상가(상권)정보 'storeListInRadius' API로, 분석 단지
좌표 반경 내의 '학원' 업소를 좌표째 수집한다. OSM 학원 데이터(서울 439곳,
매우 얇음)를 공공데이터포털의 전수 상가정보로 대체해 대치·목동 같은 학원가
밀집이 정확히 잡히게 한다.

- 인증키: MOLIT_API_KEY 재사용 (data.go.kr 계정 공통 인증키). 단, 이 API를
  data.go.kr에서 '활용신청' 해야 한다 → "소상공인시장진흥공단_상가(상권)정보".
- 분석 단지(apt_locations.json)마다 반경 1.2km 상가를 페이징 수집 →
  업종/상호명에 '학원·교습'이 들어가는 업소만 남겨 bizesId로 전역 중복 제거.
- 결과: data/static/academies.json {academy:[{name,lat,lng,cat}], ...}
  이후 build_data.py(→ scorer._school)가 이 점집합으로 단지별 1km 학원 수를
  계산한다(초등학교는 기존 schools.json 유지).

실행: python collect_academies.py  (GitHub Actions에서 geocode 뒤에 실행)
"""

import os
import json
import time
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed, CancelledError
from pathlib import Path

import requests
from dotenv import load_dotenv
from tqdm import tqdm

import sys
ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
import config

load_dotenv()
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(__name__)

LOC_CACHE = ROOT / "data" / "static" / "apt_locations.json"
OUT = ROOT / "data" / "static" / "academies.json"

API_URL = "http://apis.data.go.kr/B553077/api/open/sdsc2/storeListInRadius"
RADIUS_M = 1200          # 단지 반경 (학군 밀집도는 1km 기준이나 경계 여유로 1.2km 수집)
PAGE_SIZE = 1000
WORKERS = 6
TIME_BUDGET_SEC = 25 * 60


class ApiForbidden(Exception):
    """403 — 활용신청 미승인/미반영. 재시도해도 안 풀려 전체 수집을 중단시킨다."""
    pass


def _is_academy(item: dict) -> bool:
    """상가 업소가 '학원·교습소'인지 판정 — 업종코드가 분류 개편으로 바뀌어도
    견고하도록 업종명/상호명 문자열로 판별한다."""
    text = " ".join(str(item.get(k, "")) for k in
                    ("indsLclsNm", "indsMclsNm", "indsSclsNm", "ksicNm", "bizesNm"))
    return ("학원" in text) or ("교습" in text)


def _fetch_page(api_key: str, cx: float, cy: float, page: int) -> tuple[list, int]:
    url = (f"{API_URL}?serviceKey={api_key}&type=json"
           f"&radius={RADIUS_M}&cx={cx}&cy={cy}"
           f"&numOfRows={PAGE_SIZE}&pageNo={page}")
    for attempt in range(config.API_RETRY_COUNT):
        try:
            resp = requests.get(url, timeout=30)
            if resp.status_code == 403:
                raise ApiForbidden("403 Forbidden — '소상공인 상가정보' 활용신청 미반영 가능성")
            resp.raise_for_status()
            data = resp.json()
            body = data.get("body", data)
            items = body.get("items", []) or []
            if isinstance(items, dict):        # 단건이면 dict로 오는 경우 방어
                items = [items]
            total = int(body.get("totalCount", len(items)) or 0)
            return items, total
        except ApiForbidden:
            raise
        except Exception as e:
            wait = config.API_RETRY_BACKOFF ** attempt
            log.warning(f"재시도 {attempt+1}/{config.API_RETRY_COUNT} ({wait:.0f}s): {e}")
            time.sleep(wait)
    raise RuntimeError(f"상가정보 API 실패: cx={cx} cy={cy} p={page}")


def _collect_around(api_key: str, cx: float, cy: float) -> list[dict]:
    """한 좌표 반경의 학원 업소 목록 (여러 페이지)."""
    out, page = [], 1
    while True:
        items, total = _fetch_page(api_key, cx, cy, page)
        for it in items:
            if not _is_academy(it):
                continue
            lat = it.get("lat") or it.get("y")
            lng = it.get("lon") or it.get("lng") or it.get("x")
            if lat is None or lng is None:
                continue
            out.append({
                "id": it.get("bizesId") or f"{it.get('bizesNm')}_{lat}_{lng}",
                "name": it.get("bizesNm", ""),
                "lat": float(lat), "lng": float(lng),
                "cat": it.get("indsSclsNm") or it.get("indsMclsNm") or "",
            })
        if not items or page * PAGE_SIZE >= total:
            break
        page += 1
        time.sleep(0.15)
    return out


def _diagnose(api_key: str) -> bool:
    """첫 좌표로 API 호출 가능 여부 확인 후 로그에 남긴다."""
    loc = json.loads(LOC_CACHE.read_text(encoding="utf-8"))
    sample = next((v for v in loc.values() if v.get("lat") and v.get("lng")), None)
    if not sample:
        log.error("[진단] apt_locations.json에 좌표가 없습니다 — geocode를 먼저 실행하세요.")
        return False
    url = (f"{API_URL}?serviceKey={api_key}&type=json&radius=500"
           f"&cx={sample['lng']}&cy={sample['lat']}&numOfRows=1&pageNo=1")
    try:
        resp = requests.get(url, timeout=30)
    except Exception as e:
        log.warning(f"[진단] 상가정보 API 연결 실패: {e}")
        return False
    head = resp.text[:300].replace("\n", " ")
    log.info(f"[진단] 상가정보 API 응답: HTTP {resp.status_code} / {head}")
    if resp.status_code == 403:
        log.error("[진단] ⚠️ HTTP 403 — data.go.kr에서 '소상공인시장진흥공단_상가(상권)정보'\n"
                  "        활용신청 승인/반영 여부를 확인해주세요(동일 인증키 사용).")
        return False
    if resp.status_code != 200:
        log.error(f"[진단] ⚠️ 예상치 못한 응답(HTTP {resp.status_code}).")
        return False
    up = resp.text.upper()
    if "SERVICE_KEY" in up and "ERROR" in up:
        log.error("[진단] ⚠️ 이 인증키로 상가정보 API가 활용신청되어 있지 않습니다.")
        return False
    log.info("[진단] ✅ 상가정보 API 정상 — 학원 수집을 시작합니다.")
    return True


def main():
    api_key = os.getenv("MOLIT_API_KEY")
    if not api_key:
        raise EnvironmentError("MOLIT_API_KEY 환경변수가 없습니다 (data.go.kr 공통 인증키).")
    if not LOC_CACHE.exists():
        log.error("apt_locations.json 없음 — geocode_apts.py를 먼저 실행하세요.")
        return
    if not _diagnose(api_key):
        log.error("상가정보 API 호출이 막혀 학원 수집을 건너뜁니다(학군 학원 밀집도는 "
                  "OSM 데이터로 대체 유지). 위 진단 메시지를 확인해주세요.")
        return

    loc = json.loads(LOC_CACHE.read_text(encoding="utf-8"))
    coords = [(v["lng"], v["lat"]) for v in loc.values() if v.get("lat") and v.get("lng")]
    # 좌표 소수4자리(≈11m)로 반올림해 사실상 같은 위치 중복 쿼리 제거
    seen_pts, uniq = set(), []
    for cx, cy in coords:
        k = (round(cx, 4), round(cy, 4))
        if k not in seen_pts:
            seen_pts.add(k); uniq.append((cx, cy))
    log.info(f"학원 수집 대상 좌표 {len(uniq)}개 (단지 {len(coords)}개 중 중복 제거)")

    academies: dict = {}
    start = time.monotonic()
    done = left = 0
    stop = False
    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(_collect_around, api_key, cx, cy): (cx, cy) for cx, cy in uniq}
        for fut in tqdm(as_completed(futs), total=len(futs), desc="학원 수집", miniters=20):
            done += 1
            if not stop and time.monotonic() - start > TIME_BUDGET_SEC:
                stop = True
                left = len(uniq) - done
                log.warning(f"[시간 예산 소진] 남은 ~{left}개 좌표는 이번엔 건너뜁니다 "
                            f"(지금까지 모은 학원은 저장됨).")
                for f in futs:
                    f.cancel()
            try:
                for a in fut.result():
                    academies[a["id"]] = a
            except CancelledError:
                pass
            except ApiForbidden as e:
                if not stop:
                    stop = True
                    log.error(f"[중단] {e}")
                    for f in futs:
                        f.cancel()
            except Exception as e:
                log.error(f"좌표 실패: {e}")

    academy_list = list(academies.values())
    result = {"source": "sodsc_storeListInRadius", "radius_m": RADIUS_M,
              "count": len(academy_list), "academy": academy_list}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info(f"학원 {len(academy_list):,}곳 저장 → {OUT} "
             f"(미처리 ~{left}개 좌표)")
    print("이제 python build_data.py 를 실행하면 학군 학원 밀집도가 공공데이터로 반영됩니다.")


if __name__ == "__main__":
    main()
