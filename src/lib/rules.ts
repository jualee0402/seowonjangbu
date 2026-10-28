/**
 * 계산 규칙 (시행 월별)
 * - 규정이 바뀌면 '설정 → 계산 규칙'에서 시행 월부터 적용할 규칙을 추가
 * - 기록은 그 달에 시행 중인 규칙으로 계산 (지난 기록은 그때 규칙 그대로)
 * - 설정을 바꾸지 않은 사람은 아래 DEFAULT_RULES를 따름 (코드에서 고치면 모두에게 적용)
 */

export type Rules = {
  /** 시행 월 (YYYY-MM). 첫 규칙은 FIRST_FROM */
  from: string;
  /** 평일 정규 근무 시작·종료: 이 시간 전후 근무가 초과근무 */
  workStart: string;
  workEnd: string;
  /** 평일 공제 (분) */
  deductMinutes: number;
  /** 하루 초과근무가 이 시간(분) 이상일 때만 인정 (평일은 공제 전 기준, 휴일 포함) */
  minDailyMinutes: number;
  /** 하루 초과근무 상한 (분). null = 상한 없음 */
  weekdayCapMinutes: number | null;
  holidayCapMinutes: number | null;
  /** 월 상한 (시간, 기본 초과근무=정액분 포함). 실적은 (월 상한 − 정액분)까지 인정 */
  monthlyLimitHours: number;
  /** 기본 초과근무 시간 = 정액분 (시간). 매달 기본으로 받는 시간 */
  fixedMonthlyHours: number;
  /** 월 합계에서 1시간 미만(분 단위)은 버림 */
  monthlyRoundDown: boolean;
  /** 급량비 1개 금액 (원) */
  mealPrice: number;
  /** 급량비 한 달 최대 개수 */
  mealMonthlyCap: number;
  /** 평일: 정규 시작 전·종료 후 근무가 각각 이 시간(분) 이상이면 1개씩 */
  weekdayMealMinutes: number;
  /** 평일: 둘 다 모자라도 합쳐서 기준 이상이면 1개 */
  weekdayMealCombined: boolean;
  /** 평일 하루 최대 개수 */
  weekdayMealMax: number;
  /** 휴일: 근무가 이 시간(분)을 넘으면 1개 */
  holidayMealMinutes: number;
  /** 휴일: 근무가 이 시간(분)을 넘으면 2개. null = 사용 안 함 */
  holidaySecondMealMinutes: number | null;
};

export const RULES_KEY = "seowon_rules_v1";
/** 첫 규칙의 시행 월 (처음부터 적용) */
export const FIRST_FROM = "0000-01";

const BASE: Omit<Rules, "from"> = {
  workStart: "09:00",
  workEnd: "18:00",
  deductMinutes: 60,
  minDailyMinutes: 60,
  weekdayCapMinutes: null,
  holidayCapMinutes: null,
  monthlyLimitHours: 57,
  fixedMonthlyHours: 10,
  monthlyRoundDown: true,
  mealPrice: 9000,
  mealMonthlyCap: 20,
  weekdayMealMinutes: 60,
  weekdayMealCombined: true,
  weekdayMealMax: 2,
  holidayMealMinutes: 60,
  holidaySecondMealMinutes: null,
};

/**
 * 기본 규칙
 * - 2026년 9월까지: 하루 초과근무 4시간 상한
 * - 2026년 10월부터: 상한 없음 (「지방공무원 수당 등에 관한 규정」 제15조 개정, 2026.10.1. 시행)
 * - 공통: 월 57시간 상한(정액분 10시간 포함 → 실적 최대 47시간), 1일 1시간 이상일 때만 인정,
 *   평일 1시간 공제·휴일 공제 없음, 월간 합산 시 분 단위 버림 (「지방공무원 보수업무 등 처리지침」)
 */
export const DEFAULT_RULES: Rules[] = [
  { from: FIRST_FROM, ...BASE, weekdayCapMinutes: 240, holidayCapMinutes: 240 },
  { from: "2026-10", ...BASE },
];

export function sortRules(list: Rules[]) {
  return [...list].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/** 항목 순서를 고정한 사본 (저장값 비교용) */
function canonical(r: Rules): Rules {
  return {
    from: r.from,
    workStart: r.workStart,
    workEnd: r.workEnd,
    deductMinutes: r.deductMinutes,
    minDailyMinutes: r.minDailyMinutes,
    weekdayCapMinutes: r.weekdayCapMinutes,
    holidayCapMinutes: r.holidayCapMinutes,
    monthlyLimitHours: r.monthlyLimitHours,
    fixedMonthlyHours: r.fixedMonthlyHours,
    monthlyRoundDown: r.monthlyRoundDown,
    mealPrice: r.mealPrice,
    mealMonthlyCap: r.mealMonthlyCap,
    weekdayMealMinutes: r.weekdayMealMinutes,
    weekdayMealCombined: r.weekdayMealCombined,
    weekdayMealMax: r.weekdayMealMax,
    holidayMealMinutes: r.holidayMealMinutes,
    holidaySecondMealMinutes: r.holidaySecondMealMinutes,
  };
}

/** 두 규칙 목록이 같은지 (순서·항목 순서 무관) */
export function sameRules(a: Rules[], b: Rules[]) {
  const key = (l: Rules[]) => JSON.stringify(sortRules(l).map(canonical));
  return key(a) === key(b);
}

/** 그 달(YYYY-MM)에 시행 중인 규칙. list는 시행 월 오름차순 */
export function rulesFor(list: Rules[], monthKey: string): Rules {
  let found = list[0] ?? DEFAULT_RULES[DEFAULT_RULES.length - 1];
  for (const r of list) if (r.from <= monthKey) found = r;
  return found;
}

/** "2026년 10월부터" / "처음부터" */
export function rulesLabel(r: Rules) {
  if (r.from === FIRST_FROM) return "처음부터";
  const [y, m] = r.from.split("-").map(Number);
  return `${y}년 ${m}월부터`;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const isInt = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

/** 규칙 하나의 문제점 목록 (없으면 빈 배열) */
export function validateRules(r: Rules): string[] {
  const errors: string[] = [];
  if (!TIME.test(r.workStart) || !TIME.test(r.workEnd) || r.workStart >= r.workEnd)
    errors.push("평일 정규 근무 시간은 시작이 종료보다 빨라야 해요.");
  if (!isInt(r.deductMinutes, 0, 600)) errors.push("평일 공제는 0~600분으로 입력해 주세요.");
  if (r.weekdayCapMinutes !== null && !isInt(r.weekdayCapMinutes, 60, 1440))
    errors.push("평일 하루 상한은 1~24시간으로 입력하거나 비워 두세요.");
  if (r.holidayCapMinutes !== null && !isInt(r.holidayCapMinutes, 60, 1440))
    errors.push("휴일 하루 상한은 1~24시간으로 입력하거나 비워 두세요.");
  if (!isInt(r.minDailyMinutes, 0, 600)) errors.push("하루 최소 인정은 0~600분으로 입력해 주세요.");
  if (!isInt(r.monthlyLimitHours, 1, 744)) errors.push("월 상한을 1시간 이상으로 입력해 주세요.");
  if (!isInt(r.fixedMonthlyHours, 0, 744) || r.fixedMonthlyHours > r.monthlyLimitHours)
    errors.push("기본 초과근무(정액분)는 월 상한보다 클 수 없어요.");
  if (typeof r.monthlyRoundDown !== "boolean") errors.push("월 합계 버림 설정을 확인해 주세요.");
  if (!isInt(r.mealPrice, 1, 1_000_000)) errors.push("급량비 1개 금액을 입력해 주세요.");
  if (!isInt(r.mealMonthlyCap, 0, 100)) errors.push("급량비 한 달 최대는 0~100개로 입력해 주세요.");
  if (!isInt(r.weekdayMealMinutes, 1, 1440)) errors.push("평일 급량비 기준을 1분 이상으로 입력해 주세요.");
  if (!isInt(r.weekdayMealMax, 0, 5)) errors.push("평일 하루 최대는 0~5개로 입력해 주세요.");
  if (!isInt(r.holidayMealMinutes, 0, 1440)) errors.push("휴일 급량비 기준을 입력해 주세요.");
  if (
    r.holidaySecondMealMinutes !== null &&
    (!isInt(r.holidaySecondMealMinutes, 1, 1440) || r.holidaySecondMealMinutes <= r.holidayMealMinutes)
  )
    errors.push("휴일 2개 기준은 1개 기준보다 길게 입력하거나 비워 두세요.");
  if (typeof r.weekdayMealCombined !== "boolean") errors.push("평일 합산 기준 설정을 확인해 주세요.");
  return errors;
}

export function loadRules(): Rules[] {
  try {
    const raw = localStorage.getItem(RULES_KEY);
    if (!raw) return DEFAULT_RULES;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return DEFAULT_RULES;
    const list = sortRules(parsed.map((p) => canonical({ ...BASE, ...p } as Rules)));
    const valid =
      list[0].from === FIRST_FROM &&
      list.every((r) => /^\d{4}-\d{2}$/.test(r.from) && validateRules(r).length === 0) &&
      new Set(list.map((r) => r.from)).size === list.length;
    return valid ? list : DEFAULT_RULES;
  } catch {
    return DEFAULT_RULES;
  }
}

/** 기본값과 같으면 저장하지 않음 (코드의 기본 규칙이 바뀌면 그대로 따라가도록) */
export function saveRules(list: Rules[]) {
  try {
    if (sameRules(list, DEFAULT_RULES)) localStorage.removeItem(RULES_KEY);
    else localStorage.setItem(RULES_KEY, JSON.stringify(sortRules(list).map(canonical)));
  } catch {
    // 저장 공간 문제 등은 무시 (화면 상태는 유지)
  }
}
