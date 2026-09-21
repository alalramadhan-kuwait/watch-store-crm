import { caseLabel } from '../shared/caseLabels';
import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';
import type { Case } from '../types';
import { formatKD } from './formatKD';
import { getEffectiveItems } from './saleItems';

// ── Hourly traffic builder (Google Maps-style popular times) ─────────────────
export function buildHourlyTraffic(cases: Case[]): { hour: number; label: string; count: number }[] {
  const hourCounts: Record<number, number> = {};

  for (const c of cases) {
    const parts = (c.timeLogged || '').split(':');
    const hour = parseInt(parts[0], 10);
    if (isNaN(hour) || hour < 0 || hour > 23) continue;
    // No Interaction uses real visitor_count; every other case counts as 1 interaction
    const add = c.caseType === 'No Interaction' ? (c.visitorCount ?? 1) : 1;
    hourCounts[hour] = (hourCounts[hour] || 0) + add;
  }

  if (Object.keys(hourCounts).length === 0) return [];

  const hours = Object.keys(hourCounts).map(Number);
  const minH = Math.min(...hours);
  const maxH = Math.max(...hours);

  const result: { hour: number; label: string; count: number }[] = [];
  for (let h = minH; h <= maxH; h++) {
    const suffix = h < 12 ? 'am' : 'pm';
    const display = h === 0 ? '12am' : h === 12 ? '12pm' : h > 12 ? `${h - 12}${suffix}` : `${h}${suffix}`;
    result.push({ hour: h, label: display, count: hourCounts[h] || 0 });
  }
  return result;
}

type Breakdown = Record<string, { count: number; kd: number }>;

export function buildDailyStats(cases: Case[]) {
  // A sale created by closing an earlier follow-up carries linkedCaseId. It is NOT
  // walk-in trade for this day, so it is kept out of the day's figures and reported
  // in its own Follow-up Conversions log instead.
  const followUpWins = cases.filter(c => c.caseType === 'Sale' && !!c.linkedCaseId);
  const isFollowUpWin = (c: Case) => c.caseType === 'Sale' && !!c.linkedCaseId;
  const dayCases = cases.filter(c => !isFollowUpWin(c));
  const followUpWinRevenue = followUpWins.reduce((s, c) => s + (c.amountKD || 0), 0);

  const sales = dayCases.filter(c => c.caseType === 'Sale');
  const followups = dayCases.filter(c => c.caseType === 'Follow-up');
  const lost = dayCases.filter(c => c.caseType === 'Lost Sale');
  const browsing = dayCases.filter(c => c.caseType === 'No Interaction');
  const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
  const total = sales.length + lost.length;
  const convRate = total > 0 ? Math.round((sales.length / total) * 100) : 0;

  const staffMap: Record<string, { sales: number; kd: number; followups: number; lost: number }> = {};
  for (const c of dayCases) {
    if (!staffMap[c.staff]) staffMap[c.staff] = { sales: 0, kd: 0, followups: 0, lost: 0 };
    if (c.caseType === 'Sale') { staffMap[c.staff].sales++; staffMap[c.staff].kd += c.amountKD || 0; }
    if (c.caseType === 'Follow-up') staffMap[c.staff].followups++;
    if (c.caseType === 'Lost Sale') staffMap[c.staff].lost++;
  }

  // Brand and product-type revenue are attributed per line item, the same way the
  // manager dashboard does it. Reading case.brand here credited a whole basket to
  // its first item — a watch-plus-strap sale showed as all watch brand, and the
  // strap brand never appeared at all.
  const brandSalesMap: Breakdown = {};
  const typeSalesMap: Breakdown = {};
  const tally = (map: Breakdown, key: string, kd: number) => {
    if (!map[key]) map[key] = { count: 0, kd: 0 };
    map[key].count++;
    map[key].kd += kd;
  };
  for (const c of sales) {
    for (const item of getEffectiveItems(c)) {
      tally(brandSalesMap, item.brand || item.product || 'Unknown', item.amountKD || 0);
      tally(typeSalesMap, item.productType || 'Other', item.amountKD || 0);
    }
  }

  const brandLostMap: Record<string, number> = {};
  for (const c of lost) {
    const brand = c.brand || c.product || 'Unknown';
    brandLostMap[brand] = (brandLostMap[brand] || 0) + 1;
  }

  return {
    sales, followups, lost, browsing, revenue, convRate, staffMap,
    brandSalesMap, typeSalesMap, brandLostMap, dayCases, followUpWins, followUpWinRevenue,
  };
}

export function pdfFileName(date: string, outlet?: string) {
  const outletPart = outlet ? `_${outlet.replace(/\s+/g, '_')}` : '';
  return `TIME_KEEPER_Daily_Report_${date}${outletPart}.pdf`;
}

// ── Page geometry (mm, A4 portrait) ─────────────────────────────────────────
// The report is read on a phone and sent on WhatsApp, so the page is shaped
// like a phone: narrow enough that 8pt type lands around 11px on a handset,
// and exactly as tall as the content. It used to be A4 — a quarter of it blank
// under the last table, and every figure too small to read without zooming.
const PAGE_W = 100;
const ML = 7;
const CONTENT_R = PAGE_W - ML;           // 93
const HEADER_H = 21;
const FOOTER_H = 9;
const CONTENT_TOP = 27;
const BOTTOM_PAD = 5;
// A continuous page still needs a floor and a ceiling: a quiet day should not
// print a stub, and a very long one should not become a single unusable strip.
const MIN_PAGE_H = 150;
const MAX_PAGE_H = 1400;
const MEASURE_H = 4000;
// Smallest table worth starting: head row plus one body row. Only reached on a
// day long enough to have been paginated at MAX_PAGE_H.
const MIN_TABLE_H = 16;

const TEAL: [number, number, number] = [15, 118, 110];
const INK: [number, number, number] = [30, 41, 59];
const MUTED: [number, number, number] = [100, 116, 139];

function drawHeader(doc: jsPDF, displayDate: string, page: number, outlet?: string) {
  doc.setFillColor(10, 10, 10);
  doc.rect(0, 0, PAGE_W, HEADER_H, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'normal');
  doc.setCharSpace(2.2);
  doc.text('TIME KEEPER', ML, 9);
  doc.setCharSpace(0);
  doc.setFontSize(6);
  doc.setTextColor(170, 170, 170);
  doc.text(page > 1 ? 'DAILY REPORT · CONT.' : 'DAILY REPORT', CONTENT_R, 8, { align: 'right' });

  doc.setCharSpace(0);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(255, 255, 255);
  doc.text(displayDate, ML, 16.5);
  if (outlet) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(180, 220, 215);
    doc.text(outlet.toUpperCase(), CONTENT_R, 16.5, { align: 'right' });
  }
  doc.setFillColor(...TEAL);
  doc.rect(0, HEADER_H, PAGE_W, 1.2, 'F');
}

function drawFooter(doc: jsPDF, pageH: number, page: number, pages: number, generatedAt: string) {
  doc.setFillColor(10, 10, 10);
  doc.rect(0, pageH - FOOTER_H, PAGE_W, FOOTER_H, 'F');
  doc.setFontSize(6);
  doc.setFont('helvetica', 'normal');
  doc.setCharSpace(1.2);
  doc.setTextColor(170, 170, 170);
  doc.text('TIME KEEPER', ML, pageH - 3.5);
  doc.setCharSpace(0);
  doc.setTextColor(120, 120, 120);
  const right = pages > 1 ? `${generatedAt}  ·  ${page}/${pages}` : generatedAt;
  doc.text(right, CONTENT_R, pageH - 3.5, { align: 'right' });
}

/** Sortable label for a case's time-of-day; entries without one sort last. */
const timeKey = (c: Case) => c.timeLogged || '99:99';
/** Clip long free text; the full text lives in the app. */
const clip = (s: string | undefined, n: number) =>
  !s ? '' : s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';

/**
 * Draw everything between the bars, and say where it ended.
 *
 * Runs twice: once on a page tall enough that nothing can break, to find out
 * how much room the day actually needs, then again on a page cut to that
 * height. That is what makes the report end where the content ends.
 */
function renderBody(doc: jsPDF, pageH: number, date: string, cases: Case[]): number {
  const { sales, followups, lost, revenue, convRate, staffMap, brandSalesMap, typeSalesMap, dayCases, followUpWins, followUpWinRevenue } =
    buildDailyStats(cases);

  const contentBottom = pageH - FOOTER_H - 3;
  let curY = CONTENT_TOP;

  const ensureSpace = (h: number) => {
    if (curY + h > contentBottom) { doc.addPage(); curY = CONTENT_TOP; }
  };
  /** Section heading, optional note on the line beneath. Returns the table's start y. */
  const heading = (title: string, note?: string) => {
    ensureSpace(4 + MIN_TABLE_H);
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text(title, ML, curY);
    if (!note) return curY + 2.5;
    doc.setFontSize(6);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    const lines = doc.splitTextToSize(note, CONTENT_R - ML) as string[];
    doc.text(lines, ML, curY + 3.2);
    return curY + 2.5 + lines.length * 2.4;
  };
  const tableEnd = (gap = 6) => { curY = (doc as any).lastAutoTable.finalY + gap; };
  const tableBase = {
    theme: 'striped' as const,
    headStyles: { fillColor: TEAL, fontSize: 7, cellPadding: 1.3 },
    margin: { left: ML, right: ML, top: CONTENT_TOP, bottom: pageH - contentBottom },
    styles: { fontSize: 7.5, cellPadding: 1.3, overflow: 'linebreak' as const },
  };

  // ── Headline figures: three across, two down ─────────────────────────────
  const totalVisitors = dayCases.reduce((s, c) =>
    s + (c.caseType === 'No Interaction' ? (c.visitorCount ?? 1) : 1), 0);
  const kpis = [
    { label: 'Revenue (KD)', value: formatKD(revenue) },
    { label: 'Sales', value: String(sales.length) },
    { label: 'Conversion', value: `${convRate}%` },
    { label: 'Interested', value: String(followups.length) },
    { label: 'Lost opp.', value: String(lost.length) },
    { label: 'Visitors', value: String(totalVisitors) },
  ];
  const kpiCols = 3, kpiGap = 2.5, kpiH = 13;
  const kpiW = (CONTENT_R - ML - kpiGap * (kpiCols - 1)) / kpiCols;
  kpis.forEach((kpi, i) => {
    const x = ML + (i % kpiCols) * (kpiW + kpiGap);
    const y = curY + Math.floor(i / kpiCols) * (kpiH + kpiGap);
    doc.setFillColor(240, 253, 250);
    doc.roundedRect(x, y, kpiW, kpiH, 1.6, 1.6, 'F');
    // Revenue can run to five figures; shrink to fit rather than overflow the tile.
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...TEAL);
    let size = 11;
    doc.setFontSize(size);
    while (doc.getTextWidth(kpi.value) > kpiW - 3 && size > 6) { size -= 0.5; doc.setFontSize(size); }
    doc.text(kpi.value, x + kpiW / 2, y + 6.2, { align: 'center' });
    doc.setFontSize(5.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    doc.text(kpi.label, x + kpiW / 2, y + 10.4, { align: 'center' });
  });
  curY += Math.ceil(kpis.length / kpiCols) * (kpiH + kpiGap) + 4;

  // ── Store traffic ────────────────────────────────────────────────────────
  const traffic = buildHourlyTraffic(dayCases);
  if (traffic.length > 0) {
    const chartH = 24;
    ensureSpace(8 + chartH + 6);
    const peak = traffic.reduce((mx, t) => t.count > mx.count ? t : mx, traffic[0]);

    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text('Store Traffic', ML, curY);
    doc.setFontSize(6);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    doc.text(`${totalVisitors} visitors  ·  busiest ${peak.label} (${peak.count})`, CONTENT_R, curY, { align: 'right' });

    const chartX = ML, chartY = curY + 3, chartW = CONTENT_R - ML;
    const labelRowH = 7;
    const barAreaH = chartH - labelRowH - 4;
    const maxCount = Math.max(...traffic.map(t => t.count), 1);
    const slotW = chartW / traffic.length;
    const barW = slotW * 0.62;
    const halfGap = (slotW - barW) / 2;

    doc.setFillColor(248, 250, 252);
    doc.roundedRect(chartX, chartY, chartW, chartH, 1.6, 1.6, 'F');
    doc.setDrawColor(224, 231, 238);
    doc.setLineWidth(0.15);
    [0.33, 0.66].forEach(frac => {
      const lineY = chartY + 2 + barAreaH * (1 - frac);
      doc.line(chartX + 2, lineY, chartX + chartW - 2, lineY);
    });

    traffic.forEach((t, i) => {
      const barX = chartX + i * slotW + halfGap;
      const barH = t.count > 0 ? Math.max((t.count / maxCount) * barAreaH, 1.2) : 0;
      const barY = chartY + 2 + barAreaH - barH;
      const isPeak = t.count === peak.count && t.count > 0;
      if (barH > 0) {
        if (isPeak) doc.setFillColor(...TEAL);
        else {
          const k = t.count / maxCount;
          doc.setFillColor(Math.round(20 + (1 - k) * 100), Math.round(184 - (1 - k) * 60), Math.round(166 - (1 - k) * 50));
        }
        doc.roundedRect(barX, barY, barW, barH, 0.5, 0.5, 'F');
        doc.setFontSize(isPeak ? 5.5 : 5);
        doc.setFont('helvetica', isPeak ? 'bold' : 'normal');
        doc.setTextColor(isPeak ? 15 : 90, isPeak ? 118 : 105, isPeak ? 110 : 125);
        doc.text(String(t.count), barX + barW / 2, barY - 1.1, { align: 'center' });
      } else {
        doc.setFillColor(232, 237, 243);
        doc.roundedRect(barX, chartY + 2 + barAreaH - 1, barW, 1, 0.2, 0.2, 'F');
      }
      // Every other hour is labelled: at this width all of them collide.
      if (i % 2 === 0 || isPeak) {
        doc.setFontSize(4.8);
        doc.setFont('helvetica', isPeak ? 'bold' : 'normal');
        doc.setTextColor(isPeak ? 15 : 110, isPeak ? 118 : 120, isPeak ? 110 : 140);
        doc.text(t.label, barX + barW / 2, chartY + chartH - 2, { align: 'center' });
      }
    });
    curY = chartY + chartH + 6;
  }

  // ── Staff ────────────────────────────────────────────────────────────────
  {
    const startY = heading('Staff');
    const rows = Object.entries(staffMap)
      .sort(([, a], [, b]) => b.kd - a.kd || b.sales - a.sales)
      .map(([name, d]) => [name, String(d.sales), formatKD(d.kd), String(d.followups), String(d.lost)]);
    autoTable(doc, {
      ...tableBase, startY,
      head: [['Staff', 'Sales', 'KD', 'Int.', 'Lost']],
      body: rows.length ? rows : [['—', '0', '0.000', '0', '0']],
      columnStyles: {
        0: { cellWidth: 'auto' }, 1: { cellWidth: 10, halign: 'right' },
        2: { cellWidth: 17, halign: 'right' }, 3: { cellWidth: 9, halign: 'right' },
        4: { cellWidth: 9, halign: 'right' },
      },
    });
    tableEnd();
  }

  // ── Brands, then product types: stacked, never side by side ──────────────
  const rowsOf = (m: Breakdown) => Object.entries(m)
    .map(([k, s]) => ({ k, ...s }))
    .sort((a, b) => b.kd - a.kd || b.count - a.count)
    .map(({ k, count, kd }) => [k, String(count), formatKD(kd)]);
  const breakdownCols = {
    0: { cellWidth: 'auto' as const },
    1: { cellWidth: 12, halign: 'right' as const },
    2: { cellWidth: 20, halign: 'right' as const },
  };
  const brandRows = rowsOf(brandSalesMap);
  if (brandRows.length) {
    const startY = heading('Brands sold', 'per item — a basket counts under each of its brands');
    autoTable(doc, { ...tableBase, startY, head: [['Brand', 'Items', 'KD']], body: brandRows, columnStyles: breakdownCols });
    tableEnd();
  }
  const typeRows = rowsOf(typeSalesMap);
  if (typeRows.length) {
    const startY = heading('Product types');
    autoTable(doc, { ...tableBase, startY, head: [['Type', 'Items', 'KD']], body: typeRows, columnStyles: breakdownCols });
    tableEnd();
  }

  // ── Follow-ups closed today, kept out of the day's figures ───────────────
  if (followUpWins.length > 0) {
    const startY = heading('Follow-ups won',
      `${followUpWins.length} closed today · ${formatKD(followUpWinRevenue)} KD — from earlier visits, not counted above`);
    autoTable(doc, {
      ...tableBase, startY,
      headStyles: { ...tableBase.headStyles, fillColor: [124, 58, 237] as [number, number, number] },
      head: [['Time', 'Customer / item', 'KD']],
      body: [...followUpWins].sort((a, b) => timeKey(a).localeCompare(timeKey(b))).map(c => [
        c.timeLogged || '—',
        [c.customerName, `${c.brand || c.product || '—'}${c.linkedCaseId ? ` (from ${c.linkedCaseId})` : ''}`, c.staff].filter(Boolean).join('\n'),
        formatKD(c.amountKD || 0),
      ]),
      columnStyles: { 0: { cellWidth: 10 }, 1: { cellWidth: 'auto' }, 2: { cellWidth: 17, halign: 'right' } },
    });
    tableEnd();
  }

  // ── Every visit ──────────────────────────────────────────────────────────
  // A browsing visit with nothing written about it is footfall, already in the
  // count and the chart above; printing it would be a row of dashes. Customer
  // and note sit under the item rather than in columns of their own — at this
  // width six columns leave no room for the words that matter.
  {
    const listed = dayCases.filter(c => c.caseType !== 'No Interaction' || !!c.notes);
    const skipped = dayCases.length - listed.length;
    const startY = heading('Every visit', skipped
      ? `${skipped} browsing visit${skipped === 1 ? '' : 's'} with no note counted in traffic above, not listed`
      : undefined);
    const rows = listed
      .sort((a, b) => timeKey(a).localeCompare(timeKey(b)))
      .map(c => {
        const items = getEffectiveItems(c);
        let item: string;
        if (items.length > 1) item = `${items[0].brand || items[0].product || '—'} +${items.length - 1} more`;
        else if (c.caseType === 'Lost Sale' && c.product && c.product !== c.brand) item = [c.brand, c.product].filter(Boolean).join(' — ');
        else item = c.brand || c.product || '—';
        const detail = [
          item,
          c.customerName || undefined,
          c.lostReason ? `Reason: ${c.lostReason}` : undefined,
          clip(c.notes, 90) || undefined,
        ].filter(Boolean).join('\n');
        return [c.timeLogged || '—', `${c.staff}\n${caseLabel(c.caseType)}`, detail, c.amountKD ? formatKD(c.amountKD) : '—'];
      });
    autoTable(doc, {
      ...tableBase, startY,
      head: [['Time', 'Staff / outcome', 'Item / customer / note', 'KD']],
      body: rows.length ? rows : [['—', '—', 'Nothing logged', '—']],
      styles: { ...tableBase.styles, fontSize: 6.8, cellPadding: 1.1 },
      headStyles: { ...tableBase.headStyles, fontSize: 6.3 },
      columnStyles: {
        0: { cellWidth: 9 }, 1: { cellWidth: 20 },
        2: { cellWidth: 'auto' }, 3: { cellWidth: 13, halign: 'right' },
      },
    });
    curY = (doc as any).lastAutoTable.finalY;
  }

  return curY;
}

export function generatePDF(date: string, cases: Case[], outlet?: string): string {
  const displayDate = format(new Date(date + 'T12:00:00'), 'd MMMM yyyy');
  // Store time, whatever the device is set to — this is a business record.
  const generatedAt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuwait', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).replace(',', '');

  const build = (pageH: number) => {
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: [PAGE_W, pageH] });
    const endY = renderBody(doc, pageH, date, cases);
    return { doc, endY };
  };

  // Measure on a page nothing can overflow, then cut the page to what was used.
  const measured = build(MEASURE_H).endY;
  const pageH = Math.min(MAX_PAGE_H, Math.max(MIN_PAGE_H, Math.ceil(measured + FOOTER_H + BOTTOM_PAD)));

  const { doc } = build(pageH);
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    drawHeader(doc, displayDate, p, outlet);
    drawFooter(doc, pageH, p, pages, generatedAt);
  }
  return doc.output('datauristring');
}

export function downloadReport(date: string, pdfUri: string, outlet?: string) {
  const link = document.createElement('a');
  link.href = pdfUri;
  link.download = pdfFileName(date, outlet);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export async function shareReport(
  date: string, pdfUri: string, outlet?: string,
): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const fileName = pdfFileName(date, outlet);
  const title = `Daily Store Report — ${date}${outlet ? ` · ${outlet}` : ''}`;

  if (navigator.share) {
    try {
      const res = await fetch(pdfUri);
      const blob = await res.blob();
      const file = new File([blob], fileName, { type: 'application/pdf' });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title, text: title, files: [file] });
        return 'shared';
      }
      // this device can't attach files (e.g. desktop) — give them the PDF instead
      downloadReport(date, pdfUri, outlet);
      return 'downloaded';
    } catch (err) {
      // the user dismissed the share sheet — don't force a download on them
      if ((err as { name?: string })?.name === 'AbortError') return 'cancelled';
      // anything else: fall through and still hand over the file
    }
  }

  downloadReport(date, pdfUri, outlet);
  return 'downloaded';
}
