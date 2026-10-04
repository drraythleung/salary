// appointment-schedule.js
// 只核對更表，不讀取或儲存病人資料。
window.AppointmentSchedule = (() => {
  const result = (level, ...messages) => ({ level, messages });
  const same = (a, b) => String(a) === String(b);

  function minute(value) {
    const s = String(value || '');

    // 接受表單 HH:mm，以及資料庫 HH:mm:00。
    if (!/^(?:[01]\d|2[0-3]):[0-5]\d(?::00(?:\.0+)?)?$/.test(s)) {
      return NaN;
    }

    return Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  }

  function validDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return false;

    const d = new Date(`${date}T00:00:00Z`);
    return Number.isFinite(d.getTime()) &&
      d.toISOString().slice(0, 10) === date;
  }

  function interval(row) {
    const start = minute(row.start_time);
    const end = minute(row.end_time);

    return Number.isFinite(start) &&
      Number.isFinite(end) &&
      end > start
      ? { start, end }
      : null;
  }

  function overlaps(a, b) {
    // 09:00–10:00 與 10:00–11:00 不算重疊。
    return a.start < b.end && b.start < a.end;
  }

  function covered(target, slots) {
    // 容許相連更次合併，但不可跨過中間休息時間。
    let cursor = target.start;

    for (const slot of [...slots].sort((a, b) => a.start - b.start)) {
      if (slot.end <= cursor) continue;
      if (slot.start > cursor) return false;

      cursor = Math.max(cursor, slot.end);
      if (cursor >= target.end) return true;
    }

    return false;
  }

  async function readAll(client, table, filter = q => q) {
    const rows = [];
    let offset = 0;

    while (true) {
      const { data, error } = await filter(
        client.from(table).select('*')
      )
        .order('id', { ascending: true })
        .range(offset, offset + 199);

      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Invalid schedule response');
      if (!data.length) return rows;

      rows.push(...data);
      offset += data.length;

      if (rows.length > 10000) {
        throw new Error('Schedule row limit exceeded');
      }
    }
  }

  async function read(client, date) {
    const [clinics, rules, leaves, extras, overrides] = await Promise.all([
      readAll(client, 'clinics'),
      readAll(client, 'schedule_rules'),
      readAll(client, 'leaves', q =>
        q.lte('start_date', date).gte('end_date', date)
      ),
      readAll(client, 'extra_sessions', q => q.eq('date', date)),
      readAll(client, 'overrides', q => q.eq('date', date))
    ]);

    if (
      typeof HK_HOLIDAYS === 'undefined' ||
      !HK_HOLIDAYS ||
      typeof HK_HOLIDAYS !== 'object'
    ) {
      throw new Error('Holiday data unavailable');
    }

    return {
      clinics, rules, leaves, extras, overrides,
      holidays: HK_HOLIDAYS
    };
  }

  function evaluate(form, D) {
    const date = form.date;
    const selected = form.clinic_id;
    const target = {
      start: minute(form.start),
      end: minute(form.end)
    };

    const clinic = D.clinics.find(c => same(c.id, selected));

    if (!clinic) {
      return result('unknown', '無法核對：所選診所不存在或目前無權讀取。');
    }

    if (!clinic.active) {
      return result('block', '所選診所已停用，請先修改診所設定。');
    }

    const wd = new Date(`${date}T00:00:00Z`).getUTCDay();

    const rules = D.rules.filter(r => {
      const c = D.clinics.find(x => same(x.id, r.clinic_id));

      return c?.active &&
        r.active !== false &&
        r.weekday === wd &&
        (!r.valid_from || date >= r.valid_from) &&
        (!r.valid_to || date <= r.valid_to);
    });

    // 預約採較保守政策：
    // 全日休假／所選診所全日取消，先修改更表才接受預約。
    if (D.leaves.some(l => l.period === 'full')) {
      return result('block', '當日已設定全日休假，請先修改更表。');
    }

    const cancels = D.overrides.filter(o =>
      o.action === 'cancel' &&
      (!o.clinic_id || same(o.clinic_id, selected))
    );

    if (cancels.some(o => o.block === 'all')) {
      return result('block', '所選診所當日已設定全日取消，請先修改更表。');
    }

    // 半日休假以原有 rule.block 對應時間；
    // 不自行假設上午／下午以 12:00 分界。
    for (const leave of D.leaves) {
      const matching = rules.filter(r => r.block === leave.period);
      const spans = matching.map(interval);

      if (!matching.length || spans.some(s => !s)) {
        return result(
          'unknown',
          '當日有半日休假，但缺少可對應的有效更次時間；請先補清楚更表。'
        );
      }

      if (spans.some(s => overlaps(target, s))) {
        return result('block', '此預約與已設定的休假時段重疊。');
      }
    }

    for (const cancel of cancels) {
      const matching = rules.filter(r =>
        same(r.clinic_id, selected) && r.block === cancel.block
      );
      const spans = matching.map(interval);

      if (!matching.length || spans.some(s => !s)) {
        return result(
          'unknown',
          '當日有取消更次，但無法確定取消的實際時段；請先核對更表。'
        );
      }

      if (spans.some(s => overlaps(target, s))) {
        return result('block', '此預約與所選診所已取消的更次重疊。');
      }
    }

    const [y, m] = date.split('-').map(Number);
    const generated = Calc.generateMonth(y, m, D);

    const sessions = generated.sessions.filter(s => s.date === date);
    const skipped = generated.skipped.filter(s => s.date === date);

    const warnings = [];
    const known = [];

    const nameOf = id => {
      const c = D.clinics.find(x => same(x.id, id));
      return c?.name || c?.code || '其他診所';
    };

    for (const s of sessions) {
      if (s.kind !== 'regular') {
        warnings.push(
          `${nameOf(s.clinic_id)} 當日有加節／特更，` +
          '但目前未記錄起訖時間，無法完整核對。'
        );
        continue;
      }

      if (s.time_known !== true) {
        warnings.push(
          `${nameOf(s.clinic_id)} 當日有調整時數的更次，` +
          '但未指定調整後的起訖時間。'
        );
        continue;
      }

      const span = interval(s);

      if (!span) {
        return result(
          'unknown',
          '固定更的起訖時間無效或跨午夜，請先修改更表。'
        );
      }

      known.push({ ...span, clinic_id: s.clinic_id });
    }

    // 公眾假期停更，但其他已明確恢復的時段仍可核對。
    for (const s of skipped.filter(s =>
      s.why === 'holiday' && same(s.clinic_id, selected)
    )) {
      const span = interval(s);

      if (!span) {
        return result('unknown', '無法確定假期停更的實際時段。');
      }

      if (overlaps(target, span)) {
        warnings.push(
          '此時段原有固定更因公眾假期停開，請確認是否加開診症。'
        );
      }
    }

    const own = known.filter(s => same(s.clinic_id, selected));
    const elsewhere = known.filter(s =>
      !same(s.clinic_id, selected) && overlaps(target, s)
    );

    const clock = n =>
      String(Math.floor(n / 60)).padStart(2, '0') + ':' +
      String(n % 60).padStart(2, '0');

    const describe = s =>
      `${clock(s.start)}–${clock(s.end)} ${nameOf(s.clinic_id)}`;

    if (elsewhere.length) {
      warnings.push(
        '預約時段與另一間診所的返工安排重疊：' +
        elsewhere.map(describe).join('；')
      );
    }

    if (!covered(target, own)) {
      if (own.length) {
        warnings.push('此預約未完全落在所選診所的已知返工時段內。');
      } else if (known.length) {
        warnings.push(
          '所選診所未有可核對的返工時段。當日已知安排：' +
          known.map(describe).join('；')
        );
      } else {
        warnings.push(
          '當日未有可核對的固定返工時段，請確認是否加開診症。'
        );
      }
    }

    if (warnings.length) {
      return result('warn', ...new Set(warnings));
    }

    return result('ok', '此預約完整落在所選診所的返工時段內。');
  }

  async function check(client, form) {
    if (form.status === 'cancelled') {
      return result('skip', '取消預約不需要符合返工時段。');
    }

    const start = minute(form.start);
    const end = minute(form.end);

    if (
      !validDate(form.date) ||
      !form.clinic_id ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      end - start > 480
    ) {
      return result(
        'input',
        '請選擇診所、有效日期及同日內不超過 8 小時的預約時段。'
      );
    }

    try {
      return evaluate(form, await read(client, form.date));
    } catch {
      return result(
        'unknown',
        '無法核對更表：讀取失敗或資料不完整。請檢查登入、網絡及更表設定。'
      );
    }
  }

// 從一個已知時段扣除休假／取消時段。
  function subtractSpans(source, exclusions) {
    let parts = [source];

    for (const cut of exclusions) {
      const next = [];

      for (const part of parts) {
        if (!overlaps(part, cut)) {
          next.push(part);
          continue;
        }

        if (part.start < cut.start) {
          next.push({
            start: part.start,
            end: Math.min(part.end, cut.start)
          });
        }

        if (cut.end < part.end) {
          next.push({
            start: Math.max(part.start, cut.end),
            end: part.end
          });
        }
      }

      parts = next;
    }

    return parts.filter(part => part.end > part.start);
  }

  function nextDate(value) {
    const d = new Date(`${value}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  }

  async function calendar(client, first, last) {
    if (
      !validDate(first) ||
      !validDate(last) ||
      first > last
    ) {
      throw new Error('Invalid calendar range');
    }

    const dayCount =
      (new Date(`${last}T12:00:00Z`) -
       new Date(`${first}T12:00:00Z`)) / 86400000 + 1;

    if (dayCount > 31) {
      throw new Error('Calendar range too large');
    }

    // 讀取涉及月份的完整資料，讓 generateMonth 使用。
    // 一個跨月週會分別產生兩個月份，再抽取畫面日期。
    const monthFirst = `${first.slice(0, 7)}-01`;

    const endDate = new Date(
      `${last.slice(0, 7)}-01T12:00:00Z`
    );
    endDate.setUTCMonth(endDate.getUTCMonth() + 1);
    endDate.setUTCDate(0);

    const monthLast = endDate.toISOString().slice(0, 10);

    const [clinics, rules, leaves, extras, overrides] =
      await Promise.all([
        readAll(client, 'clinics'),
        readAll(client, 'schedule_rules'),

        readAll(client, 'leaves', q =>
          q.lte('start_date', monthLast)
            .gte('end_date', monthFirst)
        ),

        readAll(client, 'extra_sessions', q =>
          q.gte('date', monthFirst).lte('date', monthLast)
        ),

        readAll(client, 'overrides', q =>
          q.gte('date', monthFirst).lte('date', monthLast)
        )
      ]);

    if (
      typeof HK_HOLIDAYS === 'undefined' ||
      !HK_HOLIDAYS ||
      typeof HK_HOLIDAYS !== 'object' ||
      typeof Calc === 'undefined' ||
      typeof Calc.generateMonth !== 'function'
    ) {
      throw new Error('Schedule dependencies unavailable');
    }

    const D = {
      clinics,
      rules,
      leaves,
      extras,
      overrides,
      holidays: HK_HOLIDAYS
    };

    const slots = [];
    const notes = {};
    const months = new Map();

    const nameOf = id => {
      const clinic = clinics.find(c => same(c.id, id));
      return clinic?.name || clinic?.code || '其他診所';
    };

    function note(date, text) {
      if (!notes[date]) notes[date] = [];
      if (!notes[date].includes(text)) notes[date].push(text);
    }

    for (
      let date = first;
      date <= last;
      date = nextDate(date)
    ) {
      const monthKey = date.slice(0, 7);

      if (!months.has(monthKey)) {
        const [year, month] = monthKey.split('-').map(Number);
        const generated = Calc.generateMonth(year, month, D);

        if (
          !Array.isArray(generated?.sessions) ||
          !Array.isArray(generated?.skipped)
        ) {
          throw new Error('Invalid generated schedule');
        }

        months.set(monthKey, generated);
      }

      const generated = months.get(monthKey);

      const dayLeaves = leaves.filter(l =>
        l.start_date <= date && l.end_date >= date
      );

      const dayCancels = overrides.filter(o =>
        o.date === date && o.action === 'cancel'
      );

      // 與 check() 相同：全日休假優先。
      if (dayLeaves.some(l => l.period === 'full')) {
        note(date, '全日休假');
        continue;
      }

      const weekday =
        new Date(`${date}T00:00:00Z`).getUTCDay();

      const dayRules = rules.filter(r => {
        const clinic = clinics.find(c =>
          same(c.id, r.clinic_id)
        );

        return clinic?.active &&
          r.active !== false &&
          r.weekday === weekday &&
          (!r.valid_from || date >= r.valid_from) &&
          (!r.valid_to || date <= r.valid_to);
      });

      // 半日休假按 rule.block 對應，不假設 12:00 分界。
      const leaveCuts = [];
      let unresolvedLeave = false;

      for (const leave of dayLeaves) {
        const matching = dayRules.filter(r =>
          r.block === leave.period
        );
        const spans = matching.map(interval);

        if (!matching.length || spans.some(s => !s)) {
          unresolvedLeave = true;
          note(
            date,
            '半日休假時間未能確認，暫不顯示可點擊返工時段。'
          );
        } else {
          leaveCuts.push(...spans);
        }
      }

      for (const cancel of dayCancels) {
        if (cancel.block !== 'all') continue;

        note(
          date,
          cancel.clinic_id
            ? `${nameOf(cancel.clinic_id)}：全日取消`
            : '全部診所：全日取消'
        );
      }

      for (const skipped of generated.skipped.filter(s =>
        s.date === date && s.why === 'holiday'
      )) {
        note(
          date,
          `${nameOf(skipped.clinic_id)}：有固定更因公眾假期停開`
        );
      }

      const sessions = generated.sessions.filter(s =>
        s.date === date
      );

      for (const session of sessions) {
        const clinic = clinics.find(c =>
          same(c.id, session.clinic_id)
        );

        if (!clinic?.active) continue;

        const clinicName = nameOf(session.clinic_id);

        const cancels = dayCancels.filter(o =>
          !o.clinic_id ||
          same(o.clinic_id, session.clinic_id)
        );

        // 與 check() 相同：全日取消不當成返工時段。
        if (cancels.some(o => o.block === 'all')) continue;

        if (session.kind !== 'regular') {
          note(
            date,
            `${clinicName}：加節／特更，時間待確認`
          );
          continue;
        }

        if (session.time_known !== true) {
          note(
            date,
            `${clinicName}：已調整時數，時間待確認`
          );
          continue;
        }

        const span = interval(session);

        if (!span) {
          note(
            date,
            `${clinicName}：固定更時間無效或跨午夜，請核對更表`
          );
          continue;
        }

        if (unresolvedLeave) continue;

        const cancelCuts = [];
        let unresolvedCancel = false;

        for (const cancel of cancels) {
          const matching = dayRules.filter(r =>
            same(r.clinic_id, session.clinic_id) &&
            r.block === cancel.block
          );

          const spans = matching.map(interval);

          if (!matching.length || spans.some(s => !s)) {
            unresolvedCancel = true;
            note(
              date,
              `${clinicName}：取消更次時間未能確認，暫不顯示可點擊返工時段`
            );
          } else {
            cancelCuts.push(...spans);
          }
        }

        if (unresolvedCancel) continue;

        const parts = subtractSpans(
          span,
          [...leaveCuts, ...cancelCuts]
        );

        for (const part of parts) {
          slots.push({
            date,
            clinic_id: session.clinic_id,
            clinic_name: clinicName,
            start: part.start,
            end: part.end
          });
        }
      }
    }

    // 同一診所的重疊／相連時段合併，避免重複底色及標籤。
    slots.sort((a, b) =>
      a.date.localeCompare(b.date) ||
      String(a.clinic_id).localeCompare(String(b.clinic_id)) ||
      a.start - b.start ||
      a.end - b.end
    );

    const merged = [];

    for (const slot of slots) {
      const previous = merged[merged.length - 1];

      if (
        previous &&
        previous.date === slot.date &&
        same(previous.clinic_id, slot.clinic_id) &&
        slot.start <= previous.end
      ) {
        previous.end = Math.max(previous.end, slot.end);
      } else {
        merged.push({ ...slot });
      }
    }

    return {
      slots: merged.map((slot, index) => ({
        ...slot,
        id: `work-${slot.date}-${index}`
      })),
      notes
    };
  }

  return { check, calendar };
})();
