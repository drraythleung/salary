const db = (typeof SUPABASE_URL === 'string' && SUPABASE_URL.startsWith('http'))
  ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

function app() {
  return {
    session: null, loading: true, tab: 'home', err: '', ok: '',
    email: '', password: '',
    y: new Date().getFullYear(), m: new Date().getMonth() + 1,
    clinics: [], rules: [], leaves: [], extras: [], overrides: [], logs: [], invoices: [],
    att: [], attOk: true,                          // 返工標記
    profile: { full_name: '', reg_no: '', address: '', phone: '', email: '', bank_name: '', account_name: '', account_no: '', fps_id: '', signature: '', footer_note: '' },
    result: { sessions: [], skipped: [], summary: null },
    adj: { sessions: [], skipped: [] },            // 前後一個月,只供月曆顯示
    cells: [], calSum: { proj: 0 },
    calSel: Calc2.today(),
    recDate: Calc2.today(), recAll: false, recForm: {}, dayLogs: [],
    issueDate: Calc2.today(), remLang: 'both',
    newClinic: { code: '', name: '', hourly_rate: '' },
    ruleForm: { clinic_id: '', weekday: 1, block: 'am', start_time: '09:00', end_time: '13:00' },
    leaveForm: { start_date: '', end_date: '', period: 'full', reason: '' },
    extraForm: { clinic_id: '', date: '', hours: '', fixed_amount: '', note: '' },
    ovForm: { clinic_id: '', date: '', block: 'all', action: 'work', hours: '', note: '' },

    // ---------- 啟動 / 登入 ----------
    async init() {
      if (!db) { this.err = '請先在 config.js 填入 Supabase 的 URL 和 key'; this.loading = false; return; }
      const { data } = await db.auth.getSession();
      this.session = data.session;
      if (this.session) await this.load();
      this.loading = false;
      db.auth.onAuthStateChange((ev, s) => {
        const was = !!this.session;
        this.session = s;
        if (s && !was) setTimeout(() => this.load(), 0);
      });
    },
    async signIn() {
      this.err = '';
      const { error } = await db.auth.signInWithPassword({ email: this.email, password: this.password });
      if (error) this.err = '登入失敗:' + error.message;
    },
    async signOut() {
      await db.auth.signOut();
      this.clinics = []; this.logs = []; this.invoices = []; this.att = []; this.cells = [];
      this.result = { sessions: [], skipped: [], summary: null };
      this.adj = { sessions: [], skipped: [] };
    },

    // ---------- 資料 ----------
    fetchLogs() {
      return db.from('daily_logs').select('*')
        .gte('date', Calc2.monthStart(this.y, this.m, -3))
        .lt('date', Calc2.monthStart(this.y, this.m, 1))
        .order('date', { ascending: true });
    },
    async load() {
      const q = (t, o) => db.from(t).select('*').order(o, { ascending: true });
      const res = await Promise.all([
        q('clinics', 'sort'), q('schedule_rules', 'weekday'), q('leaves', 'start_date'),
        q('extra_sessions', 'date'), q('overrides', 'date'), q('invoices', 'invoice_no'),
        db.from('profile').select('*').maybeSingle(), this.fetchLogs(),
        db.from('attendance').select('*')
      ]);
      const bad = res.slice(0, 8).find(x => x.error);
      if (bad) return this.fail(bad.error);
      [this.clinics, this.rules, this.leaves, this.extras, this.overrides, this.invoices] = res.slice(0, 6).map(x => x.data);
      if (res[6].data) this.profile = { ...this.profile, ...res[6].data };
      this.logs = res[7].data;
      this.attOk = !res[8].error;                  // 未建表唔會令成個 app 失敗
      this.att = this.attOk ? res[8].data : [];
      const first = this.clinics[0]?.id || '';
      for (const f of [this.ruleForm, this.extraForm]) if (!f.clinic_id) f.clinic_id = first;
      this.recForm = Object.fromEntries(this.clinics.map(c => [c.id, { consult: '', proc: '' }]));
      this.recompute();
      await this.loadRec();
    },
    recompute() {
      const D = { clinics: this.clinics, rules: this.rules, leaves: this.leaves, extras: this.extras,
                  overrides: this.overrides, holidays: HK_HOLIDAYS, logs: this.logs };
      const g = Calc.generateMonth(this.y, this.m, D);
      this.result = { ...g, summary: Calc2.summarize(g.sessions, D, this.y, this.m) };

      // 前後一個月:只畫月曆,不入總覽 / invoice 計算
      const nb = n => {
        const t = this.y * 12 + (this.m - 1) + n;
        return Calc.generateMonth(Math.floor(t / 12), (t % 12) + 1, D);
      };
      const p = nb(-1), q = nb(1);
      this.adj = { sessions: [...p.sessions, ...q.sessions], skipped: [...p.skipped, ...q.skipped] };
      this.buildCal();
    },
    async shift(n) {
      let t = this.y * 12 + (this.m - 1) + n;
      this.y = Math.floor(t / 12); this.m = (t % 12) + 1;
      const pre = this.y + '-' + String(this.m).padStart(2, '0') + '-';
      const today = Calc2.today();
      this.calSel = today.startsWith(pre) ? today : pre + '01';
      const key = this.y + '-' + this.m;
      const r = await this.fetchLogs();
      if (key !== this.y + '-' + this.m) return;     // 期間又撳咗第二次,放棄舊結果
      if (r.error) return this.fail(r.error);
      this.logs = r.data;
      this.recompute();
      this.recDate = this.calSel;
      await this.loadRec();
    },
    fail(e) { this.err = e.message || String(e); return false; },
    flash(t) { this.ok = t; setTimeout(() => this.ok = '', 2000); },
    async add(table, row) {
      this.err = '';
      const { error } = await db.from(table).insert(row);
      if (error) return this.fail(error);
      await this.load(); this.flash('已新增'); return true;
    },
    async del(table, id) {
      if (!confirm('確定刪除?')) return;
      const { error } = await db.from(table).delete().eq('id', id);
      if (error) return this.fail(error);
      await this.load();
    },

    // ---------- 診所 ----------
    async saveClinic(c) {
      const n = v => (v === '' || v == null) ? null : +v;
      const t = v => (v === '' || v == null) ? null : v;
      const { error } = await db.from('clinics').update({
        code: c.code, name: c.name, active: c.active,
        hourly_rate: n(c.hourly_rate) || 0, consult_pct: n(c.consult_pct) || 0, procedure_pct: n(c.procedure_pct),
        est_consult_per_day: n(c.est_consult_per_day) || 0, est_procedure_per_day: n(c.est_procedure_per_day) || 0,
        payment_terms_days: n(c.payment_terms_days) || 30,
        bill_name: t(c.bill_name), bill_address: t(c.bill_address),
        contact_name: t(c.contact_name), contact_email: t(c.contact_email), contact_whatsapp: t(c.contact_whatsapp)
      }).eq('id', c.id);
      if (error) return this.fail(error);
      await this.load(); this.flash('已儲存');
    },
    async addClinic() {
      const f = this.newClinic;
      if (!f.code || !f.name) return this.err = '請填代號和名稱';
      if (await this.add('clinics', { code: f.code, name: f.name, hourly_rate: +f.hourly_rate || 0, sort: this.clinics.length + 1 }))
        this.newClinic = { code: '', name: '', hourly_rate: '' };
    },
    rulesOf(id) { return this.rules.filter(r => r.clinic_id === id); },
    clinicOf(id) { return this.clinics.find(c => c.id === id) || {}; },
    async addRule() {
      const f = this.ruleForm;
      if (!f.clinic_id) return this.err = '請先揀診所';
      await this.add('schedule_rules', { clinic_id: f.clinic_id, weekday: f.weekday, block: f.block, start_time: f.start_time, end_time: f.end_time });
    },

    // ---------- 年假 / 調整 ----------
    async addLeave() {
      const f = this.leaveForm;
      if (!f.start_date) return this.err = '請填開始日期';
      const end = f.end_date || f.start_date;
      if (end < f.start_date) return this.err = '結束日不可早過開始日';
      if (await this.add('leaves', { start_date: f.start_date, end_date: end, period: f.period, reason: f.reason || null }))
        this.leaveForm = { start_date: '', end_date: '', period: 'full', reason: '' };
    },
    async addExtra() {
      const f = this.extraForm;
      if (!f.clinic_id || !f.date) return this.err = '請揀診所和日期';
      const fixed = (f.fixed_amount === '' || f.fixed_amount == null) ? null : +f.fixed_amount;
      if (fixed == null && !+f.hours) return this.err = '請填時數,或填固定金額(特更)';
      if (await this.add('extra_sessions', { clinic_id: f.clinic_id, date: f.date, hours: +f.hours || 0, fixed_amount: fixed, note: f.note || null }))
        this.extraForm = { ...f, date: '', hours: '', fixed_amount: '', note: '' };
    },
    async addOverride() {
      const f = this.ovForm;
      if (!f.date) return this.err = '請填日期';
      if (await this.add('overrides', { date: f.date, clinic_id: f.clinic_id || null, block: f.block, action: f.action, hours: f.hours === '' ? null : +f.hours, note: f.note || null }))
        this.ovForm = { ...f, date: '', hours: '', note: '' };
    },
    quickCancel(s) { if (confirm('取消這一節?')) this.add('overrides', { date: s.date, clinic_id: s.clinic_id, block: s.block, action: 'cancel' }); },
    quickWork(s) { this.add('overrides', { date: s.date, clinic_id: s.clinic_id, block: s.block, action: 'work' }); },
    restore(id) { this.del('overrides', id); },

    // ---------- 每日記錄 ----------
    recClinics() {
      const d = this.recDate; if (!d) return [];
      const wd = new Date(d + 'T00:00:00').getDay();
      const sched = new Set(this.rules.filter(r => r.active !== false && r.weekday === wd).map(r => r.clinic_id));
      this.extras.filter(e => e.date === d).forEach(e => sched.add(e.clinic_id));
      return this.clinics.filter(c => c.active && (this.recAll || sched.has(c.id)));
    },
    async loadRec() {
      if (!db || !this.session || !this.recDate) return;
      const { data, error } = await db.from('daily_logs').select('*').eq('date', this.recDate);
      if (error) return this.fail(error);
      this.dayLogs = data;
      const f = {};
      for (const c of this.clinics) {
        const l = data.find(x => x.clinic_id === c.id);
        f[c.id] = { consult: l ? l.consult_total : '', proc: l ? l.procedure_total : '' };
      }
      this.recForm = f;
    },
    async saveRec() {
      this.err = '';
      const blank = v => v === '' || v == null;
      for (const c of this.recClinics()) {
        const f = this.recForm[c.id];
        const ex = this.dayLogs.find(l => l.clinic_id === c.id);
        if (blank(f.consult) && blank(f.proc)) {
          if (ex) { const { error } = await db.from('daily_logs').delete().eq('id', ex.id); if (error) return this.fail(error); }
        } else {
          const { error } = await db.from('daily_logs').upsert(
            { clinic_id: c.id, date: this.recDate, consult_total: +f.consult || 0, procedure_total: +f.proc || 0 },
            { onConflict: 'clinic_id,date' });
          if (error) return this.fail(error);
        }
      }
      const r = await this.fetchLogs();
      if (r.error) return this.fail(r.error);
      this.logs = r.data; this.recompute();
      await this.loadRec(); this.flash('已儲存');
    },
    async goRec(date, clinicId) {
      this.recDate = date;
      if (!this.recClinics().some(c => c.id === clinicId)) this.recAll = true;
      this.tab = 'rec';
      await this.loadRec();
      window.scrollTo(0, 0);
    },
    monthLogs() {
      const p = `${this.y}-${String(this.m).padStart(2, '0')}-`;
      return this.logs.filter(l => l.date.startsWith(p)).sort((a, b) => b.date.localeCompare(a.date));
    },

    // ---------- 月曆 ----------
    _fmt(d) {
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    },
    _share(c, consult, proc) {                     // 分成 = 診金×% + 小手術×%(小手術 % 未設定當 0)
      return (+consult || 0) * (+c.consult_pct || 0) / 100 + (+proc || 0) * (+c.procedure_pct || 0) / 100;
    },
    buildCal() {
      const pad = n => String(n).padStart(2, '0');
      const ms = `${this.y}-${pad(this.m)}-01`;
      const today = Calc2.today();
      const rows = (this.result.summary && this.result.summary.rows) || [];

      // 每間診所「每個返工日」的分成估算
      const est = {};
      for (const c of this.clinics) {
        const row = rows.find(r => r.clinic.id === c.id);
        let ec = +c.est_consult_per_day || 0, ep = +c.est_procedure_per_day || 0;
        if (row && row.src === 'avg') {
          const ls = this.logs.filter(l => l.clinic_id === c.id && l.date < ms);
          if (ls.length) {
            ec = ls.reduce((a, l) => a + (+l.consult_total || 0), 0) / ls.length;
            ep = ls.reduce((a, l) => a + (+l.procedure_total || 0), 0) / ls.length;
          }
        }
        est[c.id] = this._share(c, ec, ep);
      }

      const S = [...(this.result.sessions || []), ...this.adj.sessions];
      const K = [...(this.result.skipped || []), ...this.adj.skipped];
      const logMap = new Map(this.logs.map(l => [l.date + '|' + l.clinic_id, l]));
      const attSet = new Set(this.att.map(a => a.date + '|' + a.clinic_id));

      const first = new Date(this.y, this.m - 1, 1);
      const dim = new Date(this.y, this.m, 0).getDate();
      const weeks = Math.ceil((first.getDay() + dim) / 7);
      const cells = []; let proj = 0;

      for (let i = 0; i < weeks * 7; i++) {
        const d = new Date(this.y, this.m - 1, 1 - first.getDay() + i);
        const ds = this._fmt(d);
        const ss = S.filter(s => s.date === ds), kk = K.filter(k => k.date === ds);
        const hol = kk.find(k => k.why === 'holiday');

        const ent = {};
        const get = id => ent[id] || (ent[id] = {
          clinic_id: id, date: ds, code: this.cl(id), name: this.clinicOf(id).name || this.cl(id),
          sessions: [], offIds: [], hours: 0, base: 0, regular: false
        });
        ss.forEach(s => {
          const e = get(s.clinic_id);
          e.sessions.push(s); e.hours += +s.hours || 0; e.base += +s.base || 0;
          if (s.kind === 'regular') e.regular = true;
        });
        kk.filter(k => k.why === 'cancel').forEach(k => {
          const e = get(k.clinic_id);
          if (k.ov_id && !e.offIds.includes(k.ov_id)) e.offIds.push(k.ov_id);
        });

        const list = Object.values(ent);
        list.forEach(e => {
          const c = this.clinicOf(e.clinic_id);
          const log = logMap.get(ds + '|' + e.clinic_id);
          e.off = e.sessions.length === 0;                       // 全部節數都被取消
          e.log = !!log;
          e.worked = attSet.has(ds + '|' + e.clinic_id);
          e.estShare = (e.regular && !e.off) ? (est[e.clinic_id] || 0) : 0;
          e.budget = e.off ? 0 : e.base + e.estShare;
          if (e.off) e.actual = null;
          else if (e.regular) e.actual = log ? e.base + this._share(c, log.consult_total, log.procedure_total) : null;
          else e.actual = ds <= today ? e.base : null;           // 加節/特更:冇分成,過咗日就等於時薪/固定金額
          e.diff = e.actual == null ? null : e.actual - e.budget;
          e.missing = !e.off && e.regular && !e.log && ds < today;
        });

        const live = list.filter(e => !e.off);
        const done = live.filter(e => e.actual != null);
        const cellProj = live.reduce((a, e) => a + (e.actual != null ? e.actual : e.budget), 0);
        const inMonth = d.getMonth() === this.m - 1 && d.getFullYear() === this.y;
        if (inMonth) proj += cellProj;

        cells.push({
          date: ds, day: d.getDate(), dow: d.getDay(), inMonth,
          isToday: ds === today,
          holiday: hol ? hol.reason : '',
          other: kk.filter(k => k.why !== 'cancel'),
          entries: list,
          budget: live.reduce((a, e) => a + e.budget, 0),
          hasActual: done.length > 0,
          actual: done.reduce((a, e) => a + e.actual, 0),
          diff: done.reduce((a, e) => a + e.diff, 0),
          mark: !list.length ? '' : (!live.length ? 'no' : (live.every(e => e.worked) ? 'yes' : (live.some(e => e.worked) ? 'part' : '')))
        });
      }
      this.cells = cells;
      this.calSum = { proj };
    },
    calCells() { return this.cells; },
    selCell() { return this.cells.find(c => c.date === this.calSel) || null; },
    async selectDay(ds) {
      this.calSel = ds;
      this.recDate = ds;
      await this.loadRec();
    },
    async calToday() {
      const n = new Date();
      const diff = (n.getFullYear() - this.y) * 12 + (n.getMonth() + 1 - this.m);
      if (diff) await this.shift(diff);
      await this.selectDay(this._fmt(n));
    },

    // ---------- 返工標記 ----------
    async reloadAtt() {
      const r = await db.from('attendance').select('*');
      if (r.error) return this.fail(r.error);
      this.att = r.data; this.attOk = true; this.buildCal();
    },
    async toggleWork(e) {                           // 有返工 ⇄ 未標記
      if (!this.attOk) return this.err = '未建立 attendance 表,請先在 Supabase 執行 SQL';
      const ex = this.att.find(a => a.date === e.date && a.clinic_id === e.clinic_id);
      const r = ex
        ? await db.from('attendance').delete().eq('id', ex.id)
        : await db.from('attendance').insert({ clinic_id: e.clinic_id, date: e.date });
      if (r.error) return this.fail(r.error);
      await this.reloadAtt();
    },
    async markOff(e) {                              // 冇返工 = 取消當日所有固定節數(預算扣除)
      const rows = e.sessions.filter(s => s.kind === 'regular')
        .map(s => ({ date: s.date, clinic_id: s.clinic_id, block: s.block, action: 'cancel' }));
      if (!rows.length) return this.err = '呢個係加節/特更,請用「刪除」';
      if (!confirm('標記為冇返工?呢日呢間診所會由預算扣除(可隨時復原)。')) return;
      const ex = this.att.find(a => a.date === e.date && a.clinic_id === e.clinic_id);
      if (ex) { const r = await db.from('attendance').delete().eq('id', ex.id); if (r.error) return this.fail(r.error); }
      const { error } = await db.from('overrides').insert(rows);
      if (error) return this.fail(error);
      await this.load();
    },
    async undoOff(e) {                              // 復原冇返工(刪走取消的 override)
      if (!e.offIds.length) return;
      const { error } = await db.from('overrides').delete().in('id', e.offIds);
      if (error) return this.fail(error);
      await this.load();
    },

    // ---------- Invoice ----------
    invOf(clinicId) { return this.invoices.find(i => i.clinic_id === clinicId && i.year === this.y && i.month === this.m) || null; },
    invRows() { return (this.result.summary?.rows || []).map(r => ({ r, inv: this.invOf(r.clinic.id) })); },
    async createInvoice(row) {
      const c = row.clinic;
      if (this.invOf(c.id)) return;
      if (!this.issueDate) return this.err = '請填發出日期';
      if (row.pending && !confirm('呢間診所小手術 % 未設定,小手術分成會當 0 計。繼續?')) return;
      if (row.missing.length && !confirm(`仲有 ${row.missing.length} 日未填診金/小手術記錄,invoice 分成會偏少。繼續?`)) return;
      const t = Calc2.today();
      const future = this.result.sessions.filter(s => s.clinic_id === c.id && s.date > t).length;
      if (future && !confirm(`呢張 invoice 包含 ${future} 節未來日子的更。繼續?`)) return;
      const inv = Calc2.buildInvoice(c, this.y, this.m, this.result.sessions, this.logs, this.issueDate);
      await this.add('invoices', {
        clinic_id: c.id, year: this.y, month: this.m, invoice_no: inv.invoice_no,
        issue_date: inv.issue_date, due_date: inv.due_date, total: inv.total, snapshot: inv.snapshot
      });
    },
    async setStatus(inv, status) {
      const patch = { status };
      const t = Calc2.today();
      if (status === 'sent') { patch.sent_date = t; patch.paid_date = null; }
      if (status === 'paid') {
        const d = prompt('收款日期(YYYY-MM-DD)', t);
        if (!d) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return this.err = '日期格式應為 YYYY-MM-DD';
        patch.paid_date = d;
      }
      if (status === 'draft') { patch.sent_date = null; patch.paid_date = null; }
      const { error } = await db.from('invoices').update(patch).eq('id', inv.id);
      if (error) return this.fail(error);
      await this.load();
    },
    printInv(inv) { InvoiceDoc.open(inv, this.clinicOf(inv.clinic_id), this.profile); },
    statusLabel(i) { return ({ draft: '草稿(未發送)', sent: '已發送', paid: '已收款' })[i.status]; },
    isOverdue(i) { return i.status === 'sent' && i.due_date < Calc2.today(); },
    overdueDays(i) { return Calc2.daysBetween(i.due_date, Calc2.today()); },
    overdueList() { return this.invoices.filter(i => this.isOverdue(i)); },
    openList() { return this.invoices.filter(i => i.status !== 'paid').sort((a, b) => a.due_date.localeCompare(b.due_date)); },
    paidList() { return this.invoices.filter(i => i.status === 'paid').sort((a, b) => (b.paid_date || '').localeCompare(a.paid_date || '')); },

    // ---------- 逾期提醒 ----------
    remindText(i) { return Calc2.reminder(i, this.clinicOf(i.clinic_id), this.profile)[this.remLang]; },
    waLink(i) {
      let num = (this.clinicOf(i.clinic_id).contact_whatsapp || '').replace(/\D/g, '');
      if (num.length === 8) num = '852' + num;
      return `https://wa.me/${num}?text=${encodeURIComponent(this.remindText(i))}`;
    },
    mailLink(i) {
      const c = this.clinicOf(i.clinic_id), r = Calc2.reminder(i, c, this.profile);
      return `mailto:${c.contact_email || ''}?subject=${encodeURIComponent(r.subject)}&body=${encodeURIComponent(r[this.remLang])}`;
    },
    async copyText(t) {
      try { await navigator.clipboard.writeText(t); this.flash('已複製'); }
      catch (e) { this.err = '複製失敗,請手動選取文字'; }
    },

    // ---------- 設定 ----------
    async saveProfile() {
      this.err = '';
      const { error } = await db.from('profile').upsert({ ...this.profile, user_id: this.session.user.id }, { onConflict: 'user_id' });
      if (error) return this.fail(error);
      this.flash('已儲存');
    },
    pickSignature(ev) {
      const file = ev.target.files[0]; if (!file) return;
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const w = Math.min(400, img.width), h = Math.round(img.height * w / img.width);
        const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        this.profile.signature = cv.toDataURL('image/png');
        URL.revokeObjectURL(url);
      };
      img.onerror = () => this.err = '圖片讀取失敗';
      img.src = url;
    },

    // ---------- 顯示用 ----------
    money(n) { return 'HK$ ' + Math.round(n || 0).toLocaleString('en-US'); },
    kfmt(n) { n = Math.round(n || 0); return Math.abs(n) >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(n); },
    signed(n) { n = Math.round(n || 0); return (n >= 0 ? '+' : '−') + Math.abs(n).toLocaleString('en-US'); },
    cl(id) { const c = this.clinics.find(x => x.id === id); return c ? c.code : '?'; },
    blk(b) { return ({ am: '上午', pm: '下午', all: '全日' })[b] || ''; },
    wk(i) { return '日一二三四五六'[i]; },
    hm(t) { return (t || '').slice(0, 5); },
    dlabel(d) { return `${+d.slice(5, 7)}/${+d.slice(8, 10)}(${this.wk(new Date(d + 'T00:00:00').getDay())})`; }
  };
}
