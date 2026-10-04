const Calc = (() => {
  const pad = n => String(n).padStart(2, '0');
  const toMin = t => { const [h, m] = t.split(':'); return +h * 60 + +m; };
  const hoursOf = r => (toMin(r.end_time) - toMin(r.start_time)) / 60;
  const inRange = (d, from, to) => (!from || d >= from) && (!to || d <= to);

  // 該診所「標準一日」的時數(用來按比例估算分成)
  function dayHours(clinicId, rules) {
    const by = {};
    rules.filter(r => r.clinic_id === clinicId && r.active !== false)
         .forEach(r => by[r.weekday] = (by[r.weekday] || 0) + hoursOf(r));
    const v = Object.values(by);
    return v.length ? Math.max(...v) : 8;
  }

  function generateMonth(y, m, D) {
    const days = new Date(y, m, 0).getDate();
    const cmap = Object.fromEntries(D.clinics.map(c => [c.id, c]));
    const sessions = [], skipped = [];

    for (let d = 1; d <= days; d++) {
      const date = `${y}-${pad(m)}-${pad(d)}`;
      const wd = new Date(y, m - 1, d).getDay();
      const hol = D.holidays[date];
      for (const r of D.rules) {
        const c = cmap[r.clinic_id];
        if (!c || !c.active || r.active === false || r.weekday !== wd || !inRange(date, r.valid_from, r.valid_to)) continue;

        const ovs = D.overrides.filter(o => o.date === date &&
          (!o.clinic_id || o.clinic_id === r.clinic_id) && (o.block === 'all' || o.block === r.block));
        const cancel = ovs.find(o => o.action === 'cancel');
        const work = ovs.find(o => o.action === 'work');
        const base = {
          date,
          clinic_id: r.clinic_id,
          block: r.block,
          start_time: r.start_time,
          end_time: r.end_time
        };

        if (cancel) { skipped.push({ ...base, why: 'cancel', reason: '已取消' + (cancel.note ? `(${cancel.note})` : ''), ov_id: cancel.id }); continue; }
        if (hol && !work) { skipped.push({ ...base, why: 'holiday', reason: hol }); continue; }
        const leave = D.leaves.find(l => date >= l.start_date && date <= l.end_date && (l.period === 'full' || l.period === r.block));
        if (leave) { skipped.push({ ...base, why: 'leave', reason: '年假' + (leave.reason ? `(${leave.reason})` : '') }); continue; }

        const hours = work && work.hours != null ? Number(work.hours) : hoursOf(r);
        sessions.push({ ...base, kind: 'regular', hours, base: hours * Number(c.hourly_rate), ov_id: work ? work.id : null });
      }
    }

    const prefix = `${y}-${pad(m)}-`;
    for (const e of D.extras) {
      if (!e.date.startsWith(prefix) || !cmap[e.clinic_id]) continue;
      const fixed = e.fixed_amount != null;
      sessions.push({
        date: e.date, clinic_id: e.clinic_id, block: '', kind: fixed ? 'special' : 'extra',
        hours: Number(e.hours),
        base: fixed ? Number(e.fixed_amount) : Number(e.hours) * Number(cmap[e.clinic_id].hourly_rate),
        extra_id: e.id, note: e.note
      });
    }
    const cmp = (a, b) => a.date.localeCompare(b.date) || (a.block || '').localeCompare(b.block || '');
    sessions.sort(cmp); skipped.sort(cmp);
    return { sessions, skipped };
  }

  function summarize(sessions, D) {
    const acc = {};
    for (const s of sessions) {
      const c = D.clinics.find(x => x.id === s.clinic_id);
      const r = acc[c.id] ??= { clinic: c, dates: new Set(), hours: 0, base: 0, cHours: 0 };
      r.dates.add(s.date); r.hours += s.hours; r.base += s.base;
      if (s.kind !== 'special') r.cHours += s.hours;   // 特更固定金額不加分成
    }
    const rows = Object.values(acc).map(r => {
      const c = r.clinic, f = r.cHours / dayHours(c.id, D.rules);
      const consult = Number(c.est_consult_per_day) * f * Number(c.consult_pct) / 100;
      const pending = c.procedure_pct == null;
      const proc = pending ? 0 : Number(c.est_procedure_per_day) * f * Number(c.procedure_pct) / 100;
      return { clinic: c, days: r.dates.size, hours: r.hours, base: r.base, consult, proc, pending,
               commission: consult + proc, total: r.base + consult + proc };
    }).sort((a, b) => a.clinic.sort - b.clinic.sort);
    const sum = k => rows.reduce((t, x) => t + x[k], 0);
    return { rows, base: sum('base'), commission: sum('commission'), total: sum('total'), pending: rows.some(x => x.pending) };
  }

  return { generateMonth, summarize, hoursOf };
})();
