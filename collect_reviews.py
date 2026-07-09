"""
단지별 '실제 이야기' 해시태그 수집 — 네이버 검색 OpenAPI (블로그+카페)
─────────────────────────────────────────────────────
호갱노노·네이버부동산 리뷰를 직접 크롤링하는 것은 약관 위반이라,
공식 검색 API로 각 단지가 언급된 블로그·카페 글(제목+요약)을 받아
부동산 어휘 사전과 대조해 자주 나오는 이야기를 해시태그 5개로 요약한다.

필요 키 (developers.naver.com → 애플리케이션 등록 → '검색' API 사용 설정):
  NAVER_CLIENT_ID / NAVER_CLIENT_SECRET
키가 없으면 조용히 종료(best-effort). 일 25,000회 무료 — 394단지 × 2회면 충분.

출력: data/processed/apt_reviews.json
  {"updated":…, "apartments":{"구|단지":{"tags":[["주차",12],…], "n_posts":60}}}
"""

import json
import os
import re
import sys
import time
from datetime import date
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "processed" / "apt_reviews.json"

CID = os.environ.get("NAVER_CLIENT_ID", "").strip()
CSEC = os.environ.get("NAVER_CLIENT_SECRET", "").strip()

# 부동산 커뮤니티에서 실제로 갈리는 이야기들 — 태그: 매칭 패턴
TAG_VOCAB = {
    "주차": r"주차",
    "초품아": r"초품아|초등학교|학군",
    "학원가": r"학원가|학원",
    "역세권": r"역세권|더블역세권|도보\s?\d?\d?분?\s?거리?\s?역|지하철",
    "언덕": r"언덕|경사|오르막|비탈",
    "층간소음": r"층간\s?소음",
    "소음": r"소음|시끄럽|도로변|철로",
    "조용한동네": r"조용|한적",
    "리모델링": r"리모델링",
    "재건축": r"재건축|안전진단|정밀진단",
    "재개발": r"재개발|모아타운|신속통합",
    "커뮤니티좋음": r"커뮤니티|헬스장|수영장|골프연습장|사우나",
    "곰팡이결로": r"곰팡이|결로",
    "누수녹물": r"누수|녹물|배관",
    "신축급": r"신축|새\s?아파트|입주\s?\d년",
    "구축": r"구축|연식|오래된",
    "대단지": r"대단지",
    "숲세권공원": r"공원|숲세권|산책로?|둘레길",
    "한강뷰": r"한강\s?뷰|리버뷰|한강\s?조망",
    "조망좋음": r"뷰\s?맛집|조망|탁\s?트인",
    "상권편의": r"상권|편의시설|먹자골목|백화점|마트",
    "병원인접": r"대학병원|종합병원",
    "관리비": r"관리비",
    "갭투자언급": r"갭투자|갭이",
    "월패드보안": r"보안|경비",
    "동간거리": r"동간\s?거리|용적률",
    "복도식": r"복도식",
    "계단식": r"계단식",
    "올수리": r"올수리|올\s?리모델링|풀수리",
    "급매언급": r"급매",
}
_PATS = {t: re.compile(p) for t, p in TAG_VOCAB.items()}
_TAGRE = re.compile(r"<[^>]+>")   # 검색 API 응답의 <b> 강조 태그 제거

MIN_COUNT = 2   # 2회 미만 언급은 우연일 수 있어 태그로 채택하지 않음
TOP_N = 5


def _search(endpoint: str, query: str) -> list:
    r = requests.get(
        f"https://openapi.naver.com/v1/search/{endpoint}.json",
        params={"query": query, "display": 30, "sort": "sim"},
        headers={"X-Naver-Client-Id": CID, "X-Naver-Client-Secret": CSEC},
        timeout=15,
    )
    if r.status_code == 429:      # rate limit — 잠깐 쉬고 1회 재시도
        time.sleep(1.5)
        r = requests.get(r.url, headers={"X-Naver-Client-Id": CID, "X-Naver-Client-Secret": CSEC}, timeout=15)
    r.raise_for_status()
    return r.json().get("items", [])


def tags_for(district: str, apt: str) -> dict | None:
    q = f"{district} {apt} 아파트"
    texts = []
    for ep in ("blog", "cafearticle"):
        try:
            for it in _search(ep, q):
                texts.append(_TAGRE.sub("", f"{it.get('title', '')} {it.get('description', '')}"))
        except Exception as e:
            print(f"  {district} {apt} {ep} 실패: {e}")
        time.sleep(0.12)
    if not texts:
        return None
    counts = {}
    for t, pat in _PATS.items():
        c = sum(1 for x in texts if pat.search(x))
        if c >= MIN_COUNT:
            counts[t] = c
    top = sorted(counts.items(), key=lambda x: -x[1])[:TOP_N]
    return {"tags": top, "n_posts": len(texts)} if top else {"tags": [], "n_posts": len(texts)}


def main() -> int:
    if not (CID and CSEC):
        print("NAVER_CLIENT_ID/SECRET 미설정 — 리뷰 태그 수집을 건너뜁니다.")
        return 0
    comp = json.loads((ROOT / "data" / "processed" / "composite_score.json").read_text(encoding="utf-8"))
    apts = [(r["district"], r["apt_name"]) for r in comp["ranking"]]

    prev = {}
    if OUT.exists():
        prev = json.loads(OUT.read_text(encoding="utf-8")).get("apartments", {})

    out = {}
    for i, (d, a) in enumerate(apts, 1):
        res = tags_for(d, a)
        key = f"{d}|{a}"
        out[key] = res if res is not None else prev.get(key)  # 실패 시 이전 결과 유지
        if i % 50 == 0:
            print(f"  {i}/{len(apts)}…")
    out = {k: v for k, v in out.items() if v}

    OUT.write_text(json.dumps({
        "updated": date.today().isoformat(),
        "source": "네이버 검색 OpenAPI (블로그·카페) 언급 빈도",
        "apartments": out,
    }, ensure_ascii=False), encoding="utf-8")
    n_tagged = sum(1 for v in out.values() if v.get("tags"))
    print(f"✅ 리뷰 해시태그 저장: {n_tagged}/{len(apts)}단지 태그 확보 → {OUT}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"리뷰 태그 수집 실패: {e}")
        sys.exit(0)
