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
 * @param {object} opt      { marriage:boolean, birth:boolean } 혼인/출산 공제 적용 여부
 * @returns {{taxable:number, tax:number, netReceived:number, deduction:number}}
 *          taxable=과세표준, tax=실질 증여세(신고공제 반영), netReceived=세후 실수령
 */
export function calcGiftTax(amount, opt = {}) {
  if (!amount || amount <= 0) return { taxable: 0, tax: 0, netReceived: 0, deduction: 0 };

  let deduction = GIFT.BASIC_DEDUCTION;
  // 혼인·출산 공제는 통합 1억 한도
  if (opt.marriage || opt.birth) deduction += GIFT.MARRIAGE_BIRTH_CAP;

  const taxable = Math.max(0, amount - deduction);
  if (taxable === 0) return { taxable: 0, tax: 0, netReceived: amount, deduction };

  const b = GIFT.BRACKETS.find(br => taxable <= br.limit);
  const grossTax = taxable * b.rate - b.deduct;
  const tax = Math.max(0, grossTax * (1 - GIFT.REPORT_CREDIT));  // 자진신고 3% 공제

  return { taxable, tax, netReceived: amount - tax, deduction };
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
export const LOAN_PRODUCTS = [
  {
    id: 'newborn', name: '신생아 특례대출', rate: 0.024, years: 30,
    maxLoan: 5 * 억, houseCap: 9 * 억, incomeCap: 20000 * 만, ltv: 0.80,
    note: '2년 내 출산 가구 · 부부합산 소득 2억↓ · 주택 9억↓ · 최대 5억',
    requiresBirth: true,
  },
  {
    id: 'didimdol', name: '디딤돌대출 (신혼)', rate: 0.032, years: 30,
    maxLoan: 4 * 억, houseCap: 6 * 억, incomeCap: 8500 * 만, ltv: 0.80,
    note: '신혼 부부합산 소득 8,500만↓ · 주택 6억↓ · 전용 85㎡↓',
  },
  {
    id: 'bogeumjari', name: '보금자리론', rate: 0.043, years: 40,
    maxLoan: 3.6 * 억, houseCap: 6 * 억, incomeCap: 8500 * 만, ltv: 0.70,
    note: '소득 7천만↓(신혼 8,500만) · 주택 6억↓ · 고정금리',
  },
  {
    id: 'bank', name: '일반 주택담보대출', rate: 0.041, years: 40,
    maxLoan: Infinity, houseCap: Infinity, incomeCap: Infinity,
    ltv: 0.70, ltvFirst: 0.80,
    note: 'LTV 70%(생애최초 80%) · 스트레스 DSR 40% · 변동/혼합',
  },
];

const DSR_LIMIT = 0.40;

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
export function maxLoanByDSR(annualIncome, annualRate, years) {
  if (!annualIncome || annualIncome <= 0) return 0;
  const r = annualRate / 12, n = years * 12;
  const monthlyCap = annualIncome * DSR_LIMIT / 12;
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
export function maxLoanForProduct(product, income, price, rate, years, firstHome) {
  const byDSR = maxLoanByDSR(income, rate, years);
  const ltv = (firstHome && product.ltvFirst) ? product.ltvFirst : product.ltv;
  const byLTV = price * ltv;
  const byProduct = product.maxLoan;

  const loan = Math.min(byDSR, byLTV, byProduct);
  let bind = 'DSR';
  if (loan === byLTV) bind = `LTV ${(ltv * 100).toFixed(0)}%`;
  else if (loan === byProduct) bind = '상품한도';
  return { loan: Math.max(0, loan), bind };
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
  } = input;

  // 1) 세후 증여액 (본인/여자친구 각각 계산 후 합산)
  const giftMe = calcGiftTax(myGift, { marriage, birth });
  const giftGf = calcGiftTax(gfGift, { marriage, birth });
  const netGift = giftMe.netReceived + giftGf.netReceived;
  const giftTax = giftMe.tax + giftGf.tax;

  // 2) 순수 자기자본 (현금 + 세후증여)
  const ownEquity = myCash + gfCash + netGift;

  // 3) 이분탐색으로 최대 주택가 찾기
  //    조건: ownEquity - 부대비용(주택가) + 대출(주택가) >= 주택가
  const feasible = (price) => {
    const acq = calcAcquisitionTax(price, firstHome).tax;
    const broker = calcBrokerFee(price);
    const { loan } = maxLoanForProduct(product, income, price, rate, years, firstHome);
    // 자기자본으로 감당해야 하는 몫 = 주택가 - 대출 + 부대비용
    const needOwn = price - loan + acq + broker;
    return needOwn <= ownEquity;
  };

  let lo = 0, hi = 50 * 억;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (feasible(mid)) lo = mid; else hi = mid;
  }
  let maxPrice = lo;
  // 정책상품 주택가 상한 적용
  if (product.houseCap && maxPrice > product.houseCap) maxPrice = product.houseCap;

  // 4) 최대가격 기준 상세 재계산
  const acq = calcAcquisitionTax(maxPrice, firstHome);
  const broker = calcBrokerFee(maxPrice);
  const { loan, bind } = maxLoanForProduct(product, income, maxPrice, rate, years, firstHome);
  const monthly = calcMonthlyPayment(loan, rate, years, repay);
  const cashUsed = maxPrice + acq.tax + broker - loan;   // 실제 투입 자기자본
  const leftover = ownEquity - cashUsed;

  // 5) 정책상품 자격 경고
  const warnings = [];
  if (income > product.incomeCap) warnings.push(`${product.name}은 부부합산 소득 ${(product.incomeCap/만).toLocaleString()}만원 이하만 가능합니다.`);
  if (product.houseCap !== Infinity && lo > product.houseCap) warnings.push(`${product.name}은 주택가 ${(product.houseCap/억).toFixed(0)}억 이하만 가능해 예산이 제한되었습니다.`);
  if (product.requiresBirth && !birth) warnings.push(`${product.name}은 2년 내 출산(예정) 가구 대상입니다.`);
  const dsrRatio = income > 0 ? (calcMonthlyPayment(loan, rate, years, 'annuity').first * 12) / income : 0;

  return {
    netGift, giftTax, giftMe, giftGf,
    ownEquity,
    maxPrice,
    acqTax: acq.tax, acqRate: acq.rate, acqDiscount: acq.discount,
    brokerFee: broker,
    loan, loanBind: bind,
    monthlyFirst: monthly.first, monthlyAvg: monthly.avg, totalInterest: monthly.totalInterest,
    cashUsed, leftover,
    dsrRatio,
    warnings,
    // 자금 구성 (차트용)
    composition: {
      cash: myCash + gfCash,
      gift: netGift,
      loan: loan,
    },
  };
}

/* 포맷 헬퍼 (UI 공용) */
export function won2eok(v, digits = 2) {
  return (v / 억).toFixed(digits).replace(/\.?0+$/, '') + '억';
}
export function won2man(v) {
  return Math.round(v / 만).toLocaleString() + '만원';
}
