function incomeDashboard(base) {
  const pad = n => String(n).padStart(2, '0');
  const keyOf = r => `${r.date}|${r.clinic_id}`;

  // 空值視為未填；異常數值不可靜默變成 0。
  const num = value => {
    if (value === '' || value == null) return 0;
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new Error('資料包含無效金額／時數，請檢查原有記錄。');
    }
    return n;
  };

  const completeAmount = value =>
    value !== '' &&
    value != null &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0;

  const validDate = value => {
    if (typeof value !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

    const [y, m, d] = value.split('-').map(Number);
    const dt = new Date(y, m - 1, d);

    return dt.getFullYear() === y &&
      dt.getMonth() === m - 1 &&
      dt.getDate() === d;
  };

  // 每次最多要求 500 筆；按實際回傳數量繼續讀取。
  // 同時檢查總筆數，避免只讀取部分資料卻顯示完整總額。
  async function readAll(table, filter = q => q) {
    const rows = [];
    let expected = null;

    while (true) {
      const query = filter(
        db.from(table).select('*', { count: 'exact' })
      )
        .order('id', { ascending: true })
        .range(rows.length, rows.length + 499);

      const { data, count, error } = await query;

      if (error) {
        throw new Error(`${table} 讀取失敗：${error.message}`);
      }

      if (!Array.isArray(data) || !Number.isInteger(count)) {
        throw new Error(`${table} 未能確認資料完整性，請重新讀取。`);
      }

      if (expected == null) expected = count;

      if (count !== expected) {
        throw new Error('讀取期間資料筆數有改動，請再按「更新總覽」。');
      }

      if (!data.length && rows.length < expected) {
        throw new Error(`${table} 未能完整讀取，請重新讀取。`);
      }

      rows.push(...data);

      if (rows.length >= expected) {
        if (
          rows.length !== expected ||
          new Set(rows.map(r => r.id)).size !== rows.length
        ) {
          throw new Error(`${table} 分頁資料不一致，請重新讀取。`);
        }
        return rows;
      }
    }
  }

  return {
    ...base,

    tabs: [
      base.tabs[0],
      ['dash', 'Dashboard／收入總覽'],
      ...base.tabs.slice(1)
    ],

    dashYear: new Date().getFullYear(),
    dashRows: [],
    dashReady: false,
    dashBusy: false,
    dashError: '',
    dashUpdated: '',
    dashPaymentWarnings: 0,
    dashRequest: 0,

    async init() {
      // 切入總覽時重新讀取，避免其他頁修改後仍顯示舊數字。
      this.$watch('tab', value => {
        if (value === 'dash' && this.session) {
          this.refreshDashboard();
        }
      });

      // 登出／切換使用者後清除資料，並使舊請求失效。
      this.$watch('session', (value, oldValue) => {
        const uid = value?.user?.id;
        const oldUid = oldValue?.user?.id;

        if (uid !== oldUid) {
          this.clearDashboard();

          if (uid && this.tab === 'dash') {
            this.refreshDashboard();
          }
        }
      });

      await base.init.call(this);
    },

    clearDashboard() {
      this.dashRequest++;
      this.dashRows = [];
      this.dashReady = false;
      this.dashBusy = false;
      this.dashError = '';
      this.dashUpdated = '';
      this.dashPaymentWarnings = 0;
    },

    // 保留原本重新讀取功能；若正在 Dashboard，亦更新總覽。
    async load() {
      this.dashReady = false;
      const result = await base.load.call(this);

      if (this.tab === 'dash' && this.session) {
        await this.refreshDashboard();
      }

      return result;
    },

    // 修正首頁預計收入：只計時薪／固定金額。
    monthBudget() {
      return (this.result.sessions || [])
        .reduce((total, s) => total + num(s.base), 0);
    },

    // 修正月曆「預 HK$」：不再包含估算分成。
    buildCal() {
      base.buildCal.call(this);

      for (const cell of this.cells) {
        cell.budget = cell.entries
          .filter(e => !e.off)
          .reduce((total, e) => total + num(e.base), 0);
      }
    },

    async changeDashYear(offset) {
      this.dashYear = Number(this.dashYear) + offset;
      await this.refreshDashboard();
    },

    dashTotal(field) {
      return this.dashRows.reduce(
        (total, row) => total + (Number(row[field]) || 0),
        0
      );
    },

    dashWidth(value) {
      const max = Math.max(
        1,
        ...this.dashRows.map(r => Math.max(r.budget, r.earned))
      );

      return `${Math.max(0, Math.min(100, value / max * 100))}%`;
    },

    async openDashMonth(month) {
      const year = Number(this.dashYear);
      const difference = (year - this.y) * 12 + month - this.m;

      await this.shift(difference);
      if (this.err) return;

      this.tab = 'home';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    },

    async refreshDashboard() {
      const request = ++this.dashRequest;
      const uid = this.session?.user?.id;
      const year = Number(this.dashYear);

      this.dashReady = false;
      this.dashBusy = false;
      this.dashError = '';
      this.dashUpdated = '';
      this.dashRows = [];
      this.dashPaymentWarnings = 0;

      if (!uid || !db) return;

      if (!Number.isInteger(year) || year < 1900 || year > 9998) {
        this.dashError = '請輸入有效年份。';
        return;
      }

      this.dashBusy = true;

      const from = `${year}-01-01`;
      const to = `${year + 1}-01-01`;
      const inYear = q => q.gte('date', from).lt('date', to);

      const stillCurrent = () =>
        request === this.dashRequest &&
        this.session?.user?.id === uid &&
        Number(this.dashYear) === year;

      try {
        // 全年計算使用獨立資料，唔修改原本月曆陣列。
        const [
          clinics,
          rules,
          leaves,
          extras,
          overrides,
          logs,
          attendance,
          invoices
        ] = await Promise.all([
          readAll('clinics'),
          readAll('schedule_rules'),
          readAll('leaves'),
          readAll('extra_sessions', inYear),
          readAll('overrides', inYear),
          readAll('daily_logs', inYear),
          readAll('attendance', inYear),

          // 讀取可見發票，包括其他工作年份：
          // 舊年份發票可能喺所選年份先收款。
          readAll('invoices')
        ]);

        if (!stillCurrent()) return;

        const today = this.todayDate();
        const clinicMap = new Map(clinics.map(c => [c.id, c]));

        const worked = new Set(
          attendance
            .filter(a => a.date <= today)
            .map(keyOf)
        );

        const logMap = new Map(logs.map(l => [keyOf(l), l]));

        const D = {
          clinics,
          rules,
          leaves,
          extras,
          overrides,
          logs,
          holidays: HK_HOLIDAYS
        };

        const rows = [];

        for (let month = 1; month <= 12; month++) {
          const prefix = `${year}-${pad(month)}`;
          const monthPrefix = prefix + '-';
          const { sessions } = Calc.generateMonth(year, month, D);

          const row = {
            month,
            prefix,
            budget: 0,
            base: 0,
            share: 0,
            earned: 0,
            cash: 0,
            outstanding: 0,
            draft: 0,
            pending: 0
          };

          // 同日同診所只有一筆分成；
          // 基本收入則逐節相加。
          const shareDays = new Map();

          for (const s of sessions) {
            const amount = num(s.base);
            row.budget += amount;

            const key = keyOf(s);
            if (!worked.has(key)) continue;

            row.base += amount;

            // 固定金額特更不要求額外分成記錄。
            // 普通加節跟原本開單檢查一樣，需要檢查分成。
            if (s.kind !== 'special') {
              shareDays.set(key, s.clinic_id);
            }
          }

          const pending = new Set();

          for (const [key, clinicId] of shareDays) {
            const c = clinicMap.get(clinicId);

            if (!c) {
              throw new Error('工作記錄對應診所不存在，未能準確計算。');
            }

            const log = logMap.get(key);
            const requiresShare =
              num(c.consult_pct) > 0 ||
              num(c.procedure_pct) > 0;

            if (
              c.procedure_pct == null ||
              (
                requiresShare &&
                (
                  !log ||
                  !completeAmount(log.consult_total) ||
                  !completeAmount(log.procedure_total)
                )
              )
            ) {
              pending.add(key);
            }
          }

          // 跟現有首頁 gross() 一樣：
          // 有返工確認才計實際診金分成，且每筆日誌只計一次。
          for (const log of logs) {
            if (!log.date.startsWith(monthPrefix)) continue;

            const key = keyOf(log);
            if (!worked.has(key)) continue;

            const c = clinicMap.get(log.clinic_id);

            if (!c) {
              throw new Error(
                `${log.date} 診金記錄對應診所不存在，未能準確計算。`
              );
            }

            row.share +=
              num(log.consult_total) * num(c.consult_pct) / 100 +
              num(log.procedure_total) * num(c.procedure_pct) / 100;

            if (
              c.procedure_pct == null ||
              !completeAmount(log.consult_total) ||
              !completeAmount(log.procedure_total)
            ) {
              pending.add(key);
            }
          }

          row.pending = pending.size;
          row.earned = row.base + row.share;
          rows.push(row);
        }

        let paymentWarnings = 0;

        for (const inv of invoices) {
          // 未收款／草稿：歸屬發票所記錄嘅工作月份。
          if (Number(inv.year) === year) {
            const month = Number(inv.month);

            if (!Number.isInteger(month) || month < 1 || month > 12) {
              throw new Error(
                `發票 ${inv.invoice_no || inv.id} 嘅工作月份無效。`
              );
            }

            const row = rows[month - 1];

            if (inv.status === 'sent') {
              row.outstanding += num(inv.total);
            }

            if (inv.status === 'draft') {
              row.draft += num(inv.total);
            }
          }

          // 實際收款：按 paid_date，而唔係工作月份。
          if (inv.status === 'paid') {
            const date = inv.paid_date;

            if (!validDate(date) || date > today) {
              paymentWarnings++;
              continue;
            }

            if (date >= from && date < to) {
              const month = Number(date.slice(5, 7));
              rows[month - 1].cash += num(inv.total);
            }
          }
        }

        if (!stillCurrent()) return;

        this.dashRows = rows;
        this.dashPaymentWarnings = paymentWarnings;
        this.dashUpdated = new Date().toLocaleString('zh-HK');
        this.dashReady = true;

      } catch (error) {
        if (!stillCurrent()) return;

        this.dashRows = [];
        this.dashReady = false;
        this.dashError =
          '未能完成全年統計：' +
          (error.message || String(error)) +
          ' 未讀取成功嘅資料唔會當成 HK$ 0。';

      } finally {
        if (request === this.dashRequest) {
          this.dashBusy = false;
        }
      }
    }
  };
}
