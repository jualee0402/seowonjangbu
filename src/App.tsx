import { useEffect, useMemo, useState } from "react";

type WorkRecord = {
  id: string;
  clockIn: string;
  clockOut: string | null;
};

type LedgerEntry = {
  id: string;
  date: string;
  amount: number;
  memo?: string;
  type?: "ledger" | "personal";
};

const RECORDS_KEY = "seowon_work_records_v1";
const LEDGER_KEY = "seowon_ledger_entries_v1";
const MEAL_PRICE = 9000;
const MEAL_MONTHLY_CAP = 20;

function loadRecords(): WorkRecord[] {
  try {
    const raw = localStorage.getItem(RECORDS_KEY);
    return raw ? (JSON.parse(raw) as WorkRecord[]) : [];
  } catch {
    return [];
  }
}

function saveRecords(records: WorkRecord[]) {
  localStorage.setItem(RECORDS_KEY, JSON.stringify(records));
}

function loadLedger(): LedgerEntry[] {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    return raw ? (JSON.parse(raw) as LedgerEntry[]) : [];
  } catch {
    return [];
  }
}

function saveLedger(entries: LedgerEntry[]) {
  localStorage.setItem(LEDGER_KEY, JSON.stringify(entries));
}

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function pad(n: number) {
  return n.toString().padStart(2, "0");
}

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

function formatFullDate(d: Date) {
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 (${DOW[d.getDay()]})`;
}

function combineDateTime(dateStr: string, hhmm: string): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  const [y, mo, day] = dateStr.split("-").map(Number);
  if (!y || !mo || !day) return null;
  const d = new Date(y, mo - 1, day, h, mm, 0, 0);
  return d.toISOString();
}

function isWeekend(date: Date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function isSameMonth(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

function formatHours(hours: number) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

function formatWon(n: number) {
  return n.toLocaleString("ko-KR") + "원";
}

type ComputedRecord = {
  record: WorkRecord;
  workedHours: number;
  overtimeHours: number;
  meals: number;
  weekend: boolean;
  date: Date;
};

const DAILY_MAX_OVERTIME = 4;

function overlapHours(startMs: number, endMs: number, winStart: number, winEnd: number) {
  const s = Math.max(startMs, winStart);
  const e = Math.min(endMs, winEnd);
  return Math.max(0, (e - s) / (1000 * 60 * 60));
}

function computeRecord(record: WorkRecord): ComputedRecord | null {
  if (!record.clockOut) return null;
  const start = new Date(record.clockIn);
  const end = new Date(record.clockOut);
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) {
    return {
      record,
      workedHours: 0,
      overtimeHours: 0,
      meals: 0,
      weekend: isWeekend(start),
      date: start,
    };
  }
  const workedHours = ms / (1000 * 60 * 60);
  const weekend = isWeekend(start);
  let overtimeHours = 0;
  let meals = 0;
  if (weekend) {
    overtimeHours = Math.min(workedHours, DAILY_MAX_OVERTIME);
    // 휴일 급량비: 초과근무 60분 초과 시 1개 (하루 최대 1개)
    if (workedHours > 1) meals = 1;
  } else {
    // Use the clock-in date as the reference day for the 09:00 / 18:00 windows
    const dayStart = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    const nineAm = new Date(dayStart).setHours(9, 0, 0, 0);
    const sixPm = new Date(dayStart).setHours(18, 0, 0, 0);
    const startMs = start.getTime();
    const endMs = end.getTime();
    const morning = overlapHours(startMs, endMs, startMs, nineAm); // before 9am within work span
    const evening = overlapHours(startMs, endMs, sixPm, endMs); // after 6pm within work span
    const eligible = morning + evening;
    const afterDeduction = Math.max(0, eligible - 1);
    overtimeHours = Math.min(afterDeduction, DAILY_MAX_OVERTIME);
    // 평일 급량비 (차감 없는 원시 시간 기준):
    // 오전(>=1) → 1개, 오후(>=1) → 1개, 둘 다 안되더라도 합산이 1시간 이상이면 1개
    let mealCount = 0;
    if (morning >= 1) mealCount += 1;
    if (evening >= 1) mealCount += 1;
    if (mealCount === 0 && eligible >= 1) mealCount = 1;
    meals = Math.min(mealCount, 2);
  }
  return { record, workedHours, overtimeHours, meals, weekend, date: start };
}

export default function App() {
  const [records, setRecords] = useState<WorkRecord[]>(() => loadRecords());
  const [ledger, setLedger] = useState<LedgerEntry[]>(() => loadLedger());
  const [now, setNow] = useState(new Date());
  const [ledgerDate, setLedgerDate] = useState(todayStr());
  const [ledgerAmount, setLedgerAmount] = useState("");
  const [ledgerMemo, setLedgerMemo] = useState("");
  const [ledgerType, setLedgerType] = useState<"ledger" | "personal">("ledger");
  const [tab, setTab] = useState<"home" | "history" | "ledger">("home");
  const [toast, setToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualDate, setManualDate] = useState(todayStr());
  const [manualIn, setManualIn] = useState("09:00");
  const [manualOut, setManualOut] = useState("19:00");

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000 * 30);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const openRecord = useMemo(
    () => records.find((r) => !r.clockOut) ?? null,
    [records],
  );

  const computed = useMemo(() => {
    return records
      .map(computeRecord)
      .filter((r): r is ComputedRecord => r !== null)
      .sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [records]);

  const monthly = useMemo(() => {
    const ref = new Date();
    let totalOvertimeHours = 0;
    let weekdayMeals = 0;
    let weekendMeals = 0;
    for (const c of computed) {
      if (!isSameMonth(c.date, ref)) continue;
      totalOvertimeHours += c.overtimeHours;
      if (c.weekend) weekendMeals += c.meals;
      else weekdayMeals += c.meals;
    }
    const rawTotalMeals = weekdayMeals + weekendMeals;
    const totalMeals = Math.min(rawTotalMeals, MEAL_MONTHLY_CAP);
    const mealAmount = totalMeals * MEAL_PRICE;
    const capped = rawTotalMeals >= MEAL_MONTHLY_CAP;
    const monthlyEntries = ledger.filter((e) =>
      isSameMonth(new Date(e.date), ref),
    );
    const monthlyLedger = monthlyEntries
      .filter((e) => (e.type ?? "ledger") === "ledger")
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const monthlyPersonal = monthlyEntries
      .filter((e) => e.type === "personal")
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    return {
      totalOvertimeHours,
      weekdayMeals,
      weekendMeals,
      rawTotalMeals,
      totalMeals,
      mealAmount,
      capped,
      monthlyLedger,
      monthlyPersonal,
      balance: mealAmount - monthlyLedger,
    };
  }, [computed, ledger]);

  function clockIn() {
    if (openRecord) {
      setToast("이미 출근 기록이 있어요. 먼저 퇴근을 기록해 주세요.");
      return;
    }
    const next: WorkRecord = {
      id: uid(),
      clockIn: new Date().toISOString(),
      clockOut: null,
    };
    const newRecords = [...records, next];
    setRecords(newRecords);
    saveRecords(newRecords);
    setToast(`출근 기록 ${formatTime(next.clockIn)}`);
  }

  function clockOut() {
    if (!openRecord) {
      setToast("출근 기록이 없어요. 먼저 출근을 기록해 주세요.");
      return;
    }
    const updated = records.map((r) =>
      r.id === openRecord.id ? { ...r, clockOut: new Date().toISOString() } : r,
    );
    setRecords(updated);
    saveRecords(updated);
    setToast(`퇴근 기록 ${formatTime(new Date().toISOString())}`);
  }

  function addManualRecord() {
    const inIso = combineDateTime(manualDate, manualIn);
    const outIso = combineDateTime(manualDate, manualOut);
    if (!inIso || !outIso) {
      setToast("시간 형식을 확인해 주세요. (예: 09:00)");
      return;
    }
    if (new Date(outIso).getTime() <= new Date(inIso).getTime()) {
      setToast("퇴근 시간은 출근 시간보다 늦어야 해요.");
      return;
    }
    const next: WorkRecord = {
      id: uid(),
      clockIn: inIso,
      clockOut: outIso,
    };
    const updated = [...records, next];
    setRecords(updated);
    saveRecords(updated);
    setManualOpen(false);
    setToast("기록이 추가되었어요.");
  }

  function deleteRecord(id: string) {
    if (!confirm("이 기록을 삭제할까요?")) return;
    const updated = records.filter((r) => r.id !== id);
    setRecords(updated);
    saveRecords(updated);
  }

  function addLedger() {
    const amount = Number(ledgerAmount.replace(/[^0-9]/g, ""));
    if (!amount || amount <= 0) {
      setToast("금액을 올바르게 입력해 주세요.");
      return;
    }
    const entry: LedgerEntry = {
      id: uid(),
      date: ledgerDate,
      amount,
      memo: ledgerMemo.trim() || undefined,
      type: ledgerType,
    };
    const updated = [entry, ...ledger];
    setLedger(updated);
    saveLedger(updated);
    setLedgerAmount("");
    setLedgerMemo("");
    setToast(
      ledgerType === "ledger"
        ? "장부 사용액이 저장되었어요."
        : "내돈내산 사용액이 저장되었어요.",
    );
  }

  function deleteLedger(id: string) {
    if (!confirm("이 식사 기록을 삭제할까요?")) return;
    const updated = ledger.filter((e) => e.id !== id);
    setLedger(updated);
    saveLedger(updated);
  }

  const monthLabel = `${now.getFullYear()}년 ${now.getMonth() + 1}월`;

  function resetAll() {
    if (
      !confirm(
        "정말 모든 데이터를 초기화할까요?\n근무 기록과 장부 내역이 모두 삭제됩니다.",
      )
    )
      return;
    if (!confirm("한 번 더 확인합니다. 계속 진행할까요?")) return;
    localStorage.removeItem(RECORDS_KEY);
    localStorage.removeItem(LEDGER_KEY);
    setRecords([]);
    setLedger([]);
    setToast("모든 데이터가 초기화되었어요.");
  }

  function resetRecords() {
    if (!confirm("근무 기록을 모두 삭제할까요?")) return;
    localStorage.removeItem(RECORDS_KEY);
    setRecords([]);
    setToast("근무 기록이 초기화되었어요.");
  }

  function resetLedger() {
    if (!confirm("장부 내역을 모두 삭제할까요?")) return;
    localStorage.removeItem(LEDGER_KEY);
    setLedger([]);
    setToast("장부 내역이 초기화되었어요.");
  }

  return (
    <div className="min-h-screen pb-24" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 px-4 pt-5 pb-3 shadow-sm flex items-start justify-between"
        style={{ background: "#1e3a8a", color: "white" }}
      >
        <div>
          <div className="text-xs opacity-80">서원동 주민센터</div>
          <h1 className="text-lg font-bold mt-0.5">초과근무 · 급량비 계산기</h1>
          <div className="text-xs mt-1 opacity-80">{monthLabel} 기준</div>
        </div>
        <button
          onClick={() => setSettingsOpen(true)}
          className="text-xs px-3 py-2 rounded-lg active:scale-95 transition"
          style={{ background: "rgba(255,255,255,0.15)", color: "white" }}
          aria-label="설정"
        >
          설정
        </button>
      </header>

      {/* Dashboard */}
      <section className="px-4 pt-4">
        <div className="grid grid-cols-2 gap-3">
          <DashCard
            label="누적 초과근무"
            value={formatHours(monthly.totalOvertimeHours)}
            sub="이번 달"
            color="#2563eb"
          />
          <DashCard
            label="누적 급량비"
            value={
              monthly.capped
                ? `${MEAL_MONTHLY_CAP}개(최대)`
                : `${monthly.totalMeals}개`
            }
            sub={`평일 ${monthly.weekdayMeals} · 주말 ${monthly.weekendMeals}${monthly.capped ? ` (총 ${monthly.rawTotalMeals})` : ""}`}
            color="#059669"
          />
          <DashCard
            label="장부 누적 사용"
            value={formatWon(monthly.monthlyLedger)}
            sub="이번 달"
            color="#d97706"
          />
          <DashCard
            label="잔액"
            value={formatWon(monthly.balance)}
            sub={`급량비 ${formatWon(monthly.mealAmount)}`}
            color={monthly.balance >= 0 ? "#059669" : "#dc2626"}
            highlight
          />
        </div>
      </section>

      {/* Clock buttons */}
      <section className="px-4 pt-5">
        <div
          className="rounded-2xl p-4"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          <div className="text-center mb-3">
            <div className="text-sm font-medium" style={{ color: "var(--muted)" }}>
              {formatFullDate(now)}
            </div>
            <div className="text-3xl font-bold tabular-nums mt-1">
              {pad(now.getHours())}:{pad(now.getMinutes())}
            </div>
            {openRecord && (
              <div
                className="text-xs mt-2 inline-block px-2 py-1 rounded-full"
                style={{ background: "#fef3c7", color: "#92400e" }}
              >
                근무 중 · {formatTime(openRecord.clockIn)} 출근
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <BigButton
              label="출근 기록"
              onClick={clockIn}
              color="#2563eb"
              disabled={!!openRecord}
            />
            <BigButton
              label="퇴근 기록"
              onClick={clockOut}
              color="#dc2626"
              disabled={!openRecord}
            />
          </div>
          <button
            onClick={() => {
              setManualDate(todayStr());
              setManualIn("09:00");
              setManualOut("19:00");
              setManualOpen(true);
            }}
            className="w-full mt-3 py-3 rounded-xl text-sm font-semibold active:scale-[0.98] transition"
            style={{
              background: "#eef2ff",
              color: "#1e3a8a",
              border: "1px solid #c7d2fe",
            }}
          >
            + 지난 날짜 수동 추가
          </button>
        </div>
      </section>

      {/* Tabs */}
      <nav className="px-4 pt-5">
        <div
          className="flex rounded-xl p-1"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          {(
            [
              ["home", "오늘"],
              ["history", "근무 기록"],
              ["ledger", "식사 기록"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="flex-1 py-2.5 text-sm font-medium rounded-lg"
              style={{
                background: tab === key ? "#1e3a8a" : "transparent",
                color: tab === key ? "white" : "var(--muted)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      {/* Tab content */}
      <section className="px-4 pt-4">
        {tab === "home" && (
          <TodaySummary computed={computed} onDelete={deleteRecord} />
        )}
        {tab === "history" && (
          <HistoryList computed={computed} onDelete={deleteRecord} />
        )}
        {tab === "ledger" && (
          <LedgerTab
            ledger={ledger}
            ledgerDate={ledgerDate}
            ledgerAmount={ledgerAmount}
            ledgerMemo={ledgerMemo}
            ledgerType={ledgerType}
            setLedgerDate={setLedgerDate}
            setLedgerAmount={setLedgerAmount}
            setLedgerMemo={setLedgerMemo}
            setLedgerType={setLedgerType}
            monthlyLedger={monthly.monthlyLedger}
            monthlyPersonal={monthly.monthlyPersonal}
            onAdd={addLedger}
            onDelete={deleteLedger}
          />
        )}
      </section>

      {manualOpen && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setManualOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-t-2xl p-5 space-y-3"
            style={{ background: "var(--card)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-base font-bold">근무 기록 수동 추가</div>
              <button
                onClick={() => setManualOpen(false)}
                className="text-sm px-3 py-1.5 rounded-lg"
                style={{ color: "var(--muted)", background: "#f3f4f6" }}
              >
                닫기
              </button>
            </div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>
              놓친 날의 출퇴근 시간을 직접 입력해서 추가할 수 있어요.
            </div>
            <div>
              <label className="text-xs" style={{ color: "var(--muted)" }}>
                날짜
              </label>
              <input
                type="date"
                value={manualDate}
                onChange={(e) => setManualDate(e.target.value)}
                className="w-full mt-1 px-3 py-3 rounded-lg text-base"
                style={{ background: "#f9fafb", border: "1px solid var(--border)" }}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs" style={{ color: "var(--muted)" }}>
                  출근 시간
                </label>
                <input
                  type="time"
                  value={manualIn}
                  onChange={(e) => setManualIn(e.target.value)}
                  className="w-full mt-1 px-3 py-3 rounded-lg text-base tabular-nums"
                  style={{ background: "#f9fafb", border: "1px solid var(--border)" }}
                />
              </div>
              <div>
                <label className="text-xs" style={{ color: "var(--muted)" }}>
                  퇴근 시간
                </label>
                <input
                  type="time"
                  value={manualOut}
                  onChange={(e) => setManualOut(e.target.value)}
                  className="w-full mt-1 px-3 py-3 rounded-lg text-base tabular-nums"
                  style={{ background: "#f9fafb", border: "1px solid var(--border)" }}
                />
              </div>
            </div>
            <button
              onClick={addManualRecord}
              className="w-full py-3.5 rounded-xl text-base font-bold active:scale-[0.98] transition"
              style={{ background: "#1e3a8a", color: "white" }}
            >
              추가하기
            </button>
          </div>
        </div>
      )}

      {settingsOpen && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-t-2xl p-5 space-y-3"
            style={{ background: "var(--card)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-base font-bold">설정</div>
              <button
                onClick={() => setSettingsOpen(false)}
                className="text-sm px-3 py-1.5 rounded-lg"
                style={{ color: "var(--muted)", background: "#f3f4f6" }}
              >
                닫기
              </button>
            </div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>
              데이터를 초기화하면 되돌릴 수 없어요. 신중히 진행해 주세요.
            </div>
            <button
              onClick={() => {
                resetRecords();
                setSettingsOpen(false);
              }}
              className="w-full py-3.5 rounded-xl text-sm font-semibold active:scale-[0.98] transition"
              style={{ background: "#fef3c7", color: "#92400e" }}
            >
              근무 기록만 초기화
            </button>
            <button
              onClick={() => {
                resetLedger();
                setSettingsOpen(false);
              }}
              className="w-full py-3.5 rounded-xl text-sm font-semibold active:scale-[0.98] transition"
              style={{ background: "#fef3c7", color: "#92400e" }}
            >
              장부 내역만 초기화
            </button>
            <button
              onClick={() => {
                resetAll();
                setSettingsOpen(false);
              }}
              className="w-full py-3.5 rounded-xl text-sm font-bold active:scale-[0.98] transition"
              style={{ background: "#dc2626", color: "white" }}
            >
              전체 데이터 초기화
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div
          className="fixed left-1/2 bottom-6 -translate-x-1/2 px-4 py-2.5 rounded-full text-sm shadow-lg z-20"
          style={{ background: "#111827", color: "white" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function DashCard({
  label,
  value,
  sub,
  color,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  highlight?: boolean;
}) {
  return (
    <div
      className="rounded-2xl p-3.5"
      style={{
        background: highlight ? color : "var(--card)",
        border: highlight ? "none" : "1px solid var(--border)",
        color: highlight ? "white" : "var(--text)",
      }}
    >
      <div
        className="text-xs"
        style={{ color: highlight ? "rgba(255,255,255,0.85)" : "var(--muted)" }}
      >
        {label}
      </div>
      <div
        className="text-xl font-bold mt-1 tabular-nums"
        style={{ color: highlight ? "white" : color }}
      >
        {value}
      </div>
      {sub && (
        <div
          className="text-[11px] mt-1"
          style={{ color: highlight ? "rgba(255,255,255,0.85)" : "var(--muted)" }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

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
      className="w-full py-5 rounded-xl text-lg font-bold transition active:scale-[0.98]"
      style={{
        background: disabled ? "#e5e7eb" : color,
        color: disabled ? "#9ca3af" : "white",
        opacity: disabled ? 0.7 : 1,
      }}
    >
      {label}
    </button>
  );
}

function TodaySummary({
  computed,
  onDelete,
}: {
  computed: ComputedRecord[];
  onDelete: (id: string) => void;
}) {
  const today = todayStr();
  const todays = computed.filter((c) => formatDate(c.record.clockIn) === today);
  if (todays.length === 0) {
    return (
      <div
        className="rounded-2xl p-6 text-center"
        style={{ background: "var(--card)", border: "1px solid var(--border)", color: "var(--muted)" }}
      >
        오늘 완료된 근무 기록이 아직 없어요.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {todays.map((c) => (
        <RecordCard key={c.record.id} c={c} onDelete={onDelete} />
      ))}
    </div>
  );
}

function HistoryList({
  computed,
  onDelete,
}: {
  computed: ComputedRecord[];
  onDelete: (id: string) => void;
}) {
  if (computed.length === 0) {
    return (
      <div
        className="rounded-2xl p-6 text-center"
        style={{ background: "var(--card)", border: "1px solid var(--border)", color: "var(--muted)" }}
      >
        근무 기록이 없어요.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {computed.map((c) => (
        <RecordCard key={c.record.id} c={c} onDelete={onDelete} />
      ))}
    </div>
  );
}

function RecordCard({
  c,
  onDelete,
}: {
  c: ComputedRecord;
  onDelete: (id: string) => void;
}) {
  return (
    <div
      className="rounded-2xl p-3.5"
      style={{ background: "var(--card)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold">{formatDate(c.record.clockIn)}</div>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full"
              style={{
                background: c.weekend ? "#fee2e2" : "#dbeafe",
                color: c.weekend ? "#991b1b" : "#1e40af",
              }}
            >
              {c.weekend ? "주말" : "평일"}
            </span>
          </div>
          <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>
            {formatTime(c.record.clockIn)}
            {c.record.clockOut ? ` ~ ${formatTime(c.record.clockOut)}` : " ~ 근무 중"}
          </div>
        </div>
        <button
          onClick={() => onDelete(c.record.id)}
          className="text-xs px-2 py-1 rounded-md"
          style={{ color: "var(--muted)", background: "#f3f4f6" }}
        >
          삭제
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3 text-center">
        <Stat label="근무" value={formatHours(c.workedHours)} />
        <Stat
          label="초과근무"
          value={formatHours(c.overtimeHours)}
          color="#2563eb"
        />
        <Stat
          label="급량비"
          value={`${c.meals}개`}
          color={c.meals > 0 ? "#059669" : "var(--muted)"}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg py-2" style={{ background: "#f9fafb" }}>
      <div className="text-[10px]" style={{ color: "var(--muted)" }}>
        {label}
      </div>
      <div
        className="text-sm font-semibold mt-0.5 tabular-nums"
        style={{ color: color ?? "var(--text)" }}
      >
        {value}
      </div>
    </div>
  );
}

function LedgerTab({
  ledger,
  ledgerDate,
  ledgerAmount,
  ledgerMemo,
  ledgerType,
  setLedgerDate,
  setLedgerAmount,
  setLedgerMemo,
  setLedgerType,
  monthlyLedger,
  monthlyPersonal,
  onAdd,
  onDelete,
}: {
  ledger: LedgerEntry[];
  ledgerDate: string;
  ledgerAmount: string;
  ledgerMemo: string;
  ledgerType: "ledger" | "personal";
  setLedgerDate: (v: string) => void;
  setLedgerAmount: (v: string) => void;
  setLedgerMemo: (v: string) => void;
  setLedgerType: (v: "ledger" | "personal") => void;
  monthlyLedger: number;
  monthlyPersonal: number;
  onAdd: () => void;
  onDelete: (id: string) => void;
}) {
  const [viewType, setViewType] = useState<"ledger" | "personal">("ledger");
  const filtered = ledger
    .filter((e) => (e.type ?? "ledger") === viewType)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  const isLedger = ledgerType === "ledger";
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div
          className="rounded-xl p-3"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            장부 누적
          </div>
          <div className="text-base font-bold tabular-nums mt-0.5">
            {formatWon(monthlyLedger)}
          </div>
        </div>
        <div
          className="rounded-xl p-3"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          <div className="text-xs" style={{ color: "var(--muted)" }}>
            내돈내산 누적
          </div>
          <div className="text-base font-bold tabular-nums mt-0.5">
            {formatWon(monthlyPersonal)}
          </div>
        </div>
      </div>

      <div
        className="rounded-2xl p-4 space-y-3"
        style={{ background: "var(--card)", border: "1px solid var(--border)" }}
      >
        <div className="text-sm font-semibold">식사 기록 입력</div>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setLedgerType("ledger")}
            className="py-2.5 rounded-lg text-sm font-semibold"
            style={{
              background: isLedger ? "#1e3a8a" : "#f3f4f6",
              color: isLedger ? "white" : "var(--muted)",
              border: "1px solid var(--border)",
            }}
          >
            장부 식당
          </button>
          <button
            type="button"
            onClick={() => setLedgerType("personal")}
            className="py-2.5 rounded-lg text-sm font-semibold"
            style={{
              background: !isLedger ? "#6b7280" : "#f3f4f6",
              color: !isLedger ? "white" : "var(--muted)",
              border: "1px solid var(--border)",
            }}
          >
            내돈내산
          </button>
        </div>
        <div className="text-xs" style={{ color: "var(--muted)" }}>
          {isLedger
            ? "장부 식당에서 사용한 금액입니다. 잔액 계산에 합산됩니다."
            : "장부 외 식당에서 본인이 결제한 금액입니다. 잔액 계산에 합산되지 않아요."}
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>
            날짜
          </label>
          <input
            type="date"
            value={ledgerDate}
            onChange={(e) => setLedgerDate(e.target.value)}
            className="w-full mt-1 px-3 py-3 rounded-lg text-base"
            style={{ background: "#f9fafb", border: "1px solid var(--border)" }}
          />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>
            금액 (원)
          </label>
          <input
            type="text"
            inputMode="numeric"
            placeholder="예: 9000"
            value={ledgerAmount}
            onChange={(e) =>
              setLedgerAmount(e.target.value.replace(/[^0-9]/g, ""))
            }
            className="w-full mt-1 px-3 py-3 rounded-lg text-base tabular-nums"
            style={{ background: "#f9fafb", border: "1px solid var(--border)" }}
          />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>
            메모 (선택)
          </label>
          <input
            type="text"
            placeholder="식당 이름, 메뉴 등"
            value={ledgerMemo}
            onChange={(e) => setLedgerMemo(e.target.value)}
            className="w-full mt-1 px-3 py-3 rounded-lg text-base"
            style={{ background: "#f9fafb", border: "1px solid var(--border)" }}
          />
        </div>
        <button
          onClick={onAdd}
          className="w-full py-3.5 rounded-xl text-base font-bold active:scale-[0.98] transition"
          style={{
            background: isLedger ? "#1e3a8a" : "#374151",
            color: "white",
          }}
        >
          저장
        </button>
      </div>

      <div className="grid grid-cols-2 gap-2 pt-1">
        {(
          [
            ["ledger", "장부 식당"],
            ["personal", "내돈내산"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setViewType(key)}
            className="py-2 rounded-lg text-sm font-semibold"
            style={{
              background: viewType === key ? "var(--card)" : "transparent",
              color: viewType === key ? "var(--fg)" : "var(--muted)",
              border:
                viewType === key
                  ? "1px solid var(--border)"
                  : "1px solid transparent",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div
          className="rounded-2xl p-6 text-center"
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            color: "var(--muted)",
          }}
        >
          저장된 {viewType === "ledger" ? "장부" : "내돈내산"} 내역이 없어요.
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((e) => (
            <div
              key={e.id}
              className="rounded-xl p-3 flex items-center justify-between"
              style={{ background: "var(--card)", border: "1px solid var(--border)" }}
            >
              <div>
                <div className="text-sm font-semibold tabular-nums">
                  {formatWon(e.amount)}
                </div>
                <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                  {e.date}
                  {e.memo ? ` · ${e.memo}` : ""}
                </div>
              </div>
              <button
                onClick={() => onDelete(e.id)}
                className="text-xs px-2.5 py-1.5 rounded-md"
                style={{ color: "var(--muted)", background: "#f3f4f6" }}
              >
                삭제
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
  if (!record.clockOut) return null;
  const start = new Date(record.clockIn);
  const end = new Date(record.clockOut);
  const ms = end.getTime() - start.getTime();
  if (ms <= 0) {
    return {
      record,
      workedHours: 0,
      overtimeHours: 0,
      meals: 0,
      weekend: isWeekend(start),
      date: start,
    };
  }
  const workedHours = ms / (1000 * 60 * 60);
  const weekend = isWeekend(start);
  let overtimeHours = 0;
  let meals = 0;
  if (weekend) {
    overtimeHours = workedHours;
    if (workedHours >= 1) meals = 1;
  } else {
    overtimeHours = Math.max(0, workedHours - 1);
    if (overtimeHours >= 1) meals = 1;
  }
  return { record, workedHours, overtimeHours, meals, weekend, date: start };
}

export default function App() {
  const [records, setRecords] = useState<WorkRecord[]>(() => loadRecords());
  const [ledger, setLedger] = useState<LedgerEntry[]>(() => loadLedger());
  const [now, setNow] = useState(new Date());
  const [ledgerDate, setLedgerDate] = useState(todayStr());
  const [ledgerAmount, setLedgerAmount] = useState("");
  const [ledgerMemo, setLedgerMemo] = useState("");
  const [tab, setTab] = useState<"home" | "history" | "ledger">("home");
  const [toast, setToast] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000 * 30);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 1800);
    return () => clearTimeout(t);
  }, [toast]);

  const openRecord = useMemo(
    () => records.find((r) => !r.clockOut) ?? null,
    [records],
  );

  const computed = useMemo(() => {
    return records
      .map(computeRecord)
      .filter((r): r is ComputedRecord => r !== null)
      .sort((a, b) => b.date.getTime() - a.date.getTime());
  }, [records]);

  const monthly = useMemo(() => {
    const ref = new Date();
    let totalOvertimeHours = 0;
    let weekdayMeals = 0;
    let weekendMeals = 0;
    for (const c of computed) {
      if (!isSameMonth(c.date, ref)) continue;
      totalOvertimeHours += c.overtimeHours;
      if (c.weekend) weekendMeals += c.meals;
      else weekdayMeals += c.meals;
    }
    const rawTotalMeals = weekdayMeals + weekendMeals;
    const totalMeals = Math.min(rawTotalMeals, MEAL_MONTHLY_CAP);
    const mealAmount = totalMeals * MEAL_PRICE;
    const capped = rawTotalMeals >= MEAL_MONTHLY_CAP;
    const monthlyLedger = ledger
      .filter((e) => isSameMonth(new Date(e.date), ref))
      .reduce((s, e) => s + (Number(e.amount) || 0), 0);
    return {
      totalOvertimeHours,
      weekdayMeals,
      weekendMeals,
      rawTotalMeals,
      totalMeals,
      mealAmount,
      capped,
      monthlyLedger,
      balance: mealAmount - monthlyLedger,
    };
  }, [computed, ledger]);

  function clockIn() {
    if (openRecord) {
      setToast("이미 출근 기록이 있어요. 먼저 퇴근을 기록해 주세요.");
      return;
    }
    const next: WorkRecord = {
      id: uid(),
      clockIn: new Date().toISOString(),
      clockOut: null,
    };
    const newRecords = [...records, next];
    setRecords(newRecords);
    saveRecords(newRecords);
    setToast(`출근 기록 ${formatTime(next.clockIn)}`);
  }

  function clockOut() {
    if (!openRecord) {
      setToast("출근 기록이 없어요. 먼저 출근을 기록해 주세요.");
      return;
    }
    const updated = records.map((r) =>
      r.id === openRecord.id ? { ...r, clockOut: new Date().toISOString() } : r,
    );
    setRecords(updated);
    saveRecords(updated);
    setToast(`퇴근 기록 ${formatTime(new Date().toISOString())}`);
  }

  function deleteRecord(id: string) {
    if (!confirm("이 기록을 삭제할까요?")) return;
    const updated = records.filter((r) => r.id !== id);
    setRecords(updated);
    saveRecords(updated);
  }

  function addLedger() {
    const amount = Number(ledgerAmount.replace(/[^0-9]/g, ""));
    if (!amount || amount <= 0) {
      setToast("금액을 올바르게 입력해 주세요.");
      return;
    }
    const entry: LedgerEntry = {
      id: uid(),
      date: ledgerDate,
      amount,
      memo: ledgerMemo.trim() || undefined,
    };
    const updated = [entry, ...ledger];
    setLedger(updated);
    saveLedger(updated);
    setLedgerAmount("");
    setLedgerMemo("");
    setToast("장부 사용액이 저장되었어요.");
  }

  function deleteLedger(id: string) {
    if (!confirm("이 장부 항목을 삭제할까요?")) return;
    const updated = ledger.filter((e) => e.id !== id);
    setLedger(updated);
    saveLedger(updated);
  }

  const monthLabel = `${now.getFullYear()}년 ${now.getMonth() + 1}월`;

  function resetAll() {
    if (
      !confirm(
        "정말 모든 데이터를 초기화할까요?\n근무 기록과 장부 내역이 모두 삭제됩니다.",
      )
    )
      return;
    if (!confirm("한 번 더 확인합니다. 계속 진행할까요?")) return;
    localStorage.removeItem(RECORDS_KEY);
    localStorage.removeItem(LEDGER_KEY);
    setRecords([]);
    setLedger([]);
    setToast("모든 데이터가 초기화되었어요.");
  }

  function resetRecords() {
    if (!confirm("근무 기록을 모두 삭제할까요?")) return;
    localStorage.removeItem(RECORDS_KEY);
    setRecords([]);
    setToast("근무 기록이 초기화되었어요.");
  }

  function resetLedger() {
    if (!confirm("장부 내역을 모두 삭제할까요?")) return;
    localStorage.removeItem(LEDGER_KEY);
    setLedger([]);
    setToast("장부 내역이 초기화되었어요.");
  }

  return (
    <div className="min-h-screen pb-24" style={{ background: "var(--bg)" }}>
      {/* Header */}
      <header
        className="sticky top-0 z-10 px-4 pt-5 pb-3 shadow-sm flex items-start justify-between"
        style={{ background: "#1e3a8a", color: "white" }}
      >
        <div>
          <div className="text-xs opacity-80">서원동 주민센터</div>
          <h1 className="text-lg font-bold mt-0.5">초과근무 · 급량비 계산기</h1>
          <div className="text-xs mt-1 opacity-80">{monthLabel} 기준</div>
        </div>
        <button
          onClick={() => setSettingsOpen(true)}
          className="text-xs px-3 py-2 rounded-lg active:scale-95 transition"
          style={{ background: "rgba(255,255,255,0.15)", color: "white" }}
          aria-label="설정"
        >
          설정
        </button>
      </header>

      {/* Dashboard */}
      <section className="px-4 pt-4">
        <div className="grid grid-cols-2 gap-3">
          <DashCard
            label="누적 초과근무"
            value={formatHours(monthly.totalOvertimeHours)}
            sub="이번 달"
            color="#2563eb"
          />
          <DashCard
            label="누적 급량비"
            value={
              monthly.capped
                ? `${MEAL_MONTHLY_CAP}개(최대)`
                : `${monthly.totalMeals}개`
            }
            sub={`평일 ${monthly.weekdayMeals} · 주말 ${monthly.weekendMeals}${monthly.capped ? ` (총 ${monthly.rawTotalMeals})` : ""}`}
            color="#059669"
          />
          <DashCard
            label="장부 누적 사용"
            value={formatWon(monthly.monthlyLedger)}
            sub="이번 달"
            color="#d97706"
          />
          <DashCard
            label="잔액"
            value={formatWon(monthly.balance)}
            sub={`급량비 ${formatWon(monthly.mealAmount)}`}
            color={monthly.balance >= 0 ? "#059669" : "#dc2626"}
            highlight
          />
        </div>
      </section>

      {/* Clock buttons */}
      <section className="px-4 pt-5">
        <div
          className="rounded-2xl p-4"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          <div className="text-center mb-3">
            <div className="text-xs" style={{ color: "var(--muted)" }}>
              현재 시간
            </div>
            <div className="text-2xl font-bold tabular-nums mt-1">
              {pad(now.getHours())}:{pad(now.getMinutes())}
            </div>
            {openRecord && (
              <div
                className="text-xs mt-2 inline-block px-2 py-1 rounded-full"
                style={{ background: "#fef3c7", color: "#92400e" }}
              >
                근무 중 · {formatTime(openRecord.clockIn)} 출근
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <BigButton
              label="출근 기록"
              onClick={clockIn}
              color="#2563eb"
              disabled={!!openRecord}
            />
            <BigButton
              label="퇴근 기록"
              onClick={clockOut}
              color="#dc2626"
              disabled={!openRecord}
            />
          </div>
        </div>
      </section>

      {/* Tabs */}
      <nav className="px-4 pt-5">
        <div
          className="flex rounded-xl p-1"
          style={{ background: "var(--card)", border: "1px solid var(--border)" }}
        >
          {(
            [
              ["home", "오늘"],
              ["history", "근무 기록"],
              ["ledger", "장부"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className="flex-1 py-2.5 text-sm font-medium rounded-lg"
              style={{
                background: tab === key ? "#1e3a8a" : "transparent",
                color: tab === key ? "white" : "var(--muted)",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      {/* Tab content */}
      <section className="px-4 pt-4">
        {tab === "home" && (
          <TodaySummary computed={computed} onDelete={deleteRecord} />
        )}
        {tab === "history" && (
          <HistoryList computed={computed} onDelete={deleteRecord} />
        )}
        {tab === "ledger" && (
          <LedgerTab
            ledger={ledger}
            ledgerDate={ledgerDate}
            ledgerAmount={ledgerAmount}
            ledgerMemo={ledgerMemo}
            setLedgerDate={setLedgerDate}
            setLedgerAmount={setLedgerAmount}
            setLedgerMemo={setLedgerMemo}
            onAdd={addLedger}
            onDelete={deleteLedger}
          />
        )}
      </section>

      {settingsOpen && (
        <div
          className="fixed inset-0 z-30 flex items-end justify-center"
          style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => setSettingsOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-t-2xl p-5 space-y-3"
            style={{ background: "var(--card)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="text-base font-bold">설정</div>
              <button
                onClick={() => setSettingsOpen(false)}
                className="text-sm px-3 py-1.5 rounded-lg"
                style={{ color: "var(--muted)", background: "#f3f4f6" }}
              >
                닫기
              </button>
            </div>
            <div className="text-xs" style={{ color: "var(--muted)" }}>
              데이터를 초기화하면 되돌릴 수 없어요. 신중히 진행해 주세요.
            </div>
            <button
              onClick={() => {
                resetRecords();
                setSettingsOpen(false);
              }}
              className="w-full py-3.5 rounded-xl text-sm font-semibold active:scale-[0.98] transition"
              style={{ background: "#fef3c7", color: "#92400e" }}
            >
              근무 기록만 초기화
            </button>
            <button
              onClick={() => {
                resetLedger();
                setSettingsOpen(false);
              }}
              className="w-full py-3.5 rounded-xl text-sm font-semibold active:scale-[0.98] transition"
              style={{ background: "#fef3c7", color: "#92400e" }}
            >
              장부 내역만 초기화
            </button>
            <button
              onClick={() => {
                resetAll();
                setSettingsOpen(false);
              }}
              className="w-full py-3.5 rounded-xl text-sm font-bold active:scale-[0.98] transition"
              style={{ background: "#dc2626", color: "white" }}
            >
              전체 데이터 초기화
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div
          className="fixed left-1/2 bottom-6 -translate-x-1/2 px-4 py-2.5 rounded-full text-sm shadow-lg z-20"
          style={{ background: "#111827", color: "white" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}

function DashCard({
  label,
  value,
  sub,
  color,
  highlight,
}: {
  label: string;
  value: string;
  sub?: string;
  color: string;
  highlight?: boolean;
}) {
  return (
    <div
      className="rounded-2xl p-3.5"
      style={{
        background: highlight ? color : "var(--card)",
        border: highlight ? "none" : "1px solid var(--border)",
        color: highlight ? "white" : "var(--text)",
      }}
    >
      <div
        className="text-xs"
        style={{ color: highlight ? "rgba(255,255,255,0.85)" : "var(--muted)" }}
      >
        {label}
      </div>
      <div
        className="text-xl font-bold mt-1 tabular-nums"
        style={{ color: highlight ? "white" : color }}
      >
        {value}
      </div>
      {sub && (
        <div
          className="text-[11px] mt-1"
          style={{ color: highlight ? "rgba(255,255,255,0.85)" : "var(--muted)" }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

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
      className="w-full py-5 rounded-xl text-lg font-bold transition active:scale-[0.98]"
      style={{
        background: disabled ? "#e5e7eb" : color,
        color: disabled ? "#9ca3af" : "white",
        opacity: disabled ? 0.7 : 1,
      }}
    >
      {label}
    </button>
  );
}

function TodaySummary({
  computed,
  onDelete,
}: {
  computed: ComputedRecord[];
  onDelete: (id: string) => void;
}) {
  const today = todayStr();
  const todays = computed.filter((c) => formatDate(c.record.clockIn) === today);
  if (todays.length === 0) {
    return (
      <div
        className="rounded-2xl p-6 text-center"
        style={{ background: "var(--card)", border: "1px solid var(--border)", color: "var(--muted)" }}
      >
        오늘 완료된 근무 기록이 아직 없어요.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {todays.map((c) => (
        <RecordCard key={c.record.id} c={c} onDelete={onDelete} />
      ))}
    </div>
  );
}

function HistoryList({
  computed,
  onDelete,
}: {
  computed: ComputedRecord[];
  onDelete: (id: string) => void;
}) {
  if (computed.length === 0) {
    return (
      <div
        className="rounded-2xl p-6 text-center"
        style={{ background: "var(--card)", border: "1px solid var(--border)", color: "var(--muted)" }}
      >
        근무 기록이 없어요.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {computed.map((c) => (
        <RecordCard key={c.record.id} c={c} onDelete={onDelete} />
      ))}
    </div>
  );
}

function RecordCard({
  c,
  onDelete,
}: {
  c: ComputedRecord;
  onDelete: (id: string) => void;
}) {
  return (
    <div
      className="rounded-2xl p-3.5"
      style={{ background: "var(--card)", border: "1px solid var(--border)" }}
    >
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <div className="text-sm font-semibold">{formatDate(c.record.clockIn)}</div>
            <span
              className="text-[10px] px-1.5 py-0.5 rounded-full"
              style={{
                background: c.weekend ? "#fee2e2" : "#dbeafe",
                color: c.weekend ? "#991b1b" : "#1e40af",
              }}
            >
              {c.weekend ? "주말" : "평일"}
            </span>
          </div>
          <div className="text-xs mt-1" style={{ color: "var(--muted)" }}>
            {formatTime(c.record.clockIn)}
            {c.record.clockOut ? ` ~ ${formatTime(c.record.clockOut)}` : " ~ 근무 중"}
          </div>
        </div>
        <button
          onClick={() => onDelete(c.record.id)}
          className="text-xs px-2 py-1 rounded-md"
          style={{ color: "var(--muted)", background: "#f3f4f6" }}
        >
          삭제
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2 mt-3 text-center">
        <Stat label="근무" value={formatHours(c.workedHours)} />
        <Stat
          label="초과근무"
          value={formatHours(c.overtimeHours)}
          color="#2563eb"
        />
        <Stat
          label="급량비"
          value={`${c.meals}개`}
          color={c.meals > 0 ? "#059669" : "var(--muted)"}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <div className="rounded-lg py-2" style={{ background: "#f9fafb" }}>
      <div className="text-[10px]" style={{ color: "var(--muted)" }}>
        {label}
      </div>
      <div
        className="text-sm font-semibold mt-0.5 tabular-nums"
        style={{ color: color ?? "var(--text)" }}
      >
        {value}
      </div>
    </div>
  );
}

function LedgerTab({
  ledger,
  ledgerDate,
  ledgerAmount,
  ledgerMemo,
  setLedgerDate,
  setLedgerAmount,
  setLedgerMemo,
  onAdd,
  onDelete,
}: {
  ledger: LedgerEntry[];
  ledgerDate: string;
  ledgerAmount: string;
  ledgerMemo: string;
  setLedgerDate: (v: string) => void;
  setLedgerAmount: (v: string) => void;
  setLedgerMemo: (v: string) => void;
  onAdd: () => void;
  onDelete: (id: string) => void;
}) {
  const sorted = [...ledger].sort((a, b) => (a.date < b.date ? 1 : -1));
  return (
    <div className="space-y-3">
      <div
        className="rounded-2xl p-4 space-y-3"
        style={{ background: "var(--card)", border: "1px solid var(--border)" }}
      >
        <div className="text-sm font-semibold">장부 사용액 입력</div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>
            날짜
          </label>
          <input
            type="date"
            value={ledgerDate}
            onChange={(e) => setLedgerDate(e.target.value)}
            className="w-full mt-1 px-3 py-3 rounded-lg text-base"
            style={{ background: "#f9fafb", border: "1px solid var(--border)" }}
          />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>
            금액 (원)
          </label>
          <input
            type="text"
            inputMode="numeric"
            placeholder="예: 9000"
            value={ledgerAmount}
            onChange={(e) =>
              setLedgerAmount(e.target.value.replace(/[^0-9]/g, ""))
            }
            className="w-full mt-1 px-3 py-3 rounded-lg text-base tabular-nums"
            style={{ background: "#f9fafb", border: "1px solid var(--border)" }}
          />
        </div>
        <div>
          <label className="text-xs" style={{ color: "var(--muted)" }}>
            메모 (선택)
          </label>
          <input
            type="text"
            placeholder="식당 이름, 메뉴 등"
            value={ledgerMemo}
            onChange={(e) => setLedgerMemo(e.target.value)}
            className="w-full mt-1 px-3 py-3 rounded-lg text-base"
            style={{ background: "#f9fafb", border: "1px solid var(--border)" }}
          />
        </div>
        <button
          onClick={onAdd}
          className="w-full py-3.5 rounded-xl text-base font-bold active:scale-[0.98] transition"
          style={{ background: "#1e3a8a", color: "white" }}
        >
          저장
        </button>
      </div>

      <div className="text-sm font-semibold px-1 pt-2">사용 내역</div>
      {sorted.length === 0 ? (
        <div
          className="rounded-2xl p-6 text-center"
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            color: "var(--muted)",
          }}
        >
          저장된 장부 내역이 없어요.
        </div>
      ) : (
        <div className="space-y-2">
          {sorted.map((e) => (
            <div
              key={e.id}
              className="rounded-xl p-3 flex items-center justify-between"
              style={{ background: "var(--card)", border: "1px solid var(--border)" }}
            >
              <div>
                <div className="text-sm font-semibold tabular-nums">
                  {formatWon(e.amount)}
                </div>
                <div className="text-xs mt-0.5" style={{ color: "var(--muted)" }}>
                  {e.date}
                  {e.memo ? ` · ${e.memo}` : ""}
                </div>
              </div>
              <button
                onClick={() => onDelete(e.id)}
                className="text-xs px-2.5 py-1.5 rounded-md"
                style={{ color: "var(--muted)", background: "#f3f4f6" }}
              >
                삭제
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


