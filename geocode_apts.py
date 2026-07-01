"""
아파트 좌표 + 최근접 지하철역 수집 (Kakao Local API)
─────────────────────────────────────────────────────
분석 대상 단지(composite_score.json)의 지번 주소를 지오코딩하고,
반경 내 지하철역(SW8)을 조회해 data/static/apt_locations.json 캐시로 저장.

실행: python geocode_apts.py
  - .env에 KAKAO_REST_KEY 필요 (https://developers.kakao.com REST API 키)
  - API는 이 스크립트에서만 호출. 이후 파이프라인(build_data.py)은
    캐시 파일만 읽으므로 오프라인 동작.
  - 재실행 시 이미 수집된 단지는 건너뜀 (증분 수집).
"""

import json
import time
import sys
from pathlib import Path

import pandas as pd
import requests

ROOT = Path(__file__).parent
CACHE = ROOT / "data" / "static" / "apt_locations.json"
RADIUS_M = 1500          # 역 탐색 반경
NEAR_M = 1000            # "역세권" 집계 반경

DISTRICTS = {
    '11440': '마포구', '11170': '용산구', '11200': '성동구',
    '11215': '광진구', '11230': '동대문구', '11380': '은평구',
    '11410': '서대문구', '11470': '양천구', '11500': '강서구',
    '11560': '영등포구', '11590': '동작구', '11620': '관악구',
    '11740': '강동구', '11110': '종로구',
}


def load_key() -> str:
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("KAKAO_REST_KEY="):
                return line.split("=", 1)[1].strip()
    print("ERROR: .env에 KAKAO_REST_KEY가 없습니다.")
    sys.exit(1)


def kakao_get(session: requests.Session, url: str, params: dict) -> dict:
    for attempt in range(3):
        r = session.get(url, params=params, timeout=10)
        if r.status_code == 200:
            return r.json()
        if r.status_code == 429:          # rate limit
            time.sleep(1 + attempt)
            continue
        r.raise_for_status()
    raise RuntimeError(f"Kakao API 반복 실패: {url}")


def representative_address(raw: pd.DataFrame, apt_name: str, district: str) -> str | None:
    """단지의 최빈 (법정동, 지번) → 지번 주소 문자열"""
    sub = raw[(raw["apt_name"] == apt_name) & (raw["district_name"] == district)]
    if sub.empty:
        return None
    top = sub.groupby(["umd_name", "jibun"]).size().idxmax()
    umd, jibun = top
    jibun = str(jibun).strip()
    return f"서울 {district} {umd} {jibun}".strip()


def main():
    key = load_key()
    session = requests.Session()
    session.headers["Authorization"] = f"KakaoAK {key}"

    # 분석 대상 단지 목록
    comp = json.loads((ROOT / "data/processed/composite_score.json").read_text(encoding="utf-8"))
    targets = [(r["apt_name"], r["district"]) for r in comp["ranking"]]

    # 원본에서 주소 추출용 로드
    print("원본 데이터 로드 중...")
    dfs = [pd.read_parquet(f) for f in sorted((ROOT / "data/raw").glob("*.parquet"))]
    raw = pd.concat(dfs, ignore_index=True)
    raw["district_name"] = raw["district_code"].astype(str).map(DISTRICTS)

    # 기존 캐시 로드 (증분)
    cache: dict = {}
    if CACHE.exists():
        cache = json.loads(CACHE.read_text(encoding="utf-8"))

    ok = fail = skip = 0
    for apt_name, district in targets:
        cache_key = f"{district}|{apt_name}"
        if cache_key in cache and cache[cache_key].get("lat"):
            skip += 1
            continue

        addr = representative_address(raw, apt_name, district)
        entry = {"apt_name": apt_name, "district": district, "address": addr,
                 "lat": None, "lng": None,
                 "nearest_station": None, "nearest_station_m": None,
                 "stations_within_1km": 0}

        # 1차: 지번 주소 검색
        lat = lng = None
        if addr:
            try:
                res = kakao_get(session, "https://dapi.kakao.com/v2/local/search/address.json",
                                {"query": addr})
                docs = res.get("documents", [])
                if docs:
                    lat, lng = float(docs[0]["y"]), float(docs[0]["x"])
            except Exception as e:
                print(f"  주소검색 오류 [{addr}]: {e}")

        # 2차 폴백: 키워드 검색 (단지명)
        if lat is None:
            try:
                res = kakao_get(session, "https://dapi.kakao.com/v2/local/search/keyword.json",
                                {"query": f"서울 {district} {apt_name}", "size": 3})
                docs = res.get("documents", [])
                if docs:
                    lat, lng = float(docs[0]["y"]), float(docs[0]["x"])
            except Exception as e:
                print(f"  키워드검색 오류 [{apt_name}]: {e}")

        if lat is None:
            print(f"  ✗ 좌표 실패: {district} {apt_name} ({addr})")
            cache[cache_key] = entry
            fail += 1
            continue

        entry["lat"], entry["lng"] = lat, lng

        # 지하철역 검색 (거리순)
        try:
            res = kakao_get(session, "https://dapi.kakao.com/v2/local/search/category.json",
                            {"category_group_code": "SW8", "x": lng, "y": lat,
                             "radius": RADIUS_M, "sort": "distance", "size": 15})
            docs = res.get("documents", [])
            if docs:
                entry["nearest_station"] = docs[0]["place_name"]
                entry["nearest_station_m"] = int(docs[0]["distance"])
                entry["stations_within_1km"] = sum(1 for d in docs if int(d["distance"]) <= NEAR_M)
        except Exception as e:
            print(f"  역검색 오류 [{apt_name}]: {e}")

        st = entry["nearest_station"] or "역 없음(1.5km)"
        print(f"  ✓ {district} {apt_name}: {st} {entry['nearest_station_m'] or '-'}m")
        cache[cache_key] = entry
        ok += 1
        time.sleep(0.15)      # rate limit 여유

    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n완료: 신규 {ok}, 실패 {fail}, 스킵 {skip} → {CACHE}")
    print("이제 python build_data.py 를 다시 실행하면 교통 축이 반영됩니다.")


if __name__ == "__main__":
    main()
