/**
 * 초근밥 — 서원동 초과근무·급량비 계산기
 * @author 이주아
 * @since 2026.04
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import logoUrl from "./assets/chogeunbap.svg";
import { APP_INFO } from "./lib/appInfo";
import {
  combineDateTime,
  computeRecord,
  dateKeyOf,
  formatHours,
  formatTime,
  formatWon,
  monthKeyOf,
  pad,
  shiftDate,
  shiftMonth,
  summarizeMonth,
  type ComputedRecord,
  type LedgerEntry,
  type MonthSummary,
  type WorkRecord,
} from "./lib/worktime";
import {
  DEFAULT_RULES,
  FIRST_FROM,
  RULES_KEY,
  loadRules,
  rulesFor,
  rulesLabel,
  sameRules,
  saveRules,
  sortRules,
  validateRules,
  type Rules,
} from "./lib/rules";
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

/** 남색·달빛 노랑은 앱 아이콘에서, 파랑은 초과근무, 초록은 급량비(돈) */
const C = {
  navy: "#1e3a8a",
  moon: "#fcd34d",
  overtime: "#2563eb",
  meal: "#059669",
  danger: "#dc2626",
  holiday: "#dc2626",
  saturday: "#2563eb",
  warn: "#b45309",
  muted: "#64748b",
  faint: "#94a3b8",
  soft: "#f1f5f9",
};

type MealType = "ledger" | "personal";
type SheetName = "work" | "meal" | "holiday" | "settings" | "rules" | "basis";

/** 시연 화면의 안내 띠에서 앱을 조작할 때 쓰는 기능 */
export type AppApi = { openBasis: () => void };

/* ───────── 확인창 ───────── */

type ConfirmOptions = {
  title: string;
  message?: string;
  /** 확인 버튼 글자 (기본: 확인) */
  confirmText?: string;
  /** 삭제처럼 되돌릴 수 없는 일이면 빨간 버튼 */
  danger?: boolean;
};

/**
 * 브라우저 확인창(confirm) 대신 쓰는 앱 안의 확인창.
 * 파일 미리보기·메신저 안 브라우저처럼 확인창이 막힌 곳에서도 삭제·초기화가 되도록 함
 */
const ConfirmContext = createContext<(o: ConfirmOptions) => Promise<boolean>>(() => Promise.resolve(false));
const useConfirm = () => useContext(ConfirmContext);

/** 근무 입력창에서 넘겨주는 값 (outIso가 null이면 아직 근무 중) */
type WorkInput = {
  dateKey: string;
  inIso: string;
  outIso: string | null;
  holidayChange?: HolidayOverride | null;
};

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

/* ───────── 날짜 도우미 ───────── */

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

/** 일요일·공휴일은 빨강, 토요일은 파랑 */
function dayColor(info: DayInfo): string | undefined {
  if (info.dow === 0 || (info.kind !== "weekday" && info.name)) return C.holiday;
  if (info.dow === 6) return C.saturday;
  return undefined;
}

/* ───────── 앱 ───────── */

/** banner: 화면 맨 위(헤더 위)에 붙일 안내 띠. 시연용 화면에서만 사용 */
export default function App({ banner }: { banner?: (api: AppApi) => ReactNode }) {
  const [records, setRecords] = useState<WorkRecord[]>(() => loadList<WorkRecord>(RECORDS_KEY));
  const [ledger, setLedger] = useState<LedgerEntry[]>(() => loadList<LedgerEntry>(LEDGER_KEY));
  const [holidays, setHolidays] = useState<HolidayOverrides>(() => loadHolidayOverrides());
  const [rules, setRules] = useState<Rules[]>(() => loadRules());
  const [now, setNow] = useState(() => new Date());
  const todayKey = dateKeyOf(now);
  const currentMonth = monthKeyOf(now);
  const [viewMonth, setViewMonth] = useState(currentMonth);
  const [listTab, setListTab] = useState<"work" | "meal">("work");
  const [sheet, setSheet] = useState<SheetName | null>(null);
  const [holidaySheetMonth, setHolidaySheetMonth] = useState(currentMonth);
  const [mealType, setMealType] = useState<MealType>("ledger");
  /** 수정 중인 기록 (null이면 새로 입력) */
  const [editingWork, setEditingWork] = useState<WorkRecord | null>(null);
  const [editingMeal, setEditingMeal] = useState<LedgerEntry | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  /** 출근·퇴근 버튼을 연달아 눌러 출근하자마자 퇴근까지 찍히지 않게 잠깐 막음 */
  const lastClockAt = useRef(-Infinity);

  // 앱 안의 확인창: ask()가 돌려주는 Promise는 '확인'이면 true, '취소'·바깥 누름·Esc면 false
  const [confirmReq, setConfirmReq] = useState<ConfirmOptions | null>(null);
  const confirmResolve = useRef<((ok: boolean) => void) | null>(null);
  const ask = useCallback(
    (o: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        confirmResolve.current?.(false); // 앞의 확인창이 열려 있었다면 취소로 닫음
        confirmResolve.current = resolve;
        setConfirmReq(o);
      }),
    [],
  );
  function answerConfirm(ok: boolean) {
    const resolve = confirmResolve.current;
    confirmResolve.current = null;
    setConfirmReq(null);
    resolve?.(ok);
  }

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
    () =>
      records.map((r) =>
        computeRecord(
          r,
          (k) => isHolidayInfo(getDayInfo(k, holidays)),
          (m) => rulesFor(rules, m),
        ),
      ),
    [records, holidays, rules],
  );

  const openRecord = useMemo(() => records.find((r) => !r.clockOut) ?? null, [records]);

  const monthRules = rulesFor(rules, viewMonth);
  const summary = useMemo(
    () => summarizeMonth(computed, ledger, viewMonth, rulesFor(rules, viewMonth)),
    [computed, ledger, viewMonth, rules],
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

  /** 확인창을 거친 뒤처럼 시간이 지나서 바꿀 때: 그 순간의 최신 목록을 기준으로 */
  function updateRecords(fn: (prev: WorkRecord[]) => WorkRecord[]) {
    setRecords((prev) => {
      const next = fn(prev);
      saveList(RECORDS_KEY, next);
      return next;
    });
  }

  function updateLedger(fn: (prev: LedgerEntry[]) => LedgerEntry[]) {
    setLedger((prev) => {
      const next = fn(prev);
      saveList(LEDGER_KEY, next);
      return next;
    });
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

  /** 그 날(출근한 날 기준)의 근무 기록. 하루에 하나만 등록 */
  function recordOn(dateKey: string, exceptId?: string) {
    return records.find((r) => r.id !== exceptId && dateKeyOf(new Date(r.clockIn)) === dateKey) ?? null;
  }

  function clockIn() {
    const t = new Date();
    if (recordOn(dateKeyOf(t))) {
      setToast("오늘 근무는 이미 기록했어요");
      return false;
    }
    commitRecords([...records, { id: uid(), clockIn: t.toISOString(), clockOut: null }]);
    setToast(`출근 ${formatTime(t)}`);
    return true;
  }

  async function clockOut() {
    if (!openRecord) return false;
    const id = openRecord.id;
    const t = new Date();
    const start = new Date(openRecord.clockIn);
    // 하루 상한이 없어져서, 퇴근을 깜빡한 기록이 그대로 초과근무로 잡히지 않게 확인
    if (dateKeyOf(start) !== dateKeyOf(t)) {
      const ok = await ask({
        title: "지금 퇴근으로 기록할까요?",
        message:
          `${formatMonthDay(dateKeyOf(start))} ${formatTime(start)} 출근 기록이 아직 열려 있어요. ` +
          `지금(${formatMonthDay(dateKeyOf(t))} ${formatTime(t)})을 퇴근으로 기록할까요?\n\n` +
          "퇴근 기록을 깜빡했다면 '취소'를 누른 뒤, 근무 내역에서 그 기록을 눌러 '수정'으로 실제 퇴근 시간을 넣어 주세요.",
        confirmText: "퇴근 기록",
      });
      if (!ok) return false;
    }
    updateRecords((list) => list.map((r) => (r.id === id ? { ...r, clockOut: t.toISOString() } : r)));
    setToast(`퇴근 ${formatTime(t)}`);
    return true;
  }

  /** 출근 중이 아니면 출근, 출근 중이면 퇴근 */
  async function toggleClock() {
    if (performance.now() - lastClockAt.current < 1200) return;
    const ok = openRecord ? await clockOut() : clockIn();
    if (ok) lastClockAt.current = performance.now();
  }

  function openWorkSheet(record: WorkRecord | null) {
    setEditingWork(record);
    setSheet("work");
  }

  function openMealSheet(entry: LedgerEntry | null) {
    setEditingMeal(entry);
    setSheet("meal");
  }

  /** 근무 입력창 저장: 새 기록 추가 또는 수정 */
  function saveWork(input: WorkInput) {
    const editing = editingWork;
    if (editing) {
      commitRecords(
        records.map((r) =>
          r.id === editing.id ? { ...r, clockIn: input.inIso, clockOut: input.outIso } : r,
        ),
      );
    } else {
      commitRecords([...records, { id: uid(), clockIn: input.inIso, clockOut: input.outIso }]);
    }
    if (input.holidayChange !== undefined) setHoliday(input.dateKey, input.holidayChange);
    setSheet(null);
    setEditingWork(null);
    setViewMonth(input.dateKey.slice(0, 7));
    setListTab("work");
    setToast(editing ? "근무 기록을 수정했어요." : "근무 기록을 추가했어요.");
  }

  /** 식사 입력창 저장: 새 기록 추가 또는 수정 */
  function saveMeal(entry: Omit<LedgerEntry, "id">) {
    const editing = editingMeal;
    if (editing) {
      commitLedger(
        ledger.map((e) =>
          e.id === editing.id
            ? { id: e.id, date: entry.date, amount: entry.amount, type: entry.type, ...(entry.memo ? { memo: entry.memo } : {}) }
            : e,
        ),
      );
    } else {
      commitLedger([{ id: uid(), ...entry }, ...ledger]);
    }
    setMealType(entry.type ?? "ledger");
    setSheet(null);
    setEditingMeal(null);
    setViewMonth(entry.date.slice(0, 7));
    setListTab("meal");
    setToast(
      editing
        ? "식사 기록을 수정했어요."
        : entry.type === "personal"
          ? "내돈내산 식사를 기록했어요."
          : "장부 식사를 기록했어요.",
    );
  }

  function saveRulesList(next: Rules[]) {
    const sorted = sortRules(next);
    setRules(sorted);
    saveRules(sorted);
    setSheet(null);
    setToast("계산 규칙을 저장했어요.");
  }

  async function deleteRecord(id: string) {
    const r = records.find((x) => x.id === id);
    const start = r ? new Date(r.clockIn) : null;
    const end = r?.clockOut ? new Date(r.clockOut) : null;
    const ok = await ask({
      title: "이 근무 기록을 삭제할까요?",
      message: start
        ? `${formatMonthDay(dateKeyOf(start))} ${formatTime(start)} – ${end ? formatTime(end) : "근무 중"}`
        : undefined,
      confirmText: "삭제",
      danger: true,
    });
    if (!ok) return false;
    updateRecords((list) => list.filter((x) => x.id !== id));
    setToast("근무 기록을 삭제했어요.");
    return true;
  }

  async function deleteMeal(id: string) {
    const e = ledger.find((x) => x.id === id);
    const ok = await ask({
      title: "이 식사 기록을 삭제할까요?",
      message: e
        ? [isValidDateKey(e.date) ? formatMonthDay(e.date) : e.date, e.memo, formatWon(Number(e.amount) || 0)]
            .filter(Boolean)
            .join(" · ")
        : undefined,
      confirmText: "삭제",
      danger: true,
    });
    if (!ok) return false;
    updateLedger((list) => list.filter((x) => x.id !== id));
    setToast("식사 기록을 삭제했어요.");
    return true;
  }

  /** 앱 주소 공유: 휴대폰은 공유 창(카카오톡 등), 안 되면 주소 복사 */
  async function shareApp() {
    const { name, url } = APP_INFO;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: name, text: `${name} · 서원동 초과근무·급량비 계산기`, url });
        return;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") return; // 공유 창을 닫음
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setToast("주소를 복사했어요");
    } catch {
      setToast(url.replace("https://", ""));
    }
  }

  function openHolidaySheet() {
    setHolidaySheetMonth(viewMonth);
    setSheet("holiday");
  }

  async function resetRecords() {
    const ok = await ask({
      title: "근무 내역을 모두 삭제할까요?",
      message: "지운 기록은 되살릴 수 없어요.",
      confirmText: "모두 삭제",
      danger: true,
    });
    if (!ok) return false;
    localStorage.removeItem(RECORDS_KEY);
    setRecords([]);
    setToast("근무 내역을 초기화했어요.");
    return true;
  }

  async function resetLedger() {
    const ok = await ask({
      title: "식사 내역을 모두 삭제할까요?",
      message: "지운 기록은 되살릴 수 없어요.",
      confirmText: "모두 삭제",
      danger: true,
    });
    if (!ok) return false;
    localStorage.removeItem(LEDGER_KEY);
    setLedger([]);
    setToast("식사 내역을 초기화했어요.");
    return true;
  }

  async function resetAll() {
    const first = await ask({
      title: "모든 데이터를 초기화할까요?",
      message: "근무 내역, 식사 내역, 휴일 설정이 모두 삭제되고 계산 규칙도 기본값으로 돌아가요.",
      confirmText: "초기화",
      danger: true,
    });
    if (!first) return false;
    const second = await ask({
      title: "한 번 더 확인할게요",
      message: "정말 모든 데이터를 지울까요? 되살릴 수 없어요.",
      confirmText: "모두 지우기",
      danger: true,
    });
    if (!second) return false;
    localStorage.removeItem(RECORDS_KEY);
    localStorage.removeItem(LEDGER_KEY);
    localStorage.removeItem(HOLIDAYS_KEY);
    localStorage.removeItem(RULES_KEY);
    setRecords([]);
    setLedger([]);
    setHolidays({});
    setRules(DEFAULT_RULES);
    setToast("모든 데이터를 초기화했어요.");
    return true;
  }

  const isCurrent = viewMonth === currentMonth;

  return (
    <ConfirmContext.Provider value={ask}>
      <div className="min-h-screen" style={{ background: "var(--desk)" }}>
        {/* 앱 화면: 휴대폰에서는 꽉 차고, PC처럼 넓은 화면에서는 가운데 한 줄로 */}
        <div className="app-column relative mx-auto min-h-screen max-w-md pb-16" style={{ background: "var(--bg)" }}>
          {banner?.({ openBasis: () => setSheet("basis") })}
          <header className="sticky top-0 z-20" style={{ background: C.navy }}>
            <div className="flex items-center justify-between py-2 pr-2 pl-4">
              <div className="flex items-center gap-2">
                <img
                  src={logoUrl}
                  alt=""
                  width={30}
                  height={30}
                  className="size-[30px] shrink-0 rounded-[8px] ring-1 ring-white/20"
                />
                <h1 className="text-[18px] font-bold tracking-[-0.01em] text-white">초근밥</h1>
              </div>
              <IconButton label="설정" onClick={() => setSheet("settings")} onDark>
                <GearIcon />
              </IconButton>
            </div>
          </header>

          {/* 입력: 오늘 */}
          <TodayPanel
            now={now}
            todayInfo={dayInfoOf(todayKey)}
            openRecord={openRecord}
            todayDone={todayDone}
            doneToday={!openRecord && !!recordOn(todayKey)}
            onClock={toggleClock}
            onDone={() => setToast("오늘 근무는 이미 기록했어요")}
            onAddWork={() => openWorkSheet(null)}
            onAddMeal={() => openMealSheet(null)}
          />

          {/* 보기: 월별 내역 */}
          <main className="relative -mt-5 rounded-t-[22px] px-4 pt-2.5" style={{ background: "var(--bg)" }}>
            <section aria-label="월별 내역">
              <div className="flex items-center justify-between">
                <div className="-ml-2 flex items-center">
                  <IconButton label="이전 달" onClick={() => setViewMonth(shiftMonth(viewMonth, -1))}>
                    <ChevronIcon dir="left" />
                  </IconButton>
                  <h2 className="text-[17px] font-bold tabular-nums">{monthTitle(viewMonth)}</h2>
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
                      className="rounded-lg px-2 py-1 text-xs font-semibold transition hover:brightness-95"
                      style={{ background: "var(--navy-soft)", color: C.navy }}
                    >
                      이번 달
                    </button>
                  )}
                </div>
                <IconButton label="휴일 설정" onClick={openHolidaySheet}>
                  <CalendarIcon />
                </IconButton>
              </div>

              <SummaryPanel summary={summary} rules={monthRules} />

              <div className="mt-5">
                <Segmented
                  tabs
                  label="내역 종류"
                  value={listTab}
                  onChange={setListTab}
                  options={[
                    ["work", <TabLabel text="근무" count={monthWorks.length} active={listTab === "work"} />],
                    ["meal", <TabLabel text="식사" count={monthMeals.length} active={listTab === "meal"} />],
                  ]}
                />
              </div>

              {listTab === "work" ? (
                <WorkList
                  key={`w-${viewMonth}`}
                  rows={monthWorks}
                  dayInfoOf={dayInfoOf}
                  onEdit={(c) => openWorkSheet(c.record)}
                  onDelete={deleteRecord}
                />
              ) : (
                <MealList
                  key={`m-${viewMonth}`}
                  rows={monthMeals}
                  dayInfoOf={dayInfoOf}
                  onEdit={openMealSheet}
                  onDelete={deleteMeal}
                />
              )}
            </section>
          </main>
        </div>

        {sheet === "work" && (
          <WorkSheet
            key={editingWork?.id ?? "new"}
            record={editingWork}
            isOpenRecord={!!editingWork && editingWork.id === openRecord?.id}
            todayKey={todayKey}
            holidays={holidays}
            rules={rules}
            existingOn={(k) => recordOn(k, editingWork?.id)}
            onEditExisting={openWorkSheet}
            onClose={() => setSheet(null)}
            onSubmit={saveWork}
          />
        )}
        {sheet === "meal" && (
          <MealSheet
            entry={editingMeal}
            todayKey={todayKey}
            defaultType={mealType}
            rules={rules}
            onClose={() => setSheet(null)}
            onSubmit={saveMeal}
          />
        )}
        {sheet === "rules" && (
          <RulesSheet
            rules={rules}
            currentMonth={currentMonth}
            onClose={() => setSheet(null)}
            onSave={saveRulesList}
          />
        )}
        {sheet === "holiday" && (
          <HolidaySheet
            initialMonth={holidaySheetMonth}
            todayKey={todayKey}
            holidays={holidays}
            onSet={setHoliday}
            onClose={() => setSheet(null)}
          />
        )}
        {sheet === "settings" && (
          <SettingsSheet
            onClose={() => setSheet(null)}
            onShareApp={shareApp}
            onOpenHoliday={openHolidaySheet}
            onOpenRules={() => setSheet("rules")}
            onOpenBasis={() => setSheet("basis")}
            onResetRecords={async () => {
              if (await resetRecords()) setSheet(null);
            }}
            onResetLedger={async () => {
              if (await resetLedger()) setSheet(null);
            }}
            onResetAll={async () => {
              if (await resetAll()) setSheet(null);
            }}
          />
        )}
        {sheet === "basis" && <BasisSheet onClose={() => setSheet(null)} onOpenRules={() => setSheet("rules")} />}

        {confirmReq && <ConfirmDialog {...confirmReq} onAnswer={answerConfirm} />}

        {toast && (
          <div
            role="status"
            className="fixed left-1/2 z-50 -translate-x-1/2 rounded-full px-4 py-2.5 text-sm whitespace-nowrap shadow-lg"
            style={{
              background: "#1e293b",
              color: "white",
              bottom: "max(1.5rem, env(safe-area-inset-bottom))",
            }}
          >
            {toast}
          </div>
        )}
      </div>
    </ConfirmContext.Provider>
  );
}

/** 앱 안의 확인창 (가운데 카드). 바깥을 누르거나 Esc를 누르면 취소 */
function ConfirmDialog({
  title,
  message,
  confirmText = "확인",
  danger,
  onAnswer,
}: ConfirmOptions & { onAnswer: (ok: boolean) => void }) {
  const answerRef = useRef(onAnswer);
  answerRef.current = onAnswer;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // 아래에 열린 시트의 Esc(닫기)보다 먼저 받아서 확인창만 닫음
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      answerRef.current(false);
    };
    window.addEventListener("keydown", onKey, true);
    // 지우는 일이면 '취소'에, 아니면 확인 버튼에 초점
    (danger ? cancelRef : okRef).current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey, true);
    };
  }, [danger]);
  return (
    <div
      className="confirm-backdrop fixed inset-0 z-[60] flex items-center justify-center px-6"
      style={{ background: "rgba(15,23,42,0.5)" }}
      onClick={() => onAnswer(false)}
    >
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={message ? "confirm-message" : undefined}
        className="confirm-panel w-full max-w-[320px] rounded-[20px] bg-white px-5 pt-5 pb-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-[16px] leading-snug font-bold">
          {title}
        </h2>
        {message && (
          <p
            id="confirm-message"
            className="mt-2 text-[14px] leading-relaxed whitespace-pre-line"
            style={{ color: "#475569" }}
          >
            {message}
          </p>
        )}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={() => onAnswer(false)}
            className="rounded-xl py-3 text-[15px] font-semibold transition hover:brightness-95"
            style={{ background: C.soft, color: "#334155" }}
          >
            취소
          </button>
          <button
            ref={okRef}
            type="button"
            onClick={() => onAnswer(true)}
            className="rounded-xl py-3 text-[15px] font-bold text-white transition hover:brightness-110"
            style={{ background: danger ? C.danger : C.navy }}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────── 오늘 (입력 영역) ───────── */

function TodayPanel({
  now,
  todayInfo,
  openRecord,
  todayDone,
  doneToday,
  onClock,
  onDone,
  onAddWork,
  onAddMeal,
}: {
  now: Date;
  todayInfo: DayInfo;
  openRecord: WorkRecord | null;
  todayDone: ComputedRecord[];
  /** 오늘 근무를 이미 기록함 (하루에 한 번만) */
  doneToday: boolean;
  onClock: () => void;
  onDone: () => void;
  onAddWork: () => void;
  onAddMeal: () => void;
}) {
  const working = !!openRecord;
  return (
    <section aria-label="오늘" className="px-4 pt-2 pb-9 text-white" style={{ background: C.navy }}>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[15px] font-semibold">
              {formatMonthDay(dateKeyOf(now))} {DOW[now.getDay()]}요일
            </span>
            {todayInfo.kind !== "weekday" && (
              <span
                className="rounded-full bg-white/15 px-2 py-0.5 text-[11px] font-semibold"
                style={{ color: "#fecaca" }}
              >
                {todayInfo.name ?? "주말"}
              </span>
            )}
          </div>
          <TodayStatus now={now} openRecord={openRecord} todayDone={todayDone} />
        </div>
        <div className="shrink-0 text-[32px] leading-none font-bold tracking-[-0.02em] tabular-nums">
          {pad(now.getHours())}:{pad(now.getMinutes())}
        </div>
      </div>
      {doneToday ? (
        <button
          onClick={onDone}
          aria-disabled="true"
          className="mt-4 flex h-14 w-full cursor-default items-center justify-center gap-2 rounded-2xl bg-white/10 text-[18px] font-bold text-white/60"
        >
          <CheckIcon />
          퇴근 완료
        </button>
      ) : (
        <button
          onClick={onClock}
          className="mt-4 flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-[18px] font-bold transition hover:brightness-105 active:scale-[0.98]"
          style={working ? { background: C.moon, color: C.navy } : { background: "white", color: C.navy }}
        >
          {working ? <MoonIcon /> : <SunIcon />}
          {working ? "퇴근" : "출근"}
        </button>
      )}
      <div className="mt-2.5 grid grid-cols-2 gap-2.5">
        <GhostButton onClick={onAddWork}>근무 입력</GhostButton>
        <GhostButton onClick={onAddMeal}>식사 입력</GhostButton>
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
    if (dateKeyOf(start) !== dateKeyOf(now)) {
      return (
        <p className="mt-1 text-[13px]" style={{ color: "#fde68a" }}>
          {formatMonthDay(dateKeyOf(start))} {formatTime(start)} 출근 · 퇴근 기록 없음
        </p>
      );
    }
    const elapsed = (now.getTime() - start.getTime()) / (1000 * 60 * 60);
    return (
      <p className="mt-1 flex items-center gap-1.5 text-[13px] text-white/80">
        <span className="size-1.5 shrink-0 rounded-full motion-safe:animate-pulse" style={{ background: C.moon }} />
        {formatTime(start)} 출근
        {Math.round(elapsed * 60) >= 1 ? ` · ${formatHours(elapsed)}째` : ""}
      </p>
    );
  }
  if (todayDone.length > 0) {
    const overtime = todayDone.reduce((s, c) => s + c.overtimeHours, 0);
    const meals = todayDone.reduce((s, c) => s + c.meals, 0);
    return (
      <p className="mt-1 text-[13px] text-white/70">
        오늘 초과 {overtime > 0 ? formatHours(overtime) : "없음"} · 급량비 {meals}개
      </p>
    );
  }
  return null;
}

function GhostButton({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-11 items-center justify-center gap-1 rounded-xl bg-white/10 text-[14px] font-semibold text-white transition hover:bg-white/15 active:scale-[0.98]"
    >
      <PlusIcon />
      {children}
    </button>
  );
}

/* ───────── 월 요약 ───────── */

function SummaryPanel({ summary: s, rules }: { summary: MonthSummary; rules: Rules }) {
  const [open, setOpen] = useState(false);
  const otCap = s.overtimeCap;
  const mealCap = rules.mealMonthlyCap;
  const otOver = s.overtimeHours > otCap;
  const mealOver = s.rawMeals > mealCap;
  return (
    <div className="mt-2 rounded-[20px] bg-white">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="block w-full px-4 pt-4 pb-1 text-left"
      >
        {/* 위: 한도까지 얼마나 찼는지 */}
        <span className="grid grid-cols-2 gap-5">
          <Meter
            icon={<MoonIcon size={13} />}
            label="초과근무 실적"
            value={formatHours(s.overtimeHours)}
            ratio={otCap > 0 ? s.overtimeHours / otCap : 1}
            max={`최대 ${otCap}시간`}
            color={C.overtime}
            over={otOver}
          />
          <Meter
            icon={<BowlIcon size={14} />}
            label="급량비"
            value={`${s.rawMeals}개`}
            ratio={mealCap > 0 ? s.rawMeals / mealCap : 0}
            max={`최대 ${mealCap}개`}
            color={C.meal}
            over={mealOver}
          />
        </span>
        {/* 아래: 받는 것과 쓴 것 */}
        <span className="mt-3.5 grid grid-cols-3 gap-2 border-t pt-3">
          <Figure label="수당 시간" value={formatHours(s.allowanceHours)} color={C.overtime} />
          <Figure label="장부 사용" value={formatWon(s.ledgerSpent)} />
          <Figure label="잔액" value={formatWon(s.balance)} color={s.balance >= 0 ? C.meal : C.danger} />
        </span>
        <span className="mt-1 flex justify-center" style={{ color: "#cbd5e1" }}>
          <ChevronIcon dir={open ? "up" : "down"} size={18} />
        </span>
      </button>
      {open && <SummaryBreakdown summary={s} />}
    </div>
  );
}

/** 이번 달 실적·개수와 한도 막대 (한도를 넘으면 주황) */
function Meter({
  icon,
  label,
  value,
  ratio,
  max,
  color,
  over,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  ratio: number;
  max: string;
  color: string;
  over: boolean;
}) {
  return (
    <span className="block min-w-0">
      <span className="flex items-center gap-1 text-[13px] font-medium" style={{ color: C.muted }}>
        <span style={{ color }}>{icon}</span>
        {label}
      </span>
      <span
        className="mt-0.5 block text-[16px] leading-tight font-bold tracking-[-0.015em] whitespace-nowrap tabular-nums"
        style={{ color: over ? C.warn : color }}
      >
        {value}
      </span>
      <span className="mt-2 block h-1.5 overflow-hidden rounded-full" style={{ background: C.soft }}>
        <span
          className="block h-full rounded-full"
          style={{ width: `${Math.min(100, Math.max(0, ratio * 100))}%`, background: over ? "#d97706" : color }}
        />
      </span>
      <span
        className="mt-1 block text-right text-[12px] whitespace-nowrap tabular-nums"
        style={{ color: over ? C.warn : C.muted }}
      >
        {max}
      </span>
    </span>
  );
}

function Figure({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <span className="block min-w-0">
      <span className="block text-[12px]" style={{ color: C.muted }}>
        {label}
      </span>
      <span
        className="mt-0.5 block text-[16px] font-bold whitespace-nowrap tabular-nums"
        style={{ color: color ?? "var(--text)" }}
      >
        {value}
      </span>
    </span>
  );
}

/** 요약을 누르면 보이는 계산 내역 */
function SummaryBreakdown({ summary: s }: { summary: MonthSummary }) {
  const rows: [string, string][] = [
    ["수당 시간", `기본 ${s.fixedHours}시간 + 실적 ${formatHours(s.recognizedOvertimeHours)}`],
    [`급량비 ${s.meals}개`, formatWon(s.mealAmount)],
  ];
  if (s.personalSpent > 0) rows.push(["내돈내산 (잔액 제외)", formatWon(s.personalSpent)]);
  return (
    <div className="mx-3 mb-3 rounded-2xl px-3.5 py-3 text-[13px]" style={{ background: C.soft }}>
      <DetailRows rows={rows} />
      <p className="mt-1.5 text-[12px]" style={{ color: C.muted }}>
        급량비 평일 {s.weekdayMeals}개 · 휴일 {s.holidayMeals}개
        {s.mealCapped ? `, ${s.meals}개까지 인정` : ""}
      </p>
    </div>
  );
}

/* ───────── 목록 ───────── */

function TabLabel({ text, count, active }: { text: string; count: number; active: boolean }) {
  return (
    <>
      {text}{" "}
      <span className="tabular-nums" style={{ color: active ? C.navy : C.faint }}>
        {count}
      </span>
    </>
  );
}

function DateCell({ dateKey, info, show }: { dateKey: string; info: DayInfo; show: boolean }) {
  if (!show) return <span aria-hidden="true" />;
  const color = dayColor(info);
  return (
    <span className="flex items-baseline gap-1 tabular-nums" style={{ color }}>
      <span className="text-[15px] font-bold">{Number(dateKey.slice(8))}</span>
      <span className="text-[11px]" style={{ color: color ?? C.muted }}>
        {DOW[info.dow]}
      </span>
    </span>
  );
}

/** 급량비 개수만큼 밥그릇 */
function MealIcons({ count }: { count: number }) {
  if (count <= 0) return <span aria-hidden="true" />;
  return (
    <span
      role="img"
      aria-label={`급량비 ${count}개`}
      className="flex items-center justify-end gap-0.5"
      style={{ color: C.meal }}
    >
      {count <= 2 ? (
        Array.from({ length: count }, (_, i) => <BowlIcon key={i} size={16} />)
      ) : (
        <>
          <BowlIcon size={16} />
          <span className="text-[12px] font-semibold tabular-nums">{count}</span>
        </>
      )}
    </span>
  );
}

/** 펼친 줄에 보여 줄 계산 내역 (항목, 값) */
function workBreakdown(c: ComputedRecord, info: DayInfo): [string, string][] {
  if (c.holiday) {
    const name = info.name ?? (info.kind === "weekend" ? `${DOW[info.dow]}요일` : "휴일");
    return [[`${name} 근무`, formatHours(c.eligibleHours)]];
  }
  const rows: [string, string][] = [];
  if (c.morningHours > 0) rows.push([`${c.rules.workStart} 전`, formatHours(c.morningHours)]);
  if (c.eveningHours > 0) rows.push([`${c.rules.workEnd} 후`, formatHours(c.eveningHours)]);
  if (c.deductionHours > 0) rows.push(["공제", `− ${formatHours(c.deductionHours)}`]);
  return rows;
}

/** 운영시간 안내 한 줄: 운영시간 밖이라 뺀 시간, 또는 8시간 이상이라 인정한 경우 */
function windowNote(c: ComputedRecord): { text: string; warn: boolean } | null {
  const r = c.rules;
  if (Math.round(c.outsideHours * 60) >= 1) {
    const range = c.holiday
      ? `${r.holidayWindowStart}~${r.holidayWindowEnd}`
      : `${r.weekdayWindowStart}~${r.weekdayWindowEnd}`;
    return { text: `운영시간(${range}) 밖 ${formatHours(c.outsideHours)} 제외`, warn: true };
  }
  if (c.windowExempt && r.windowExemptMinutes !== null) {
    return { text: `${formatHours(r.windowExemptMinutes / 60)} 이상이라 운영시간 밖도 인정 (국·소장 결재)`, warn: false };
  }
  return null;
}

function WorkList({
  rows,
  dayInfoOf,
  onEdit,
  onDelete,
}: {
  rows: ComputedRecord[];
  dayInfoOf: (k: string) => DayInfo;
  onEdit: (c: ComputedRecord) => void;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (rows.length === 0) {
    return <EmptyList icon={<MoonIcon size={26} />} text="근무 기록이 없어요" />;
  }
  const cols = "grid grid-cols-[2.5rem_1fr_2rem_5.25rem] items-center gap-1.5";
  return (
    <ul className="mt-3 overflow-hidden rounded-[20px] bg-white">
      {rows.map((c, i) => {
        const firstOfDay = i === 0 || rows[i - 1].dateKey !== c.dateKey;
        const info = dayInfoOf(c.dateKey);
        const open = openId === c.record.id;
        const nextDay = c.end && dateKeyOf(c.end) !== c.dateKey;
        const breakdown = c.end ? workBreakdown(c, info) : [];
        return (
          <li key={c.record.id} className={firstOfDay && i > 0 ? "border-t" : ""}>
            <button
              onClick={() => setOpenId(open ? null : c.record.id)}
              aria-expanded={open}
              className={`${cols} w-full px-3.5 py-3 text-left transition hover:bg-slate-50 active:bg-slate-100`}
            >
              {firstOfDay ? (
                <DateCell dateKey={c.dateKey} info={info} show />
              ) : (
                // 하루 한 번만 등록하도록 바뀌기 전에 같은 날 두 번 이상 찍힌 기록
                <span
                  className="justify-self-start rounded-md px-1.5 py-0.5 text-[11px] font-semibold"
                  style={{ background: "#fef3c7", color: "#92400e" }}
                >
                  중복
                </span>
              )}
              <span className="min-w-0 text-[15px] tabular-nums">
                {formatTime(c.start)} – {c.end ? formatTime(c.end) : ""}
                {nextDay && (
                  <span className="ml-0.5 align-top text-[10px]" style={{ color: C.muted }}>
                    +1
                  </span>
                )}
              </span>
              <MealIcons count={c.end ? c.meals : 0} />
              <span
                className="text-right text-[15px] font-semibold tabular-nums"
                style={{ color: c.overtimeHours > 0 ? C.overtime : "#cbd5e1" }}
              >
                {c.end ? (
                  c.overtimeHours > 0 ? (
                    formatHours(c.overtimeHours)
                  ) : (
                    "–"
                  )
                ) : (
                  <span
                    className="rounded-full px-2 py-0.5 text-[12px] font-semibold"
                    style={{ background: "#fef3c7", color: "#92400e" }}
                  >
                    근무 중
                  </span>
                )}
              </span>
            </button>
            {open && (
              <Detail
                onEdit={() => onEdit(c)}
                onDelete={async () => {
                  if (await onDelete(c.record.id)) setOpenId(null);
                }}
              >
                {c.end ? (
                  <>
                    {breakdown.length > 0 && <DetailRows rows={breakdown} />}
                    <DetailRows
                      strong={breakdown.length > 0 ? "line" : "plain"}
                      rows={[["초과근무", formatHours(c.overtimeHours)]]}
                    />
                    {c.belowMinimum && (
                      <p style={{ color: C.warn }}>
                        {formatHours(c.rules.minDailyMinutes / 60)} 미만이라 인정되지 않아요.
                      </p>
                    )}
                    {c.cappedAt !== null && (
                      <p style={{ color: C.warn }}>하루 상한 {formatHours(c.cappedAt)}까지만 인정돼요.</p>
                    )}
                    {(() => {
                      const note = windowNote(c);
                      return note && <p style={{ color: note.warn ? C.warn : C.muted }}>{note.text}</p>;
                    })()}
                  </>
                ) : (
                  <p style={{ color: C.muted }}>퇴근 전이에요.</p>
                )}
              </Detail>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function MealList({
  rows,
  dayInfoOf,
  onEdit,
  onDelete,
}: {
  rows: LedgerEntry[];
  dayInfoOf: (k: string) => DayInfo;
  onEdit: (e: LedgerEntry) => void;
  onDelete: (id: string) => Promise<boolean>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  if (rows.length === 0) {
    return <EmptyList icon={<BowlIcon size={28} />} text="식사 기록이 없어요" />;
  }
  const cols = "grid grid-cols-[2.5rem_1fr_auto] items-center gap-1.5";
  return (
    <ul className="mt-3 overflow-hidden rounded-[20px] bg-white">
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
              className={`${cols} w-full px-3.5 py-3 text-left transition hover:bg-slate-50 active:bg-slate-100`}
            >
              {info ? (
                <DateCell dateKey={e.date} info={info} show={firstOfDay} />
              ) : (
                <span className="text-xs">{e.date}</span>
              )}
              <span className="flex min-w-0 items-center gap-1.5">
                {/* 장부 사용(잔액에서 빠짐)은 남색, 내돈내산(잔액 제외)은 회색 */}
                <span
                  className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold"
                  style={
                    personal
                      ? { background: C.soft, color: C.muted }
                      : { background: "var(--navy-soft)", color: C.navy }
                  }
                >
                  {personal ? "내돈내산" : "장부 사용"}
                </span>
                <span className="truncate text-[15px]">{e.memo ?? ""}</span>
              </span>
              <span
                className="text-right text-[15px] font-semibold tabular-nums"
                style={{ color: personal ? C.muted : "var(--text)" }}
              >
                {formatWon(Number(e.amount) || 0)}
              </span>
            </button>
            {open && (
              <Detail
                onEdit={() => onEdit(e)}
                onDelete={async () => {
                  if (await onDelete(e.id)) setOpenId(null);
                }}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Detail({
  children,
  onEdit,
  onDelete,
}: {
  children?: ReactNode;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={children ? "mx-3 mb-3 rounded-2xl px-3.5 py-3 text-[13px]" : "px-3.5 pb-3"}
      style={children ? { background: C.soft } : undefined}
    >
      {children && <div className="mb-3 space-y-1.5">{children}</div>}
      <div className="flex justify-end gap-2">
        <button
          onClick={onEdit}
          className="rounded-lg px-4 py-1.5 text-[13px] font-semibold transition hover:brightness-95"
          style={{ background: "var(--navy-soft)", color: C.navy }}
        >
          수정
        </button>
        <button
          onClick={onDelete}
          className="rounded-lg px-4 py-1.5 text-[13px] font-semibold transition hover:brightness-95"
          style={{ background: "#fee2e2", color: "#b91c1c" }}
        >
          삭제
        </button>
      </div>
    </div>
  );
}

function DetailRows({ rows, strong }: { rows: [string, string][]; strong?: "line" | "plain" }) {
  return (
    <dl
      className={strong === "line" ? "space-y-0.5 border-t border-dashed pt-1.5" : "space-y-0.5"}
      style={strong === "line" ? { borderColor: "#cbd5e1" } : undefined}
    >
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3">
          <dt className={strong ? "font-semibold" : ""} style={{ color: strong ? "var(--text)" : C.muted }}>
            {k}
          </dt>
          <dd
            className="min-w-0 text-right tabular-nums"
            style={strong ? { fontWeight: 700, color: C.overtime } : undefined}
          >
            {v}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function EmptyList({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="mt-3 flex flex-col items-center gap-2 rounded-[20px] bg-white px-4 py-10">
      <span style={{ color: "#cbd5e1" }}>{icon}</span>
      <span className="text-sm" style={{ color: C.muted }}>
        {text}
      </span>
    </div>
  );
}

/* ───────── 시트 (아래에서 올라오는 입력창) ───────── */

function Sheet({
  title,
  onClose,
  action,
  children,
}: {
  title: string;
  onClose: () => void;
  /** 닫기 버튼 옆에 붙일 버튼 */
  action?: ReactNode;
  children: ReactNode;
}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      // 확인창이 먼저 받은 Esc는 무시
      if (e.key === "Escape" && !e.defaultPrevented) closeRef.current();
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
      style={{ background: "rgba(15,23,42,0.5)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="sheet-panel max-h-[90vh] w-full max-w-md overflow-y-auto rounded-t-[22px]"
        style={{ background: "var(--card)", paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="sticky top-0 z-10 flex items-center justify-between gap-2 pt-3 pr-2.5 pb-2 pl-5"
          style={{ background: "var(--card)" }}
        >
          <h2 className="text-[17px] font-bold">{title}</h2>
          <div className="flex items-center gap-0.5">
            {action}
            <IconButton label="닫기" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          </div>
        </div>
        <div className="space-y-4 px-5 pt-1">{children}</div>
      </div>
    </div>
  );
}

const inputClass = "mt-1.5 w-full rounded-xl border px-3.5 py-3 text-base";
const inputStyle = { background: "#f8fafc" };

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="text-[13px] font-medium" style={{ color: C.muted }}>
      {children}
    </label>
  );
}

/** 평일·휴일 표시 (주말·공휴일처럼 여기서 바꿀 수 없는 날) */
function DayKindBadge({ info, weekdayName }: { info: DayInfo; weekdayName?: boolean }) {
  const holiday = isHolidayInfo(info);
  const reason =
    info.kind === "weekend"
      ? (info.name ?? (weekdayName ? `${DOW[info.dow]}요일` : null))
      : info.kind === "holiday"
        ? (info.name ?? null)
        : info.disabledPublicName
          ? `${info.disabledPublicName} 해제`
          : null;
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-[12px]">
      {reason && <span style={{ color: C.muted }}>{reason}</span>}
      <span
        className="rounded-full px-2 py-0.5 font-semibold"
        style={holiday ? { background: "#fee2e2", color: "#b91c1c" } : { background: C.soft, color: C.muted }}
      >
        {holiday ? "휴일" : "평일"}
      </span>
    </span>
  );
}

function WorkSheet({
  record,
  isOpenRecord,
  todayKey,
  holidays,
  rules,
  existingOn,
  onEditExisting,
  onClose,
  onSubmit,
}: {
  /** 수정할 기록 (null이면 새로 입력) */
  record: WorkRecord | null;
  /** 수정하는 기록이 아직 퇴근 전(근무 중)인지 */
  isOpenRecord: boolean;
  todayKey: string;
  holidays: HolidayOverrides;
  rules: Rules[];
  /** 그 날 이미 있는 다른 근무 기록 (하루에 하나만 등록) */
  existingOn: (dateKey: string) => WorkRecord | null;
  /** 이미 있는 기록을 고치러 가기 */
  onEditExisting: (record: WorkRecord) => void;
  onClose: () => void;
  onSubmit: (input: WorkInput) => void;
}) {
  const editing = !!record;
  const initStart = record ? new Date(record.clockIn) : null;
  const initEnd = record?.clockOut ? new Date(record.clockOut) : null;
  const initDate = initStart ? dateKeyOf(initStart) : todayKey;

  const [date, setDate] = useState(initDate);
  const [inTime, setInTime] = useState(initStart ? formatTime(initStart) : "09:00");
  const [outTime, setOutTime] = useState(initEnd ? formatTime(initEnd) : isOpenRecord ? "18:00" : "19:00");
  const [nextDay, setNextDay] = useState(!!initEnd && dateKeyOf(initEnd) !== initDate);
  const [working, setWorking] = useState(isOpenRecord);
  const [markHoliday, setMarkHoliday] = useState(
    () => getDayInfo(initDate, holidays).source === "custom",
  );

  const validDate = isValidDateKey(date);
  const info = validDate ? getDayInfo(date, holidays) : null;
  // 평일(또는 직접 지정한 휴일)만 여기서 휴일 여부를 바꿀 수 있음
  const toggleable =
    !!info && ((info.kind === "weekday" && !info.disabledPublicName) || info.source === "custom");
  const holiday = info ? (toggleable ? markHoliday : isHolidayInfo(info)) : false;

  const inIso = validDate ? combineDateTime(date, inTime) : null;
  const outIso =
    validDate && !working ? combineDateTime(nextDay ? shiftDate(date, 1) : date, outTime) : null;
  const existing = validDate ? existingOn(date) : null;
  const error = !validDate
    ? "날짜를 선택해 주세요."
    : existing
      ? "이 날은 이미 근무 기록이 있어요."
      : !inIso || (!working && !outIso)
      ? "시간을 확인해 주세요."
      : working && new Date(inIso).getTime() > Date.now()
        ? "출근 시간이 지금보다 늦어요."
        : !working && outIso && new Date(outIso).getTime() <= new Date(inIso).getTime()
          ? "퇴근이 출근보다 빨라요."
          : null;
  const showNextDay = !working && (nextDay || outTime <= inTime);
  const preview =
    !error && inIso && outIso
      ? computeRecord(
          { id: "preview", clockIn: inIso, clockOut: outIso },
          () => holiday,
          (m) => rulesFor(rules, m),
        )
      : null;
  const previewNote = preview ? windowNote(preview) : null;

  function changeDate(v: string) {
    setDate(v);
    setMarkHoliday(isValidDateKey(v) && getDayInfo(v, holidays).source === "custom");
  }

  function submit() {
    if (error || !inIso || !info) return;
    let holidayChange: HolidayOverride | null | undefined;
    if (toggleable) {
      const wasCustom = info.source === "custom";
      if (markHoliday && !wasCustom) holidayChange = { on: true, name: DEFAULT_CUSTOM_NAME };
      if (!markHoliday && wasCustom) holidayChange = null;
    }
    onSubmit({ dateKey: date, inIso, outIso: working ? null : outIso, holidayChange });
  }

  return (
    <Sheet title={editing ? "근무 수정" : "근무 입력"} onClose={onClose}>
      <div>
        <div className="flex min-h-8 items-center justify-between gap-2">
          <FieldLabel htmlFor="work-date">날짜</FieldLabel>
          {info &&
            (toggleable ? (
              <Segmented
                small
                label="계산 기준"
                value={markHoliday ? "holiday" : "weekday"}
                onChange={(v) => setMarkHoliday(v === "holiday")}
                options={[
                  ["weekday", "평일"],
                  ["holiday", "휴일"],
                ]}
                activeStyle={(v) => (v === "holiday" ? { background: C.holiday, color: "white" } : undefined)}
              />
            ) : (
              <DayKindBadge info={info} weekdayName />
            ))}
        </div>
        <input
          id="work-date"
          type="date"
          value={date}
          onChange={(e) => changeDate(e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel htmlFor="work-in">출근</FieldLabel>
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
          <FieldLabel htmlFor="work-out">퇴근</FieldLabel>
          {working ? (
            <div
              className="mt-1.5 flex h-[50px] items-center rounded-xl border px-3.5 text-base"
              style={{ background: C.soft, color: C.faint }}
            >
              –
            </div>
          ) : (
            <input
              id="work-out"
              type="time"
              value={outTime}
              onChange={(e) => setOutTime(e.target.value)}
              className={`${inputClass} tabular-nums`}
              style={inputStyle}
            />
          )}
        </div>
      </div>
      {(isOpenRecord || showNextDay) && (
        <div className="flex flex-wrap gap-2">
          {isOpenRecord && (
            <ToggleChip checked={working} onChange={setWorking}>
              퇴근 전
            </ToggleChip>
          )}
          {showNextDay && (
            <ToggleChip checked={nextDay} onChange={setNextDay}>
              다음 날 퇴근
            </ToggleChip>
          )}
        </div>
      )}
      <div
        className="flex items-center justify-between gap-2 rounded-xl px-3.5 py-3 text-[14px]"
        style={error ? { background: "#fef2f2", color: "#b91c1c" } : { background: C.soft }}
      >
        {existing && !editing ? (
          <>
            <span>{error}</span>
            <button
              type="button"
              onClick={() => onEditExisting(existing)}
              className="-my-1 shrink-0 rounded-lg bg-white px-3 py-1.5 text-[13px] font-semibold transition hover:brightness-95"
              style={{ color: "#b91c1c" }}
            >
              그 기록 수정
            </button>
          </>
        ) : (
          <span>
            {error ??
          (working ? (
            <span style={{ color: C.muted }}>퇴근하면 계산돼요.</span>
          ) : (
            preview && (
              <>
                초과근무 <b style={{ color: C.overtime }}>{formatHours(preview.overtimeHours)}</b>
                <span style={{ color: C.faint }}> · </span>
                급량비 <b style={{ color: C.meal }}>{preview.meals}개</b>
                {previewNote && (
                  <span
                    className="mt-0.5 block text-[12px]"
                    style={{ color: previewNote.warn ? C.warn : C.muted }}
                  >
                    {previewNote.text}
                  </span>
                )}
              </>
            )
          ))}
          </span>
        )}
      </div>
      <PrimaryButton onClick={submit} disabled={!!error}>
        저장
      </PrimaryButton>
    </Sheet>
  );
}

function MealSheet({
  entry,
  todayKey,
  defaultType,
  rules,
  onClose,
  onSubmit,
}: {
  /** 수정할 기록 (null이면 새로 입력) */
  entry: LedgerEntry | null;
  todayKey: string;
  defaultType: MealType;
  rules: Rules[];
  onClose: () => void;
  onSubmit: (entry: Omit<LedgerEntry, "id">) => void;
}) {
  const editing = !!entry;
  const [type, setType] = useState<MealType>(
    entry ? (entry.type === "personal" ? "personal" : "ledger") : defaultType,
  );
  const [date, setDate] = useState(entry?.date ?? todayKey);
  const [amount, setAmount] = useState(entry ? String(Math.round(Number(entry.amount) || 0)) : "");
  const [memo, setMemo] = useState(entry?.memo ?? "");
  const value = Number(amount);
  const canSave = isValidDateKey(date) && value > 0;
  const isLedger = type === "ledger";
  const price = rulesFor(rules, (isValidDateKey(date) ? date : todayKey).slice(0, 7)).mealPrice;

  function submit() {
    if (!canSave) return;
    onSubmit({ date, amount: value, memo: memo.trim() || undefined, type });
  }

  return (
    <Sheet title={editing ? "식사 수정" : "식사 입력"} onClose={onClose}>
      <Segmented
        label="식사 구분"
        value={type}
        onChange={setType}
        options={[
          ["ledger", "장부 식당"],
          ["personal", "내돈내산"],
        ]}
        activeStyle={(v) =>
          v === "ledger" ? { background: C.navy, color: "white" } : { background: "#475569", color: "white" }
        }
      />
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
          <FieldLabel htmlFor="meal-amount">금액</FieldLabel>
          <button
            type="button"
            onClick={() => setAmount(String(price))}
            className="rounded-full border px-2.5 py-0.5 text-xs font-semibold tabular-nums transition hover:brightness-95"
            style={{ color: C.navy, borderColor: "var(--navy-line)", background: "var(--navy-soft)" }}
          >
            {price.toLocaleString("ko-KR")}원
          </button>
        </div>
        <input
          id="meal-amount"
          type="text"
          inputMode="numeric"
          placeholder={`예: ${price.toLocaleString("ko-KR")}`}
          value={amount ? Number(amount).toLocaleString("ko-KR") : ""}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, "").slice(0, 9))}
          className={`${inputClass} tabular-nums`}
          style={inputStyle}
        />
      </div>
      <div>
        <FieldLabel htmlFor="meal-memo">메모</FieldLabel>
        <input
          id="meal-memo"
          type="text"
          placeholder="식당, 메뉴"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          className={inputClass}
          style={inputStyle}
        />
      </div>
      <PrimaryButton onClick={submit} disabled={!canSave} color={isLedger ? C.navy : "#334155"}>
        저장
      </PrimaryButton>
    </Sheet>
  );
}

/* ───────── 휴일 설정 ───────── */

function HolidaySheet({
  initialMonth,
  todayKey,
  holidays,
  onSet,
  onClose,
}: {
  initialMonth: string;
  todayKey: string;
  holidays: HolidayOverrides;
  onSet: (dateKey: string, ov: HolidayOverride | null) => void;
  onClose: () => void;
}) {
  const [month, setMonth] = useState(initialMonth);
  const [selected, setSelected] = useState<string | null>(null);
  const changed = Object.keys(holidays).sort();

  return (
    <Sheet title="휴일 설정" onClose={onClose}>
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
      />
      {selected ? (
        <SelectedDayPanel
          dateKey={selected}
          info={getDayInfo(selected, holidays)}
          onSet={(ov) => onSet(selected, ov)}
        />
      ) : (
        <p className="py-1 text-center text-[13px]" style={{ color: C.muted }}>
          날짜를 눌러 휴일을 지정하세요.
        </p>
      )}
      {changed.length > 0 && (
        <div>
          <div className="mb-1 px-1 text-[13px] font-medium" style={{ color: C.muted }}>
            직접 바꾼 날
          </div>
          <ul className="divide-y overflow-hidden rounded-2xl border">
            {changed.map((k) => {
              const ov = holidays[k];
              const [y, m, d] = k.split("-").map(Number);
              const dow = DOW[new Date(y, m - 1, d).getDay()];
              const label = ov.on
                ? ov.name || DEFAULT_CUSTOM_NAME
                : `${PUBLIC_HOLIDAYS[k] ?? "공휴일"} → 평일`;
              return (
                <li key={k} className="flex items-center justify-between gap-2 py-1.5 pr-2 pl-3.5">
                  <button
                    className="min-w-0 truncate text-left text-sm"
                    onClick={() => {
                      setMonth(k.slice(0, 7));
                      setSelected(k);
                    }}
                  >
                    <span className="tabular-nums">
                      {y}. {m}. {d}. {dow}
                    </span>{" "}
                    <span style={{ color: ov.on ? C.holiday : C.muted }}>{label}</span>
                  </button>
                  <button
                    onClick={() => onSet(k, null)}
                    className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition hover:brightness-95"
                    style={{ background: C.soft, color: "#475569" }}
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
}: {
  month: string;
  onMonthChange: (m: string) => void;
  selected: string | null;
  onSelect: (k: string) => void;
  holidays: HolidayOverrides;
  todayKey: string;
}) {
  const [y, m] = month.split("-").map(Number);
  const leading = new Date(y, m - 1, 1).getDay();
  const days = new Date(y, m, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: leading }, () => null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  return (
    <div className="rounded-2xl border p-2">
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
          return (
            <button
              key={key}
              onClick={() => onSelect(key)}
              aria-pressed={isSel}
              aria-label={`${m}월 ${d}일${info.name ? ` ${info.name}` : ""}`}
              className="mx-0.5 flex h-12 flex-col items-center rounded-lg pt-1 transition hover:bg-slate-100"
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
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SelectedDayPanel({
  dateKey,
  info,
  onSet,
}: {
  dateKey: string;
  info: DayInfo;
  onSet: (ov: HolidayOverride | null) => void;
}) {
  const outline = "rounded-lg border bg-white px-3 py-2 text-xs font-semibold transition hover:brightness-95";
  let body: ReactNode;
  if (info.kind === "weekend") {
    body = (
      <p className="text-xs" style={{ color: C.muted }}>
        주말은 항상 휴일이에요.
      </p>
    );
  } else if (info.kind === "holiday" && info.source === "public") {
    body = (
      <button onClick={() => onSet({ on: false })} className={outline} style={{ color: "#475569" }}>
        평일로 계산
      </button>
    );
  } else if (info.kind === "holiday") {
    body = (
      <button onClick={() => onSet(null)} className={outline} style={{ color: "#475569" }}>
        휴일 해제
      </button>
    );
  } else if (info.disabledPublicName) {
    body = (
      <button onClick={() => onSet(null)} className={outline} style={{ color: C.holiday }}>
        다시 휴일로
      </button>
    );
  } else {
    body = (
      <div className="grid grid-cols-3 gap-1.5">
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
    );
  }
  return (
    <div className="rounded-2xl px-3.5 py-3" style={{ background: C.soft }}>
      <div className="mb-2.5 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">
          {formatMonthDay(dateKey)} {DOW[info.dow]}요일
        </span>
        <DayKindBadge info={info} />
      </div>
      {body}
    </div>
  );
}

/* ───────── 설정 ───────── */

function SettingsSheet({
  onClose,
  onShareApp,
  onOpenHoliday,
  onOpenRules,
  onOpenBasis,
  onResetRecords,
  onResetLedger,
  onResetAll,
}: {
  onClose: () => void;
  onShareApp: () => void;
  onOpenHoliday: () => void;
  onOpenRules: () => void;
  onOpenBasis: () => void;
  onResetRecords: () => void;
  onResetLedger: () => void;
  onResetAll: () => void;
}) {
  const row = "flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left text-[15px] transition hover:bg-slate-50";
  return (
    <Sheet title="설정" onClose={onClose}>
      <div className="divide-y overflow-hidden rounded-2xl border">
        {(
          [
            ["휴일 설정", onOpenHoliday, null],
            ["계산 규칙", onOpenRules, null],
            ["계산 근거", onOpenBasis, "공식 규정 · 2026.10. 개정"],
          ] as const
        ).map(([title, onClick, note]) => (
          <button key={title} onClick={onClick} className={`${row} font-semibold`}>
            {title}
            <span className="flex min-w-0 items-center gap-1" style={{ color: C.faint }}>
              {note && (
                <span className="truncate text-[12px] font-medium" style={{ color: C.muted }}>
                  {note}
                </span>
              )}
              <ChevronIcon dir="right" />
            </span>
          </button>
        ))}
      </div>
      <div>
        <div className="mb-1 px-1 text-[13px] font-medium" style={{ color: C.muted }}>
          데이터 초기화
        </div>
        <div className="divide-y overflow-hidden rounded-2xl border">
          <button onClick={onResetRecords} className={row} style={{ color: "#b91c1c" }}>
            근무 내역 초기화
          </button>
          <button onClick={onResetLedger} className={row} style={{ color: "#b91c1c" }}>
            식사 내역 초기화
          </button>
          <button onClick={onResetAll} className={`${row} font-bold`} style={{ color: C.danger }}>
            전체 초기화
          </button>
        </div>
      </div>
      <AppInfo onShare={onShareApp} />
    </Sheet>
  );
}

/** 앱 이름·버전·개발·문의·주소 (주소를 누르면 공유 또는 복사) */
function AppInfo({ onShare }: { onShare: () => void }) {
  const { name, version, developer, office, email, github, url } = APP_INFO;
  const link = "underline-offset-2 hover:underline";
  return (
    <footer className="space-y-0.5 pt-3 pb-1 text-center text-[12px] leading-relaxed" style={{ color: C.muted }}>
      <p className="flex items-center justify-center gap-1.5">
        <img src={logoUrl} alt="" width={18} height={18} className="size-[18px] rounded-[5px]" />
        <span>
          <b className="font-semibold" style={{ color: "var(--text)" }}>
            {name}
          </b>{" "}
          · 버전 {version}
        </span>
      </p>
      <p>
        <span className="inline-block">개발 {developer}</span> · <span className="inline-block">{office}</span>
      </p>
      <p>
        <span className="inline-block">
          문의{" "}
          <a href={`mailto:${email}`} className={link}>
            {email}
          </a>
        </span>{" "}
        ·{" "}
        <span className="inline-block">
          GitHub{" "}
          <a href={`https://github.com/${github}`} target="_blank" rel="noreferrer" className={link}>
            {github}
          </a>
        </span>
      </p>
      <p>
        주소{" "}
        <button
          type="button"
          onClick={onShare}
          title="공유하거나 복사하기"
          className="font-semibold underline decoration-dotted underline-offset-2"
          style={{ color: C.navy }}
        >
          {url.replace("https://", "")}
        </button>
      </p>
    </footer>
  );
}

/* ───────── 계산 근거 ───────── */

/**
 * 기본 계산 규칙(rules.ts의 DEFAULT_RULES)의 출처.
 * 규정이 바뀌어 기본값을 고칠 때 여기 설명도 함께 고쳐 주세요.
 */
const BASIS_SOURCES = [
  {
    key: "수당규정",
    name: "「지방공무원 수당 등에 관한 규정」 제15조",
    note: "2026. 10. 1. 개정 시행: 1일 4시간 상한 삭제, 월 57시간 상한 유지",
  },
  {
    key: "처리지침",
    name: "「지방공무원 보수업무 등 처리지침」 제5장 Ⅵ. 초과근무수당",
    note: "시간외근무시간 산정방법 (2026. 10. 1. 개정: 이틀에 걸친 근무는 1회 공제)",
  },
  {
    key: "운영시간",
    name: "관악구 초과근무 제도개선 안내 (2026. 10. 2.)",
    note: "초과근무 운영시간, 8시간 이상 근무 시 예외(국·소장 결재)",
  },
  {
    key: "급량비",
    name: "기관 급량비 운영 기준",
    note: "1개 금액과 월 개수는 계산 규칙에서 기관 기준에 맞게 바꿀 수 있어요",
  },
] as const;

type BasisKey = (typeof BASIS_SOURCES)[number]["key"];

/** 2026년 10월 개정사항과 앱에 반영한 내용 */
const BASIS_CHANGES: [string, string][] = [
  ["1일 4시간 상한 폐지", "10월 기록부터 하루 상한 없이 계산해요. 9월까지 기록은 4시간 상한 그대로예요."],
  ["이틀에 걸친 연속 근무", "시작한 날 기준으로 1시간만 공제해요."],
  ["초과근무 운영시간", "평일 06:00~23:00, 휴일 07:00~22:00 밖의 근무는 빼요. 그날 8시간 이상이면 예외예요."],
];

/** 항목별 계산 기준과 근거 */
const BASIS_ITEMS: [string, string, BasisKey][] = [
  ["인정 조건", "하루 1시간 이상 근무한 날만 인정 (평일은 공제 전 기준)", "처리지침"],
  ["평일", "09시 전 + 18시 후 근무에서 1시간 공제, 분 단위까지 합산", "처리지침"],
  ["토요일·휴일", "공제 없이 근무 전체를 분 단위까지 합산", "처리지침"],
  ["월 합계", "1시간 미만(분 단위)은 버림", "처리지침"],
  ["월 상한", "57시간 (기본 10시간 포함, 실적은 최대 47시간)", "수당규정"],
  ["운영시간", "평일 06~23시, 휴일 07~22시 (2026년 10월부터)", "운영시간"],
  ["급량비", "1개 9,000원, 월 20개까지. 평일은 정규 근무 전·후 각 1시간 이상이면 1개씩", "급량비"],
];

function BasisSheet({ onClose, onOpenRules }: { onClose: () => void; onOpenRules: () => void }) {
  const groupLabel = "mb-1.5 px-1 text-[13px] font-medium";
  return (
    <Sheet title="계산 근거" onClose={onClose}>
      <div className="rounded-2xl px-4 py-3.5" style={{ background: "var(--navy-soft)" }}>
        <p className="text-[15px] font-bold" style={{ color: C.navy }}>
          공식 규정을 바탕으로 계산해요
        </p>
        <p className="mt-1 text-[13px] leading-relaxed" style={{ color: "#334155" }}>
          「지방공무원 수당 등에 관한 규정」과 「지방공무원 보수업무 등 처리지침」(2026. 10. 1. 개정 시행),
          관악구 초과근무 제도개선 안내(2026. 10. 2.)를 계산 규칙의 기본값으로 넣었어요.
        </p>
      </div>

      <div>
        <div className={groupLabel} style={{ color: C.muted }}>
          2026년 10월 개정사항 반영
        </div>
        <ul className="divide-y rounded-2xl border">
          {BASIS_CHANGES.map(([title, text]) => (
            <li key={title} className="flex gap-2.5 px-3.5 py-3">
              <span className="mt-0.5 shrink-0" style={{ color: C.meal }}>
                <CheckIcon size={16} />
              </span>
              <span className="min-w-0">
                <span className="block text-[14px] font-semibold">{title}</span>
                <span className="mt-0.5 block text-[13px] leading-snug" style={{ color: "#475569" }}>
                  {text}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className={groupLabel} style={{ color: C.muted }}>
          항목별 기준
        </div>
        <ul className="divide-y rounded-2xl border">
          {BASIS_ITEMS.map(([title, rule, source]) => (
            <li key={title} className="grid grid-cols-[4.75rem_1fr] gap-2 px-3.5 py-2.5 text-[13px]">
              <span className="font-semibold">{title}</span>
              <span className="min-w-0 leading-snug" style={{ color: "#334155" }}>
                {rule}
                <span
                  className="ml-1.5 inline-block rounded-md px-1.5 py-px align-[1px] text-[11px] font-semibold whitespace-nowrap"
                  style={{ background: C.soft, color: C.muted }}
                >
                  {source}
                </span>
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className={groupLabel} style={{ color: C.muted }}>
          근거 규정
        </div>
        <ol className="space-y-2.5 rounded-2xl border px-3.5 py-3">
          {BASIS_SOURCES.map((s) => (
            <li key={s.key} className="text-[13px] leading-snug">
              <span
                className="mr-1.5 inline-block rounded-md px-1.5 py-px align-[1px] text-[11px] font-semibold"
                style={{ background: C.soft, color: C.muted }}
              >
                {s.key}
              </span>
              <span className="font-semibold">{s.name}</span>
              <span className="mt-0.5 block" style={{ color: C.muted }}>
                {s.note}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <p className="px-1 text-[12px] leading-relaxed" style={{ color: C.muted }}>
        참고용 계산이에요. 실제 인정 시간은 인사랑 근무기록과 결재를 따르고, 개인용무시간 제외와 월 상한
        예외(현안·재난 업무)는 반영하지 않아요.
      </p>

      <button
        onClick={onOpenRules}
        className="flex w-full items-center justify-center gap-1 rounded-2xl border py-3 text-[14px] font-semibold transition hover:bg-slate-50"
        style={{ color: C.navy }}
      >
        계산 규칙 보기
        <ChevronIcon dir="right" size={16} />
      </button>
    </Sheet>
  );
}

/* ───────── 계산 규칙 ───────── */

/** 숫자만 받는 작은 입력칸. nullable이면 비울 때 null(사용 안 함) */
function NumField({
  label,
  value,
  onChange,
  unit,
  nullable,
  money,
  placeholder,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  unit: string;
  nullable?: boolean;
  money?: boolean;
  placeholder?: string;
}) {
  const text =
    value === null || Number.isNaN(value) ? "" : money ? value.toLocaleString("ko-KR") : String(value);
  return (
    <span className="flex items-center gap-1.5">
      <input
        type="text"
        inputMode="numeric"
        aria-label={label}
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          const digits = e.target.value.replace(/[^0-9]/g, "").slice(0, 7);
          onChange(digits === "" ? (nullable ? null : NaN) : Number(digits));
        }}
        className={`${money ? "w-24" : "w-16"} rounded-lg border px-2.5 py-2 text-right text-sm tabular-nums`}
        style={{ background: "#f8fafc" }}
      />
      <span className="w-7 text-xs" style={{ color: C.muted }}>
        {unit}
      </span>
    </span>
  );
}

function RuleRow({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="text-[14px]">{label}</div>
        {help && (
          <div className="mt-0.5 text-[12px] leading-snug" style={{ color: C.muted }}>
            {help}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** 시작~종료 시각 두 칸 (정규 근무, 운영시간) */
function TimeRangeRow({
  label,
  help,
  start,
  end,
  onStart,
  onEnd,
  startLabel,
  endLabel,
}: {
  label: string;
  help?: string;
  start: string;
  end: string;
  onStart: (v: string) => void;
  onEnd: (v: string) => void;
  startLabel: string;
  endLabel: string;
}) {
  const input = "w-full min-w-0 rounded-lg border px-2.5 py-2 text-sm tabular-nums";
  return (
    <div className="px-3.5 py-2.5">
      <div className="text-[14px]">{label}</div>
      {help && (
        <div className="mt-0.5 text-[12px] leading-snug" style={{ color: C.muted }}>
          {help}
        </div>
      )}
      <div className="mt-2 grid grid-cols-[1fr_auto_1fr] items-center gap-2">
        <input
          type="time"
          aria-label={startLabel}
          value={start}
          onChange={(e) => onStart(e.target.value)}
          className={input}
          style={{ background: "#f8fafc" }}
        />
        <span style={{ color: C.muted }}>~</span>
        <input
          type="time"
          aria-label={endLabel}
          value={end}
          onChange={(e) => onEnd(e.target.value)}
          className={input}
          style={{ background: "#f8fafc" }}
        />
      </div>
    </div>
  );
}

function RuleCheck({
  label,
  help,
  checked,
  onChange,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <span className="min-w-0">
        <span className="block text-[14px]">{label}</span>
        {help && (
          <span className="mt-0.5 block text-[12px] leading-snug" style={{ color: C.muted }}>
            {help}
          </span>
        )}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mr-9 size-5 shrink-0 accent-[#1e3a8a]"
      />
    </label>
  );
}

function RulesSheet({
  rules,
  currentMonth,
  onClose,
  onSave,
}: {
  rules: Rules[];
  currentMonth: string;
  onClose: () => void;
  onSave: (next: Rules[]) => void;
}) {
  const ask = useConfirm();
  const [list, setList] = useState<Rules[]>(() => sortRules(rules));
  const [selFrom, setSelFrom] = useState(() => rulesFor(sortRules(rules), currentMonth).from);
  const [adding, setAdding] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [cy, cm] = currentMonth.split("-").map(Number);
  const [newYear, setNewYear] = useState(cm === 12 ? cy + 1 : cy);
  const [newMonth, setNewMonth] = useState(cm === 12 ? 1 : cm + 1);

  const sel = list.find((r) => r.from === selFrom) ?? list[list.length - 1];
  const idx = list.indexOf(sel);
  const currentFrom = rulesFor(list, currentMonth).from;
  const nextFrom = list[idx + 1]?.from;
  const until = nextFrom ? monthTitle(shiftMonth(nextFrom, -1)) : null;
  const dirty = !sameRules(list, rules);
  const problems = list.flatMap((r) => validateRules(r).map((m) => `${rulesLabel(r)} 규칙: ${m}`));
  /** 설명은 '?'를 눌렀을 때만 */
  const help = (text: string) => (showHelp ? text : undefined);
  const otMax =
    Number.isFinite(sel.monthlyLimitHours) && Number.isFinite(sel.fixedMonthlyHours)
      ? String(Math.max(0, sel.monthlyLimitHours - sel.fixedMonthlyHours))
      : "–";

  function patch(p: Partial<Rules>) {
    setList((l) => l.map((r) => (r.from === sel.from ? { ...r, ...p } : r)));
  }

  function addVersion() {
    const from = `${newYear}-${pad(newMonth)}`;
    if (!list.some((r) => r.from === from)) {
      setList(sortRules([...list, { ...rulesFor(list, from), from }]));
    }
    setSelFrom(from);
    setAdding(false);
  }

  // 확인창이 떠 있는 동안에는 다른 조작을 할 수 없어서, 확인 뒤에도 list는 그대로임
  async function removeVersion() {
    if (sel.from === FIRST_FROM) return;
    const from = sel.from;
    const ok = await ask({
      title: `${rulesLabel(sel)} 규칙을 지울까요?`,
      message: "그 기간 기록은 바로 앞 규칙으로 계산돼요.",
      confirmText: "삭제",
      danger: true,
    });
    if (!ok) return;
    const next = list.filter((r) => r.from !== from);
    setList(next);
    setSelFrom(rulesFor(next, currentMonth).from);
  }

  async function resetDefaults() {
    const ok = await ask({
      title: "계산 규칙을 기본값으로 되돌릴까요?",
      message: "'저장'을 눌러야 적용돼요.",
      confirmText: "되돌리기",
    });
    if (!ok) return;
    setList(DEFAULT_RULES);
    setSelFrom(rulesFor(DEFAULT_RULES, currentMonth).from);
  }

  async function close() {
    if (dirty) {
      const ok = await ask({
        title: "저장하지 않고 닫을까요?",
        message: "바꾼 내용이 사라져요.",
        confirmText: "닫기",
      });
      if (!ok) return;
    }
    onClose();
  }

  const minutesToHours = (m: number | null) => (m === null ? null : m / 60);
  const hoursToMinutes = (h: number | null) => (h === null ? null : h * 60);
  const years = Array.from({ length: 7 }, (_, i) => cy - 2 + i);
  const selectClass = "rounded-lg border bg-white px-2 py-1.5 text-sm";
  const group = "divide-y rounded-2xl border";
  const groupLabel = "mb-1 px-1 text-[13px] font-medium";

  return (
    <Sheet
      title="계산 규칙"
      onClose={close}
      action={
        <IconButton
          label={showHelp ? "설명 숨기기" : "설명 보기"}
          pressed={showHelp}
          onClick={() => setShowHelp((v) => !v)}
        >
          <HelpIcon />
        </IconButton>
      }
    >
      <div className="flex flex-wrap gap-1.5">
        {list.map((r) => {
          const active = r.from === sel.from;
          return (
            <button
              key={r.from}
              onClick={() => setSelFrom(r.from)}
              aria-pressed={active}
              className="rounded-full border px-3 py-1.5 text-xs font-semibold transition hover:brightness-95"
              style={
                active
                  ? { background: C.navy, color: "white", borderColor: C.navy }
                  : { background: "white", color: "#334155" }
              }
            >
              {rulesLabel(r)}
              {r.from === currentFrom ? " · 지금" : ""}
            </button>
          );
        })}
        <button
          onClick={() => setAdding((a) => !a)}
          aria-expanded={adding}
          className="rounded-full border border-dashed px-3 py-1.5 text-xs font-semibold transition hover:bg-slate-50"
          style={{ color: C.navy, borderColor: "var(--navy-line)" }}
        >
          + 새 규칙
        </button>
      </div>

      {adding && (
        <div
          className="flex flex-wrap items-center gap-1.5 rounded-2xl px-3.5 py-3 text-sm"
          style={{ background: C.soft }}
        >
          <select
            aria-label="시행 연도"
            value={newYear}
            onChange={(e) => setNewYear(Number(e.target.value))}
            className={selectClass}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          년
          <select
            aria-label="시행 월"
            value={newMonth}
            onChange={(e) => setNewMonth(Number(e.target.value))}
            className={selectClass}
          >
            {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          월부터
          <button
            onClick={addVersion}
            className="ml-auto rounded-lg px-3.5 py-2 text-xs font-semibold text-white transition hover:brightness-125"
            style={{ background: C.navy }}
          >
            추가
          </button>
        </div>
      )}

      {until && (
        <p className="-mt-2 px-1 text-[13px]" style={{ color: C.muted }}>
          {until}까지 적용
        </p>
      )}

      <div>
        <div className={groupLabel} style={{ color: C.muted }}>
          초과근무
        </div>
        <div className={group}>
          <TimeRangeRow
            label="평일 정규 근무"
            help={help("이 시간 전과 후의 근무가 초과근무예요")}
            start={sel.workStart}
            end={sel.workEnd}
            onStart={(v) => patch({ workStart: v })}
            onEnd={(v) => patch({ workEnd: v })}
            startLabel="정규 근무 시작"
            endLabel="정규 근무 종료"
          />
          <RuleCheck
            label="운영시간 적용"
            help={help("운영시간 밖 근무는 초과근무로 치지 않아요")}
            checked={sel.windowEnabled}
            onChange={(v) => patch({ windowEnabled: v })}
          />
          {sel.windowEnabled && (
            <>
              <TimeRangeRow
                label="평일 운영시간"
                start={sel.weekdayWindowStart}
                end={sel.weekdayWindowEnd}
                onStart={(v) => patch({ weekdayWindowStart: v })}
                onEnd={(v) => patch({ weekdayWindowEnd: v })}
                startLabel="평일 운영 시작"
                endLabel="평일 운영 종료"
              />
              <TimeRangeRow
                label="휴일 운영시간"
                start={sel.holidayWindowStart}
                end={sel.holidayWindowEnd}
                onStart={(v) => patch({ holidayWindowStart: v })}
                onEnd={(v) => patch({ holidayWindowEnd: v })}
                startLabel="휴일 운영 시작"
                endLabel="휴일 운영 종료"
              />
              <RuleRow
                label="운영시간 예외 기준"
                help={help("그 날 초과근무(공제 전)가 이 시간 이상이면 운영시간 밖도 인정 (국·소장 결재). 비우면 예외 없음")}
              >
                <NumField
                  label="운영시간 예외 기준"
                  value={minutesToHours(sel.windowExemptMinutes)}
                  onChange={(v) => patch({ windowExemptMinutes: hoursToMinutes(v) })}
                  unit="시간"
                  nullable
                  placeholder="없음"
                />
              </RuleRow>
            </>
          )}
          <RuleRow label="평일 공제" help={help("평일 초과근무에서 빼는 시간")}>
            <NumField label="평일 공제" value={sel.deductMinutes} onChange={(v) => patch({ deductMinutes: v ?? NaN })} unit="분" />
          </RuleRow>
          <RuleRow label="하루 최소" help={help("하루 초과근무가 이보다 짧으면 인정하지 않아요 (평일은 공제 전 기준)")}>
            <NumField label="하루 최소 인정" value={sel.minDailyMinutes} onChange={(v) => patch({ minDailyMinutes: v ?? NaN })} unit="분" />
          </RuleRow>
          <RuleRow label="평일 하루 상한" help={help("비우면 상한 없음")}>
            <NumField
              label="평일 하루 상한"
              value={minutesToHours(sel.weekdayCapMinutes)}
              onChange={(v) => patch({ weekdayCapMinutes: hoursToMinutes(v) })}
              unit="시간"
              nullable
              placeholder="없음"
            />
          </RuleRow>
          <RuleRow label="휴일 하루 상한" help={help("비우면 상한 없음")}>
            <NumField
              label="휴일 하루 상한"
              value={minutesToHours(sel.holidayCapMinutes)}
              onChange={(v) => patch({ holidayCapMinutes: hoursToMinutes(v) })}
              unit="시간"
              nullable
              placeholder="없음"
            />
          </RuleRow>
          <RuleRow label="월 상한" help={help("기본 초과근무를 포함한 한 달 최대")}>
            <NumField label="월 상한" value={sel.monthlyLimitHours} onChange={(v) => patch({ monthlyLimitHours: v ?? NaN })} unit="시간" />
          </RuleRow>
          <RuleRow label="기본 초과근무" help={help("기록과 상관없이 매달 받는 시간 (정액분)")}>
            <NumField label="기본 초과근무" value={sel.fixedMonthlyHours} onChange={(v) => patch({ fixedMonthlyHours: v ?? NaN })} unit="시간" />
          </RuleRow>
          <RuleRow label="실적 최대" help={help("월 상한 − 기본 초과근무")}>
            <span className="flex items-center gap-1.5">
              <span
                id="rule-ot-max"
                className="w-16 px-2.5 text-right text-sm font-bold tabular-nums"
                style={{ color: C.overtime }}
              >
                {otMax}
              </span>
              <span className="w-7 text-xs" style={{ color: C.muted }}>
                시간
              </span>
            </span>
          </RuleRow>
          <RuleCheck
            label="월 합계 분 단위 버림"
            help={help("한 달 실적에서 1시간 미만은 버려요")}
            checked={sel.monthlyRoundDown}
            onChange={(v) => patch({ monthlyRoundDown: v })}
          />
        </div>
      </div>

      <div>
        <div className={groupLabel} style={{ color: C.muted }}>
          급량비
        </div>
        <div className={group}>
          <RuleRow label="1개 금액">
            <NumField label="급량비 1개 금액" value={sel.mealPrice} onChange={(v) => patch({ mealPrice: v ?? NaN })} unit="원" money />
          </RuleRow>
          <RuleRow label="한 달 최대">
            <NumField label="급량비 한 달 최대" value={sel.mealMonthlyCap} onChange={(v) => patch({ mealMonthlyCap: v ?? NaN })} unit="개" />
          </RuleRow>
          <RuleRow label="평일 기준" help={help("정규 시간 전·후 근무가 각각 이 시간 이상이면 1개씩")}>
            <NumField label="평일 급량비 기준" value={sel.weekdayMealMinutes} onChange={(v) => patch({ weekdayMealMinutes: v ?? NaN })} unit="분" />
          </RuleRow>
          <RuleCheck
            label="평일 전·후 합산"
            help={help("둘 다 모자라도 합쳐서 기준 이상이면 1개")}
            checked={sel.weekdayMealCombined}
            onChange={(v) => patch({ weekdayMealCombined: v })}
          />
          <RuleRow label="평일 하루 최대">
            <NumField label="평일 하루 최대" value={sel.weekdayMealMax} onChange={(v) => patch({ weekdayMealMax: v ?? NaN })} unit="개" />
          </RuleRow>
          <RuleRow label="휴일 1개 기준" help={help("근무가 이 시간을 넘으면 1개")}>
            <NumField label="휴일 급량비 기준" value={sel.holidayMealMinutes} onChange={(v) => patch({ holidayMealMinutes: v ?? NaN })} unit="분" />
          </RuleRow>
          <RuleRow label="휴일 2개 기준" help={help("근무가 이 시간을 넘으면 2개, 비우면 사용 안 함")}>
            <NumField
              label="휴일 2개 기준"
              value={sel.holidaySecondMealMinutes}
              onChange={(v) => patch({ holidaySecondMealMinutes: v })}
              unit="분"
              nullable
              placeholder="없음"
            />
          </RuleRow>
        </div>
      </div>

      {sel.from !== FIRST_FROM && (
        <button
          onClick={removeVersion}
          className="w-full rounded-2xl border py-3 text-sm font-semibold transition hover:bg-red-50"
          style={{ color: "#b91c1c" }}
        >
          이 규칙 삭제
        </button>
      )}

      <div
        className="sticky -mx-5 border-t bg-white px-5 pt-3"
        style={{
          bottom: "calc(-1 * max(1.25rem, env(safe-area-inset-bottom)))",
          paddingBottom: "max(1.25rem, env(safe-area-inset-bottom))",
        }}
      >
        {problems.length > 0 && (
          <p className="mb-2 text-xs" style={{ color: "#b91c1c" }}>
            {problems[0]}
          </p>
        )}
        <div className="flex gap-2">
          <button
            onClick={resetDefaults}
            className="rounded-2xl border px-4 py-3 text-sm font-semibold transition hover:bg-slate-50"
          >
            기본값으로
          </button>
          <button
            onClick={() => onSave(list)}
            disabled={!dirty || problems.length > 0}
            className="flex-1 rounded-2xl py-3 text-base font-bold text-white transition enabled:hover:brightness-125 disabled:opacity-40"
            style={{ background: C.navy }}
          >
            저장
          </button>
        </div>
      </div>
    </Sheet>
  );
}

/* ───────── 작은 부품 ───────── */

/** 둘 중 하나를 고르는 버튼 묶음. tabs면 탭 목록(role=tablist)으로 동작 */
function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
  tabs,
  small,
  activeStyle,
}: {
  label: string;
  options: readonly (readonly [T, ReactNode])[];
  value: T;
  onChange: (v: T) => void;
  tabs?: boolean;
  small?: boolean;
  /** 선택된 칸의 색 (없으면 흰 바탕) */
  activeStyle?: (v: T) => { background: string; color: string } | undefined;
}) {
  return (
    <div
      role={tabs ? "tablist" : "group"}
      aria-label={label}
      className={`grid auto-cols-fr grid-flow-col gap-1 ${small ? "rounded-[10px] p-[3px]" : "rounded-xl p-1"}`}
      style={{ background: tabs ? "#e5eaf1" : C.soft }}
    >
      {options.map(([key, text]) => {
        const active = key === value;
        const on = activeStyle?.(key) ?? { background: "white", color: "var(--text)" };
        return (
          <button
            key={key}
            type="button"
            role={tabs ? "tab" : undefined}
            aria-selected={tabs ? active : undefined}
            aria-pressed={tabs ? undefined : active}
            onClick={() => onChange(key)}
            className={`font-semibold whitespace-nowrap transition ${small ? "rounded-[7px] px-3 py-1 text-[12px]" : "rounded-lg py-2 text-[14px]"}`}
            style={{
              background: active ? on.background : "transparent",
              color: active ? on.color : C.muted,
              boxShadow: active ? "0 1px 2px rgba(15,23,42,0.08)" : "none",
            }}
          >
            {text}
          </button>
        );
      })}
    </div>
  );
}

/** 체크박스를 알약 모양으로 */
function ToggleChip({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: ReactNode;
}) {
  return (
    <label
      className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1.5 text-[13px] font-semibold transition"
      style={
        checked
          ? { background: "var(--navy-soft)", borderColor: "var(--navy-line)", color: C.navy }
          : { background: "white", color: C.muted }
      }
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="size-4 accent-[#1e3a8a]"
      />
      {children}
    </label>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  color = C.navy,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="w-full rounded-2xl py-3.5 text-base font-bold text-white transition enabled:hover:brightness-125 active:scale-[0.98] disabled:opacity-40"
      style={{ background: color }}
    >
      {children}
    </button>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  onDark,
  pressed,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  /** 남색 바탕 위 (헤더) */
  onDark?: boolean;
  /** 켜고 끄는 버튼이면 켜진 상태 */
  pressed?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={`grid size-10 shrink-0 place-items-center rounded-xl transition disabled:opacity-25 ${
        onDark
          ? "text-white enabled:hover:bg-white/10 enabled:active:bg-white/20"
          : "enabled:hover:bg-slate-200/60 enabled:active:bg-slate-200"
      }`}
      style={pressed ? { background: "var(--navy-soft)", color: C.navy } : undefined}
    >
      {children}
    </button>
  );
}

/* ───────── 아이콘 ───────── */

function ChevronIcon({ dir, size = 20 }: { dir: "left" | "right" | "up" | "down"; size?: number }) {
  const d = { left: "M15 18l-6-6 6-6", right: "M9 18l6-6-6-6", up: "M6 15l6-6 6 6", down: "M6 9l6 6 6-6" }[dir];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
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
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2.5" />
      <path d="M3 10h18M8 3v4M16 3v4" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.27 4.8 10.35 2.54 13.65 2.54 13.73 4.8 15.87 5.69 17.52 4.15 19.85 6.48 18.31 8.13 19.2 10.27 21.46 10.35 21.46 13.65 19.2 13.73 18.31 15.87 19.85 17.52 17.52 19.85 15.87 18.31 13.73 19.2 13.65 21.46 10.35 21.46 10.27 19.2 8.13 18.31 6.48 19.85 4.15 17.52 5.69 15.87 4.8 13.73 2.54 13.65 2.54 10.35 4.8 10.27 5.69 8.13 4.15 6.48 6.48 4.15 8.13 5.69Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function CheckIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" />
      <path d="M9.4 9.3a2.7 2.7 0 0 1 5.2.9c0 1.8-2.6 2.3-2.6 3.9" />
      <circle cx="12" cy="17.3" r="0.4" fill="currentColor" />
    </svg>
  );
}

/** 출근: 해 */
function SunIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" fill="#fcd34d" />
      <path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
    </svg>
  );
}

/** 퇴근·초과근무: 달 (앱 아이콘의 초승달) */
function MoonIcon({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.6 14.6A8.6 8.6 0 0 1 9.4 3.4a8.6 8.6 0 1 0 11.2 11.2Z" fill="currentColor" />
    </svg>
  );
}

/** 급량비: 밥그릇 (앱 아이콘의 밥그릇) */
function BowlIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.6 7.6C3.6 4.9 5.6 3.1 8 3.1s4.4 1.8 4.4 4.5Z" fill="currentColor" opacity="0.38" />
      <path d="M1.4 7.6h13.2c0 3.4-2.9 6-6.6 6s-6.6-2.6-6.6-6Z" fill="currentColor" />
      <path d="M6.1 13.3h3.8l-.5 1.6H6.6Z" fill="currentColor" />
    </svg>
  );
}
