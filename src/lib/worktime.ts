/**
 * 초과근무·급량비 계산
 *
 * 평일 초과근무: 오전(09시 이전) + 오후(18시 이후) 합산 후 1시간 공제
 * 휴일 초과근무: 근무시간 전체 (토·일·공휴일·지정 휴일)
 * 1일 4시간 상한: 2026.10.1. 시행 「공무원수당 등에 관한 규정」 개정으로 폐지
 *   → 2026-09-30 이전 기록에는 당시 기준(4시간 상한)을 그대로 적용
 */

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

export const MEAL_PRICE = 9000;
export const MEAL_MONTHLY_CAP = 20;
/** 월 초과근무 한도 (참고 표시용, 계산에는 적용하지 않음) */
export const OVERTIME_MONTHLY_LIMIT = 57;
const DEDUCTION_HOURS = 1;
const OLD_DAILY_CAP_HOURS = 4;
export const DAILY_CAP_REMOVED_FROM = "2026-10-01";

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

/** 해당 날짜에 적용되는 1일 초과근무 상한 (시간) */
export function dailyCapFor(dateKey: string) {
  return dateKey < DAILY_CAP_REMOVED_FROM ? OLD_DAILY_CAP_HOURS : Infinity;
}

export type ComputedRecord = {
  record: WorkRecord;
  /** 출근 날짜 (YYYY-MM-DD) — 평일/휴일 판정과 월 집계 기준 */
  dateKey: string;
  start: Date;
  end: Date | null;
  holiday: boolean;
  workedHours: number;
  /** 평일: 09시 이전 근무 */
  morningHours: number;
  /** 평일: 18시 이후 근무 */
  eveningHours: number;
  /** 평일: 공제한 시간 (최대 1시간) */
  deductionHours: number;
  overtimeHours: number;
  /** 2026년 9월 이전 기록에 4시간 상한이 적용됐는지 */
  cappedByOldRule: boolean;
  meals: number;
};

function overlapHours(startMs: number, endMs: number, winStart: number, winEnd: number) {
  const s = Math.max(startMs, winStart);
  const e = Math.min(endMs, winEnd);
  return Math.max(0, (e - s) / HOUR_MS);
}

export function computeRecord(
  record: WorkRecord,
  isHoliday: (dateKey: string) => boolean,
): ComputedRecord {
  const start = new Date(record.clockIn);
  const end = record.clockOut ? new Date(record.clockOut) : null;
  const dateKey = dateKeyOf(start);
  const holiday = isHoliday(dateKey);
  const base: ComputedRecord = {
    record,
    dateKey,
    start,
    end,
    holiday,
    workedHours: 0,
    morningHours: 0,
    eveningHours: 0,
    deductionHours: 0,
    overtimeHours: 0,
    cappedByOldRule: false,
    meals: 0,
  };
  if (!end) return base;
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) return base;

  const workedHours = ms / HOUR_MS;
  const cap = dailyCapFor(dateKey);

  if (holiday) {
    return {
      ...base,
      workedHours,
      overtimeHours: Math.min(workedHours, cap),
      cappedByOldRule: workedHours > cap,
      // 휴일 급량비: 1시간 초과 근무 시 1개 (하루 최대 1개)
      meals: workedHours > 1 ? 1 : 0,
    };
  }

  // 출근한 날을 기준으로 09:00 / 18:00 구간을 나눔
  const nineAm = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9).getTime();
  const sixPm = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 18).getTime();
  const s = start.getTime();
  const e = end.getTime();
  const morning = overlapHours(s, e, s, nineAm);
  const evening = overlapHours(s, e, sixPm, e);
  const eligible = morning + evening;
  const deduction = Math.min(eligible, DEDUCTION_HOURS);
  const afterDeduction = eligible - deduction;

  // 평일 급량비 (공제 전 시간 기준):
  // 오전 1시간 이상 → 1개, 오후 1시간 이상 → 1개, 둘 다 아니어도 합산 1시간 이상이면 1개
  let meals = 0;
  if (morning >= 1) meals += 1;
  if (evening >= 1) meals += 1;
  if (meals === 0 && eligible >= 1) meals = 1;

  return {
    ...base,
    workedHours,
    morningHours: morning,
    eveningHours: evening,
    deductionHours: deduction,
    overtimeHours: Math.min(afterDeduction, cap),
    cappedByOldRule: afterDeduction > cap,
    meals: Math.min(meals, 2),
  };
}

export type MonthSummary = {
  overtimeHours: number;
  weekdayMeals: number;
  holidayMeals: number;
  /** 상한 적용 전 급량비 개수 */
  rawMeals: number;
  /** 월 상한(20개) 적용 후 */
  meals: number;
  mealCapped: boolean;
  mealAmount: number;
  ledgerSpent: number;
  personalSpent: number;
  balance: number;
};

export function summarizeMonth(
  computed: ComputedRecord[],
  ledger: LedgerEntry[],
  monthKey: string,
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
  const meals = Math.min(rawMeals, MEAL_MONTHLY_CAP);
  const mealAmount = meals * MEAL_PRICE;
  let ledgerSpent = 0;
  let personalSpent = 0;
  for (const e of ledger) {
    if (!e.date.startsWith(monthKey)) continue;
    const amount = Number(e.amount) || 0;
    if (e.type === "personal") personalSpent += amount;
    else ledgerSpent += amount;
  }
  return {
    overtimeHours,
    weekdayMeals,
    holidayMeals,
    rawMeals,
    meals,
    mealCapped: rawMeals >= MEAL_MONTHLY_CAP,
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
