// Invoice 列印頁(新視窗 → 瀏覽器列印 → 另存 PDF)
const InvoiceDoc = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = n => 'HK$ ' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const WD = '日一二三四五六';

  function html(inv, clinic, p) {
    const s = inv.snapshot, P = p || {};
    const wd = d => `${+d.slice(5, 7)}/${+d.slice(8, 10)}(${WD[new Date(d + 'T00:00:00').getDay()]})`;
    const net = Math.round((new Date(inv.due_date + 'T00:00:00') - new Date(inv.issue_date + 'T00:00:00')) / 864e5);
    const desc = l => {
      const note = l.note ? ' – ' + esc(l.note) : '';
      if (l.kind === 'special') return '特別更 Special session' + note;
      if (l.kind === 'extra') return '加節 Additional session' + note;
      return '診症服務 Clinical session' + (l.block === 'am' ? ' 上午 AM' : l.block === 'pm' ? ' 下午 PM' : '');
    };
    const rows = s.lines.map(l => `<tr><td>${wd(l.date)}</td><td>${desc(l)}</td>
      <td class="r">${l.kind === 'special' ? '' : l.hours}</td><td class="r">${l.rate == null ? '' : money(l.rate)}</td>
      <td class="r">${money(l.amount)}</td></tr>`).join('');

    let comm = '';
    if (s.consult.pct > 0) comm += `<tr><td colspan="4">診金分成 Consultation fee share — 當月診金總額 ${money(s.consult.total)} × ${s.consult.pct}%</td><td class="r">${money(s.consult.amount)}</td></tr>`;
    if (s.procedure.pct != null && s.procedure.pct > 0) comm += `<tr><td colspan="4">小手術分成 Minor procedure share — 當月小手術總額 ${money(s.procedure.total)} × ${s.procedure.pct}%</td><td class="r">${money(s.procedure.amount)}</td></tr>`;

    const pay = [
      P.bank_name && `銀行 Bank: ${esc(P.bank_name)}`,
      P.account_name && `戶口名稱 Account name: ${esc(P.account_name)}`,
      P.account_no && `戶口號碼 Account no.: ${esc(P.account_no)}`,
      P.fps_id && `轉數快 FPS: ${esc(P.fps_id)}`
    ].filter(Boolean).join('<br>');
    const sig = P.signature && String(P.signature).startsWith('data:image/') ? `<img class="sig" src="${esc(P.signature)}">` : '';

    return `<!DOCTYPE html><html lang="zh-HK"><head><meta charset="UTF-8"><title>Invoice ${esc(inv.invoice_no)}</title>
<style>
@page { size: A4; margin: 15mm; }
body { font-family: "Noto Sans TC","PingFang HK","Microsoft JhengHei",Arial,sans-serif; font-size: 12px; color: #111; }
.top { display: flex; justify-content: space-between; gap: 20px; }
h1 { margin: 0 0 6px; font-size: 22px; }
.box { margin: 16px 0; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { border-bottom: 1px solid #ccc; padding: 5px 6px; text-align: left; vertical-align: top; }
th { background: #f2f2f2; }
.r { text-align: right; white-space: nowrap; }
.total td { font-weight: bold; font-size: 14px; border-top: 2px solid #111; }
.sig { max-height: 70px; display: block; margin-top: 30px; }
.muted { color: #555; }
</style></head><body>
<div class="top">
  <div>
    <b style="font-size:15px">${esc(P.full_name)}</b><br>
    ${P.reg_no ? `註冊編號 Reg. No.: ${esc(P.reg_no)}<br>` : ''}
    ${P.address ? esc(P.address).replace(/\n/g, '<br>') + '<br>' : ''}
    ${P.phone ? 'Tel: ' + esc(P.phone) + '<br>' : ''}${P.email ? esc(P.email) : ''}
  </div>
  <div style="text-align:right">
    <h1>INVOICE 發票</h1>
    編號 No.: <b>${esc(inv.invoice_no)}</b><br>
    發出日期 Date: ${esc(inv.issue_date)}<br>
    到期日 Due: ${esc(inv.due_date)}（${net} 日 days）
  </div>
</div>
<div class="box">
  <b>致 Bill to:</b><br>${esc(s.bill_name)}<br>${esc(s.bill_address).replace(/\n/g, '<br>')}<br>
  <span class="muted">服務期間 Service period: ${s.period.y} 年 ${s.period.m} 月</span>
</div>
<table>
  <tr><th>日期 Date</th><th>項目 Description</th><th class="r">時數 Hours</th><th class="r">單價 Rate</th><th class="r">金額 Amount</th></tr>
  ${rows}${comm}
  <tr class="total"><td colspan="4">合計 Total</td><td class="r">${money(inv.total)}</td></tr>
</table>
<div class="box"><b>付款方式 Payment</b><br>${pay || '<span class="muted">(請在設定頁填寫銀行資料)</span>'}</div>
${sig}
<div>${esc(P.full_name)}</div>
${P.footer_note ? `<div class="muted" style="margin-top:14px">${esc(P.footer_note).replace(/\n/g, '<br>')}</div>` : ''}
</body></html>`;
  }

  function open(inv, clinic, p) {
    const w = window.open('', '_blank');
    if (!w) { alert('瀏覽器擋咗彈出視窗,請允許後再試'); return; }
    w.document.write(html(inv, clinic, p));
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 500);
  }

  return { html, open };
})();
