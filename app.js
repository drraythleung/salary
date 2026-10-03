const db = (typeof SUPABASE_URL === 'string' && SUPABASE_URL.startsWith('http'))
  ? supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

function app() {
  return {
    session: null, loading: true, tab: 'home', err: '', ok: '',
    email: '', password: '',
    y: new Date().getFullYear(), m: new Date().getMonth() + 1,
    clinics: [], rules: [], leaves: [], extras: [], overrides: [],
    result: { sessions: [], skipped: [], summary: null },
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
    async signOut() { await db.auth.signOut(); this.clinics = []; this.result = { sessions: [], skipped: [], summary: null }; },

    // ---------- 資料 ----------
    async load() {
      const q = (t, o) => db.from(t).select('*').order(o, { ascending: true });
      const res = await Promise.all([q('clinics', 'sort'), q('schedule_rules', 'weekday'), q('leaves', 'start_date'), q('extra_sessions', 'date'), q('overrides', 'date')]);
      const bad = res.find(x => x.error);
      if (bad) return this.fail(bad.error);
      [this.clinics, this.rules, this.leaves, this.extras, this.overrides] = res.map(x => x.data);
      const first = this.clinics[0]?.id || '';
      for (const f of [this.ruleForm, this.extraForm]) if (!f.clinic_id) f.clinic_id = first;
      this.recompute();
    },
    recompute() {
      const D = { clinics: this.clinics, rules: this.rules, leaves: this.leaves, extras: this.extras, overrides: this.overrides, holidays: HK_HOLIDAYS };
      const g = Calc.generateMonth(this.y, this.m, D);
      this.result = { ...g, summary: Calc.summarize(g.sessions, D) };
    },
    shift(n) { let t = this.y * 12 + (this.m - 1) + n; this.y = Math.floor(t / 12); this.m = (t % 12) + 1; this.recompute(); },
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
      const { error } = await db.from('clinics').update({
        code: c.code, name: c.name, active: c.active,
        hourly_rate: n(c.hourly_rate) || 0, consult_pct: n(c.consult_pct) || 0, procedure_pct: n(c.procedure_pct),
        est_consult_per_day: n(c.est_consult_per_day) || 0, est_procedure_per_day: n(c.est_procedure_per_day) || 0,
        payment_terms_days: n(c.payment_terms_days) || 30
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

    // ---------- 顯示用 ----------
    money(n) { return 'HK$ ' + Math.round(n || 0).toLocaleString('en-US'); },
    cl(id) { const c = this.clinics.find(x => x.id === id); return c ? c.code : '?'; },
    blk(b) { return ({ am: '上午', pm: '下午', all: '全日' })[b] || ''; },
    wk(i) { return '日一二三四五六'[i]; },
    hm(t) { return (t || '').slice(0, 5); },
    dlabel(d) { return `${+d.slice(5, 7)}/${+d.slice(8, 10)}(${this.wk(new Date(d + 'T00:00:00').getDay())})`; }
  };
}
