/**
 * appointments.js
 * 單醫生、單操作帳戶；全部預約時間以香港時間顯示。
 * 不使用 localStorage 儲存病人資料。
 */
window.incomeAppointments = function(base) {
  const kinds = [
    ['initial', '初診', 30],
    ['followup', '覆診', 15],
    ['procedure', '小手術', 30],
    ['other', '其他', 15]
  ];

  const statuses = [
    ['booked', '已預約'],
    ['confirmed', '已確認'],
    ['arrived', '已到達'],
    ['completed', '已完成'],
    ['cancelled', '已取消'],
    ['no_show', '失約']
  ];

  function hk(value = new Date()) {
    const date = value instanceof Date ? value : new Date(value);

    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Hong_Kong',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(date);

    const p = Object.fromEntries(
      parts.filter(x => x.type !== 'literal')
        .map(x => [x.type, x.value])
    );

    return {
      date: `${p.year}-${p.month}-${p.day}`,
      time: `${p.hour}:${p.minute}`
    };
  }

  function dateShift(date, days) {
    const d = new Date(`${date}T12:00:00+08:00`);
    d.setTime(d.getTime() + days * 86400000);
    return hk(d).date;
  }

  function blank(date) {
    return {
      id: '',
      version: 0,
      date,
      clinic_id: '',
      clinic_name: '',
      patient_label: '',
      phone: '',
      kind: 'followup',
      start: '09:00',
      end: '09:15',
      status: 'booked',
      schedule_checked: false
    };
  }

  function safeError(message) {
    const error = new Error(message);
    error.bookingSafe = true;
    return error;
  }

  const today = hk().date;

  return {
    ...base,

    tabs: [
      ...(base.tabs || []).filter(t => t[0] !== 'appt'),
      ['appt', '病人預約']
    ],

    apKinds: kinds,
    apStatuses: statuses,

    apDate: today,
    apClinic: '',
    apSearch: '',
    apRows: [],
    apForm: blank(today),

    apBusy: false,
    apError: '',
    apNotice: '',
    apReady: false,
    apUser: '',
    apToken: 0,

    apEvents: [],
    apHistoryTitle: '',
    apReminder: '',
apSchedule: {
  level: 'input',
  messages: ['請選擇日期、診所及時間。']
},
apScheduleSeq: 0,
apScheduleTimer: null,

apScheduleKey() {
  const f = this.apForm;

  return JSON.stringify([
    f.id,
    f.date,
    f.clinic_id,
    f.start,
    f.end,
    f.status
  ]);
},

apQueueSchedule() {
  clearTimeout(this.apScheduleTimer);

  // 即時令舊查詢失效，唔等下一次查詢開始。
  this.apScheduleSeq++;
  this.apForm.schedule_checked = false;

  if (!this.session) {
    this.apSchedule = {
      level: 'input',
      messages: ['請先登入。']
    };
    return;
  }

  this.apSchedule = {
    level: 'loading',
    messages: ['正在核對更表……']
  };

  this.apScheduleTimer = setTimeout(() => {
    this.apPreviewSchedule();
  }, 300);
},

async apCheckSchedule(form) {
  const unavailable = message => ({
    level: 'unknown',
    messages: [message]
  });

  if (
    typeof window.AppointmentSchedule?.check !== 'function'
  ) {
    return unavailable(
      '更表核對模組未載入，請檢查 appointment-schedule.js 是否已正確載入。'
    );
  }

  try {
    const checked = await window.AppointmentSchedule.check(db, form);

    const levels = [
      'input', 'unknown', 'block', 'warn', 'ok', 'skip'
    ];

    if (
      !checked ||
      !levels.includes(checked.level) ||
      !Array.isArray(checked.messages) ||
      !checked.messages.every(message => typeof message === 'string') ||
      (checked.level === 'skip' && form.status !== 'cancelled')
    ) {
      return unavailable(
        '更表核對結果無效，暫時不能儲存，請重新載入頁面再試。'
      );
    }

    return checked;
  } catch {
    return unavailable(
      '無法核對更表，請檢查登入、網絡及更表設定後再試。'
    );
  }
},
    
async apPreviewSchedule() {
  const seq = ++this.apScheduleSeq;
  const user = this.session?.user?.id;
  const key = this.apScheduleKey();
  const form = { ...this.apForm };

  if (!user) return;

const checked = await this.apCheckSchedule(form);

  if (
    seq !== this.apScheduleSeq ||
    user !== this.session?.user?.id ||
    key !== this.apScheduleKey()
  ) return;

  this.apSchedule = checked;
},
    apInit() {
      this.apUser = this.session?.user?.id || '';
      this.apNew();

      this.$watch('tab', value => {
        if (value === 'appt' && this.session) {
          this.apRefresh();
        }
      });

      this.$watch('session', () => {
        const user = this.session?.user?.id || '';

        if (user !== this.apUser) {
          this.apClear();
          this.apUser = user;

          if (user && this.tab === 'appt') {
            this.apRefresh();
          }
        }
      });

      if (this.session && this.tab === 'appt') {
        this.apRefresh();
      }
      this.$watch('apScheduleKey()', () => {
  this.apQueueSchedule();
});

this.$watch('tab', value => {
  if (value === 'appt') this.apQueueSchedule();
});

this.$watch('session', () => {
  this.apQueueSchedule();
});

this.apQueueSchedule();
    },

    apClear() {
      clearTimeout(this.apScheduleTimer);
this.apScheduleSeq++;
this.apSchedule = {
  level: 'input',
  messages: ['請選擇日期、診所及時間。']
};
      // 使已發出但未完成的請求失效。
      this.apToken++;
      this.apBusy = false;
      this.apRows = [];
      this.apEvents = [];
      this.apHistoryTitle = '';
      this.apReminder = '';
      this.apError = '';
      this.apNotice = '';
      this.apSearch = '';
      this.apClinic = '';
      this.apReady = false;
      this.apDate = hk().date;
      this.apForm = blank(this.apDate);
    },

    async signOut(...args) {
      this.apClear();
      return await base.signOut.apply(this, args);
    },

    apToday() {
      return hk().date;
    },

    apDateTime(value) {
      if (!value) return '—';
      const p = hk(value);
      return `${p.date} ${p.time}`;
    },

    apTime(value) {
      return value ? hk(value).time : '—';
    },

    apKindLabel(value) {
      return kinds.find(x => x[0] === value)?.[1] || value;
    },

    apStatusLabel(value) {
      return statuses.find(x => x[0] === value)?.[1] || value;
    },

    apErrorText(error) {
      if (error?.bookingSafe) return error.message;

      switch (error?.code) {
        case '23P01':
          return '呢段時間已有其他有效預約，包括其他診所。請更改時間。';
        case '23505':
          return '呢筆草稿可能已經儲存。請先重新讀取，避免重複新增。';
        case '42501':
          return '冇預約資料存取權限。請檢查批准帳戶及資料庫權限。';
        case '23514':
          return '資料不符合限制。請檢查姓名／編號、診所、日期及時間。';
        case 'PGRST205':
        case '42P01':
          return '預約資料表未準備好，請先完成 SQL 安裝。';
        default:
          return '操作未能確認完成。請檢查網絡及登入狀態；如剛才係儲存，先重新讀取確認，唔好立即重複新增。';
      }
    },

    async apRun(task) {
      if (this.apBusy) return;

      const user = this.session?.user?.id;

      if (!user) {
        this.apClear();
        return;
      }

      const token = ++this.apToken;
      const alive = () =>
        token === this.apToken &&
        this.session?.user?.id === user;

      this.apBusy = true;
      this.apError = '';
      this.apNotice = '';

      try {
        await task(alive, user);
      } catch (error) {
        if (alive()) this.apError = this.apErrorText(error);
      } finally {
        if (alive()) this.apBusy = false;
      }
    },

    async apFetchDay(alive, user) {
      const date = this.apDate;

      this.apReady = false;
      this.apRows = [];
      this.apEvents = [];
      this.apHistoryTitle = '';
      this.apReminder = '';

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw safeError('請選擇有效日期。');
      }

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

      const from = `${date}T00:00:00+08:00`;
      const to = `${dateShift(date, 1)}T00:00:00+08:00`;

      const rows = [];
      const pageSize = 200;

      // 分頁讀取，避免單次回傳上限導致列表靜靜缺漏。
      for (let offset = 0; ; offset += pageSize) {
        const { data, error } = await db
          .from('patient_appointments')
          .select('*')
          .eq('owner_id', user)
          .gte('starts_at', from)
          .lt('starts_at', to)
          .order('starts_at', { ascending: true })
          .order('id', { ascending: true })
          .range(offset, offset + pageSize - 1);

        if (!alive()) return;
        if (error) throw error;

        rows.push(...(data || []));

        // 讀到空頁才停止，不假設專案 API 上限。
        if (!data?.length) break;

        if (rows.length > 5000) {
          throw safeError('當日記錄數量異常，已停止載入，請檢查資料。');
        }

        // 按實際取得數量推進，兼容較小 API 回傳上限。
        offset += data.length - pageSize;
      }

      if (!alive()) return;

      this.apRows = rows;
      this.apReady = true;
    },

    async apRefresh() {
      return this.apRun((alive, user) =>
        this.apFetchDay(alive, user)
      );
    },

    async apMoveDay(days) {
      this.apDate = dateShift(this.apDate || hk().date, days);
      return this.apRefresh();
    },

    apFiltered() {
      const q = this.apSearch.trim().toLocaleLowerCase();
      const phoneQ = q.replace(/[^\d+]/g, '');

      return this.apRows.filter(row => {
        if (
          this.apClinic &&
          String(row.clinic_id) !== String(this.apClinic)
        ) return false;

        if (!q) return true;

        const text = [
          row.patient_label,
          row.phone
        ].join(' ').toLocaleLowerCase();

        const phone = (row.phone || '').replace(/[^\d+]/g, '');

        return text.includes(q) ||
          (phoneQ.length >= 3 && phone.includes(phoneQ));
      });
    },

    apNew() {
      const form = blank(this.apDate || hk().date);

      if (this.apClinic) {
        form.clinic_id = String(this.apClinic);
      } else if ((this.clinics || []).length === 1) {
        form.clinic_id = String(this.clinics[0].id);
      }

      this.apForm = form;
      this.apReminder = '';
    },

    apSetEnd() {
      const f = this.apForm;
      f.schedule_checked = false;

      if (!/^\d{2}:\d{2}$/.test(f.start)) return;

      const duration = kinds.find(x => x[0] === f.kind)?.[2] || 15;
      const [h, m] = f.start.split(':').map(Number);
      const end = h * 60 + m + duration;

      if (end >= 1440) {
        f.end = '';
        return;
      }

      f.end =
        String(Math.floor(end / 60)).padStart(2, '0') + ':' +
        String(end % 60).padStart(2, '0');
    },

    apEdit(row) {
      const start = hk(row.starts_at);
      const end = hk(row.ends_at);

      this.apForm = {
        id: row.id,
        version: row.version,
        date: start.date,
        clinic_id: String(row.clinic_id),
        clinic_name: row.clinic_name,
        patient_label: row.patient_label,
        phone: row.phone || '',
        kind: row.kind,
        start: start.time,
        end: end.time,
        status: row.status,
        schedule_checked: false
      };

      this.apReminder = '';
      this.apError = '';
      this.apNotice = '';

      this.$nextTick(() => {
        this.$refs.apEditor?.scrollIntoView({
          behavior: 'smooth',
          block: 'start'
        });
      });
    },

    apPayload(form) {
if (
  form.status !== 'cancelled' &&
  !form.schedule_checked
) {
  throw safeError('請先核對當日返工時段及休假，再勾選確認。');
}

      const label = form.patient_label.trim();
      const phone = form.phone.trim();

      if (!label || label.length > 100 || phone.length > 32) {
        throw safeError('姓名／病歷編號必須填寫，並請檢查欄位長度。');
      }

      const clinic = (this.clinics || []).find(
        c => String(c.id) === String(form.clinic_id)
      );

      // 舊診所已從設定移除時，容許原預約保留原有快照。
      const originalClinic =
        form.version > 0 &&
        form.clinic_name &&
        this.apRows.some(row =>
          row.id === form.id &&
          String(row.clinic_id) === String(form.clinic_id)
        );

      if (!clinic && !originalClinic) {
        throw safeError('請選擇有效診所。');
      }

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(form.date) ||
        !/^\d{2}:\d{2}$/.test(form.start) ||
        !/^\d{2}:\d{2}$/.test(form.end)
      ) {
        throw safeError('請填寫有效日期、開始及結束時間。');
      }

      const start = new Date(
        `${form.date}T${form.start}:00+08:00`
      );
      const end = new Date(
        `${form.date}T${form.end}:00+08:00`
      );

      const duration = (end - start) / 60000;

      if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        duration > 480 ||
        hk(start).date !== form.date ||
        hk(start).time !== form.start ||
        hk(end).date !== form.date ||
        hk(end).time !== form.end
      ) {
        throw safeError('結束時間須晚於開始時間，同日內最多 8 小時；跨午夜請拆開。');
      }

      if (
        !kinds.some(x => x[0] === form.kind) ||
        !statuses.some(x => x[0] === form.status)
      ) {
        throw safeError('預約類型或狀態無效。');
      }

      return {
        clinic_id: String(form.clinic_id),
        clinic_name: clinic ? clinic.name : form.clinic_name,
        patient_label: label,
        phone,
        kind: form.kind,
        starts_at: start.toISOString(),
        ends_at: end.toISOString(),
        status: form.status
      };
    },

    async apSave() {
      return this.apRun(async (alive, user) => {
const f = { ...this.apForm };
const payload = this.apPayload(f);
const stamp = JSON.stringify(f);

// 儲存前重新讀取，唔只相信畫面上的預覽結果。
const checked = await this.apCheckSchedule(f);

if (!alive()) return;

// 等待期間改過表單，就唔儲存舊快照。
if (JSON.stringify(this.apForm) !== stamp) {
  throw safeError('核對期間表單已改動，請重新核對後再儲存。');
}

// 防止未完成的預覽覆蓋今次儲存核對結果。
clearTimeout(this.apScheduleTimer);
this.apScheduleSeq++;
this.apSchedule = checked;

if (['input', 'unknown', 'block'].includes(checked.level)) {
  throw safeError(checked.messages.join('\n'));
}

if (
  checked.level === 'warn' &&
  !confirm(
    checked.messages.join('\n\n') +
    '\n\n我已另外確認返工診所、完整時段及休假安排，仍然儲存？'
  )
) {
  return;
}

let result;

        if (f.version > 0) {
          result = await db
            .from('patient_appointments')
            .update(payload)
            .eq('id', f.id)
            .eq('owner_id', user)
            .eq('version', f.version)
            .select('id')
            .maybeSingle();
        } else {
          if (!this.apForm.id) {
            if (!globalThis.crypto?.randomUUID) {
              throw safeError('請使用支援安全連線的瀏覽器，並透過 HTTPS 開啟系統。');
            }

            // 同一草稿重試沿用同一 ID，避免網絡中斷後重複新增。
            this.apForm.id = globalThis.crypto.randomUUID();
          }

          result = await db
            .from('patient_appointments')
            .insert({
              id: this.apForm.id,
              ...payload
            })
            .select('id')
            .maybeSingle();
        }

        if (!alive()) return;
        if (result.error) throw result.error;

        if (!result.data) {
          throw safeError('記錄可能已在其他視窗修改，或存取權限已改變。請重新讀取，再開啟最新記錄；今次未覆蓋舊資料。');
        }

        this.apDate = f.date;
        this.apNew();
        this.apNotice = '預約已儲存。';

        // 即使重新讀取失敗，仍保留上方「已儲存」提示。
        await this.apFetchDay(alive, user);
      });
    },

    async apCancel(row) {
      if (!confirm(
        `取消 ${row.patient_label} 於 ${this.apDateTime(row.starts_at)} 的預約？`
      )) return;

      return this.apRun(async (alive, user) => {
        const { data, error } = await db
          .from('patient_appointments')
          .update({ status: 'cancelled' })
          .eq('id', row.id)
          .eq('owner_id', user)
          .eq('version', row.version)
          .select('id')
          .maybeSingle();

        if (!alive()) return;
        if (error) throw error;

        if (!data) {
          throw safeError('呢筆預約已變更或權限已改變。請重新讀取後再操作。');
        }

        if (this.apForm.id === row.id) this.apNew();

        this.apNotice = '預約已取消，記錄保留。';
        await this.apFetchDay(alive, user);
      });
    },

    async apHistory(row) {
      return this.apRun(async (alive, user) => {
        this.apEvents = [];
        this.apHistoryTitle = '';

        const { data, error } = await db
          .from('patient_appointment_events')
          .select('*')
          .eq('owner_id', user)
          .eq('appointment_id', row.id)
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(100);

        if (!alive()) return;
        if (error) throw error;

        this.apEvents = data || [];
        this.apHistoryTitle = `${row.patient_label} · 最近 100 筆更改紀錄`;
      });
    },

    apScheduleText(schedule) {
      if (!schedule) return '—';

      return [
        this.apDateTime(schedule.starts_at),
        '– ' + this.apTime(schedule.ends_at),
        schedule.clinic_name,
        this.apKindLabel(schedule.kind),
        this.apStatusLabel(schedule.status)
      ].join(' · ');
    },

    async apCopyReminder(row) {
      if (['cancelled', 'no_show', 'completed'].includes(row.status)) {
        this.apError = '此預約已取消、失約或完成，不產生預約提醒。';
        return;
      }

      const start = hk(row.starts_at);

      this.apReminder =
        `你好，提醒你已預約於 ${start.date} ` +
        `${start.time} 到 ${row.clinic_name} 應診。` +
        `如需改期或取消，請聯絡診所。謝謝。`;

      this.apError = '';

      try {
        await navigator.clipboard.writeText(this.apReminder);
        this.apNotice = '提醒文字已複製，發送前請核對收件人及內容。';
      } catch {
        this.apNotice = '未能自動複製，請在下方文字框手動複製。';
      }
    }
  };
};
