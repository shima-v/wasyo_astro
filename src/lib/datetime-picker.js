// 空き枠駆動の「日時ピッカー」共有部品。
// お客様フロー（index）・日時変更（manage）・管理の代理登録（admin/reservations）が
// 同じ「空き日カレンダー（ヒートマップ）→ 日付タップ → 時刻ポップアップ」で日時を選べるよう、
// 組み立てを1か所に集約する。DOM 構造・クラス・見た目は reserve-calendar.css / TimeDialog.astro に従う。
//
// 2階建て:
//   1) renderAvailabilityCalendar(...) … 月グリッド（ヒートマップ＋前月/次月＋日付クリック）の
//      "描画だけ" を行う純粋なレンダラ。index/manage の既存 renderCalendar と 1バイト違わぬ HTML を
//      生成する（挙動不変の抽出）。host 側の副作用（state 反映・ステップ遷移など）は
//      onNav / onDayClick コールバックに委ねる。
//   2) createDateTimePicker(...) … 上記レンダラ＋時刻ポップアップ（TimeDialog）＋内部 state を束ねた
//      高水準コントローラ。新規呼び出し元（代理登録フォーム）が「空き日時だけ選ばせる」UI を
//      最小の配線で組める。index/manage は既存 state と密結合のため 1)（レンダラ）のみ採用し、
//      回帰ゼロを優先する。

import { heatMark } from './heatmap.js';
import { openTimeDialog as openTimeDlg, renderTimeButtons } from './time-dialog.js';

/** カレンダー曜日ヘッダの既定（日始まり）。 */
export const CAL_WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];

/** 'yyyy-MM-dd' を「年*12+月」の連番へ。前月/次月ボタンの活性判定に使う。 */
export function ymIndex(ymd) {
  const [y, m] = ymd.split('-').map(Number);
  return y * 12 + (m - 1);
}

/** 表示中の月 {y, m(0始まり)} を delta ヶ月ずらした {y, m} を返す（月跨ぎ正規化）。 */
export function stepMonth(c, delta) {
  const d = new Date(c.y, c.m + delta, 1);
  return { y: d.getFullYear(), m: d.getMonth() };
}

const escDefault = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 空き日カレンダー（1ヶ月分）を mount に描画し、前月/次月・日付クリックを配線する。
 * index/manage の既存 renderCalendar を挙動不変で切り出したもの（生成 HTML・クラス・
 * イベント配線が一致）。state 反映などの副作用は onNav/onDayClick で host が担う。
 *
 * @param {Object} o
 * @param {HTMLElement} o.mount 描画先（例: #dateList）
 * @param {Array<{date:string, times:string[]}>} o.days 空き日（times 数がヒートマップの枠数）
 * @param {Object} [o.holidays] { 'yyyy-MM-dd': 祝日名 }
 * @param {Set<string>} o.availSet 空き日の集合（days の date 群）
 * @param {string} o.calMin 空き最小日 'yyyy-MM-dd'
 * @param {string} o.calMax 空き最大日 'yyyy-MM-dd'
 * @param {{y:number, m:number}} o.calMonth 表示中の月
 * @param {string|null} [o.selectedDate] 選択中の日（active 強調）
 * @param {string[]} [o.weekdays] 曜日ヘッダ（既定 CAL_WEEKDAYS）
 * @param {number} [o.heatHiMin] ◎ の下限枠数（既定 8）
 * @param {(s:any)=>string} [o.esc] エスケープ関数
 * @param {(newCalMonth:{y:number,m:number})=>void} o.onNav 前月/次月が押されたとき（新しい月を渡す）
 * @param {(ymd:string)=>void} o.onDayClick 空き日がタップされたとき（その日の 'yyyy-MM-dd'）
 */
export function renderAvailabilityCalendar({
  mount,
  days,
  holidays = {},
  availSet,
  calMin,
  calMax,
  calMonth,
  selectedDate = null,
  weekdays = CAL_WEEKDAYS,
  heatHiMin = 8,
  esc = escDefault,
  onNav,
  onDayClick,
}) {
  // 各日の空き枠数マップ（date -> times.length）。ヒートマップの濃淡・記号に使う。
  const countByDate = new Map(days.map((d) => [d.date, d.times.length]));
  const { y, m } = calMonth;
  const firstDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const cur = y * 12 + m;
  const canPrev = cur > ymIndex(calMin);
  const canNext = cur < ymIndex(calMax);
  let html =
    '<div class="cal-head">' +
    `<button type="button" class="cal-nav" id="calPrev" ${canPrev ? '' : 'disabled'} aria-label="前の月">‹</button>` +
    `<span class="cal-title">${y}年${m + 1}月</span>` +
    `<button type="button" class="cal-nav" id="calNext" ${canNext ? '' : 'disabled'} aria-label="次の月">›</button>` +
    '</div><div class="cal-grid">' +
    weekdays.map((w, i) => `<span class="cal-wd${i === 0 ? ' sun' : ''}${i === 6 ? ' sat' : ''}">${w}</span>`).join('');
  for (let i = 0; i < firstDow; i++) html += '<span class="cal-cell empty"></span>';
  for (let day = 1; day <= daysInMonth; day++) {
    const ymd = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const dow = new Date(y, m, day).getDay();
    const dowCls = dow === 0 ? ' sun' : dow === 6 ? ' sat' : '';
    if (availSet.has(ymd)) {
      const active = selectedDate === ymd ? ' active' : '';
      // 空き枠数で濃淡＋記号を出し分け（◎=空き多い / ○=残りわずか）。共有ロジック heatMark。
      const cnt = countByDate.get(ymd) || 0;
      const { mark, cls } = heatMark(cnt, { hiMin: heatHiMin });
      const heatCls = ' ' + cls;
      html += `<button type="button" class="cal-cell cal-day avail${heatCls}${active}${dowCls}" data-date="${ymd}" title="空き ${cnt} 枠">${day}<span class="heat-mark" aria-hidden="true">${mark}</span></button>`;
    } else {
      // 非 avail: 祝日は祝日名、それ以外の休業・受付外・満は ✕（凡例「✕ 空きなし・お休み」と整合）
      const hol = holidays[ymd];
      if (hol) {
        html += `<span class="cal-cell cal-day disabled holiday${dowCls}" title="${esc(hol)}">${day}<small class="hol-name">${esc(hol)}</small></span>`;
      } else {
        html += `<span class="cal-cell cal-day disabled${dowCls}">${day}<span class="cal-x" aria-hidden="true">✕</span></span>`;
      }
    }
  }
  html += '</div>';
  html += '<p class="cal-legend"><span>◎ 空きが多い</span><span>○ 残りわずか</span><span>✕ 空きなし・お休み</span></p>';
  mount.innerHTML = html;
  const prev = mount.querySelector('#calPrev');
  const next = mount.querySelector('#calNext');
  if (prev) prev.onclick = () => onNav(stepMonth(calMonth, -1));
  if (next) next.onclick = () => onNav(stepMonth(calMonth, 1));
  mount.querySelectorAll('.cal-day.avail').forEach((b) => {
    b.addEventListener('click', () => onDayClick(b.dataset.date));
  });
}

/**
 * 空き枠駆動の日時ピッカー・コントローラを作る（高水準・内部 state 込み）。
 * 「空き日カレンダー → 日付タップ → 時刻ポップアップ（TimeDialog）で開始時刻を選ぶ」までを
 * 一括で面倒みる。時刻ポップアップの器（#timeDialog…）はページに <TimeDialog /> を置いておくこと。
 * 返り値のメソッドで日付データの投入・取得・リセットを行う。
 *
 * @param {Object} o
 * @param {HTMLElement} o.dateListEl カレンダー描画先（例: #agentDateList）
 * @param {HTMLElement} [o.statusEl] 状況テキストの表示先（任意）
 * @param {string} [o.statusClass] status のベースクラス（既定 'slot-status'）
 * @param {string[]} [o.weekdays]
 * @param {number} [o.heatHiMin]
 * @param {(s:any)=>string} [o.esc]
 * @param {(ymd:string)=>string} [o.fmtDateLabel] 時刻ポップアップ見出し用の日付ラベル
 * @param {{initial?:string, loading?:string, ready?:string, empty?:string, unconfigured?:string, error?:string}} [o.statusText]
 * @param {(ymd:string)=>void} [o.onDateChange] 日付が変わった直後（時刻は未選択）
 * @param {(sel:{date:string,time:string})=>void} [o.onSelect] 日付＋時刻が確定したとき
 * @returns {{setDays:Function, setLoading:Function, setStatus:Function, reset:Function, getSelection:Function, hasSelection:Function}}
 */
export function createDateTimePicker({
  dateListEl,
  statusEl = null,
  statusClass = 'slot-status',
  weekdays = CAL_WEEKDAYS,
  heatHiMin = 8,
  esc = escDefault,
  fmtDateLabel = (ymd) => ymd,
  statusText = {},
  onDateChange,
  onSelect,
} = {}) {
  const st = {
    days: [],
    holidays: {},
    availSet: null,
    calMin: null,
    calMax: null,
    calMonth: null,
    date: null,
    time: null,
  };

  function setStatus(msg, kind) {
    if (!statusEl) return;
    if (kind === 'loading') {
      statusEl.className = statusClass + ' loading';
      statusEl.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>' + (msg || '') + '</span>';
    } else {
      statusEl.className = statusClass + (kind ? ' ' + kind : '');
      statusEl.textContent = msg || '';
    }
  }

  function renderCalendar() {
    renderAvailabilityCalendar({
      mount: dateListEl,
      days: st.days,
      holidays: st.holidays,
      availSet: st.availSet,
      calMin: st.calMin,
      calMax: st.calMax,
      calMonth: st.calMonth,
      selectedDate: st.date,
      weekdays,
      heatHiMin,
      esc,
      onNav: (nm) => {
        st.calMonth = nm;
        renderCalendar();
      },
      onDayClick: (ymd) => {
        st.date = ymd;
        st.time = null;
        if (typeof onDateChange === 'function') onDateChange(ymd);
        renderCalendar();
        openTimeDialog();
      },
    });
  }

  // 選択中の日付の空き時刻を、共有 renderTimeButtons で時刻ポップアップ本体に描画する。
  function renderTimes() {
    const day = st.days.find((d) => d.date === st.date);
    const body = document.getElementById('timeDialogBody');
    if (!day) {
      if (body) body.innerHTML = '';
      return;
    }
    renderTimeButtons(
      day.times,
      (t) => {
        st.time = t;
        if (typeof onSelect === 'function') onSelect({ date: st.date, time: st.time });
      },
      { title: fmtDateLabel(st.date) + ' の開始時刻', selected: st.time },
    );
  }

  // 時刻ポップアップを開く（本体を描いてから共有 openTimeDlg で showModal）。
  function openTimeDialog() {
    renderTimes();
    openTimeDlg();
  }

  /** 空き日データ（computeDaysForSlot の結果など）を投入し、カレンダーを描画する。選択はリセット。 */
  function setDays(days, holidays) {
    st.days = days || [];
    st.holidays = holidays || {};
    st.date = null;
    st.time = null;
    st.calMonth = null;
    const body = document.getElementById('timeDialogBody');
    if (body) body.innerHTML = ''; // 前回の時刻候補をクリア
    if (!st.days.length) {
      setStatus(statusText.empty || 'この期間はネット予約の空きがありません。', 'slot-empty');
      dateListEl.innerHTML = '';
      return;
    }
    setStatus(statusText.ready || 'ご希望の日付を選んでください。');
    st.availSet = new Set(st.days.map((d) => d.date));
    st.calMin = st.days[0].date;
    st.calMax = st.days[st.days.length - 1].date;
    const [y, m] = st.calMin.split('-').map(Number);
    st.calMonth = { y, m: m - 1 };
    renderCalendar();
  }

  /** 取得中の見せ方（スケルトン＋ローディング文言）。 */
  function setLoading(msg) {
    setStatus(msg || '空き状況を確認中…', 'loading');
    if (dateListEl) dateListEl.innerHTML = '<div class="cal-skeleton" aria-hidden="true"></div>';
  }

  /** 全リセット（データ・選択・カレンダー・時刻候補・状況テキスト）。 */
  function reset() {
    st.days = [];
    st.holidays = {};
    st.availSet = null;
    st.calMin = null;
    st.calMax = null;
    st.calMonth = null;
    st.date = null;
    st.time = null;
    if (dateListEl) dateListEl.innerHTML = '';
    const body = document.getElementById('timeDialogBody');
    if (body) body.innerHTML = '';
    setStatus(statusText.initial || '', '');
  }

  /** 現在の選択 { date, time }（'yyyy-MM-dd' / 'HH:MM'、未選択は null）。 */
  function getSelection() {
    return { date: st.date, time: st.time };
  }

  /** 日付＋時刻が両方選ばれているか。 */
  function hasSelection() {
    return !!(st.date && st.time);
  }

  return { setDays, setLoading, setStatus, reset, getSelection, hasSelection };
}
