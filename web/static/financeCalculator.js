/**
 * financeCalculator.js
 * ─────────────────────────────────────────────────────────────
 * 부동산 매수 가용자금 · 세금 · 대출 · 현금흐름 계산 유틸리티
 *
 * ⚠️ 유지보수 가이드
 *  - 세율/공제/규제가 바뀌면 "이 파일의 상수만" 수정하면 됩니다.
 *  - UI(dashboard.js)에는 계산식을 넣지 않습니다. 순수 함수만 export.
 *  - 금액 단위: 모든 함수의 입출력은 "원(KRW)" 기준. (억 = 1e8)
 *  - 기준 시점: 2026년 세법/대출규제 대표값. 실제 조건은 개별 상담 필요.
 * ───────────────────────────────────────────────────────────── */

const 억 = 1e8;
const 만 = 1e4;

/* ============================================================
 * 1. 증여세 (직계존비속 · 혼인/출산 공제)
 * ============================================================
 * 상속세 및 증여세법 기준.
 *  - 성년 자녀가 직계존속(부모)에게 받는 경우 10년간 5,000만원 공제.
 *  - 혼인공제: 혼인신고일 전후 2년 이내 증여 시 1억원 추가 공제 (2024 신설).
 *  - 출산공제: 자녀 출생일부터 2년 이내 증여 시 1억원 추가 공제.
 *    ※ 혼인+출산 공제는 "합산 1억원 한도" (중복 불가, 통합 1억).
 *  - 따라서 신혼부부 각자 최대 공제 = 5,000만(기본) + 1억(혼인) = 1.5억.
 *  - 공제·세율은 "수증자 1인 기준"이므로 본인/배우자 각각 따로 계산해야 함.
 */
const GIFT = {
  BASIC_DEDUCTION: 5000 * 만,      // 직계존속 → 성년 자녀 기본공제 (10년 합산)
  MARRIAGE_DEDUCTION: 10000 * 만,  // 혼인공제 (전후 2년)
  BIRTH_DEDUCTION: 10000 * 만,     // 출산공제 (2년 내)
  MARRIAGE_BIRTH_CAP: 10000 * 만,  // 혼인+출산 통합 한도 (1억)
  // 증여세 누진세율 (과세표준 구간 상한, 세율, 누진공제액)
  BRACKETS: [
    { limit: 1 * 억,   rate: 0.10, deduct: 0 },
    { limit: 5 * 억,   rate: 0.20, deduct: 1000 * 만 },
    { limit: 10 * 억,  rate: 0.30, deduct: 6000 * 만 },
    { limit: 30 * 억,  rate: 0.40, deduct: 16000 * 만 },
    { limit: Infinity, rate: 0.50, deduct: 46000 * 만 },
  ],
  REPORT_CREDIT: 0.03,  // 자진신고 세액공제 3%
};

/**
 * 증여세 계산 (수증자 1인 기준)
 * @param {number} amount   증여받는 금액 (원)
 * @param {object} opt      { marriage:boolean, birth:boolean, useBasic:boolean } 공제 적용 여부
 *                          (marriage/birth 중 하나라도 true면 혼인·출산공제 1억 적용, useBasic=false면 기본공제 0.5억 미적용)
 * @returns {{taxable:number, tax:number, netReceived:number, deduction:number}}
 *          taxable=과세표준, tax=실질 증여세(신고공제 반영), netReceived=세후 실수령
 */
export function calcGiftTax(amount, opt = {}) {
  const bonusApplied = !!(opt.marriage || opt.birth);
  const basicDeduction = opt.useBasic === false ? 0 : GIFT.BASIC_DEDUCTION;
  const bonusDeduction = bonusApplied ? GIFT.MARRIAGE_BIRTH_CAP : 0;   // 혼인·출산 공제는 통합 1억 한도
  const deduction = basicDeduction + bonusDeduction;

  if (!amount || amount <= 0) {
    return {
      taxable: 0, tax: 0, netReceived: 0, deduction,
      basicDeduction, bonusDeduction, bonusApplied,
      usedBasic: 0, usedBonus: 0, rate: 0, bracketDeduct: 0, grossTax: 0,
    };
  }

  // 공제는 기본공제부터 먼저 채우고 남는 한도를 혼인/출산 공제로 채운다 (표시용 분해)
  const usedBasic = Math.min(amount, basicDeduction);
  const usedBonus = Math.min(Math.max(0, amount - usedBasic), bonusDeduction);

  const taxable = Math.max(0, amount - deduction);
  if (taxable === 0) {
    return {
      taxable: 0, tax: 0, netReceived: amount, deduction,
      basicDeduction, bonusDeduction, bonusApplied,
      usedBasic, usedBonus, rate: 0, bracketDeduct: 0, grossTax: 0,
    };
  }

  const b = GIFT.BRACKETS.find(br => taxable <= br.limit);
  const grossTax = taxable * b.rate - b.deduct;
  const tax = Math.max(0, grossTax * (1 - GIFT.REPORT_CREDIT));  // 자진신고 3% 공제

  return {
    taxable, tax, netReceived: amount - tax, deduction,
    basicDeduction, bonusDeduction, bonusApplied,
    usedBasic, usedBonus, rate: b.rate, bracketDeduct: b.deduct, grossTax,
  };
}

/* ============================================================
 * 2. 취득세 (생애최초 감면 반영)
 * ============================================================
 * 지방세법 기준 (주택, 1주택 표준세율).
 *  - 6억 이하:            취득세 1.0% + 지방교육세 0.1%           = 1.1%
 *  - 6억 초과 ~ 9억 이하: 세율이 6→9억 구간에서 1%→3% 선형 증가 (+지방교육세)
 *  - 9억 초과:            취득세 3.0% + 지방교육세 0.3%           = 3.3%
 *  - 85㎡ 초과 시 농특세 0.2% 추가 (여기서는 국민주택규모 이하 가정하여 제외).
 *  - 생애최초 감면: 주택가 12억 이하일 때 취득세 최대 200만원 감면.
 */
const ACQ = {
  RATE_LOW: 0.011,          // 6억 이하 (교육세 포함)
  RATE_HIGH: 0.033,         // 9억 초과 (교육세 포함)
  FIRST_HOME_CAP: 1200000000, // 생애최초 감면 대상 상한 12억
  FIRST_HOME_DISCOUNT: 200 * 만, // 최대 감면액 200만원
};

/**
 * 취득세 계산
 * @param {number} price       주택 매매가 (원)
 * @param {boolean} firstHome  생애최초 여부
 * @returns {{rate:number, tax:number, discount:number}}
 */
export function calcAcquisitionTax(price, firstHome = false) {
  if (!price || price <= 0) return { rate: 0, tax: 0, discount: 0 };

  let rate;
  if (price <= 6 * 억) {
    rate = ACQ.RATE_LOW;
  } else if (price <= 9 * 억) {
    // 6~9억 구간: 취득세 본세가 1%→3% 선형 증가, 교육세는 본세의 10%
    const base = 0.01 + (price / 억 - 6) / 3 * 0.02;  // 1.0% ~ 3.0%
    rate = base * 1.1;
  } else {
    rate = ACQ.RATE_HIGH;
  }

  let tax = price * rate;
  let discount = 0;
  if (firstHome && price <= ACQ.FIRST_HOME_CAP) {
    discount = Math.min(ACQ.FIRST_HOME_DISCOUNT, tax);
    tax -= discount;
  }
  return { rate, tax, discount };
}

/* ============================================================
 * 3. 중개보수 (부동산 복비, 서울 주택 매매 상한요율)
 * ============================================================
 *  - 2억~6억:  0.4%
 *  - 6억~9억:  0.5%
 *  - 9억 이상: 0.9% (상한, 실제는 협의)
 *  - 부가세 별도지만 여기서는 상한요율만 반영.
 */
const BROKER_BRACKETS = [
  { limit: 2 * 억,   rate: 0.005 },
  { limit: 6 * 억,   rate: 0.004 },
  { limit: 9 * 억,   rate: 0.005 },
  { limit: Infinity, rate: 0.009 },
];

/** 중개보수 계산 @returns {number} 원 */
export function calcBrokerFee(price) {
  if (!price || price <= 0) return 0;
  const b = BROKER_BRACKETS.find(br => price <= br.limit);
  return price * b.rate;
}

/* ============================================================
 * 4. 대출 (DSR · LTV · 정책상품 · 상환 시뮬레이션)
 * ============================================================
 *  - DSR: 원리금 상환액 / 연소득. 은행권 40% 규제.
 *  - LTV: 대출액 / 주택가. 생애최초 80%, 그 외 70% 가정 (비규제).
 *  - 정책대출은 각 상품별 소득·주택가·한도 요건이 있으며 부합 시 우대금리 적용.
 */
// 2026년 기준 대표값 (기금e든든·주택도시기금 공시 기준)
export const LOAN_PRODUCTS = [
  {
    id: 'newborn', name: '신생아 특례대출', rate: 0.027, years: 30,
    maxLoan: 4 * 억, houseCap: 9 * 억, incomeCap: 20000 * 만, ltv: 0.70,
    note: '2년 내 출산 무주택 가구 · 부부합산 2억↓ · 주택 9억↓ · 최대 4억(2026 축소) · 금리 1.6~3.3%',
    requiresBirth: true,
  },
  {
    id: 'didimdol', name: '디딤돌대출 (신혼)', rate: 0.032, years: 30,
    maxLoan: 4 * 억, houseCap: 6 * 억, incomeCap: 8500 * 만, ltv: 0.70,
    note: '신혼 부부합산 8,500만↓ · 주택 6억↓ · 전용 85㎡↓ · 금리 2.65~3.95%',
  },
  {
    id: 'bogeumjari', name: '보금자리론', rate: 0.042, years: 40,
    maxLoan: 3.6 * 억, houseCap: 6 * 억, incomeCap: 8500 * 만, ltv: 0.70,
    note: '소득 7천만↓(신혼 8,500만) · 주택 6억↓ · 고정금리',
  },
  {
    id: 'bank', name: '일반 주택담보대출', rate: 0.041, years: 40,
    maxLoan: Infinity, houseCap: Infinity, incomeCap: Infinity,
    ltv: 0.70,
    note: '수도권 LTV 70% 일괄(6·27 후속) · 스트레스 DSR 40% · 규제지역 40%·6억 캡',
  },
];

const DSR_LIMIT = 0.40;

/* ============================================================
 * 4-1. 부동산 규제 (2025 6·27 대책 · 토지거래허가제)
 * ============================================================
 * 2025년 6월 27일 가계부채 관리방안(6·27 대책) 핵심:
 *  - 수도권·규제지역 주택담보대출 최대 한도 6억원으로 제한
 *    (소득·LTV로 그보다 더 나와도 6억에서 잘림)
 *  - 생활안정자금 목적 주담대 1억원 한도
 *  - 6개월 내 전입 의무(실거주), 규제지역 다주택 LTV 0%
 *  - 스트레스 DSR 3단계: 가산금리(약 +1.5%p)를 얹어 한도를 보수적으로 산정
 *
 * 토지거래허가구역(토허제): 강남·서초·송파·용산 등.
 *  - 실거주 목적만 매수 허가 → 전세 낀 갭투자 불가
 *    (전세보증금으로 잔금을 치를 수 없어 자기자본+대출로만 조달해야 함)
 *  - 2년 실거주 의무.
 */
export const REGULATION = {
  METRO_LOAN_CAP: 6 * 억,        // 6·27 대책 수도권/규제지역 주담대 한도
  STRESS_DSR_ADDON: 0.015,       // 스트레스 DSR 가산금리 (한도 산정용)
  // 규제지역(투기과열지구=강남·서초·송파·용산+토지거래허가구역) LTV
  //  - 은행업감독규정상 규제지역 실수요 LTV 40%
  //  - 6·27 대책 후속으로 수도권 생애최초 LTV 우대(80%)가 70%로 일괄 축소됨
  //    (규제지역은 생애최초 여부와 무관하게 40% 적용, 보수 기준)
  LTV_REGULATED: 0.40,
  LTV_REGULATED_FIRST: 0.40,
  LTV_NORMAL: 0.70,              // 수도권 일반
  LTV_NORMAL_FIRST: 0.70,        // 수도권 생애최초 (6·27 후속으로 80%→70%)
};

/* ============================================================
 * 4-2. 부모 차용 (무이자 차용증)
 * ============================================================
 * 상속세 및 증여세법 §41조의4 (금전 무상대출 등에 따른 이익의 증여):
 *  - 특수관계인(부모↔자녀)에게 무이자/저리로 돈을 빌려주면
 *    "적정이자(연 4.6%)와 실제이자의 차액"을 증여로 봄.
 *  - 단, 그 차액(=증여이익)이 "연 1,000만원 미만"이면 과세하지 않음.
 *  - 따라서 무이자로 빌릴 수 있는 최대 원금:
 *      원금 × 4.6% < 1,000만원  →  원금 < 2억 1,739만원
 *  - 이 한도 내에서는 이자 없이 "원금만" 갚으면 되고 증여세도 없음.
 *  - 실제로는 차용증 작성 + 정기적 원금 상환 이체 기록이 있어야 인정됨.
 */
export const FAMILY_LOAN = {
  LEGAL_RATE: 0.046,             // 상증세법 적정이자율 4.6%
  EXEMPT_INTEREST: 1000 * 만,    // 증여이익 비과세 기준 연 1,000만원
  get MAX_NO_INTEREST() {        // 무이자 허용 최대 원금 ≈ 2.17억
    return this.EXEMPT_INTEREST / this.LEGAL_RATE;
  },
};

/**
 * 부모 무이자 차용 상환 계산
 * @param {number} principal 차용 원금 (원)
 * @param {number} years     상환 기간 (년) — 무이자이므로 원금균등만
 * @returns {{monthly:number, overLimit:boolean, deemedInterest:number, giftRisk:number}}
 *   monthly=월 원금상환액, overLimit=2.17억 초과 여부,
 *   deemedInterest=초과 시 연 간주이자, giftRisk=증여로 간주될 위험 금액
 */
export function calcFamilyLoan(principal, years = 10) {
  if (!principal || principal <= 0) return { monthly: 0, overLimit: false, deemedInterest: 0, giftRisk: 0 };
  const n = years * 12;
  const monthly = principal / n;                 // 무이자 → 원금만 균등 분할
  const limit = FAMILY_LOAN.MAX_NO_INTEREST;
  const overLimit = principal > limit;
  // 초과분에 대한 연 간주이자 (4.6%) — 1천만 넘으면 증여세 대상
  const deemedInterest = principal * FAMILY_LOAN.LEGAL_RATE;
  const giftRisk = overLimit ? deemedInterest - FAMILY_LOAN.EXEMPT_INTEREST : 0;
  return { monthly, overLimit, deemedInterest, giftRisk };
}

/**
 * 기본공제·혼인공제를 뺀 후 무이자 차용으로 돌릴 수 있는 최대 한도.
 * = min(공제 후 남은 금액, 무이자 허용 최대 원금 2.17억)
 * 슬라이더 상한값 계산에 사용한다.
 * @param {number} total 부모 지원 총액 (원)
 * @param {object} opt   { marriage, birth }
 */
export function maxFamilyLoanFor(total, opt = {}) {
  const bonusApplied = !!(opt.marriage || opt.birth);
  let remaining = Math.max(0, total || 0);
  if (opt.useBasic !== false) remaining -= Math.min(remaining, GIFT.BASIC_DEDUCTION);
  if (bonusApplied) remaining -= Math.min(remaining, GIFT.MARRIAGE_BIRTH_CAP);
  return Math.min(remaining, FAMILY_LOAN.MAX_NO_INTEREST);
}

/**
 * 부모 지원 총액을 "세금·이자 부담이 없는 항목부터" 채워 분해한다.
 * 순서: ① 직계존속 기본공제(0.5억, 항상 가능) → ② 혼인·출산공제(1억, 옵션 체크 시) →
 *       ③ 무이자 차용(기본은 한도 ≈2.17억까지 자동 사용, 슬라이더로 직접 조절 가능) →
 *       ④ 그래도(혹은 차용을 줄여서) 남으면 과세 증여로 처리.
 * 무이자 차용을 슬라이더로 줄이면 그만큼 "그 외 증여"가 늘어나 총액은 항상 보존된다.
 * @param {number} total 부모 지원 총액 (원)
 * @param {object} opt   { marriage, birth, useBasic, familyLoanOverride }
 *   useBasic: false면 기본공제 0.5억을 적용하지 않음 (기본값 true).
 *   familyLoanOverride: 사용자가 슬라이더로 지정한 무이자 차용액. null/undefined면 한도 최대치를 자동 사용.
 * @returns {{basicGift:number, bonusGift:number, familyLoan:number, extraGift:number, totalGift:number}}
 */
export function splitParentSupport(total, opt = {}) {
  const bonusApplied = !!(opt.marriage || opt.birth);
  let remaining = Math.max(0, total || 0);

  const basicGift = opt.useBasic === false ? 0 : Math.min(remaining, GIFT.BASIC_DEDUCTION);
  remaining -= basicGift;

  const bonusGift = bonusApplied ? Math.min(remaining, GIFT.MARRIAGE_BIRTH_CAP) : 0;
  remaining -= bonusGift;

  const autoFamilyLoan = Math.min(remaining, FAMILY_LOAN.MAX_NO_INTEREST);
  const familyLoan = (opt.familyLoanOverride != null)
    ? Math.min(Math.max(0, opt.familyLoanOverride), remaining, FAMILY_LOAN.MAX_NO_INTEREST)
    : autoFamilyLoan;
  remaining -= familyLoan;

  const extraGift = remaining;   // 무이자 차용으로 쓰지 않은 나머지는 과세 증여로 처리

  return {
    basicGift, bonusGift, familyLoan, extraGift,
    totalGift: basicGift + bonusGift + extraGift,
  };
}

/* ============================================================
 * 세법·규제 근거 텍스트 (UI '근거 보기'용)
 * ============================================================ */
export const LEGAL_BASIS = {
  acq: {
    title: '취득세는 왜, 어떻게 내나요?',
    body: '집을 사면 소유권을 취득한 대가로 지방자치단체에 내는 지방세입니다(지방세법 §11). ' +
          '1주택 기준 세율은 매매가 6억 이하 1%, 6~9억 구간은 1→3%로 비례 증가, 9억 초과 3%이며 ' +
          '여기에 지방교육세(취득세의 10%)가 더해져 실효세율은 각각 1.1% / 1.1~3.3% / 3.3%가 됩니다. ' +
          '전용 85㎡ 초과 시 농어촌특별세 0.2%가 추가됩니다. 생애최초 구입은 12억 이하 주택에 한해 ' +
          '취득세를 최대 200만원까지 감면합니다(지방세특례제한법 §36의3).',
  },
  broker: {
    title: '중개보수(복비)는 어떻게 정해지나요?',
    body: '공인중개사법 시행규칙과 각 시·도 조례로 매매가 구간별 상한요율이 정해져 있습니다. ' +
          '서울 주택 매매 기준 2~6억 0.4%, 6~9억 0.5%, 9~12억 0.5%, 12~15억 0.6%, 15억 이상 0.7%가 ' +
          '상한이며(요율은 협의 가능), 별도로 부가가치세가 붙습니다. 본 계산기는 보수적으로 상한요율을 적용합니다.',
  },
  gift: {
    title: '증여세와 공제는 어떻게 계산되나요?',
    body: '부모가 자녀에게 재산을 무상으로 주면 받는 사람(자녀)이 증여세를 냅니다(상증세법). ' +
          '성년 자녀는 부모로부터 10년 합산 5,000만원까지 공제되고, 2024년 신설된 혼인·출산 증여공제로 ' +
          '혼인신고 전후 2년 또는 출산 2년 내 증여 시 1억원을 추가 공제받습니다(혼인+출산 통합 1억 한도). ' +
          '즉 신혼부부는 1인당 최대 1.5억까지 증여세 없이 받을 수 있습니다. 공제 초과분은 과세표준에 따라 ' +
          '10%(1억↓)~50%(30억↑) 누진세율이 적용되며, 기한 내 자진신고 시 3% 세액공제가 있습니다.',
  },
  loan: {
    title: 'DSR·LTV·6·27 대책이 대출한도를 어떻게 정하나요?',
    body: 'LTV(주택담보인정비율)는 집값 대비 빌릴 수 있는 비율입니다. 수도권은 70%가 기본이며, ' +
          '2025년 6·27 대책 후속으로 생애최초 우대(80%)도 수도권에선 70%로 일괄 축소됐습니다. ' +
          '투기과열지구·조정대상지역(현재 강남·서초·송파·용산)과 토지거래허가구역 같은 규제지역은 ' +
          '실수요 기준 40%로 더 축소됩니다. DSR(총부채원리금상환비율)은 연소득 대비 모든 대출의 ' +
          '연간 원리금이 40%를 넘지 못하게 하는 규제로, 소득이 낮으면 LTV가 남아도 대출이 막힙니다. ' +
          '2025년 6·27 가계부채 관리방안으로 수도권·규제지역 주택담보대출은 한도가 최대 6억원으로 제한되고, ' +
          '스트레스 DSR(가산금리 약 +1.5%p)이 적용돼 실제 한도는 더 보수적으로 산정됩니다. ' +
          '최종 대출액은 이 네 가지(LTV · DSR · 6억 캡 · 상품한도) 중 가장 작은 값으로 정해집니다. ' +
          '[근거: 은행업감독규정 별표6, 금융위원회 2025.6.27 가계부채 관리방안]',
  },
  family: {
    title: '부모 무이자 차용증은 얼마까지 가능한가요?',
    body: '부모에게 돈을 빌리면 원칙적으로 증여가 아니지만, 무이자로 빌리면 "적정이자(연 4.6%)만큼 이득을 ' +
          '증여받은 것"으로 봅니다(상증세법 §41조의4). 다만 그 이자상당액이 연 1,000만원 미만이면 과세하지 ' +
          '않습니다. 4.6% × 원금 < 1,000만원을 풀면 원금 약 2억 1,739만원까지는 무이자로 빌려도 증여세가 ' +
          '없습니다. 대신 실제 차용으로 인정받으려면 차용증을 쓰고 원금을 정기적으로 계좌이체로 갚은 기록이 ' +
          '있어야 합니다. 이 돈은 갚아야 할 빚이므로 자기자본과는 구분해 관리해야 합니다.',
  },
  toho: {
    title: '토지거래허가구역(토허제)이면 뭐가 달라지나요?',
    body: '강남·서초·송파·용산 등 토지거래허가구역에서는 주택을 살 때 구청의 허가가 필요하고, 실거주 목적만 ' +
          '허가됩니다. 따라서 전세를 끼고 사는 갭투자가 불가능해 전세보증금으로 잔금을 치를 수 없고, ' +
          '자기자본과 대출만으로 매수 자금을 마련해야 합니다. 또한 2년간 실거주 의무가 있어 매수 직후 ' +
          '전월세를 놓을 수 없습니다.',
  },
  rate: {
    title: '대출 금리는 4.1% 고정인가요?',
    body: '아닙니다. 일반 주택담보대출 금리(기본값 4.10%)는 대표 참고값일 뿐, 은행·시점·개인 신용·고정/변동 ' +
          '방식에 따라 매일 달라집니다. 정확히 하려면 아래 "실제 대출 금리 확인하기"의 공식 사이트(금융감독원 ' +
          '금융상품 한눈에, 은행연합회 소비자포털 등)에서 현재 금리를 확인해 각자 금리(%) 칸에 직접 입력하세요. ' +
          '디딤돌·보금자리론·신생아 특례는 주택도시기금·주택금융공사 공시금리를 따릅니다.',
  },
};

/**
 * 월 상환액 계산
 * @param {number} principal  대출원금 (원)
 * @param {number} annualRate 연이율 (예: 0.041)
 * @param {number} years      만기 (년)
 * @param {'annuity'|'linear'} type 상환방식
 * @returns {{first:number, avg:number, totalInterest:number}}
 *          first=1회차 상환액, avg=평균 월상환액, totalInterest=총이자
 */
export function calcMonthlyPayment(principal, annualRate, years, type = 'annuity') {
  if (!principal || principal <= 0) return { first: 0, avg: 0, totalInterest: 0 };
  const r = annualRate / 12, n = years * 12;

  if (type === 'linear') {
    // 원금균등: 매월 원금 일정 + 잔액 이자. 1회차가 가장 큼.
    const monthlyPrincipal = principal / n;
    const first = monthlyPrincipal + principal * r;
    const totalInterest = principal * r * (n + 1) / 2;      // 등차수열 합
    const avg = (principal + totalInterest) / n;
    return { first, avg, totalInterest };
  }
  // 원리금균등: 매월 동일.
  const pay = r === 0 ? principal / n : principal * r / (1 - Math.pow(1 + r, -n));
  const totalInterest = pay * n - principal;
  return { first: pay, avg: pay, totalInterest };
}

/**
 * DSR 40% 기준 최대 대출 가능액 (원리금균등 기준으로 한도 산정)
 * @param {number} annualIncome 연소득 (원)
 * @param {number} annualRate   연이율
 * @param {number} years        만기 (년)
 * @returns {number} 대출 가능액 (원)
 */
export function maxLoanByDSR(annualIncome, annualRate, years, otherMonthly = 0) {
  if (!annualIncome || annualIncome <= 0) return 0;
  const r = annualRate / 12, n = years * 12;
  // DSR 40% 한도에서 기존 대출(신용대출 등) 월 원리금을 먼저 뺀 나머지가 주담대 여력
  const monthlyCap = Math.max(0, annualIncome * DSR_LIMIT / 12 - (otherMonthly || 0));
  return r === 0 ? monthlyCap * n : monthlyCap * (1 - Math.pow(1 + r, -n)) / r;
}

/**
 * 특정 대출상품 기준 실제 대출 가능액 = min(DSR한도, LTV한도, 상품한도)
 * @param {object} product   LOAN_PRODUCTS 항목
 * @param {number} income    연소득 (원)
 * @param {number} price     주택가 (원)
 * @param {number} rate      적용 금리
 * @param {number} years     만기
 * @param {boolean} firstHome 생애최초
 * @returns {{loan:number, bind:string}} loan=가능액, bind=제약요인
 */
export function maxLoanForProduct(product, income, price, rate, years, firstHome, opt = {}) {
  const { regulated = false } = opt;   // 규제지역/토허제 여부
  // 스트레스 DSR: 한도 산정 시 가산금리를 얹어 보수적으로 계산
  const stressRate = rate + REGULATION.STRESS_DSR_ADDON;
  const byDSR = maxLoanByDSR(income, stressRate, years);

  // LTV: 일반 주담대는 규제지역 여부에 따라 40/50%로 축소, 정책상품은 자체 LTV
  let ltv;
  if (product.id === 'bank') {
    if (regulated) ltv = firstHome ? REGULATION.LTV_REGULATED_FIRST : REGULATION.LTV_REGULATED;
    else ltv = firstHome ? REGULATION.LTV_NORMAL_FIRST : REGULATION.LTV_NORMAL;
  } else {
    ltv = (firstHome && product.ltvFirst) ? product.ltvFirst : product.ltv;
  }
  const byLTV = price * ltv;
  const byProduct = product.maxLoan;
  // 6·27 대책: 규제지역이면 일반 주담대 6억 한도 (정책상품은 자체 한도 우선)
  const byRegion = (regulated && product.id === 'bank') ? REGULATION.METRO_LOAN_CAP : Infinity;

  const loan = Math.min(byDSR, byLTV, byProduct, byRegion);
  let bind = 'DSR(스트레스)';
  if (loan === byLTV) bind = `LTV ${(ltv * 100).toFixed(0)}%${regulated ? '(규제지역)' : ''}`;
  else if (loan === byProduct) bind = '상품한도';
  else if (loan === byRegion) bind = '6·27 대책 6억';
  return { loan: Math.max(0, loan), bind, ltv };
}

/* ============================================================
 * 5. 종합: 최대 매수 가능 주택가격 도출
 * ============================================================
 * 매수구조: 주택가 = 자기자본 + 증여(세후) + 대출
 * 부대비용(취득세·중개비)은 자기자본에서 먼저 차감.
 *
 * 대출은 주택가(LTV)와 소득(DSR)에 함께 묶이므로,
 * 주택가를 이분탐색으로 찾아 "부대비용 포함 총지출 = 조달가능액"이 되는
 * 최대 주택가를 구한다.
 */

/**
 * @param {object} input {
 *   myCash, gfCash, myGift, gfGift,   // 원
 *   marriage, birth,                  // 공제 옵션
 *   income,                           // 연소득(원)
 *   product, rate, years, repay,      // 대출
 *   firstHome                         // 생애최초
 * }
 * @returns {object} 계산 결과 전체
 */
export function analyzeFinance(input) {
  const {
    myCash = 0, gfCash = 0, myGift = 0, gfGift = 0,
    marriage = false, birth = false,
    income = 0, product, rate, years, repay = 'annuity', firstHome = false,
    familyLoan = 0, familyYears = 10,   // 부모 무이자 차용
    regulated = false,                  // 규제지역/토허제
  } = input;

  // 1) 세후 증여액 (본인/여자친구 각각 계산 후 합산)
  const giftMe = calcGiftTax(myGift, { marriage, birth });
  const giftGf = calcGiftTax(gfGift, { marriage, birth });
  const netGift = giftMe.netReceived + giftGf.netReceived;
  const giftTax = giftMe.tax + giftGf.tax;

  // 2) 자기자본(현금+세후증여) + 부모차용(빚이지만 조달원)
  const ownEquity = myCash + gfCash + netGift;
  const family = calcFamilyLoan(familyLoan, familyYears);
  const availableFunds = ownEquity + familyLoan;   // 매수에 투입 가능한 총 현금성 자금

  // 3) 이분탐색으로 최대 주택가 찾기
  //    조건: availableFunds - 부대비용(주택가) + 은행대출(주택가) >= 주택가
  const feasible = (price) => {
    const acq = calcAcquisitionTax(price, firstHome).tax;
    const broker = calcBrokerFee(price);
    const { loan } = maxLoanForProduct(product, income, price, rate, years, firstHome, { regulated });
    const needOwn = price - loan + acq + broker;
    return needOwn <= availableFunds;
  };

  let lo = 0, hi = 50 * 억;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (feasible(mid)) lo = mid; else hi = mid;
  }
  let maxPrice = lo;
  if (product.houseCap && maxPrice > product.houseCap) maxPrice = product.houseCap;

  // 4) 최대가격 기준 상세 재계산
  const acq = calcAcquisitionTax(maxPrice, firstHome);
  const broker = calcBrokerFee(maxPrice);
  const { loan, bind, ltv: appliedLtv } = maxLoanForProduct(product, income, maxPrice, rate, years, firstHome, { regulated });
  const monthly = calcMonthlyPayment(loan, rate, years, repay);
  const cashUsed = maxPrice + acq.tax + broker - loan - familyLoan;  // 실제 투입 자기자본
  const leftover = ownEquity - cashUsed;

  // 부모차용 + 은행대출 합산 월 상환액
  const totalMonthly = monthly.first + family.monthly;

  // 5) 자격/규제 경고
  const warnings = [];
  if (income > product.incomeCap) warnings.push(`${product.name}은 부부합산 소득 ${(product.incomeCap/만).toLocaleString()}만원 이하만 가능합니다.`);
  if (product.houseCap !== Infinity && lo > product.houseCap) warnings.push(`${product.name}은 주택가 ${(product.houseCap/억).toFixed(0)}억 이하만 가능해 예산이 제한되었습니다.`);
  if (product.requiresBirth && !birth) warnings.push(`${product.name}은 2년 내 출산(예정) 가구 대상입니다.`);
  if (regulated) warnings.push(`토지거래허가구역은 실거주 목적만 매수 허가되며, 전세 낀 갭투자가 불가능합니다(2년 실거주 의무).`);
  if (regulated && product.id === 'bank' && bind === '6·27 대책 6억') warnings.push(`6·27 대책으로 규제지역 주담대가 6억으로 제한되었습니다.`);
  if (family.overLimit) warnings.push(`부모 차용이 무이자 한도(${won2eok(FAMILY_LOAN.MAX_NO_INTEREST)})를 초과했습니다. 초과분은 연 ${won2man(family.giftRisk)}이 증여로 간주될 수 있어 이자 지급이 필요합니다.`);

  // DSR은 은행대출 원리금 기준 (부모차용은 DSR 산정 제외)
  const dsrRatio = income > 0 ? (calcMonthlyPayment(loan, rate, years, 'annuity').first * 12) / income : 0;

  return {
    netGift, grossGift: myGift + gfGift, giftTax, giftMe, giftGf,
    myCash, gfCash,
    ownEquity, availableFunds,
    appliedLtv, regulated,
    maxPrice,
    acqTax: acq.tax, acqRate: acq.rate, acqDiscount: acq.discount,
    brokerFee: broker,
    loan, loanBind: bind,
    familyLoan, familyMonthly: family.monthly, familyOverLimit: family.overLimit,
    familyDeemedInterest: family.deemedInterest,
    monthlyFirst: monthly.first, monthlyAvg: monthly.avg, totalInterest: monthly.totalInterest,
    totalMonthly,
    cashUsed, leftover,
    dsrRatio,
    warnings,
    composition: {
      cash: myCash + gfCash,
      gift: netGift,
      family: familyLoan,
      loan: loan,
    },
  };
}

/* ============================================================
 * 6. 커플(2인) 분석: 각자 가용자금 → 합산 최대 매수가
 * ============================================================
 * 각자(A/B)가 현금·부모증여·부모차용·연소득·대출상품을 따로 입력한다.
 *  - 대출 한도(DSR)는 각자 소득 기준으로 산정 후 합산 (공동명의 가정)
 *  - LTV·6억 캡·부대비용은 주택(공통)에 적용
 *  - 결과에 각자 기여 가용자금과 월 상환액을 분리해 보여준다.
 */
/**
 * 개인 소득만으로 산정한 최대 대출 가능액(DSR·상품한도 기준, 주택가/LTV와 무관).
 * 대출 시뮬레이터 슬라이더의 상한값으로 사용한다.
 */
export function personDsrLoan(p) {
  const stressRate = (p.rate || 0.041) + REGULATION.STRESS_DSR_ADDON;
  return Math.min(
    maxLoanByDSR(p.income || 0, stressRate, p.years || 40, p.otherMonthly || 0),
    (p.product && p.product.maxLoan) || Infinity
  );
}

function analyzePerson(p, common) {
  // 기본공제/혼인공제 여부는 각자(p) 설정, 출산공제는 공통(common) 설정
  const gift = calcGiftTax(p.gift || 0, { marriage: p.marriage, birth: common.birth, useBasic: p.useBasic });
  const fam = calcFamilyLoan(p.family || 0, p.familyYears || 10);
  const equity = (p.cash || 0) + gift.netReceived;   // 현금 + 세후증여
  const stressRate = (p.rate || 0.041) + REGULATION.STRESS_DSR_ADDON;
  // 대출 한도(DSR)는 세전 연소득 기준으로 산정 — 기타대출 월 원리금은 한도에서 차감
  const otherMonthly = p.otherMonthly || 0;
  const dsrLoan = Math.min(
    maxLoanByDSR(p.income || 0, stressRate, p.years || 40, otherMonthly),
    (p.product && p.product.maxLoan) || Infinity
  );
  return {
    cash: p.cash || 0, giftGross: p.gift || 0, netGift: gift.netReceived, giftTax: gift.tax,
    giftDetail: gift,   // 증여공제 내역(기본/혼인·출산 공제, 과세표준, 세율 등) 표시용
    parentSplit: p.parentSplit,   // 부모지원 총액 분해 내역(기본공제/혼인공제/무이자차용/그외증여)
    family: p.family || 0, familyMonthly: fam.monthly, familyOverLimit: fam.overLimit,
    equity, dsrLoan, income: p.income || 0, otherMonthly,
    // 실제 상환 여력은 사용자가 입력한 세후 실수령 월급 기준
    netMonthly: p.netMonthly || 0,
    product: p.product, rate: p.rate, years: p.years,
  };
}

export function analyzeCouple(inA, inB, common) {
  const { firstHome = false, regulated = false, repay = 'annuity' } = common;
  const A = analyzePerson(inA, common);
  const B = analyzePerson(inB, common);

  const ownEquity = A.equity + B.equity;                 // 두 사람 자기자본(현금+세후증여)
  const familyTotal = A.family + B.family;               // 부모 무이자 차용 합
  const available = ownEquity + familyTotal;             // 매수 투입 가능 현금성 자금
  const dsrTotal = A.dsrLoan + B.dsrLoan;                // 소득 기준 대출 한도(각자 최대치) 합

  // 사용자가 대출 시뮬레이터 슬라이더로 실제 사용할 대출액을 낮췄다면 그 값을 쓰고,
  // 손대지 않았다면(loanOverride 미지정) 기존처럼 각자 최대 한도(dsrLoan)를 그대로 사용한다.
  const reqA = (inA.loanOverride != null) ? Math.min(Math.max(0, inA.loanOverride), A.dsrLoan) : A.dsrLoan;
  const reqB = (inB.loanOverride != null) ? Math.min(Math.max(0, inB.loanOverride), B.dsrLoan) : B.dsrLoan;
  const reqTotal = reqA + reqB;                          // 실제 조달하려는 대출 희망액 합

  // LTV (공통, 일반 주담대 기준)
  let ltv;
  if (regulated) ltv = firstHome ? REGULATION.LTV_REGULATED_FIRST : REGULATION.LTV_REGULATED;
  else ltv = firstHome ? REGULATION.LTV_NORMAL_FIRST : REGULATION.LTV_NORMAL;

  const loanCapAt = (price) => {
    let loan = Math.min(reqTotal, price * ltv);
    if (regulated) loan = Math.min(loan, REGULATION.METRO_LOAN_CAP);
    return loan;
  };
  const feasible = (price) => {
    const acq = calcAcquisitionTax(price, firstHome).tax;
    const broker = calcBrokerFee(price);
    return (price - loanCapAt(price) + acq + broker) <= available;
  };

  let lo = 0, hi = 50 * 억;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (feasible(mid)) lo = mid; else hi = mid;
  }
  const maxPrice = lo;

  const acq = calcAcquisitionTax(maxPrice, firstHome);
  const broker = calcBrokerFee(maxPrice);
  const byLTV = maxPrice * ltv;
  let loan = Math.min(reqTotal, byLTV);
  let bind = '희망 대출액';
  if (loan === byLTV) bind = `LTV ${(ltv * 100).toFixed(0)}%${regulated ? '(규제지역)' : ''}`;
  if (regulated && loan > REGULATION.METRO_LOAN_CAP) { loan = REGULATION.METRO_LOAN_CAP; bind = '6·27 대책 6억'; }

  // 대출을 각자 희망(요청) 대출액 비율로 배분
  const loanA = reqTotal > 0 ? loan * reqA / reqTotal : loan / 2;
  const loanB = loan - loanA;
  const monthlyA = calcMonthlyPayment(loanA, A.rate, A.years, repay).first + A.familyMonthly;
  const monthlyB = calcMonthlyPayment(loanB, B.rate, B.years, repay).first + B.familyMonthly;

  const person = (P, ln, mth) => {
    const bankMonthly = mth - P.familyMonthly;   // 은행 상환분
    // DSR = (주담대 원리금 + 기타대출 원리금) × 12 ÷ 세전 연소득. 규제선 40%.
    const housingMonthlyDsr = calcMonthlyPayment(ln, P.rate, P.years, 'annuity').first;  // 원리금균등 기준
    const dsrMonthly = housingMonthlyDsr + (P.otherMonthly || 0);
    const dsrRatio = P.income > 0 ? (dsrMonthly * 12) / P.income : 0;
    return {
      cash: P.cash, netGift: P.netGift, giftGross: P.giftGross, giftTax: P.giftTax,
      giftDetail: P.giftDetail,   // 증여공제 분해 내역 (기본/혼인·출산 공제, 과세표준, 세율)
      parentSplit: P.parentSplit, // 부모지원 총액 분해 내역 (기본공제/혼인공제/무이자차용/그외증여)
      family: P.family, parentTotal: P.giftGross + P.family,   // 부모 지원 총액
      loan: ln, monthly: mth,
      bankMonthly, familyMonthly: P.familyMonthly,
      income: P.income, netMonthly: P.netMonthly,
      // 상환 여력: 실제 세후 월급 대비 월 상환액 비중
      burdenPct: P.netMonthly > 0 ? (mth / P.netMonthly) : 0,
      contrib: P.equity + P.family + ln,     // 각자 총 기여 가용자금
      dsrLoan: P.dsrLoan, familyOverLimit: P.familyOverLimit,
      // DSR 계산기 표시용 (주담대·기타대출 원리금 분해)
      dsrRatio, dsrHousingMonthly: housingMonthlyDsr, dsrOtherMonthly: P.otherMonthly || 0,
      rate: P.rate, years: P.years,          // 대출 시뮬레이터용 (금리·만기)
    };
  };

  const warnings = [];
  if (regulated) warnings.push('토지거래허가구역/규제지역: 실거주 목적만 허가·2년 실거주 의무, 갭투자 불가, LTV·6억 규제 적용.');
  if (A.familyOverLimit) warnings.push(`나의 부모 차용이 무이자 한도(${won2eok(FAMILY_LOAN.MAX_NO_INTEREST)})를 초과했습니다.`);
  if (B.familyOverLimit) warnings.push(`여자친구의 부모 차용이 무이자 한도(${won2eok(FAMILY_LOAN.MAX_NO_INTEREST)})를 초과했습니다.`);

  return {
    maxPrice, ltv, loan, loanBind: bind, warnings,
    ownEquity, familyTotal, available,
    acqTax: acq.tax, acqRate: acq.rate, brokerFee: broker,
    giftTax: A.giftTax + B.giftTax, netGift: A.netGift + B.netGift,
    grossGift: A.giftGross + B.giftGross,
    totalMonthly: monthlyA + monthlyB,
    regulated,
    A: person(A, loanA, monthlyA),
    B: person(B, loanB, monthlyB),
    composition: { cashGift: ownEquity, family: familyTotal, loan },
  };
}

/* ============================================================
 * 참고문헌 · 법령 출처 (UI 하단 표시용)
 * ============================================================ */
export const REFERENCES = [
  { name: '지방세법 제11조 (취득세 세율)', org: '행정안전부',
    url: 'https://www.law.go.kr/법령/지방세법' },
  { name: '지방세특례제한법 제36조의3 (생애최초 취득세 감면)', org: '행정안전부',
    url: 'https://www.law.go.kr/법령/지방세특례제한법' },
  { name: '상속세 및 증여세법 제53조·제53조의2 (증여재산공제·혼인출산공제)', org: '국세청',
    url: 'https://www.law.go.kr/법령/상속세및증여세법' },
  { name: '상속세 및 증여세법 제41조의4 (금전 무상대출 등에 따른 이익의 증여)', org: '국세청',
    url: 'https://www.law.go.kr/법령/상속세및증여세법' },
  { name: '은행업감독규정 별표6 (LTV·DSR 규제비율)', org: '금융위원회·금융감독원',
    url: 'https://www.law.go.kr/행정규칙/은행업감독규정' },
  { name: '가계부채 관리방안 (2025.6.27, 수도권 주담대 6억 한도·스트레스 DSR)', org: '금융위원회',
    url: 'https://www.fsc.go.kr' },
  { name: '공인중개사법 시행규칙 제20조 (중개보수 상한요율)', org: '국토교통부',
    url: 'https://www.law.go.kr/법령/공인중개사법시행규칙' },
  { name: '부동산 거래신고 등에 관한 법률 (토지거래허가구역)', org: '국토교통부',
    url: 'https://www.law.go.kr/법령/부동산거래신고등에관한법률' },
  { name: '실거래가 공개시스템 (분석 데이터 원천)', org: '국토교통부',
    url: 'https://rt.molit.go.kr' },
];

/* ============================================================
 * 증여세 계산 근거 (수식 + 세율표, UI 표시용)
 * ============================================================ */
export const GIFT_TAX_TABLE = {
  formula: [
    '① 과세표준 = 증여재산가액 − 증여재산공제',
    '② 산출세액 = 과세표준 × 세율 − 누진공제액',
    '③ 납부세액 = 산출세액 × (1 − 신고세액공제 3%)',
  ],
  deductions: [
    { name: '직계존속 → 성년 자녀 (10년 합산)', amount: '5,000만원' },
    { name: '혼인 증여공제 (혼인신고 전후 2년)', amount: '1억원' },
    { name: '출산 증여공제 (자녀 출생 2년 내)', amount: '1억원 (혼인공제와 통합 1억 한도)' },
  ],
  // 상속세 및 증여세법 제26조 세율 (과세표준 구간별)
  brackets: [
    { base: '1억원 이하', rate: '10%', deduct: '—' },
    { base: '1억원 초과 ~ 5억원 이하', rate: '20%', deduct: '1,000만원' },
    { base: '5억원 초과 ~ 10억원 이하', rate: '30%', deduct: '6,000만원' },
    { base: '10억원 초과 ~ 30억원 이하', rate: '40%', deduct: '1억 6,000만원' },
    { base: '30억원 초과', rate: '50%', deduct: '4억 6,000만원' },
  ],
  example: '예) 성년 자녀가 부모에게 3억 증여 + 혼인공제 → 과세표준 3억 − (5,000만 + 1억) = 1.5억, ' +
           '산출세액 1.5억 × 20% − 1,000만 = 2,000만원, 신고공제 3% 적용 → 약 1,940만원.',
};

/* 실제 대출 금리를 직접 확인할 수 있는 사이트 (금리 입력란에 반영용) */
export const LOAN_RATE_SOURCES = [
  { name: '금융상품 한눈에 (주택담보대출 금리 비교)', org: '금융감독원',
    url: 'https://finlife.fss.or.kr/finlife/ldng/houseMrtg/list.do?menuNo=700007' },
  { name: '대출금리비교 (은행별 가계대출)', org: '전국은행연합회 소비자포털',
    url: 'https://portal.kfb.or.kr/compare/loan_household.php' },
  { name: '주택담보대출 찾기 (보금자리·디딤돌·특례)', org: '한국주택금융공사',
    url: 'https://www.hf.go.kr/ko/sub01/sub01_04.do' },
  { name: '주택도시기금 (디딤돌·신생아 특례 공시금리)', org: '주택도시보증공사',
    url: 'https://nhuf.molit.go.kr' },
];

/* 포맷 헬퍼 (UI 공용) */
export function won2eok(v, digits = 2) {
  return (v / 억).toFixed(digits).replace(/\.?0+$/, '') + '억';
}
export function won2man(v) {
  return Math.round(v / 만).toLocaleString() + '만원';
}

/* ═══════════ 전세 자금 계획 (매매와 분리된 비용 체계) ═══════════
 * 전세는 취득세·등기비용이 없다. 나가는 돈: 보증금(대부분 회수), 임대차
 * 중개보수, 이사·기타비, (선택) 전세보증금 반환보증 보험료, 대출이자. */

export const JEONSE_LOAN_PRODUCTS = [
  { id: 'butumok_newly', name: '버팀목 전세대출 (신혼부부)', rate: 0.021, cap: 3.0e8, ratio: 0.80,
    cond: '수도권 보증금 4억 이하 · 부부합산 소득 7,500만 이하', condCapJ: 4.0e8 },
  { id: 'hug',  name: '일반 전세대출 (HUG 보증)', rate: 0.038, cap: 4.0e8, ratio: 0.80,
    cond: '수도권 보증금 7억 이하', condCapJ: 7.0e8 },
  { id: 'sgi',  name: '일반 전세대출 (SGI 보증)', rate: 0.041, cap: 5.0e8, ratio: 0.80,
    cond: '보증금 제한 없음 · 한도 최대 5억', condCapJ: Infinity },
];

// 임대차(전세) 중개보수 상한 — 서울 주택 임대차 요율 (공인중개사법 시행규칙)
export function calcJeonseBroker(J) {
  if (J <= 0.5e8) return Math.min(J * 0.005, 20e4);
  if (J <  1e8)   return Math.min(J * 0.004, 30e4);
  if (J <  6e8)   return J * 0.003;
  if (J < 12e8)   return J * 0.004;
  return J * 0.008;
}

export function jeonseLoanFor(J, product) {
  if (J > (product.condCapJ ?? Infinity)) return 0;   // 상품의 보증금 요건 초과 → 대출 불가
  return Math.min(J * product.ratio, product.cap);
}

// 자기자본+전세대출로 감당 가능한 최대 보증금 (중개보수·이사비 포함, 이분탐색)
export function maxJeonseBudget(equity, product, moveCost = 3e6) {
  let lo = 0, hi = 50e8;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    const need = mid + calcJeonseBroker(mid) + moveCost - jeonseLoanFor(mid, product);
    if (need <= equity) lo = mid; else hi = mid;
  }
  return lo;
}

// HUG 전세보증금 반환보증 보험료율 (아파트 개인 기준 연 0.115~0.128% — 상단값 사용)
export const JEONSE_INSURE_RATE = 0.00128;
