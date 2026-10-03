// Phase 2:實際分成、預計 vs 預算、Invoice 內容、逾期提醒
const Calc2 = (() => {
  const pad = n => String(n).padStart(2, '0');
  const sumOf = (a, k) => a.reduce((t, x) => t + Number(x[k] || 0), 0);
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = () => fmt(new Date());
  const addDays = (s, n) => { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return fmt(d); };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5); // b - a
  const monthStart = (y, m, off = 0) => { const t = y * 12 + (m - 1) + off; return `${Math.floor(t / 12)}-${pad(t % 12 + 1)}-01`; };
  const round2 = n => Math.round(n * 100) / 100;

  function dayHours(id, rules) {
    const by = {};
    rules.filter(r => r.clinic_id === id && r.active !== false)
         .forEach(r => by[r.weekday] = (by[r.weekday] || 0) + Calc.hoursOf(r));
    const v = Object.values(by);
    return v.length ? Math.max(...v) : 8;
  }

  // 估算每日診金/小手術:過去 3 個月有 >=5 日記錄就用平均,否則用手動數字
  function estimate(c, logs, y, m) {
    const from = monthStart(y, m, -3), to = monthStart(y, m);
    const ls = logs.filter(l => l.clinic_id === c.id && l.date >= from && l.date < to);
    if (ls.length >= 5) {
      return { consult: sumOf(ls, 'consult_total') / ls.length, proc: sumOf(ls, 'procedure_total') / ls.length, src: 'avg', n: ls.length };
    }
    return { consult: Number(c.est_consult_per_day), proc: Number(c.est_procedure_per_day), src: 'manual', n: ls.length };
  }

  function summarize(sessions, D, y, m) {
    const prefix = `${y}-${pad(m)}-`, t = today();
    const monthLogs = D.logs.filter(l => l.date.startsWith(prefix));
    const plan = Calc.summarize(sessions, D);                         // Phase 1 預算(純手動估算)
    const planBy = Object.fromEntries(plan.rows.map(r => [r.clinic.id, r]));

    const acc = {};
    const get = id => acc[id] ??= { dates: new Set(), hours: 0, base: 0, byDate: {} };
    for (const s of sessions) {
      const a = get(s.clinic_id);
      a.dates.add(s.date); a.hours += s.hours; a.base += s.base;
      if (s.kind !== 'special') a.byDate[s.date] = (a.byDate[s.date] || 0) + s.hours;
    }
    for (const l of monthLogs) get(l.clinic_id);

    const rows = D.clinics.filter(c => acc[c.id]).map(c => {
      const a = acc[c.id], dh = dayHours(c.id, D.rules), e = estimate(c, D.logs, y, m);
      const cp = Number(c.consult_pct) / 100;
      const pending = c.procedure_pct == null;
      const pp = pending ? 0 : Number(c.procedure_pct) / 100;
      const ls = monthLogs.filter(l => l.clinic_id === c.id);
      const logged = new Set(ls.map(l => l.date));
      const aC = sumOf(ls, 'consult_total') * cp, aP = sumOf(ls, 'procedure_total') * pp;
      let eC = 0, eP = 0, unlogged = 0;
      const missing = [];
      for (const [date, h] of Object.entries(a.byDate)) {
        if (logged.has(date)) continue;
        unlogged++;
        const f = h / dh;
        eC += e.consult * f * cp; eP += e.proc * f * pp;
        if (date < t && (cp > 0 || pp > 0)) missing.push({ date, clinic_id: c.id });
      }
      return {
        clinic: c, days: a.dates.size, hours: a.hours, base: a.base,
        aC, aP, eC, eP, pending, src: e.src, nAvg: e.n, nLogged: logged.size, unlogged, missing,
        total: a.base + aC + aP + eC + eP, plan: planBy[c.id] ? planBy[c.id].total : 0
      };
    }).sort((p, q) => p.clinic.sort - q.clinic.sort);

    const sum = k => rows.reduce((s, r) => s + r[k], 0);
    return {
      rows, base: sum('base'), actual: sum('aC') + sum('aP'), estimated: sum('eC') + sum('eP'),
      total: sum('total'), plan: plan.total, pending: rows.some(r => r.pending),
      missing: rows.flatMap(r => r.missing).sort((p, q) => p.date.localeCompare(q.date))
    };
  }

  // 生成 invoice 內容(用實際記錄,唔用估算)
  function buildInvoice(c, y, m, sessions, logs, issueDate) {
    const rate = Number(c.hourly_rate);
    const lines = sessions.filter(s => s.clinic_id === c.id).map(s => ({
      date: s.date, block: s.block, kind: s.kind, hours: s.hours,
      rate: s.kind === 'special' ? null : rate, amount: s.base, note: s.note || null
    }));
    const base = sumOf(lines, 'amount');
    const ls = logs.filter(l => l.clinic_id === c.id && l.date.startsWith(`${y}-${pad(m)}-`));
    const cT = sumOf(ls, 'consult_total'), pT = sumOf(ls, 'procedure_total');
    const cPct = Number(c.consult_pct);
    const pPct = c.procedure_pct == null ? null : Number(c.procedure_pct);
    const cAmt = cT * cPct / 100, pAmt = pPct == null ? 0 : pT * pPct / 100;
    return {
      invoice_no: `${y}-${pad(m)}-${c.code}`,
      issue_date: issueDate,
      due_date: addDays(issueDate, Number(c.payment_terms_days) || 30),
      total: round2(base + cAmt + pAmt),
      snapshot: {
        period: { y, m }, clinic_code: c.code,
        bill_name: c.bill_name || c.name, bill_address: c.bill_address || '',
        lines, base,
        consult: { total: cT, pct: cPct, amount: cAmt },
        procedure: { total: pT, pct: pPct, amount: pAmt },
        logged_days: ls.length
      }
    };
  }

  // 逾期提醒(中英)
  function reminder(inv, clinic, profile) {
    const od = daysBetween(inv.due_date, today());
    const amt = 'HK$ ' + Math.round(inv.total).toLocaleString('en-US');
    const who = (clinic && clinic.contact_name) || '';
    const me = (profile && profile.full_name) || '';
    const zh = `${who}你好,\n想跟進 Invoice ${inv.invoice_no}(${amt},到期日 ${inv.due_date}),${od > 0 ? `現時已逾期 ${od} 日` : '即將到期'}。煩請協助安排付款。如已付款,請忽略此訊息。多謝!\n${me}`;
    const en = `Hi${who ? ' ' + who : ''},\nA gentle reminder on Invoice ${inv.invoice_no} (${amt}, due ${inv.due_date})${od > 0 ? `, now ${od} day(s) overdue` : ''}. Could you please arrange payment? If already paid, please ignore this message. Thank you!\n${me}`;
    return { zh, en, both: zh + '\n\n' + en, subject: `Invoice ${inv.invoice_no} 付款提醒 Payment reminder` };
  }

  return { summarize, buildInvoice, reminder, today, addDays, daysBetween, monthStart };
})();
