/**
 * 초과근무·급량비 계산
 *
 * 평일 초과근무: 정규 시작 전 + 정규 종료 후 근무를 합산한 뒤 공제
 * 휴일 초과근무: 근무시간 전체 (토·일·공휴일·지정 휴일)
 * 하루 초과근무가 최소 인정 시간(기본 1시간)보다 짧으면 인정하지 않음
 * 운영시간(평일 06~23시, 휴일 07~22시) 밖 근무는 빼고 계산. 단 그 날 초과근무가 8시간 이상이면(국·소장 결재) 예외
 * 월 실적은 (월 상한 − 정액분)까지, 월 합계의 분 단위는 버림
 * 정규 근무 시간, 공제, 하루 상한, 급량비 기준·단가 등은 시행 월별 규칙(rules.ts)을 따름
 */

import type { Rules } from "./rules";

export type WorkRecord = {
  id: string;
  clockIn: string;
  clockOut: string | null;
};

export type LedgerEntry = {
  id: string;
  date: string;
  amount: number;
  memo?: string;
  type?: "ledger" | "personal";
};

const HOUR_MS = 1000 * 60 * 60;

export function pad(n: number) {
  return n.toString().padStart(2, "0");
}

export function dateKeyOf(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function monthKeyOf(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function shiftMonth(monthKey: string, delta: number) {
  const [y, m] = monthKey.split("-").map(Number);
  return monthKeyOf(new Date(y, m - 1 + delta, 1));
}

/** "2026-10-31" + 1일 → "2026-11-01" */
export function shiftDate(dateKey: string, delta: number) {
  const [y, m, d] = dateKey.split("-").map(Number);
  return dateKeyOf(new Date(y, m - 1, d + delta));
}

export type ComputedRecord = {
  record: WorkRecord;
  /** 출근 날짜 (YYYY-MM-DD) — 평일/휴일 판정과 월 집계 기준 */
  dateKey: string;
  start: Date;
  end: Date | null;
  holiday: boolean;
  /** 이 기록에 적용된 규칙 */
  rules: Rules;
  workedHours: number;
  /** 평일: 정규 시작 전 근무 */
  morningHours: number;
  /** 평일: 정규 종료 후 근무 */
  eveningHours: number;
  /** 평일: 공제한 시간 */
  deductionHours: number;
  overtimeHours: number;
  /** 하루 상한이 적용돼 줄어든 경우 그 상한(시간) */
  cappedAt: number | null;
  /** 하루 최소 인정 시간에 못 미쳐 인정하지 않은 경우 */
  belowMinimum: boolean;
  meals: number;
  /** 초과근무로 보는 시간 (운영시간 적용 후, 공제 전). 평일 = 전 + 후, 휴일 = 근무 시간 */
  eligibleHours: number;
  /** 운영시간 밖이라 뺀 시간 (예외로 인정했으면 0) */
  outsideHours: number;
  /** 운영시간 밖 근무가 있었지만 8시간 이상(국·소장 결재)이라 인정한 경우 */
  windowExempt: boolean;
};

function overlapHours(startMs: number, endMs: number, winStart: number, winEnd: number) {
  const s = Math.max(startMs, winStart);
  const e = Math.min(endMs, winEnd);
  return Math.max(0, (e - s) / HOUR_MS);
}

function atTime(day: Date, hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
}

/**
 * @param isHoliday 날짜(YYYY-MM-DD)가 휴일인지
 * @param rulesOf 그 달(YYYY-MM)에 시행 중인 규칙
 */
export function computeRecord(
  record: WorkRecord,
  isHoliday: (dateKey: string) => boolean,
  rulesOf: (monthKey: string) => Rules,
): ComputedRecord {
  const start = new Date(record.clockIn);
  const end = record.clockOut ? new Date(record.clockOut) : null;
  const dateKey = dateKeyOf(start);
  const holiday = isHoliday(dateKey);
  const rules = rulesOf(dateKey.slice(0, 7));
  const base: ComputedRecord = {
    record,
    dateKey,
    start,
    end,
    holiday,
    rules,
    workedHours: 0,
    morningHours: 0,
    eveningHours: 0,
    deductionHours: 0,
    overtimeHours: 0,
    cappedAt: null,
    belowMinimum: false,
    meals: 0,
    eligibleHours: 0,
    outsideHours: 0,
    windowExempt: false,
  };
  if (!end) return base;
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) return base;

  const workedHours = ms / HOUR_MS;
  const minimum = rules.minDailyMinutes / 60;
  const s = start.getTime();
  const e = end.getTime();
  /** 운영시간 예외: 그 날 초과근무(운영시간 적용 전)가 기준 이상이면 운영시간 밖도 인정 */
  const exemptByLength = (raw: number) =>
    rules.windowExemptMinutes !== null && raw >= rules.windowExemptMinutes / 60;

  if (holiday) {
    // 운영시간은 출근한 날 기준 (기본 07:00~22:00)
    const windowed = rules.windowEnabled
      ? overlapHours(s, e, atTime(start, rules.holidayWindowStart), atTime(start, rules.holidayWindowEnd))
      : workedHours;
    const outside = workedHours - windowed;
    const exempt = outside > 1e-9 && exemptByLength(workedHours);
    const hours = exempt ? workedHours : windowed;
    const cap = rules.holidayCapMinutes === null ? Infinity : rules.holidayCapMinutes / 60;
    const counted = hours >= minimum;
    let meals = hours > rules.holidayMealMinutes / 60 ? 1 : 0;
    if (rules.holidaySecondMealMinutes !== null && hours > rules.holidaySecondMealMinutes / 60) meals = 2;
    return {
      ...base,
      workedHours,
      eligibleHours: hours,
      outsideHours: exempt ? 0 : outside,
      windowExempt: exempt,
      overtimeHours: counted ? Math.min(hours, cap) : 0,
      cappedAt: counted && hours > cap ? cap : null,
      belowMinimum: hours > 0 && !counted,
      meals,
    };
  }

  // 출근한 날을 기준으로 정규 시작 전 / 정규 종료 후 구간을 나눔
  const workStart = atTime(start, rules.workStart);
  const workEnd = atTime(start, rules.workEnd);
  const rawMorning = overlapHours(s, e, s, workStart);
  const rawEvening = overlapHours(s, e, workEnd, e);
  // 운영시간(기본 06:00~23:00) 안쪽만
  const winMorning = rules.windowEnabled
    ? overlapHours(s, e, atTime(start, rules.weekdayWindowStart), workStart)
    : rawMorning;
  const winEvening = rules.windowEnabled
    ? overlapHours(s, e, workEnd, atTime(start, rules.weekdayWindowEnd))
    : rawEvening;
  const outside = rawMorning + rawEvening - (winMorning + winEvening);
  const exempt = outside > 1e-9 && exemptByLength(rawMorning + rawEvening);
  const morning = exempt ? rawMorning : winMorning;
  const evening = exempt ? rawEvening : winEvening;
  const eligible = morning + evening;
  const counted = eligible >= minimum;
  const deduction = Math.min(eligible, rules.deductMinutes / 60);
  const afterDeduction = counted ? eligible - deduction : 0;
  const cap = rules.weekdayCapMinutes === null ? Infinity : rules.weekdayCapMinutes / 60;

  // 평일 급량비 (공제 전 시간 기준): 전·후 각각 기준 이상이면 1개씩, 둘 다 아니어도 합산 기준 이상이면 1개
  const threshold = rules.weekdayMealMinutes / 60;
  let meals = 0;
  if (morning >= threshold) meals += 1;
  if (evening >= threshold) meals += 1;
  if (meals === 0 && rules.weekdayMealCombined && eligible >= threshold) meals = 1;

  return {
    ...base,
    workedHours,
    morningHours: morning,
    eveningHours: evening,
    deductionHours: deduction,
    overtimeHours: Math.min(afterDeduction, cap),
    cappedAt: afterDeduction > cap ? cap : null,
    belowMinimum: eligible > 0 && !counted,
    meals: Math.min(meals, rules.weekdayMealMax),
    eligibleHours: eligible,
    outsideHours: exempt ? 0 : Math.max(0, outside),
    windowExempt: exempt,
  };
}

export type MonthSummary = {
  /** 기록으로 계산한 초과근무 합계 (공제 후) */
  overtimeHours: number;
  /** 실적으로 인정되는 최대 시간 (월 상한 − 정액분) */
  overtimeCap: number;
  /** 수당 실적으로 인정되는 시간 (분 단위 버림, 실적 최대 적용) */
  recognizedOvertimeHours: number;
  /** 기본 초과근무(정액분) */
  fixedHours: number;
  /** 이 달 수당 시간 = 정액분 + 인정 실적 */
  allowanceHours: number;
  weekdayMeals: number;
  holidayMeals: number;
  /** 상한 적용 전 급량비 개수 */
  rawMeals: number;
  /** 월 상한 적용 후 */
  meals: number;
  mealCapped: boolean;
  mealAmount: number;
  ledgerSpent: number;
  personalSpent: number;
  balance: number;
};

/** @param rules 그 달에 시행 중인 규칙 (급량비 단가·월 최대) */
export function summarizeMonth(
  computed: ComputedRecord[],
  ledger: LedgerEntry[],
  monthKey: string,
  rules: Rules,
): MonthSummary {
  let overtimeHours = 0;
  let weekdayMeals = 0;
  let holidayMeals = 0;
  for (const c of computed) {
    if (!c.end || !c.dateKey.startsWith(monthKey)) continue;
    overtimeHours += c.overtimeHours;
    if (c.holiday) holidayMeals += c.meals;
    else weekdayMeals += c.meals;
  }
  const rawMeals = weekdayMeals + holidayMeals;
  const meals = Math.min(rawMeals, rules.mealMonthlyCap);
  const mealAmount = meals * rules.mealPrice;
  let ledgerSpent = 0;
  let personalSpent = 0;
  for (const e of ledger) {
    if (!e.date.startsWith(monthKey)) continue;
    const amount = Number(e.amount) || 0;
    if (e.type === "personal") personalSpent += amount;
    else ledgerSpent += amount;
  }
  const overtimeCap = Math.max(0, rules.monthlyLimitHours - rules.fixedMonthlyHours);
  // 분 단위 버림: 부동소수 오차를 피하려고 분으로 바꿔 계산
  const totalMinutes = Math.round(overtimeHours * 60 * 1000) / 1000;
  const counted = rules.monthlyRoundDown ? Math.floor(totalMinutes / 60) : totalMinutes / 60;
  const recognizedOvertimeHours = Math.min(counted, overtimeCap);
  return {
    overtimeHours,
    overtimeCap,
    recognizedOvertimeHours,
    fixedHours: rules.fixedMonthlyHours,
    allowanceHours: rules.fixedMonthlyHours + recognizedOvertimeHours,
    weekdayMeals,
    holidayMeals,
    rawMeals,
    meals,
    mealCapped: rawMeals >= rules.mealMonthlyCap,
    mealAmount,
    ledgerSpent,
    personalSpent,
    balance: mealAmount - ledgerSpent,
  };
}

/** 시간(소수) → "2시간 30분" / "40분" / "0시간" */
export function formatHours(hours: number) {
  const total = Math.round(Math.max(0, hours) * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0 && m > 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

export function formatWon(n: number) {
  return n.toLocaleString("ko-KR") + "원";
}

export function formatTime(d: Date) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function combineDateTime(dateKey: string, hhmm: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  const [y, mo, day] = dateKey.split("-").map(Number);
  if (!y || !mo || !day) return null;
  return new Date(y, mo - 1, day, h, mm, 0, 0).toISOString();
}
