"""
학군 프록시용 학교·학원 좌표 수집 (Overpass API, 1회)
─────────────────────────────────────────────────────
서울 지역의 ① 초등학교와 ② 학원 좌표를 OpenStreetMap Overpass에서 수집해
data/static/schools.json 캐시로 저장한다. subway_stations 수집과 동일한 방식.

이후 build_data.py(→ src/scorer._school)가 이 캐시만 읽어, 단지별로
  · 가장 가까운 초등학교 직선거리(초품아)
  · 반경 1km 내 학원 수(학원가 밀집도)
를 계산해 '학군' 축으로 반영한다.

⚠️ 공식 학업성취도·명문중 배정 데이터는 비공개라 반영 불가 — 여기서 얻는 것은
   "초등학교 근접 + 학원가 밀집"이라는 정량 프록시일 뿐이다.

실행: python collect_schools.py  (API 키 불필요, 무료. 재실행 시 캐시 있으면 스킵)
"""

import json
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "static" / "schools.json"
UA = {"User-Agent": "seoul-apt-analysis/1.0 (personal research)"}

# 서울 대략 bbox (지하철역 수집과 동일 범위)
BBOX = "37.42,126.75,37.72,127.20"
OVERPASS = "https://overpass-api.de/api/interpreter"


def _fetch(query: str) -> list[dict]:
    r = requests.post(OVERPASS, data={"data": query}, headers=UA, timeout=120)
    r.raise_for_status()
    elements = r.json().get("elements", [])
    seen = {}
    for e in elements:
        name = e.get("tags", {}).get("name", "")
        # way/relation은 center 좌표 사용
        lat = e.get("lat") or e.get("center", {}).get("lat")
        lng = e.get("lon") or e.get("center", {}).get("lon")
        if lat is None or lng is None:
            continue
        key = (name, round(lat, 4), round(lng, 4))
        seen[key] = {"name": name, "lat": lat, "lng": lng}
    return list(seen.values())


def collect() -> dict:
    # 이미 수집돼 있으면 스킵 (증분)
    if OUT.exists():
        cached = json.loads(OUT.read_text(encoding="utf-8"))
        if cached.get("elementary"):
            print(f"이미 수집됨: 초등 {len(cached['elementary'])}, "
                  f"학원 {len(cached.get('academy', []))} → {OUT} (스킵)")
            return cached

    print("초등학교 좌표 수집 중 (Overpass)...")
    elem_q = f"""
    [out:json][timeout:90];
    (
      node["amenity"="school"]["isced:level"~"1"]({BBOX});
      node["amenity"="school"]["name"~"초등학교"]({BBOX});
      way["amenity"="school"]["name"~"초등학교"]({BBOX});
    );
    out center;
    """
    elementary = _fetch(elem_q)
    print(f"  초등학교 {len(elementary)}개")

    print("학원 좌표 수집 중 (Overpass)...")
    # 한국 학원은 name에 '학원'이 들어가는 경우가 대다수 — 이름 정규식으로 폭넓게 수집
    aca_q = f"""
    [out:json][timeout:90];
    (
      node["name"~"학원"]({BBOX});
      node["amenity"="prep_school"]({BBOX});
    );
    out body;
    """
    academy = _fetch(aca_q)
    print(f"  학원 {len(academy)}개")

    if len(elementary) < 50:
        print(f"경고: 초등학교가 {len(elementary)}개만 수집됨 — Overpass 응답 확인 필요")

    result = {"bbox": BBOX, "elementary": elementary, "academy": academy}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"저장 → {OUT}")
    print("이제 python build_data.py 를 실행하면 학군 축이 반영됩니다.")
    return result


if __name__ == "__main__":
    try:
        collect()
    except Exception as e:
        print(f"학교 수집 실패: {e}", file=sys.stderr)
        sys.exit(1)
