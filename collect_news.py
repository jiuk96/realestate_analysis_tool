"""
부동산 뉴스 수집 + 쉬운 해설 — 네이버 뉴스 검색 OpenAPI
─────────────────────────────────────────────────────
직접 크롤링 대신 공식 검색 API로 최근 부동산 뉴스(제목·요약·언론사·날짜·링크)를
받아온다. 각 기사에는 헤드라인의 키워드를 감지해 '왜 중요한가'를 미리 써 둔
테마 해설을 붙인다 — 기사별 요약을 지어내지 않고, 우리가 검증한 설명만 얹는 방식.

필요 키: NAVER_CLIENT_ID / NAVER_CLIENT_SECRET (리뷰 수집과 동일 키).
출력: data/processed/news.json
"""

import html
import json
import os
import re
import sys
from datetime import date, datetime
from pathlib import Path

import requests

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "processed" / "news.json"
CID = os.environ.get("NAVER_CLIENT_ID", "").strip()
CSEC = os.environ.get("NAVER_CLIENT_SECRET", "").strip()

# 수집 검색어 — 초보에게 실제로 영향 큰 주제 위주
QUERIES = [
    "부동산 대책", "아파트 매매 시세", "전세 사기", "재건축 재개발",
    "청약 분양", "주택담보대출 금리 DSR", "부동산 세금", "전세 월세 시장",
]

# 헤드라인 키워드 → 테마 (라벨, 이모지, "왜 중요한가" 쉬운 해설)
THEMES = [
    ("금리·대출", "🏦", r"금리|대출|DSR|LTV|한국은행|기준금리|스트레스",
     "대출 금리와 한도(DSR·LTV) 규제는 '내가 집을 얼마까지 살 수 있나'를 직접 바꿉니다. "
     "금리가 오르면 같은 소득으로 빌릴 수 있는 돈이 줄어 매수세가 식고, 규제가 풀리면 반대로 살아납니다. "
     "우리 예산 플래너의 금리 칸에 최신 금리를 넣어 다시 계산해 보세요."),
    ("전세사기·보증", "🛡️", r"전세\s?사기|깡통|보증금|반환보증|HUG|역전세",
     "전세가가 매매가에 육박(전세가율↑)하거나 집주인이 보증금을 못 돌려주는 상황이 핵심입니다. "
     "계약 전 등기부(근저당)·전세가율·반환보증 가입 가능 여부를 반드시 확인하세요 — "
     "우리 전세 안전성 지표와 '쉬운 상식'의 전세 체크리스트가 이 위험을 걸러줍니다."),
    ("청약·분양", "🎫", r"청약|분양|무순위|줍줍|특별공급|사전청약|분양가상한",
     "새 아파트를 시세보다 싸게 살 기회입니다. 다만 자격(순위·가점·특공)과 자금(계약금·중도금) 준비가 필요하니, "
     "우리 청약 페이지에서 내 자격을 먼저 진단하고 공고 일정을 확인하세요."),
    ("재건축·재개발", "🏗️", r"재건축|재개발|정비사업|안전진단|모아타운|신속통합|용적률|조합",
     "낡은 동네·아파트가 새 아파트로 바뀌는 사업입니다. 단계가 진행될수록 리스크는 줄고 가격은 오릅니다. "
     "'쉬운 상식'의 재개발·재건축 3박자와 빌라 구역 분석으로 어느 구역이 유망한지 가늠할 수 있습니다."),
    ("정부대책·규제", "📜", r"대책|규제|토지거래허가|투기과열|조정대상|공급|그린벨트|세제",
     "정부가 시장을 누르거나(규제) 공급을 늘리는(대책) 신호입니다. 규제지역 지정은 대출·세금·청약 요건을 한꺼번에 바꾸므로, "
     "관심 지역이 포함됐는지 꼭 확인하세요. 실거주자에겐 경쟁을 줄여주는 면도 있습니다."),
    ("세금", "🧾", r"취득세|양도세|종부세|종합부동산세|보유세|재산세|증여",
     "집을 사고(취득세)·갖고(재산세·종부세)·팔 때(양도세) 내는 돈입니다. 다주택이면 세율이 크게 뛰고 "
     "입주권·분양권도 주택 수에 들어갑니다 — 큰 결정 전 세무사 확인을 권합니다."),
    ("시세·거래동향", "📈", r"시세|실거래|집값|매매가|거래량|하락|상승|반등|미분양",
     "시장의 체온계입니다. 거래량이 늘면서 가격이 오르면 상승 신호, 미분양이 쌓이면 침체 신호입니다. "
     "특정 기사 하나보다 '거래량+가격'을 같이 봐야 하며, 우리 지도·구별 순위로 실거래 흐름을 확인하세요."),
]
_DEFAULT_THEME = ("부동산 일반", "🏠", None,
                  "부동산 시장 전반에 대한 소식입니다. 헤드라인만 보지 말고 본문에서 '어느 지역·누구에게' 영향인지 확인하세요.")

_TAG = re.compile(r"<[^>]+>")
# 부동산 관련성 게이트: 제목에 이 중 하나는 있어야 채택(정치·증시·일반경제 노이즈 제거).
# 제목 기준이라 본문이 부동산 맥락이어도 헤드라인이 정치면 걸러진다.
_RELEVANT = re.compile(
    r"부동산|아파트|주택|집값|전세|월세|매매|임대|분양|청약|재건축|재개발|재정비|정비사업|리모델링|"
    r"주담대|주택담보|대출|LTV|DSR|취득세|양도세|종부세|공시가|매물|실거래|입주|전셋값|보증금|"
    r"오피스텔|빌라|다세대|미분양|용적률|그린벨트|토지거래|잔금|규제지역|1주택|다주택|갭투자|깡통|"
    r"모아타운|신통기획|공급|신도시|착공|보상|역세권|생활권|초고가|평당|호가|GTX|전매|입주권|분양권")


def _clean(s: str) -> str:
    return html.unescape(_TAG.sub("", s or "")).strip()


def _theme_of(text: str):
    for label, emoji, pat, expl in THEMES:
        if pat and re.search(pat, text):
            return {"label": label, "emoji": emoji, "explainer": expl}
    label, emoji, _, expl = _DEFAULT_THEME
    return {"label": label, "emoji": emoji, "explainer": expl}


def _search(query: str) -> list:
    r = requests.get(
        "https://openapi.naver.com/v1/search/news.json",
        params={"query": query, "display": 20, "sort": "date"},
        headers={"X-Naver-Client-Id": CID, "X-Naver-Client-Secret": CSEC},
        timeout=15,
    )
    r.raise_for_status()
    return r.json().get("items", [])


def _pubdate(s: str) -> str:
    try:
        return datetime.strptime(s, "%a, %d %b %Y %H:%M:%S %z").strftime("%Y-%m-%d")
    except Exception:
        return ""


def main() -> int:
    if not (CID and CSEC):
        print("NAVER_CLIENT_ID/SECRET 미설정 — 뉴스 수집 건너뜀.")
        return 0

    seen, items = set(), []
    for q in QUERIES:
        try:
            for it in _search(q):
                title = _clean(it.get("title"))
                desc = _clean(it.get("description"))
                link = it.get("link") or it.get("originallink") or ""
                if not title or link in seen:
                    continue
                # 광고·단순 시세표 기사 최소 필터
                if len(title) < 8:
                    continue
                if not _RELEVANT.search(title):
                    continue   # 제목이 부동산과 무관하면 제외(정치·증시 헤드라인)
                seen.add(link)
                th = _theme_of(title + " " + desc)
                items.append({
                    "title": title, "summary": desc, "link": link,
                    "date": _pubdate(it.get("pubDate", "")),
                    "theme": th["label"], "emoji": th["emoji"], "explainer": th["explainer"],
                })
        except Exception as e:
            print(f"  '{q}' 실패: {e}")

    # 최신순 정렬 후 상한
    items.sort(key=lambda x: x["date"], reverse=True)
    items = items[:60]

    # 테마별 개수 (뉴스 페이지 필터용)
    themes = {}
    for it in items:
        themes.setdefault(it["theme"], 0)
        themes[it["theme"]] += 1

    OUT.write_text(json.dumps({
        "updated": date.today().isoformat(),
        "source": "네이버 뉴스 검색 API · 해설은 본 서비스가 작성",
        "themes": themes,
        "items": items,
    }, ensure_ascii=False), encoding="utf-8")
    print(f"✅ 부동산 뉴스 {len(items)}건 저장 (테마 {len(themes)}종) → {OUT}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(f"뉴스 수집 실패: {e}")
        sys.exit(0)
