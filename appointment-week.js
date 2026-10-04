/**
 * appointment-week.js
 *
 * 包住 incomeAppointments()：
 * - 保留原本儲存、取消、版本及更表核對邏輯。
 * - 將 apFetchDay 改為讀取所選日期所在的完整一週。
 * - 全部預約時間沿用原有香港時間函式。
 * - 不使用 localStorage 儲存病人資料。
 */
window.incomeAppointmentWeek = function(base) {
  const colours = [
    ['#e8f0fe', '#174ea6', '#4285f4'],
    ['#e4f4ed', '#176448', '#34a875'],
    ['#f0e8fc', '#673ab7', '#9b72d0'],
    ['#fff0dc', '#8a5200', '#e6a037'],
    ['#fce7ee', '#a52b58', '#db7095'],
    ['#e0f3f7', '#17677a', '#36a2b8']
  ];

  // 這裡處理「日曆日期」，不使用使用者電腦的本地時區。
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;

    const date = new Date(`${value}T12:00:00Z`);

    return Number.isFinite(date.getTime()) &&
      date.toISOString().slice(0, 10) === value;
  }

  function shiftDate(value, days) {
    const date = new Date(`${value}T12:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  }

  function weekStart(value) {
    const weekday = new Date(`${value}T12:00:00Z`).getUTCDay();
    return shiftDate(value, -((weekday + 6) % 7));
  }

  function safeError(message) {
    const error = new Error(message);
    error.bookingSafe = true;
    return error;
  }

  return {
    ...base,

    awView: window.matchMedia('(max-width: 650px)').matches
      ? 'day'
      : 'week',

    awShowInactive: false,
    awOriginal: '',
    awPositioned: false,

    awHours: Array.from({ length: 24 }, (_, i) => i),
    awSlots: Array.from({ length: 96 }, (_, i) => i * 15),

    awInit() {
      // 原本 apInit 仍然只執行一次。
      this.apInit();

      this.$watch('tab', value => {
        if (value === 'appt') this.awScroll();
      });
    },

    apClear() {
      this.$refs.awDialog?.close();
      this.awOriginal = '';
      this.awPositioned = false;
      this.awShowInactive = false;

      return base.apClear.call(this);
    },

    // 原本儲存成功、取消成功都會呼叫 apNew。
    // 這裡順便關閉編輯面板。
    apNew() {
      this.$refs.awDialog?.close();
      this.apEvents = [];
      this.apHistoryTitle = '';
      this.awOriginal = '';

      return base.apNew.call(this);
    },

    awSafeDate() {
      return validDate(this.apDate) ? this.apDate : this.apToday();
    },

    awDays() {
      const selected = this.awSafeDate();
      const first = this.awView === 'day'
        ? selected
        : weekStart(selected);

      const count = this.awView === 'day' ? 1 : 7;
      const today = this.apToday();

      return Array.from({ length: count }, (_, index) => {
        const date = shiftDate(first, index);
        const weekday =
          new Date(`${date}T12:00:00Z`).getUTCDay();

        return {
          date,
          number: Number(date.slice(8, 10)),
          weekday: ['日', '一', '二', '三', '四', '五', '六'][weekday],
          sunday: weekday === 0,
          today: date === today
        };
      });
    },

    awTitle() {
      const days = this.awDays();
      const first = days[0].date;
      const last = days[days.length - 1].date;

      const full = date => {
        const [y, m, d] = date.split('-').map(Number);
        return `${y}年${m}月${d}日`;
      };

      if (first === last) return full(first);

      if (first.slice(0, 7) === last.slice(0, 7)) {
        return `${full(first)}－${Number(last.slice(8))}日`;
      }

      if (first.slice(0, 4) === last.slice(0, 4)) {
        return `${full(first)}－${Number(last.slice(5, 7))}月${Number(last.slice(8))}日`;
      }

      return `${full(first)}－${full(last)}`;
    },

    awHM(minutes) {
      return String(Math.floor(minutes / 60)).padStart(2, '0') +
        ':' + String(minutes % 60).padStart(2, '0');
    },

    awMinutes(time) {
      const [hours, minutes] = time.split(':').map(Number);
      return hours * 60 + minutes;
    },

    awRowDate(row) {
      // 原有 apDateTime 已經轉成香港時間。
      return this.apDateTime(row.starts_at).slice(0, 10);
    },

    awInactive(row) {
      return ['cancelled', 'no_show'].includes(row.status);
    },

    awRows() {
      // 保留原本姓名／電話／诊所搜尋邏輯。
      return this.apFiltered().filter(row => {
        if (!this.awShowInactive && this.awInactive(row)) {
          return false;
        }

        return this.awView !== 'day' ||
          this.awRowDate(row) === this.awSafeDate();
      });
    },

    awColour(clinicId) {
      let hash = 0;

      for (const char of String(clinicId || '')) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
      }

      const [background, ink, line] =
        colours[hash % colours.length];

      return { background, ink, line };
    },

    awLegend() {
      const seen = new Map();

      for (const row of this.awRows()) {
        const id = String(row.clinic_id);

        if (!seen.has(id)) {
          seen.set(id, {
            id,
            name: row.clinic_name,
            colour: this.awColour(id).line
          });
        }
      }

      return [...seen.values()];
    },

    awDescription(row) {
      return [
        row.patient_label,
        `${this.apTime(row.starts_at)}–${this.apTime(row.ends_at)}`,
        row.clinic_name,
        this.apKindLabel(row.kind),
        this.apStatusLabel(row.status)
      ].join(' · ');
    },

    /*
     * 將有交疊的卡片分組，再分配欄位。
     * 已取消／失約顯示時，也不會完全蓋住有效預約。
     */
    awEvents(date) {
      const items = this.awRows()
        .filter(row => this.awRowDate(row) === date)
        .map(row => {
          const start = this.awMinutes(this.apTime(row.starts_at));
          const duration =
            (new Date(row.ends_at) - new Date(row.starts_at)) / 60000;

          return {
            row,
            start,
            end: Math.min(1440, start + duration),
            lane: 0
          };
        })
        .filter(item =>
          Number.isFinite(item.start) &&
          Number.isFinite(item.end) &&
          item.end > item.start
        )
        .sort((a, b) =>
          a.start - b.start ||
          a.end - b.end ||
          String(a.row.id).localeCompare(String(b.row.id))
        );

      const groups = [];
      let group = [];
      let groupEnd = -1;

      for (const item of items) {
        if (group.length && item.start >= groupEnd) {
          groups.push(group);
          group = [];
          groupEnd = -1;
        }

        group.push(item);
        groupEnd = Math.max(groupEnd, item.end);
      }

      if (group.length) groups.push(group);

      const result = [];

      for (const entries of groups) {
        const laneEnds = [];

        for (const item of entries) {
          let lane = laneEnds.findIndex(end => end <= item.start);

          if (lane === -1) lane = laneEnds.length;

          laneEnds[lane] = item.end;
          item.lane = lane;
        }

        const count = laneEnds.length;

        for (const item of entries) {
          const colour = this.awColour(item.row.clinic_id);
          const duration = item.end - item.start;

          result.push({
            ...item,
            compact: duration < 30,

            style: {
              top: `${item.start * 2}px`,
              height: `${Math.max(2, duration * 2 - 2)}px`,
              left: `calc(${item.lane * 100 / count}% + 2px)`,
              width: `calc(${100 / count}% - 4px)`,
              '--event-bg': colour.background,
              '--event-ink': colour.ink,
              '--event-line': colour.line
            }
          });
        }
      }

      return result;
    },

    awScroll() {
      this.$nextTick(() => {
        const element = this.$refs.awScroll;
        if (element) element.scrollTop = 8 * 60 * 2;
      });
    },

    awSetView(view) {
      if (this.apBusy) return;

      this.awView = view;
      this.awScroll();
    },

    async awMove(direction) {
      if (this.apBusy) return;

      const days = this.awView === 'week' ? 7 : 1;

      this.apDate = shiftDate(
        this.awSafeDate(),
        direction * days
      );

      return this.apRefresh();
    },

    async awToday() {
      if (this.apBusy) return;

      this.apDate = this.apToday();
      await this.apRefresh();
      this.awScroll();
    },

    /*
     * 函式名刻意保留 apFetchDay。
     * 原本 apRefresh / apSave / apCancel 呼叫它時，
     * 現在都會更新完整一週。
     */
    async apFetchDay(alive, user) {
      const selected = this.apDate;

      this.apReady = false;
      this.apRows = [];
      this.apEvents = [];
      this.apHistoryTitle = '';
      this.apReminder = '';

      if (!validDate(selected)) {
        throw safeError('請選擇有效日期。');
      }

      const first = weekStart(selected);
      const next = shiftDate(first, 7);

      const access = await db
        .from('booking_access')
        .select('user_id')
        .eq('user_id', user)
        .maybeSingle();

      if (!alive()) return;
      if (access.error) throw access.error;

      if (!access.data) {
        throw safeError('呢個登入帳戶未獲批准使用病人預約。');
      }

      const rows = [];
      const pageSize = 200;
      let offset = 0;

      for (;;) {
        const { data, error } = await db
          .from('patient_appointments')
          .select('*')
          .eq('owner_id', user)
          .gte('starts_at', `${first}T00:00:00+08:00`)
          .lt('starts_at', `${next}T00:00:00+08:00`)
          .order('starts_at', { ascending: true })
          .order('id', { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (!alive()) return;
        if (error) throw error;
        if (!data?.length) break;

        rows.push(...data);
        offset += data.length;

        if (rows.length > 10000) {
          throw safeError(
            '本週預約數量異常，已停止載入，請檢查資料。'
          );
        }
      }

      if (!alive() || selected !== this.apDate) return;

      this.apRows = rows;
      this.apReady = true;

      if (!this.awPositioned) {
        this.awPositioned = true;
        this.awScroll();
      }
    },

    awFormStamp() {
      // 背景更表核對會改動 schedule_checked，
      // 不應因此誤判為使用者改過表單。
      const { schedule_checked, ...form } = this.apForm;
      return JSON.stringify(form);
    },

    awShowEditor() {
      this.apError = '';
      this.apNotice = '';
      this.apEvents = [];
      this.apHistoryTitle = '';
      this.apReminder = '';
      this.awOriginal = this.awFormStamp();

      this.$nextTick(() => {
        const dialog = this.$refs.awDialog;

        if (!dialog || !this.session) return;
        if (!dialog.open) dialog.showModal();

        dialog.scrollTop = 0;
        this.$refs.awPatient?.focus({ preventScroll: true });
      });
    },

    awCreate(date = this.awSafeDate(), time = '09:00') {
      if (this.apBusy || this.loading || !this.session) return;

      this.apNew();
      this.apForm.date = date;
      this.apForm.start = time;
      this.apSetEnd();

      this.awShowEditor();
    },

    apEdit(row) {
      if (!row || this.apBusy) return;

      base.apEdit.call(this, row);
      this.awShowEditor();
    },

    awClose() {
      if (this.apBusy) return;

      if (
        this.awOriginal &&
        this.awOriginal !== this.awFormStamp() &&
        !confirm('有未儲存嘅修改，確定放棄並關閉？')
      ) {
        return;
      }

      this.apNew();
    },

    awSelected() {
      if (!(this.apForm.version > 0)) return null;

      return this.apRows.find(
        row => row.id === this.apForm.id
      ) || null;
    },

    async awCancelSelected() {
      const row = this.awSelected();
      if (!row || this.apBusy) return;

      if (
        this.awOriginal !== this.awFormStamp() &&
        !confirm('表單有未儲存修改。忽略呢啲修改，取消原有預約？')
      ) {
        return;
      }

      return this.apCancel(row);
    }
  };
};
