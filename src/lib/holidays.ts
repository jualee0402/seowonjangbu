/**
 * 휴일 판정
 * - 토·일: 항상 휴일
 * - 관공서 공휴일(대체공휴일·선거일 포함): 아래 PUBLIC_HOLIDAYS 목록으로 자동 휴일
 * - 임시공휴일 등: 앱의 '휴일 설정'에서 사용자가 직접 지정 (기기에 저장)
 */

/**
 * 관공서 공휴일 목록 (YYYY-MM-DD → 이름)
 * - 2026년부터 노동절(5/1)·제헌절(7/17) 관공서 공휴일 포함
 * - 2026·2027년: 월력요항 기준 / 2028년: 한국천문연구원 잠정 자료 (2027년 6월 월력요항 발표 후 확인)
 * - 임시공휴일이 발표되면 앱에서 지정하거나 이 목록에 추가하세요.
 */
export const PUBLIC_HOLIDAYS: Record<string, string> = {
  // 2026
  "2026-01-01": "신정",
  "2026-02-16": "설날 연휴",
  "2026-02-17": "설날",
  "2026-02-18": "설날 연휴",
  "2026-03-01": "삼일절",
  "2026-03-02": "대체공휴일",
  "2026-05-01": "노동절",
  "2026-05-05": "어린이날",
  "2026-05-24": "부처님오신날",
  "2026-05-25": "대체공휴일",
  "2026-06-03": "지방선거",
  "2026-06-06": "현충일",
  "2026-07-17": "제헌절",
  "2026-08-15": "광복절",
  "2026-08-17": "대체공휴일",
  "2026-09-24": "추석 연휴",
  "2026-09-25": "추석",
  "2026-09-26": "추석 연휴",
  "2026-10-03": "개천절",
  "2026-10-05": "대체공휴일",
  "2026-10-09": "한글날",
  "2026-12-25": "성탄절",
  // 2027
  "2027-01-01": "신정",
  "2027-02-06": "설날 연휴",
  "2027-02-07": "설날",
  "2027-02-08": "설날 연휴",
  "2027-02-09": "대체공휴일",
  "2027-03-01": "삼일절",
  "2027-05-01": "노동절",
  "2027-05-03": "대체공휴일",
  "2027-05-05": "어린이날",
  "2027-05-13": "부처님오신날",
  "2027-06-06": "현충일",
  "2027-07-17": "제헌절",
  "2027-07-19": "대체공휴일",
  "2027-08-15": "광복절",
  "2027-08-16": "대체공휴일",
  "2027-09-14": "추석 연휴",
  "2027-09-15": "추석",
  "2027-09-16": "추석 연휴",
  "2027-10-03": "개천절",
  "2027-10-04": "대체공휴일",
  "2027-10-09": "한글날",
  "2027-10-11": "대체공휴일",
  "2027-12-25": "성탄절",
  "2027-12-27": "대체공휴일",
  // 2028 (잠정)
  "2028-01-01": "신정",
  "2028-01-26": "설날 연휴",
  "2028-01-27": "설날",
  "2028-01-28": "설날 연휴",
  "2028-03-01": "삼일절",
  "2028-04-12": "국회의원선거",
  "2028-05-01": "노동절",
  "2028-05-02": "부처님오신날",
  "2028-05-05": "어린이날",
  "2028-06-06": "현충일",
  "2028-07-17": "제헌절",
  "2028-08-15": "광복절",
  "2028-10-02": "추석 연휴",
  "2028-10-03": "추석·개천절",
  "2028-10-04": "추석 연휴",
  "2028-10-05": "대체공휴일",
  "2028-10-09": "한글날",
  "2028-12-25": "성탄절",
};

export const HOLIDAYS_KEY = "seowon_holidays_v1";

/** 사용자가 바꾼 날: 평일→휴일 지정(on: true) 또는 공휴일→평일 계산(on: false) */
export type HolidayOverride = { on: boolean; name?: string };
export type HolidayOverrides = Record<string, HolidayOverride>;

/** 휴일 지정할 때 고를 수 있는 이름 */
export const CUSTOM_HOLIDAY_NAMES = ["임시공휴일", "대체공휴일", "기타 휴일"] as const;
export const DEFAULT_CUSTOM_NAME = "지정 휴일";

export type DayInfo = {
  /** 계산 기준: 평일 / 주말 / (평일인) 휴일 */
  kind: "weekday" | "weekend" | "holiday";
  /** 표시용 이름 (공휴일명 또는 지정한 이름) */
  name?: string;
  /** 휴일의 출처 */
  source?: "public" | "custom";
  /** 공휴일이지만 사용자가 평일로 계산하도록 바꾼 경우 그 공휴일 이름 */
  disabledPublicName?: string;
  /** 0(일) ~ 6(토) */
  dow: number;
};

export function dayOfWeek(dateKey: string): number {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

export function getDayInfo(dateKey: string, overrides: HolidayOverrides): DayInfo {
  const dow = dayOfWeek(dateKey);
  const publicName = PUBLIC_HOLIDAYS[dateKey];
  if (dow === 0 || dow === 6) {
    return { kind: "weekend", name: publicName, source: publicName ? "public" : undefined, dow };
  }
  const ov = overrides[dateKey];
  if (ov && !ov.on && publicName) {
    return { kind: "weekday", disabledPublicName: publicName, dow };
  }
  if (publicName) return { kind: "holiday", name: publicName, source: "public", dow };
  if (ov && ov.on) {
    return { kind: "holiday", name: ov.name || DEFAULT_CUSTOM_NAME, source: "custom", dow };
  }
  return { kind: "weekday", dow };
}

export function isHolidayInfo(info: DayInfo) {
  return info.kind !== "weekday";
}

/** 달력 칸에 들어갈 짧은 이름 */
export function shortHolidayName(name: string) {
  const map: Record<string, string> = {
    대체공휴일: "대체",
    임시공휴일: "임시",
    "기타 휴일": "휴일",
    [DEFAULT_CUSTOM_NAME]: "휴일",
    부처님오신날: "부처님",
    "설날 연휴": "설연휴",
    "추석 연휴": "추석연휴",
    "추석·개천절": "추석",
    국회의원선거: "총선",
  };
  return map[name] ?? name;
}

export function loadHolidayOverrides(): HolidayOverrides {
  try {
    const raw = localStorage.getItem(HOLIDAYS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function saveHolidayOverrides(overrides: HolidayOverrides) {
  try {
    localStorage.setItem(HOLIDAYS_KEY, JSON.stringify(overrides));
  } catch {
    // 저장 공간 문제 등은 무시 (화면 상태는 유지)
  }
}
