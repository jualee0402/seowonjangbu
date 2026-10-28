/**
 * 서원동 초과근무·급량비 계산기
 * @author 이주아
 * @since 2026.04
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MEAL_MONTHLY_CAP,
  MEAL_PRICE,
  OVERTIME_MONTHLY_LIMIT,
  combineDateTime,
  computeRecord,
  dateKeyOf,
  formatHours,
  formatTime,
  formatWon,
  monthKeyOf,
  pad,
  shiftMonth,
  summarizeMonth,
  type ComputedRecord,
  type LedgerEntry,
  type MonthSummary,
  type WorkRecord,
} from "./lib/worktime";
import {
  CUSTOM_HOLIDAY_NAMES,
  DEFAULT_CUSTOM_NAME,
  HOLIDAYS_KEY,
  PUBLIC_HOLIDAYS,
  getDayInfo,
  isHolidayInfo,
  loadHolidayOverrides,
  saveHolidayOverrides,
  shortHolidayName,
  type DayInfo,
  type HolidayOverride,
  type HolidayOverrides,
} from "./lib/holidays";

const RECORDS_KEY = "seowon_work_records_v1";
const LEDGER_KEY = "seowon_ledger_entries_v1";

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

const C = {
  navy: "#1e3a8a",
  overtime: "#2563eb",
  meal: "#059669",
  danger: "#dc2626",
  holiday: "#dc2626",
  saturday: "#2563eb",
  muted: "#6b7280",
  faint: "#9ca3af",
};

type MealType = "ledger" | "personal";
type SheetName = "work" | "meal" | "holiday" | "settings";

/* ───────── 저장소 ───────── */

function loadList<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function saveList(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 저장 공간 문제 등은 무시 (화면 상태는 유지)
  }
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/* ───────── 날짜·문구 도우미 ───────── */

function isValidDateKey(k: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(k);
}

function formatMonthDay(dateKey: string) {
  const [, m, d] = dateKey.split("-").map(Number);
  return `${m}월 ${d}일`;
}

function monthTitle(monthKey: string) {
  const [y, m] = monthKey.split("-").map(Number);
  return `${y}년 ${m}월`;
}

function monthShort(monthKey: string) {
  return `${Number(monthKey.split("-")[1])}월`;
}

/** 일요일·공휴일은 빨강, 토요일은 파랑 */
function dayColor(info: DayInfo): string | undefined {
  if (info.dow === 0 || (info.kind !== "weekday" && info.name)) return C.holiday;
  if (info.dow === 6) return C.saturday;
  return undefined;
}

/** 받침 유무에 따라 조사 선택 */
function hasBatchim(word: string) {
  const code = word.trim().slice(-1).charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return false;
  return code % 28 !== 0;
}
const withIra = (w: string) => w + (hasBatchim(w) ? "이라" : "라");
const withJiman = (w: string) => w + (hasBatchim(w) ? "이지만" : "지만");

/* ───────── 앱 ───────── */

/** banner: 화면 맨 위(헤더 위)에 붙일 안내 띠. 시연용 화면에서만 사용 */
export default function App({ banner }: { banner?: ReactNode }) {
  const [records, setRecords] = useState<WorkRecord[]>(() => loadList<WorkRecord>(RECORDS_KEY));
  const [ledger, setLedger] = useState<LedgerEntry[]>(() => loadList<LedgerEntry>(LEDGER_KEY));
  const [holidays, setHolidays] = useState<HolidayOverrides>(() => loadHolidayOverrides());
  const [now, setNow] = useState(() => new Date());
  const todayKey = dateKeyOf(now);
  const currentMonth = monthKeyOf(now);
  const [viewMonth, setViewMonth] = useState(currentMonth);
  const [listTab, setListTab] = useState<"work" | "meal">("work");
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [holidaySheetMonth, setHolidaySheetMonth] = useState(currentMonth);
  const [mealType, setMealType] = useState<MealType>("ledger");
  const [toast, setToast] = useState<string | null>(null);

  // 시계: 30초마다, 그리고 앱으로 돌아올 때 갱신
  useEffect(() => {
    const tick = () => setNow(new Date());
    const t = setInterval(tick, 1000 * 30);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);

  // 달이 바뀌면 '이번 달'을 보고 있던 화면은 새 달로 따라감
  const lastCurrentMonth = useRef(currentMonth);
  useEffect(() => {
    if (lastCurrentMonth.current === currentMonth) return;
    const prev = lastCurrentMonth.current;
    setViewMonth((v) => (v === prev ? currentMonth : v));
    lastCurrentMonth.current = currentMonth;
  }, [currentMonth]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const dayInfoOf = (k: string) => getDayInfo(k, holidays);

  const computed = useMemo(
    () => records.map((r) => computeRecord(r, (k) => isHolidayInfo(getDayInfo(k, holidays)))),
    [records, holidays],
  );

  const openRecord = useMemo(() => records.find((r) => !r.clockOut) ?? null, [records]);

  const summary = useMemo(
    () => summarizeMonth(computed, ledger, viewMonth),
    [computed, ledger, viewMonth],
  );

  const monthWorks = useMemo(
    () =>
      computed
        .filter((c) => c.dateKey.startsWith(viewMonth))
        .sort((a, b) => b.start.getTime() - a.start.getTime()),
    [computed, viewMonth],
  );

  const monthMeals = useMemo(
    () =>
      ledger
        .filter((e) => e.date.startsWith(viewMonth))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [ledger, viewMonth],
  );

  const todayDone = computed.filter((c) => c.dateKey === todayKey && c.end);

  const workCountByDay = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of computed) m.set(c.dateKey, (m.get(c.dateKey) ?? 0) + 1);
    return m;
  }, [computed]);

  // 다음 달 버튼: 이번 달 또는 기록이 있는 마지막 달까지
  const latestMonth = useMemo(() => {
    let m = currentMonth;
    for (const c of computed) if (c.dateKey.slice(0, 7) > m) m = c.dateKey.slice(0, 7);
    for (const e of ledger) if (e.date.slice(0, 7) > m) m = e.date.slice(0, 7);
    return m;
  }, [computed, ledger, currentMonth]);

  function commitRecords(next: WorkRecord[]) {
    setRecords(next);
    saveList(RECORDS_KEY, next);
  }

  function commitLedger(next: LedgerEntry[]) {
    setLedger(next);
    saveList(LEDGER_KEY, next);
  }

  function setHoliday(dateKey: string, ov: HolidayOverride | null) {
    setHolidays((prev) => {
      const next = { ...prev };
      if (ov) next[dateKey] = ov;
      else delete next[dateKey];
      saveHolidayOverrides(next);
      return next;
    });
  }

  function clockIn() {
    if (openRecord) {
      setToast("이미 출근 기록이 있어요. 먼저 퇴근을 기록해 주세요.");
      return;
    }
    const t = new Date();
    commitRecords([...records, { id: uid(), clockIn: t.toISOString(), clockOut: null }]);
    setToast(`출근 기록 ${formatTime(t)}`);
  }

  function clockOut() {
    if (!openRecord) {
      setToast("출근 기록이 없어요. 먼저 출근을 기록해 주세요.");
      return;
    }
    const t = new Date();
    const start = new Date(openRecord.clockIn);
    // 하루 상한이 없어져서, 퇴근을 깜빡한 기록이 그대로 초과근무로 잡히지 않게 확인
    if (dateKeyOf(start) !== dateKeyOf(t)) {
      const ok = confirm(
        `${formatMonthDay(dateKeyOf(start))} ${formatTime(start)} 출근 기록이 아직 열려 있어요.\n` +
          `지금(${formatMonthDay(dateKeyOf(t))} ${formatTime(t)}) 퇴근으로 기록할까요?\n\n` +
          "퇴근 기록을 깜빡했다면 '취소'를 누른 뒤, 근무 내역에서 그 기록을 지우고 '근무 직접 입력'으로 다시 넣어 주세요.",
      );
      if (!ok) return;
    }
    commitRecords(
      records.map((r) => (r.id === openRecord.id ? { ...r, clockOut: t.toISOString() } : r)),
    );
    setToast(`퇴근 기록 ${formatTime(t)}`);
  }

  function addWork(input: {
    dateKey: string;
    inIso: string;
    outIso: string;
    holidayChange?: HolidayOverride | null;
  }) {
    commitRecords([...records, { id: uid(), clockIn: input.inIso, clockOut: input.outIso }]);
    if (input.holidayChange !== undefined) setHoliday(input.dateKey, input.holidayChange);
    setSheet(null);
    setViewMonth(input.dateKey.slice(0, 7));
    setListTab("work");
    setToast("근무 기록을 추가했어요.");
  }

  function addMeal(entry: Omit<LedgerEntry, "id">) {
    commitLedger([{ id: uid(), ...entry }, ...ledger]);
    setMealType(entry.type ?? "ledger");
    setSheet(null);
    setViewMonth(entry.date.slice(0, 7));
    setListTab("meal");
    setToast(entry.type === "personal" ? "내돈내산 식사를 기록했어요." : "장부 식사를 기록했어요.");
  }

  function deleteRecord(id: string) {
    if (!confirm("이 근무 기록을 삭제할까요?")) return false;
    commitRecords(records.filter((r) => r.id !== id));
    setToast("근무 기록을 삭제했어요.");
    return true;
  }

  function deleteMeal(id: string) {
    if (!confirm("이 식사 기록을 삭제할까요?")) return false;
    commitLedger(ledger.filter((e) => e.id !== id));
    setToast("식사 기록을 삭제했어요.");
    return true;
  }

  function openHolidaySheet() {
    setHolidaySheetMonth(viewMonth);
    setSheet("holiday");
  }

  function resetRecords() {
    if (!confirm("근무 내역을 모두 삭제할까요?")) return;
    localStorage.removeItem(RECORDS_KEY);
    setRecords([]);
    setToast("근무 내역을 초기화했어요.");
  }

  function resetLedger() {
    if (!confirm("식사 내역을 모두 삭제할까요?")) return;
    localStorage.removeItem(LEDGER_KEY);
    setLedger([]);
    setToast("식사 내역을 초기화했어요.");
  }

  function resetAll() {
    if (
      !confirm(
        "정말 모든 데이터를 초기화할까요?\n근무 내역, 식사 내역, 휴일 설정이 모두 삭제됩니다.",
      )
    )
      return;
    if (!confirm("한 번 더 확인합니다. 계속 진행할까요?")) return;
    localStorage.removeItem(RECORDS_KEY);
    localStorage.removeItem(LEDGER_KEY);
    localStorage.removeItem(HOLIDAYS_KEY);
    setRecords([]);
    setLedger([]);
    setHolidays({});
    setToast("모든 데이터를 초기화했어요.");
  }

  const isCurrent = viewMonth === currentMonth;

  return (
    <div className="min-h-screen" style={{ background: "var(--desk)" }}>
      {/* 앱 화면: 휴대폰에서는 꽉 차고, PC처럼 넓은 화면에서는 가운데 한 줄로 */}
      <div className="app-column relative mx-auto min-h-screen max-w-md pb-20" style={{ background: "var(--bg)" }}>
        {banner}
        <header className="sticky top-0 z-20 shadow-sm" style={{ background: C.navy, color: "white" }}>
          <div className="flex items-center justify-between px-4 pt-4 pb-3">
            <div>
              <div className="text-[11px] opacity-80">서원동 주민센터</div>
              <h1 className="text-[17px] leading-snug font-bold">초과근무 · 급량비 계산기</h1>
            </div>
            <button
              onClick={() => setSheet("settings")}
              className="rounded-lg bg-white/15 px-3 py-2 text-xs font-medium text-white transition hover:bg-white/25 active:scale-95"
            >
              설정
            </button>
          </div>
        </header>

        <main className="px-4">
          {/* 입력: 오늘 */}
          <TodayCard
            now={now}
            todayInfo={dayInfoOf(todayKey)}
            openRecord={openRecord}
            todayDone={todayDone}
            onClockIn={clockIn}
            onClockOut={clockOut}
            onAddWork={() => setSheet("work")}
            onAddMeal={() => setSheet("meal")}
          />

          {/* 보기: 월별 내역 */}
          <section aria-label="월별 내역">
            <div className="mt-7 flex items-center justify-between">
              <div className="-ml-1.5 flex items-center">
                <IconButton label="이전 달" onClick={() => setViewMonth(shiftMonth(viewMonth, -1))}>
                  <ChevronIcon dir="left" />
                </IconButton>
                <h2 className="px-0.5 text-[17px] font-bold tabular-nums">{monthTitle(viewMonth)}</h2>
                <IconButton
                  label="다음 달"
                  disabled={viewMonth >= latestMonth}
                  onClick={() => setViewMonth(shiftMonth(viewMonth, 1))}
                >
                  <ChevronIcon dir="right" />
                </IconButton>
                {!isCurrent && (
                  <button
                    onClick={() => setViewMonth(currentMonth)}
                    className="ml-0.5 rounded-md px-2 py-1 text-xs font-semibold transition hover:brightness-95"
                    style={{ background: "var(--navy-soft)", color: C.navy }}
                  >
                    이번 달
                  </button>
                )}
              </div>
              <button
                onClick={openHolidaySheet}
                className="flex items-center gap-1 rounded-lg border bg-white px-2.5 py-1.5 text-xs font-semibold transition hover:bg-gray-50"
                style={{ color: C.navy }}
              >
                <CalendarIcon />
                휴일 설정
              </button>
            </div>

            <SummaryPanel summary={summary} />

            <div
              role="tablist"
              aria-label="내역 종류"
              className="mt-5 grid grid-cols-2 rounded-xl p-1"
              style={{ background: "#e5e7eb" }}
            >
              {(
                [
                  ["work", "근무 내역", monthWorks.length],
                  ["meal", "식사 내역", monthMeals.length],
                ] as const
              ).map(([key, label, count]) => {
                const active = listTab === key;
                return (
                  <button
                    key={key}
                    role="tab"
                    aria-selected={active}
                    onClick={() => setListTab(key)}
                    className="rounded-lg py-2 text-sm font-semibold transition"
                    style={{
                      background: active ? "white" : "transparent",
                      color: active ? "var(--text)" : C.muted,
                      boxShadow: active ? "0 1px 2px rgba(0,0,0,0.08)" : "none",
                    }}
                  >
                    {label}{" "}
                    <span className="tabular-nums" style={{ color: active ? C.navy : C.faint }}>
                      {count}
                    </span>
                  </button>
                );
              })}
            </div>

            {listTab === "work" ? (
              <WorkList
                key={`w-${viewMonth}`}
                rows={monthWorks}
                dayInfoOf={dayInfoOf}
                monthLabel={monthShort(viewMonth)}
                onDelete={deleteRecord}
              />
            ) : (
              <MealList
                key={`m-${viewMonth}`}
                rows={monthMeals}
                dayInfoOf={dayInfoOf}
                monthLabel={monthShort(viewMonth)}
                onDelete={deleteMeal}
              />
            )}
          </section>
        </main>
      </div>

      {sheet === "work" && (
        <WorkSheet
          todayKey={todayKey}
          holidays={holidays}
          onClose={() => setSheet(null)}
          onSubmit={addWork}
        />
      )}
      {sheet === "meal" && (
        <MealSheet
          todayKey={todayKey}
          defaultType={mealType}
          onClose={() => setSheet(null)}
          onSubmit={addMeal}
        />
      )}
      {sheet === "holiday" && (
        <HolidaySheet
          initialMonth={holidaySheetMonth}
          todayKey={todayKey}
          holidays={holidays}
          workCountByDay={workCountByDay}
          onSet={setHoliday}
          onClose={() => setSheet(null)}
        />
      )}
      {sheet === "settings" && (
        <SettingsSheet
          onClose={() => setSheet(null)}
          onOpenHoliday={openHolidaySheet}
          onResetRecords={() => {
            resetRecords();
            setSheet(null);
          }}
          onResetLedger={() => {
            resetLedger();
            setSheet(null);
          }}
          onResetAll={() => {
            resetAll();
            setSheet(null);
          }}
        />
      )}

      {toast && (
        <div
          role="status"
          className="fixed left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2.5 text-sm whitespace-nowrap shadow-lg"
          style={{
            background: "#111827",
            color: "white",
            bottom: "max(1.5rem, env(safe-area-inset-bottom))",
          }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

/* ───────── 오늘 (입력 영역) ───────── */

function TodayCard({
  now,
  todayInfo,
  openRecord,
  todayDone,
  onClockIn,
  onClockOut,
  onAddWork,
  onAddMeal,
}: {
  now: Date;
  todayInfo: DayInfo;
  openRecord: WorkRecord | null;
  todayDone: ComputedRecord[];
  onClockIn: () => void;
  onClockOut: () => void;
  onAddWork: () => void;
  onAddMeal: () => void;
}) {
  const todayKey = dateKeyOf(now);
  return (
    <section aria-label="오늘" className="mt-4 rounded-2xl border bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[15px] font-semibold">
              {formatMonthDay(todayKey)} {DOW[now.getDay()]}요일
            </span>
            {todayInfo.kind !== "weekday" && <HolidayTag text={todayInfo.name ?? "주말"} />}
          </div>
          <TodayStatus now={now} openRecord={openRecord} todayDone={todayDone} />
        </div>
        <div className="shrink-0 text-[28px] leading-none font-bold tabular-nums">
          {pad(now.getHours())}:{pad(now.getMinutes())}
        </div>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2.5">
        <BigButton label="출근 기록" onClick={onClockIn} color={C.overtime} disabled={!!openRecord} />
        <BigButton label="퇴근 기록" onClick={onClockOut} color={C.danger} disabled={!openRecord} />
      </div>
      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        <SoftButton onClick={onAddWork}>근무 직접 입력</SoftButton>
        <SoftButton onClick={onAddMeal}>식사 기록</SoftButton>
      </div>
    </section>
  );
}

function TodayStatus({
  now,
  openRecord,
  todayDone,
}: {
  now: Date;
  openRecord: WorkRecord | null;
  todayDone: ComputedRecord[];
}) {
  if (openRecord) {
    const start = new Date(openRecord.clockIn);
    const sameDay = dateKeyOf(start) === dateKeyOf(now);
    const elapsed = (now.getTime() - start.getTime()) / (1000 * 60 * 60);
    return (
      <div
        className="mt-1.5 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
        style={
          sameDay
            ? { background: "#fef3c7", color: "#92400e" }
            : { background: "#fee2e2", color: "#991b1b" }
        }
      >
        <span className="size-1.5 rounded-full" style={{ background: "currentColor" }} />
        {sameDay
          ? `근무 중 · ${formatTime(start)} 출근 · ${formatHours(elapsed)}째`
          : `${formatMonthDay(dateKeyOf(start))} ${formatTime(start)} 출근 후 퇴근 기록이 없어요`}
      </div>
    );
  }
  if (todayDone.length > 0) {
    const first = Math.min(...todayDone.map((c) => c.start.getTime()));
    const last = Math.max(...todayDone.map((c) => (c.end ? c.end.getTime() : 0)));
    const overtime = todayDone.reduce((s, c) => s + c.overtimeHours, 0);
    const meals = todayDone.reduce((s, c) => s + c.meals, 0);
    return (
      <div className="mt-1.5 text-xs" style={{ color: C.muted }}>
        오늘 {formatTime(new Date(first))}–{formatTime(new Date(last))} · 초과{" "}
        {overtime > 0 ? formatHours(overtime) : "없음"} · 급량비 {meals}개
      </div>
    );
  }
  return (
    <div className="mt-1.5 text-xs" style={{ color: C.muted }}>
      아직 출근 기록이 없어요
    </div>
  );
}

/* ───────── 월 요약 ───────── */

function SummaryPanel({ summary: s }: { summary: MonthSummary }) {
  const otOver = s.overtimeHours > OVERTIME_MONTHLY_LIMIT;
  return (
    <div className="mt-3 rounded-2xl border bg-white p-4">
      <dl className="space-y-1 text-sm">
        <div className="flex items-baseline justify-between">
          <dt style={{ color: C.muted }}>
            급량비 {s.meals}개{s.mealCapped ? " (월 최대)" : ""}
          </dt>
          <dd className="tabular-nums">{formatWon(s.mealAmount)}</dd>
        </div>
        <div className="flex items-baseline justify-between">
          <dt style={{ color: C.muted }}>장부 사용</dt>
          <dd className="tabular-nums">
            {s.ledgerSpent > 0 ? `− ${formatWon(s.ledgerSpent)}` : formatWon(0)}
          </dd>
        </div>
      </dl>
      <div className="mt-2 flex items-baseline justify-between border-t border-dashed pt-2">
        <span className="text-sm font-semibold">잔액</span>
        <span
          className="text-2xl font-bold tabular-nums"
          style={{ color: s.balance >= 0 ? C.meal : C.danger }}
        >
          {formatWon(s.balance)}
        </span>
      </div>
      {s.personalSpent > 0 && (
        <div className="mt-0.5 text-right text-[11px]" style={{ color: C.faint }}>
          내돈내산 {formatWon(s.personalSpent)}은 잔액에 넣지 않아요
        </div>
      )}
      <div className="mt-4 grid grid-cols-2 gap-4 border-t pt-3.5">
        <Meter
          label="초과근무"
          limit={`한도 ${OVERTIME_MONTHLY_LIMIT}시간`}
          value={formatHours(s.overtimeHours)}
          ratio={s.overtimeHours / OVERTIME_MONTHLY_LIMIT}
          color={otOver ? "#d97706" : C.overtime}
          note={
            otOver
              ? `한도 초과 ${formatHours(s.overtimeHours - OVERTIME_MONTHLY_LIMIT)}`
              : `한도까지 ${formatHours(OVERTIME_MONTHLY_LIMIT - s.overtimeHours)}`
          }
          warn={otOver}
        />
        <Meter
          label="급량비"
          limit={`최대 ${MEAL_MONTHLY_CAP}개`}
          value={`${s.meals}개`}
          ratio={s.rawMeals / MEAL_MONTHLY_CAP}
          color={C.meal}
          note={
            s.rawMeals > MEAL_MONTHLY_CAP
              ? `평일 ${s.weekdayMeals} · 휴일 ${s.holidayMeals} (총 ${s.rawMeals}개)`
              : `평일 ${s.weekdayMeals} · 휴일 ${s.holidayMeals}`
          }
        />
      </div>
    </div>
  );
}

function Meter({
  label,
  limit,
  value,
  ratio,
  color,
  note,
  warn,
}: {
  label: string;
  limit: string;
  value: string;
  ratio: number;
  color: string;
  note: string;
  warn?: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-1 text-xs">
        <span style={{ color: C.muted }}>{label}</span>
        <span className="tabular-nums" style={{ color: C.faint }}>
          {limit}
        </span>
      </div>
      <div className="mt-0.5 text-lg font-bold tabular-nums" style={{ color }}>
        {value}
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full" style={{ background: "#f3f4f6" }}>
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%`, background: color }}
        />
      </div>
      <div className="mt-1 text-[11px]" style={{ color: warn ? "#b45309" : C.muted }}>
        {note}
      </div>
    </div>
  );
}

/* ───────── 목록 ───────── */

function DateCell({ dateKey, info, show }: { dateKey: string; info: DayInfo; show: boolean }) {
  if (!show) return <span aria-hidden="true" />;
  const color = dayColor(info);
  return (
    <span className="text-center leading-tight" style={{ color }}>
      <span className="block text-[15px] font-bold tabular-nums">{Number(dateKey.slice(8))}</span>
      <span className="block text-[11px]">{DOW[info.dow]}</span>
    </span>
  );
}

/** 펼친 줄에 보여 줄 계산 내역 (항목, 값) */
function workBreakdown(c: ComputedRecord): [string, string][] {
  const rows: [string, string][] = [
    ["근무", `${formatHours(c.workedHours)} (${c.holiday ? "휴일" : "평일"})`],
  ];
  if (!c.holiday) {
    if (c.morningHours > 0) rows.push(["9시 전", formatHours(c.morningHours)]);
    if (c.eveningHours > 0) rows.push(["18시 후", formatHours(c.eveningHours)]);
    if (c.deductionHours > 0) rows.push(["공제", `− ${formatHours(c.deductionHours)}`]);
  }
  return rows;
}

function WorkList({
  rows,
  dayInfoOf,
  monthLabel,
  onDelete,
}: {
  rows: ComputedRecord[];
  dayInfoOf: (k: string) => DayInfo;
  monthLabel: string;
  onDelete: (id: string) => boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (rows.length === 0) {
    return (
      <EmptyList
        title={`${monthLabel} 근무 내역이 없어요.`}
        hint="출근 기록 버튼이나 ‘근무 직접 입력’으로 추가하세요."
      />
    );
  }
  const cols = "grid grid-cols-[2.5rem_1fr_2.75rem_5.5rem] items-center gap-2";
  return (
    <>
      <div className="mt-3 overflow-hidden rounded-2xl border bg-white">
        <div
          className={`${cols} border-b px-3 py-2 text-[11px] font-medium`}
          style={{ background: "#f9fafb", color: C.muted }}
        >
          <span className="text-center">날짜</span>
          <span>출퇴근</span>
          <span className="text-right">급량비</span>
          <span className="text-right">초과근무</span>
        </div>
        <ul>
          {rows.map((c, i) => {
            const firstOfDay = i === 0 || rows[i - 1].dateKey !== c.dateKey;
            const info = dayInfoOf(c.dateKey);
            const open = openId === c.record.id;
            const nextDay = c.end && dateKeyOf(c.end) !== c.dateKey;
            return (
              <li key={c.record.id} className={firstOfDay && i > 0 ? "border-t" : ""}>
                <button
                  onClick={() => setOpenId(open ? null : c.record.id)}
                  aria-expanded={open}
                  className={`${cols} w-full px-3 py-2 text-left transition hover:bg-gray-50 active:bg-gray-100`}
                  style={{ background: open ? "#f9fafb" : undefined }}
                >
                  <DateCell dateKey={c.dateKey} info={info} show={firstOfDay} />
                  <span className="min-w-0">
                    <span className="block text-sm tabular-nums">
                      {formatTime(c.start)} – {c.end ? formatTime(c.end) : ""}
                      {nextDay && (
                        <span className="ml-0.5 text-[10px]" style={{ color: C.muted }}>
                          +1
                        </span>
                      )}
                    </span>
                    {firstOfDay && info.kind !== "weekday" && info.name && (
                      <span className="block truncate text-[11px]" style={{ color: C.holiday }}>
                        {info.name}
                      </span>
                    )}
                  </span>
                  <span
                    className="text-right text-sm tabular-nums"
                    style={{ color: c.meals > 0 ? C.meal : C.faint }}
                  >
                    {c.end ? (c.meals > 0 ? `${c.meals}개` : "–") : ""}
                  </span>
                  <span
                    className="text-right text-sm font-semibold tabular-nums"
                    style={{ color: c.overtimeHours > 0 ? C.overtime : C.faint }}
                  >
                    {c.end ? (
                      c.overtimeHours > 0 ? (
                        formatHours(c.overtimeHours)
                      ) : (
                        "–"
                      )
                    ) : (
                      <span
                        className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
                        style={{ background: "#fef3c7", color: "#92400e" }}
                      >
                        근무 중
                      </span>
                    )}
                  </span>
                </button>
                {open && (
                  <Detail
                    onDelete={() => {
                      if (onDelete(c.record.id)) setOpenId(null);
                    }}
                  >
                    {c.end ? (
                      <>
                        <DetailRows rows={workBreakdown(c)} />
                        <DetailRows
                          strong
                          rows={[
                            ["초과근무", formatHours(c.overtimeHours)],
                            ["급량비", `${c.meals}개`],
                          ]}
                        />
                        {!c.holiday && c.morningHours === 0 && c.eveningHours === 0 && (
                          <p style={{ color: C.muted }}>9시~18시 안의 근무라 초과근무가 없어요.</p>
                        )}
                        {c.holiday && (
                          <p style={{ color: C.muted }}>휴일 근무는 근무시간 전체를 인정해요.</p>
                        )}
                        {c.cappedByOldRule && (
                          <p style={{ color: "#b45309" }}>
                            2026년 9월까지 적용된 1일 4시간 상한으로 4시간만 인정했어요.
                          </p>
                        )}
                      </>
                    ) : (
                      <p>{formatTime(c.start)} 출근 · 아직 퇴근 기록이 없어요.</p>
                    )}
                  </Detail>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <p className="mt-2 text-center text-[11px]" style={{ color: C.faint }}>
        줄을 누르면 계산 내역과 삭제 버튼이 보여요.
      </p>
    </>
  );
}

function MealList({
  rows,
  dayInfoOf,
  monthLabel,
  onDelete,
}: {
  rows: LedgerEntry[];
  dayInfoOf: (k: string) => DayInfo;
  monthLabel: string;
  onDelete: (id: string) => boolean;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (rows.length === 0) {
    return (
      <EmptyList title={`${monthLabel} 식사 내역이 없어요.`} hint="‘식사 기록’ 버튼으로 추가하세요." />
    );
  }
  const cols = "grid grid-cols-[2.5rem_1fr_auto] items-center gap-2";
  return (
    <>
      <div className="mt-3 overflow-hidden rounded-2xl border bg-white">
        <div
          className={`${cols} border-b px-3 py-2 text-[11px] font-medium`}
          style={{ background: "#f9fafb", color: C.muted }}
        >
          <span className="text-center">날짜</span>
          <span>내용</span>
          <span className="text-right">금액</span>
        </div>
        <ul>
          {rows.map((e, i) => {
            const firstOfDay = i === 0 || rows[i - 1].date !== e.date;
            const personal = e.type === "personal";
            const open = openId === e.id;
            const info = isValidDateKey(e.date) ? dayInfoOf(e.date) : null;
            return (
              <li key={e.id} className={firstOfDay && i > 0 ? "border-t" : ""}>
                <button
                  onClick={() => setOpenId(open ? null : e.id)}
                  aria-expanded={open}
                  className={`${cols} w-full px-3 py-2.5 text-left transition hover:bg-gray-50 active:bg-gray-100`}
                  style={{ background: open ? "#f9fafb" : undefined }}
                >
                  {info ? (
                    <DateCell dateKey={e.date} info={info} show={firstOfDay} />
                  ) : (
                    <span className="text-center text-xs">{e.date}</span>
                  )}
                  <span className="flex min-w-0 items-center gap-1.5">
                    <MealTag personal={personal} />
                    <span className="truncate text-sm">{e.memo ?? ""}</span>
                  </span>
                  <span
                    className="text-right text-sm font-semibold tabular-nums"
                    style={{ color: personal ? C.muted : "var(--text)" }}
                  >
                    {formatWon(Number(e.amount) || 0)}
                  </span>
                </button>
                {open && (
                  <Detail
                    onDelete={() => {
                      if (onDelete(e.id)) setOpenId(null);
                    }}
                  >
                    <DetailRows
                      rows={[
                        ["구분", personal ? "내돈내산" : "장부 식당"],
                        ["날짜", isValidDateKey(e.date) ? formatMonthDay(e.date) : e.date],
                        ...(e.memo ? ([["메모", e.memo]] as [string, string][]) : []),
                      ]}
                    />
                    <p style={{ color: C.muted }}>
                      {personal ? "잔액 계산에 넣지 않는 기록이에요." : "이 달 잔액에서 빠지는 기록이에요."}
                    </p>
                  </Detail>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <p className="mt-2 text-center text-[11px]" style={{ color: C.faint }}>
        줄을 누르면 삭제 버튼이 보여요.
      </p>
    </>
  );
}

function Detail({ children, onDelete }: { children: ReactNode; onDelete: () => void }) {
  return (
    <div className="mx-3 mb-3 rounded-xl px-3 py-2.5 text-[13px]" style={{ background: "#f3f4f6" }}>
      <div className="space-y-1.5">{children}</div>
      <div className="mt-2 flex justify-end">
        <button
          onClick={onDelete}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold transition hover:brightness-95"
          style={{ background: "#fee2e2", color: "#b91c1c" }}
        >
          이 기록 삭제
        </button>
      </div>
    </div>
  );
}

function DetailRows({ rows, strong }: { rows: [string, string][]; strong?: boolean }) {
  return (
    <dl className={strong ? "space-y-0.5 border-t border-dashed pt-1.5" : "space-y-0.5"}>
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3">
          <dt style={{ color: C.muted }}>{k}</dt>
          <dd
            className="min-w-0 text-right tabular-nums"
            style={
              strong
                ? { fontWeight: 700, color: k === "급량비" ? C.meal : C.overtime }
                : undefined
            }
          >
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EmptyList({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="mt-3 rounded-2xl border bg-white px-4 py-8 text-center">
      <div className="text-sm font-medium" style={{ color: C.muted }}>
        {title}
      </div>
      <div className="mt-1 text-xs" style={{ color: C.faint }}>
        {hint}
      </div>
    </div>
  );
}

function MealTag({ personal }: { personal: boolean }) {
  return (
    <span
      className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold"
      style={personal ? { background: "#f3f4f6", color: "#4b5563" } : { background: "#fef3c7", color: "#92400e" }}
    >
      {personal ? "내돈내산" : "장부"}
    </span>
  );
}

function HolidayTag({ text }: { text: string }) {
  return (
    <span
      className="rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: "#fee2e2", color: "#b91c1c" }}
    >
      {text}
    </span>
  );
}

/* ───────── 시트 (아래에서 올라오는 입력창) ───────── */

function Sheet({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, []);
  return (
    <div
      className="sheet-backdrop fixed inset-0 z-30 flex items-end justify-center"
      style={{ background: "rgba(17,24,39,0.5)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="sheet-panel max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-2xl"
        style={{ background: "var(--card)", paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="sticky top-0 z-10 flex items-start justify-between gap-3 px-5 pt-5 pb-3"
          style={{ background: "var(--card)" }}
        >
          <div>
            <h2 className="text-base font-bold">{title}</h2>
            {description && (
              <p className="mt-0.5 text-xs" style={{ color: C.muted }}>
                {description}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg px-3 py-1.5 text-sm transition hover:brightness-95"
            style={{ color: C.muted, background: "#f3f4f6" }}
          >
            닫기
          </button>
        </div>
        <div className="space-y-3 px-5">{children}</div>
      </div>
    </div>
  );
}

const inputClass = "mt-1 w-full rounded-lg border px-3 py-3 text-base";
const inputStyle = { background: "#f9fafb" };

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-xs" style={{ color: C.muted }}>
      {children}
    </label>
  );
}

function dayTypeText(info: DayInfo) {
  if (info.kind === "weekend") {
    return info.name
      ? `${withIra(`${info.name}(${DOW[info.dow]})`)} 휴일 기준으로 계산해요.`
      : `${withIra(`${DOW[info.dow]}요일`)} 휴일 기준으로 계산해요.`;
  }
  if (info.kind === "holiday") {
    return info.source === "custom"
      ? `직접 지정한 ${withIra(info.name ?? DEFAULT_CUSTOM_NAME)} 휴일 기준으로 계산해요.`
      : `${withIra(info.name ?? "공휴일")} 휴일 기준으로 계산해요.`;
  }
  if (info.disabledPublicName) {
    return `${withJiman(info.disabledPublicName)} 평일로 계산하도록 바꿔 둔 날이에요.`;
  }
  return `${DOW[info.dow]}요일, 평일 기준으로 계산해요.`;
}

function WorkSheet({
  todayKey,
  holidays,
  onClose,
  onSubmit,
}: {
  todayKey: string;
  holidays: HolidayOverrides;
  onClose: () => void;
  onSubmit: (input: {
    dateKey: string;
    inIso: string;
    outIso: string;
    holidayChange?: HolidayOverride | null;
  }) => void;
}) {
  const [date, setDate] = useState(todayKey);
  const [inTime, setInTime] = useState("09:00");
  const [outTime, setOutTime] = useState("19:00");
  const [markHoliday, setMarkHoliday] = useState(
    () => getDayInfo(todayKey, holidays).source === "custom",
  );

  const validDate = isValidDateKey(date);
  const info = validDate ? getDayInfo(date, holidays) : null;
  // 평일(또는 직접 지정한 휴일)만 여기서 휴일 여부를 바꿀 수 있음
  const toggleable =
    !!info && ((info.kind === "weekday" && !info.disabledPublicName) || info.source === "custom");
  const holiday = info ? (toggleable ? markHoliday : isHolidayInfo(info)) : false;

  const inIso = validDate ? combineDateTime(date, inTime) : null;
  const outIso = validDate ? combineDateTime(date, outTime) : null;
  const error = !validDate
    ? "날짜를 선택해 주세요."
    : !inIso || !outIso
      ? "시간 형식을 확인해 주세요. (예: 09:00)"
      : new Date(outIso).getTime() <= new Date(inIso).getTime()
        ? "퇴근 시간은 출근 시간보다 늦어야 해요."
        : null;
  const preview =
    !error && inIso && outIso
      ? computeRecord({ id: "preview", clockIn: inIso, clockOut: outIso }, () => holiday)
      : null;

  function changeDate(v: string) {
    setDate(v);
    setMarkHoliday(isValidDateKey(v) && getDayInfo(v, holidays).source === "custom");
  }

  function submit() {
    if (error || !inIso || !outIso || !info) return;
    let holidayChange: HolidayOverride | null | undefined;
    if (toggleable) {
      const wasCustom = info.source === "custom";
      if (markHoliday && !wasCustom) holidayChange = { on: true, name: DEFAULT_CUSTOM_NAME };
      if (!markHoliday && wasCustom) holidayChange = null;
    }
    onSubmit({ dateKey: date, inIso, outIso, holidayChange });
  }

  return (
    <Sheet title="근무 직접 입력" description="출퇴근 버튼을 누르지 못한 날의 시간을 입력하세요." onClose={onClose}>
      <div>
        <FieldLabel htmlFor="work-date">날짜</FieldLabel>
        <input
          id="work-date"
          type="date"
          value={date}
          onChange={(e) => changeDate(e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
        {info && (
          <p
            className="mt-1.5 text-xs"
            style={{ color: holiday ? C.holiday : C.muted }}
          >
            {toggleable && markHoliday && info.source !== "custom"
              ? "휴일 기준으로 계산해요."
              : toggleable && !markHoliday && info.source === "custom"
                ? "휴일 지정을 풀고 평일 기준으로 계산해요."
                : dayTypeText(info)}
          </p>
        )}
      </div>
      {toggleable && (
        <label className="flex items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm">
          <input
            type="checkbox"
            checked={markHoliday}
            onChange={(e) => setMarkHoliday(e.target.checked)}
            className="size-4 accent-[#dc2626]"
          />
          <span>
            이 날을 휴일로 계산{" "}
            <span className="text-xs" style={{ color: C.muted }}>
              (임시공휴일 등)
            </span>
          </span>
        </label>
      )}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor="work-in">출근 시간</FieldLabel>
          <input
            id="work-in"
            type="time"
            value={inTime}
            onChange={(e) => setInTime(e.target.value)}
            className={`${inputClass} tabular-nums`}
            style={inputStyle}
          />
        </div>
        <div>
          <FieldLabel htmlFor="work-out">퇴근 시간</FieldLabel>
          <input
            id="work-out"
            type="time"
            value={outTime}
            onChange={(e) => setOutTime(e.target.value)}
            className={`${inputClass} tabular-nums`}
            style={inputStyle}
          />
        </div>
      </div>
      <div
        className="rounded-xl px-3 py-2.5 text-sm"
        style={error ? { background: "#fef2f2", color: "#b91c1c" } : { background: "#f9fafb" }}
      >
        {error ??
          (preview && (
            <>
              근무 {formatHours(preview.workedHours)} · 초과{" "}
              <b style={{ color: C.overtime }}>{formatHours(preview.overtimeHours)}</b> · 급량비{" "}
              <b style={{ color: C.meal }}>{preview.meals}개</b>
            </>
          ))}
      </div>
      <button
        onClick={submit}
        disabled={!!error}
        className="w-full rounded-xl py-3.5 text-base font-bold text-white transition enabled:hover:brightness-125 active:scale-[0.98] disabled:opacity-40"
        style={{ background: C.navy }}
      >
        추가하기
      </button>
    </Sheet>
  );
}

function MealSheet({
  todayKey,
  defaultType,
  onClose,
  onSubmit,
}: {
  todayKey: string;
  defaultType: MealType;
  onClose: () => void;
  onSubmit: (entry: Omit<LedgerEntry, "id">) => void;
}) {
  const [type, setType] = useState<MealType>(defaultType);
  const [date, setDate] = useState(todayKey);
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const value = Number(amount);
  const canSave = isValidDateKey(date) && value > 0;
  const isLedger = type === "ledger";

  function submit() {
    if (!canSave) return;
    onSubmit({ date, amount: value, memo: memo.trim() || undefined, type });
  }

  return (
    <Sheet title="식사 기록" onClose={onClose}>
      <div className="grid grid-cols-2 gap-1 rounded-xl p-1" style={{ background: "#f3f4f6" }}>
        {(
          [
            ["ledger", "장부 식당", C.navy],
            ["personal", "내돈내산", "#4b5563"],
          ] as const
        ).map(([key, label, color]) => (
          <button
            key={key}
            type="button"
            onClick={() => setType(key)}
            aria-pressed={type === key}
            className="rounded-lg py-2.5 text-sm font-semibold transition"
            style={{
              background: type === key ? color : "transparent",
              color: type === key ? "white" : C.muted,
            }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-xs" style={{ color: C.muted }}>
        {isLedger
          ? "장부 식당에서 쓴 금액이에요. 이 달 잔액에서 빠져요."
          : "장부 밖에서 직접 결제한 금액이에요. 잔액 계산에는 넣지 않아요."}
      </p>
      <div>
        <FieldLabel htmlFor="meal-date">날짜</FieldLabel>
        <input
          id="meal-date"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </div>
      <div>
        <div className="flex items-center justify-between">
          <FieldLabel htmlFor="meal-amount">금액 (원)</FieldLabel>
          <button
            type="button"
            onClick={() => setAmount(String(MEAL_PRICE))}
            className="rounded-full border px-2.5 py-0.5 text-xs font-semibold tabular-nums transition hover:brightness-95"
            style={{ color: C.navy, borderColor: "var(--navy-line)", background: "var(--navy-soft)" }}
          >
            {MEAL_PRICE.toLocaleString("ko-KR")}원
          </button>
        </div>
        <input
          id="meal-amount"
          type="text"
          inputMode="numeric"
          placeholder="예: 9,000"
          value={amount ? Number(amount).toLocaleString("ko-KR") : ""}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, "").slice(0, 9))}
          className={`${inputClass} tabular-nums`}
          style={inputStyle}
        />
      </div>
      <div>
        <FieldLabel htmlFor="meal-memo">메모 (선택)</FieldLabel>
        <input
          id="meal-memo"
          type="text"
          placeholder="식당 이름, 메뉴 등"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </div>
      <button
        onClick={submit}
        disabled={!canSave}
        className="w-full rounded-xl py-3.5 text-base font-bold text-white transition enabled:hover:brightness-125 active:scale-[0.98] disabled:opacity-40"
        style={{ background: isLedger ? C.navy : "#374151" }}
      >
        저장
      </button>
    </Sheet>
  );
}

/* ───────── 휴일 설정 ───────── */

function HolidaySheet({
  initialMonth,
  todayKey,
  holidays,
  workCountByDay,
  onSet,
  onClose,
}: {
  initialMonth: string;
  todayKey: string;
  holidays: HolidayOverrides;
  workCountByDay: Map<string, number>;
  onSet: (dateKey: string, ov: HolidayOverride | null) => void;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [selected, setSelected] = useState<string | null>(null);
  const changed = Object.keys(holidays).sort();

  return (
    <Sheet
      title="휴일 설정"
      description="토·일과 공휴일(대체공휴일 포함)은 자동으로 휴일로 계산해요. 임시공휴일처럼 평일에 쉬는 날은 날짜를 눌러 지정하세요."
      onClose={onClose}
    >
      <MonthCalendar
        month={month}
        onMonthChange={(m) => {
          setMonth(m);
          setSelected(null);
        }}
        selected={selected}
        onSelect={setSelected}
        holidays={holidays}
        todayKey={todayKey}
        workCountByDay={workCountByDay}
      />
      {selected ? (
        <SelectedDayPanel
          dateKey={selected}
          info={getDayInfo(selected, holidays)}
          workCount={workCountByDay.get(selected) ?? 0}
          onSet={(ov) => onSet(selected, ov)}
        />
      ) : (
        <p className="rounded-xl px-3 py-3 text-center text-xs" style={{ background: "#f9fafb", color: C.muted }}>
          날짜를 누르면 휴일로 지정하거나 해제할 수 있어요.
        </p>
      )}
      {changed.length > 0 && (
        <div className="pt-1">
          <div className="text-xs font-semibold" style={{ color: C.muted }}>
            직접 바꾼 날
          </div>
          <ul className="mt-1">
            {changed.map((k) => {
              const ov = holidays[k];
              const [y, m, d] = k.split("-").map(Number);
              const dow = DOW[new Date(y, m - 1, d).getDay()];
              const label = ov.on
                ? ov.name || DEFAULT_CUSTOM_NAME
                : `${PUBLIC_HOLIDAYS[k] ?? "공휴일"} → 평일로 계산`;
              return (
                <li key={k} className="flex items-center justify-between gap-2 border-b py-2 last:border-b-0">
                  <button
                    className="min-w-0 truncate text-left text-sm"
                    onClick={() => {
                      setMonth(k.slice(0, 7));
                      setSelected(k);
                    }}
                  >
                    <span className="tabular-nums">
                      {y}. {m}. {d}. ({dow})
                    </span>{" "}
                    <span style={{ color: ov.on ? C.holiday : C.muted }}>{label}</span>
                  </button>
                  <button
                    onClick={() => onSet(k, null)}
                    className="shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold transition hover:brightness-95"
                    style={{ background: "#f3f4f6", color: "#4b5563" }}
                  >
                    {ov.on ? "해제" : "되돌리기"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Sheet>
  );
}

function MonthCalendar({
  month,
  onMonthChange,
  selected,
  onSelect,
  holidays,
  todayKey,
  workCountByDay,
}: {
  month: string;
  onMonthChange: (m: string) => void;
  selected: string | null;
  onSelect: (k: string) => void;
  holidays: HolidayOverrides;
  todayKey: string;
  workCountByDay: Map<string, number>;
}) {
  const [y, m] = month.split("-").map(Number);
  const leading = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  return (
    <div className="rounded-xl border p-2">
      <div className="flex items-center justify-between">
        <IconButton label="이전 달" onClick={() => onMonthChange(shiftMonth(month, -1))}>
          <ChevronIcon dir="left" />
        </IconButton>
        <div className="text-sm font-bold tabular-nums">{monthTitle(month)}</div>
        <IconButton label="다음 달" onClick={() => onMonthChange(shiftMonth(month, 1))}>
          <ChevronIcon dir="right" />
        </IconButton>
      </div>
      <div className="mt-1 grid grid-cols-7 text-center text-[11px]">
        {DOW.map((d, i) => (
          <div
            key={d}
            className="py-1"
            style={{ color: i === 0 ? C.holiday : i === 6 ? C.saturday : C.muted }}
          >
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-y-0.5">
        {cells.map((d, i) => {
          if (d === null) return <div key={`b${i}`} />;
          const key = `${month}-${pad(d)}`;
          const info = getDayInfo(key, holidays);
          const isSel = key === selected;
          const isToday = key === todayKey;
          const custom = info.source === "custom";
          const label = info.name
            ? shortHolidayName(info.name)
            : info.disabledPublicName
              ? shortHolidayName(info.disabledPublicName)
              : "";
          const hasWork = (workCountByDay.get(key) ?? 0) > 0;
          return (
            <button
              key={key}
              onClick={() => onSelect(key)}
              aria-pressed={isSel}
              aria-label={`${m}월 ${d}일${info.name ? ` ${info.name}` : ""}`}
              className="relative mx-0.5 flex h-12 flex-col items-center rounded-lg pt-1 transition hover:bg-gray-100"
              style={{
                background: isSel ? "var(--navy-soft)" : custom ? "#fee2e2" : undefined,
                boxShadow: isSel ? `inset 0 0 0 2px ${C.navy}` : undefined,
              }}
            >
              <span
                className="text-sm leading-5 tabular-nums"
                style={{
                  color: dayColor(info) ?? "var(--text)",
                  fontWeight: isToday ? 800 : 500,
                  textDecoration: isToday ? "underline" : undefined,
                  textUnderlineOffset: "3px",
                }}
              >
                {d}
              </span>
              {label && (
                <span
                  className="max-w-full truncate px-0.5 text-[10px] leading-3"
                  style={{
                    color: info.disabledPublicName ? C.faint : C.holiday,
                    textDecoration: info.disabledPublicName ? "line-through" : undefined,
                  }}
                >
                  {label}
                </span>
              )}
              {hasWork && (
                <span
                  className="absolute bottom-1 size-1 rounded-full"
                  style={{ background: C.overtime }}
                />
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-1.5 flex items-center justify-end gap-3 px-1 text-[10px]" style={{ color: C.muted }}>
        <span className="flex items-center gap-1">
          <span className="size-1 rounded-full" style={{ background: C.overtime }} />
          근무 기록 있음
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm" style={{ background: "#fee2e2" }} />
          직접 지정한 휴일
        </span>
      </div>
    </div>
  );
}

function SelectedDayPanel({
  dateKey,
  info,
  workCount,
  onSet,
}: {
  dateKey: string;
  info: DayInfo;
  workCount: number;
  onSet: (ov: HolidayOverride | null) => void;
}) {
  const title = `${formatMonthDay(dateKey)} ${DOW[info.dow]}요일`;
  let body: ReactNode;
  if (info.kind === "weekend") {
    body = (
      <p className="text-xs" style={{ color: C.muted }}>
        {info.name ? `${info.name}, ` : ""}주말은 항상 휴일로 계산해요.
      </p>
    );
  } else if (info.kind === "holiday" && info.source === "public") {
    body = (
      <>
        <p className="text-xs" style={{ color: C.holiday }}>
          {withIra(info.name ?? "공휴일")} 휴일로 계산해요.
        </p>
        <button
          onClick={() => onSet({ on: false })}
          className="mt-2 rounded-lg border px-3 py-2 text-xs font-semibold transition hover:brightness-95"
          style={{ color: "#4b5563", background: "white" }}
        >
          이 날은 평일로 계산하기
        </button>
      </>
    );
  } else if (info.kind === "holiday") {
    body = (
      <>
        <p className="text-xs" style={{ color: C.holiday }}>
          {info.name}(직접 지정) · 휴일로 계산해요.
        </p>
        <button
          onClick={() => onSet(null)}
          className="mt-2 rounded-lg border px-3 py-2 text-xs font-semibold transition hover:brightness-95"
          style={{ color: "#4b5563", background: "white" }}
        >
          휴일 지정 해제
        </button>
      </>
    );
  } else if (info.disabledPublicName) {
    body = (
      <>
        <p className="text-xs" style={{ color: C.muted }}>
          {withJiman(info.disabledPublicName)} 평일로 계산하도록 바꿔 둔 날이에요.
        </p>
        <button
          onClick={() => onSet(null)}
          className="mt-2 rounded-lg border px-3 py-2 text-xs font-semibold transition hover:brightness-95"
          style={{ color: C.holiday, background: "white" }}
        >
          다시 휴일로 계산하기
        </button>
      </>
    );
  } else {
    body = (
      <>
        <p className="text-xs" style={{ color: C.muted }}>
          평일로 계산해요. 쉬는 날이면 아래에서 골라 휴일로 지정하세요.
        </p>
        <div className="mt-2 grid grid-cols-3 gap-1.5">
          {CUSTOM_HOLIDAY_NAMES.map((name) => (
            <button
              key={name}
              onClick={() => onSet({ on: true, name })}
              className="rounded-lg border py-2 text-xs font-semibold transition hover:brightness-95"
              style={{ color: C.holiday, borderColor: "#fecaca", background: "#fff5f5" }}
            >
              {name}
            </button>
          ))}
        </div>
      </>
    );
  }
  return (
    <div className="rounded-xl px-3 py-3" style={{ background: "#f9fafb" }}>
      <div className="text-sm font-semibold">{title}</div>
      <div className="mt-1">{body}</div>
      {workCount > 0 && info.kind !== "weekend" && (
        <p className="mt-2 text-[11px]" style={{ color: C.faint }}>
          이 날 근무 기록 {workCount}건의 계산에 바로 반영돼요.
        </p>
      )}
    </div>
  );
}

/* ───────── 설정 ───────── */

function SettingsSheet({
  onClose,
  onOpenHoliday,
  onResetRecords,
  onResetLedger,
  onResetAll,
}: {
  onClose: () => void;
  onOpenHoliday: () => void;
  onResetRecords: () => void;
  onResetLedger: () => void;
  onResetAll: () => void;
}) {
  return (
    <Sheet title="설정" onClose={onClose}>
      <button
        onClick={onOpenHoliday}
        className="flex w-full items-center justify-between rounded-xl border px-4 py-3.5 text-left transition hover:bg-gray-50"
      >
        <span>
          <span className="block text-sm font-semibold">휴일 설정</span>
          <span className="block text-xs" style={{ color: C.muted }}>
            임시공휴일 등 평일에 쉬는 날 지정
          </span>
        </span>
        <span style={{ color: C.faint }}>
          <ChevronIcon dir="right" />
        </span>
      </button>

      <details className="rounded-xl border px-4 py-3">
        <summary className="cursor-pointer text-sm font-semibold">계산 기준</summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-4 text-xs" style={{ color: "#4b5563" }}>
          <li>평일 초과근무: 9시 전과 18시 후 근무를 더한 뒤 1시간 공제</li>
          <li>휴일 초과근무: 근무시간 전체 (토·일, 공휴일, 직접 지정한 휴일)</li>
          <li>1일 4시간 상한은 2026년 10월 1일부터 없어졌어요. 그 전 기록은 당시 기준으로 계산해요.</li>
          <li>월 초과근무 한도 {OVERTIME_MONTHLY_LIMIT}시간은 참고로만 보여 줘요.</li>
          <li>평일 급량비: 9시 전 1시간 이상 1개, 18시 후 1시간 이상 1개 (각각 모자라도 합쳐서 1시간 이상이면 1개)</li>
          <li>휴일 급량비: 1시간 넘게 근무하면 1개</li>
          <li>
            급량비는 하루 최대 2개, 한 달 최대 {MEAL_MONTHLY_CAP}개, 1개 {formatWon(MEAL_PRICE)}
          </li>
        </ul>
      </details>

      <div className="pt-2">
        <div className="text-xs font-semibold" style={{ color: C.muted }}>
          데이터 초기화
        </div>
        <p className="mt-0.5 text-xs" style={{ color: C.muted }}>
          초기화하면 되돌릴 수 없어요. 신중히 진행해 주세요.
        </p>
      </div>
      <button
        onClick={onResetRecords}
        className="w-full rounded-xl py-3.5 text-sm font-semibold transition hover:brightness-95 active:scale-[0.98]"
        style={{ background: "#fef3c7", color: "#92400e" }}
      >
        근무 내역만 초기화
      </button>
      <button
        onClick={onResetLedger}
        className="w-full rounded-xl py-3.5 text-sm font-semibold transition hover:brightness-95 active:scale-[0.98]"
        style={{ background: "#fef3c7", color: "#92400e" }}
      >
        식사 내역만 초기화
      </button>
      <button
        onClick={onResetAll}
        className="w-full rounded-xl py-3.5 text-sm font-bold transition hover:brightness-110 active:scale-[0.98]"
        style={{ background: C.danger, color: "white" }}
      >
        전체 데이터 초기화
      </button>
    </Sheet>
  );
}

/* ───────── 작은 부품 ───────── */

function BigButton({
  label,
  onClick,
  color,
  disabled,
}: {
  label: string;
  onClick: () => void;
  color: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-xl py-4 text-[17px] font-bold transition enabled:hover:brightness-110 enabled:active:scale-[0.98]"
      style={{
        background: disabled ? "#e5e7eb" : color,
        color: disabled ? C.faint : "white",
      }}
    >
      {label}
    </button>
  );
}

function SoftButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center justify-center gap-1 rounded-xl border py-3 text-sm font-semibold transition hover:brightness-[0.97] active:scale-[0.98]"
      style={{ background: "var(--navy-soft)", color: C.navy, borderColor: "var(--navy-line)" }}
    >
      <PlusIcon />
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid size-9 place-items-center rounded-lg transition enabled:hover:bg-gray-200/60 enabled:active:bg-gray-200 disabled:opacity-25"
    >
      {children}
    </button>
  );
}

function ChevronIcon({ dir }: { dir: "left" | "right" }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={dir === "left" ? "M15 18l-6-6 6-6" : "M9 18l6-6-6-6"} />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}
