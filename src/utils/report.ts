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
// Every page carries the header bar and footer bar, so content is confined to
// the band between them. Tables get the same band as their page-break margins,
// which is what stops a continuation page from running under the header.
const PAGE_W = 210;
const PAGE_H = 297;
const ML = 14;
const CONTENT_R = PAGE_W - ML;           // 196
const HEADER_H = 28;
const FOOTER_H = 12;
const CONTENT_TOP = 36;
const CONTENT_BOTTOM = PAGE_H - FOOTER_H - 4;   // 281
const TABLE_MARGIN = { left: ML, right: ML, top: CONTENT_TOP, bottom: PAGE_H - CONTENT_BOTTOM };
// Smallest table worth starting on a page: head row plus one body row. A heading
// is only drawn where at least this much room follows it, so it can never sit
// alone at the foot of a page with its table on the next one.
const MIN_TABLE_H = 16;

const TEAL: [number, number, number] = [15, 118, 110];
const INK: [number, number, number] = [30, 41, 59];
const MUTED: [number, number, number] = [100, 116, 139];

function drawHeader(doc: jsPDF, displayDate: string, outlet?: string) {
  doc.setFillColor(10, 10, 10);
  doc.rect(0, 0, PAGE_W, HEADER_H, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(15);
  doc.setFont('helvetica', 'normal');
  doc.setCharSpace(3);
  doc.text('TIME KEEPER', ML, 11);
  doc.setFontSize(7);
  doc.setCharSpace(2);
  doc.setTextColor(180, 180, 180);
  doc.text('EST. 2018', ML, 17);
  doc.setCharSpace(1);
  doc.setFontSize(8);
  doc.setTextColor(200, 200, 200);
  doc.text('DAILY REPORT', CONTENT_R, 11, { align: 'right' });
  doc.setFontSize(10);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setCharSpace(0);
  doc.text(displayDate, CONTENT_R, outlet ? 17 : 20, { align: 'right' });
  if (outlet) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(180, 220, 215);
    doc.text(outlet.toUpperCase(), CONTENT_R, 24, { align: 'right' });
  }
  doc.setFillColor(...TEAL);
  doc.rect(0, HEADER_H, PAGE_W, 1.5, 'F');
}

function drawFooter(doc: jsPDF, page: number, pages: number, generatedAt: string) {
  doc.setFillColor(10, 10, 10);
  doc.rect(0, PAGE_H - FOOTER_H, PAGE_W, FOOTER_H, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setCharSpace(1.5);
  doc.setTextColor(180, 180, 180);
  doc.text('TIME KEEPER', ML, PAGE_H - 5);
  doc.setCharSpace(0);
  doc.setTextColor(120, 120, 120);
  if (pages > 1) doc.text(`Page ${page} of ${pages}`, PAGE_W / 2, PAGE_H - 5, { align: 'center' });
  doc.text(`Generated ${generatedAt}`, CONTENT_R, PAGE_H - 5, { align: 'right' });
}

/** Sortable label for a case's time-of-day; entries without one sort last. */
const timeKey = (c: Case) => c.timeLogged || '99:99';

export function generatePDF(date: string, cases: Case[], outlet?: string): string {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const { sales, followups, lost, revenue, convRate, staffMap, brandSalesMap, typeSalesMap, dayCases, followUpWins, followUpWinRevenue } =
    buildDailyStats(cases);
  const displayDate = format(new Date(date + 'T12:00:00'), 'd MMMM yyyy');
  // Store time, whatever the device is set to — this is a business record.
  const generatedAt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kuwait', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date()).replace(',', '');

  let curY = CONTENT_TOP;

  /** Start a new page if `h` mm will not fit above the footer. */
  const ensureSpace = (h: number) => {
    if (curY + h > CONTENT_BOTTOM) { doc.addPage(); curY = CONTENT_TOP; }
  };
  /** Section heading, optional one-line note beneath; returns the y a table should start at. */
  const heading = (title: string, note?: string) => {
    ensureSpace((note ? 8 : 3) + MIN_TABLE_H);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text(title, ML, curY);
    if (note) {
      doc.setFontSize(7.5);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...MUTED);
      doc.text(note, ML, curY + 5);
    }
    return curY + (note ? 8 : 3);
  };
  const tableEnd = () => { curY = (doc as any).lastAutoTable.finalY + 8; };
  const tableBase = { theme: 'striped' as const, headStyles: { fillColor: TEAL }, margin: TABLE_MARGIN };

  // ── KPI tiles (2 rows × 3) ───────────────────────────────────────────────
  const totalVisitorKd = dayCases.reduce((s, c) =>
    s + (c.caseType === 'No Interaction' ? (c.visitorCount ?? 1) : 1), 0);
  const kpis = [
    { label: 'Revenue (KD)', value: formatKD(revenue) },
    { label: 'Sales', value: String(sales.length) },
    { label: 'Follow-ups', value: String(followups.length) },
    { label: 'Lost Sales', value: String(lost.length) },
    { label: 'Total Visitors', value: String(totalVisitorKd) },
    { label: 'Conversion', value: `${convRate}%` },
  ];
  const kpiW = 58, kpiH = 18, kpiGap = 3;
  kpis.forEach((kpi, i) => {
    const x = ML + (i % 3) * (kpiW + kpiGap);
    const y = curY + Math.floor(i / 3) * (kpiH + kpiGap);
    doc.setFillColor(240, 253, 250);
    doc.roundedRect(x, y, kpiW, kpiH, 2, 2, 'F');
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...TEAL);
    doc.text(kpi.value, x + kpiW / 2, y + 7, { align: 'center' });
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    doc.text(kpi.label, x + kpiW / 2, y + 13, { align: 'center' });
  });
  curY += 2 * (kpiH + kpiGap) + 8;

  // ── Store Traffic chart (Google Maps-style popular times) ────────────────
  const traffic = buildHourlyTraffic(dayCases);
  if (traffic.length > 0) {
    const chartH = 36;           // total chart box height
    ensureSpace(9 + chartH + 8);
    const peakEntry = traffic.reduce((mx, t) => t.count > mx.count ? t : mx, traffic[0]);

    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text('Store Traffic', ML, curY);

    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    doc.text(`${totalVisitorKd} total visitors / interactions  ·  Peak: ${peakEntry.label} (${peakEntry.count})`, ML, curY + 5);

    const chartX = ML;
    const chartY = curY + 9;
    const chartW = CONTENT_R - ML;
    const labelRowH = 8;         // bottom label area
    const barAreaH = chartH - labelRowH - 4; // usable bar height
    const maxCount = Math.max(...traffic.map(t => t.count), 1);
    const n = traffic.length;

    // Calculate bar width and gaps so all bars fit
    const totalGapFrac = 0.35;   // 35% of slot is gap
    const slotW = chartW / n;
    const barW = slotW * (1 - totalGapFrac);
    const halfGap = (slotW * totalGapFrac) / 2;

    // Chart background
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(chartX, chartY, chartW, chartH, 2, 2, 'F');

    // Subtle horizontal guide lines (25%, 50%, 75%)
    doc.setDrawColor(220, 228, 236);
    doc.setLineWidth(0.2);
    [0.25, 0.5, 0.75].forEach(frac => {
      const lineY = chartY + 2 + barAreaH * (1 - frac);
      doc.line(chartX + 2, lineY, chartX + chartW - 2, lineY);
    });

    traffic.forEach((t, i) => {
      const slotX = chartX + i * slotW;
      const barX = slotX + halfGap;
      const barH = t.count > 0 ? Math.max((t.count / maxCount) * barAreaH, 1.5) : 0;
      const barY = chartY + 2 + barAreaH - barH;
      const isPeak = t.count === peakEntry.count && t.count > 0;
      const isEmpty = t.count === 0;

      // Bar fill — Google Maps uses orange/amber; we match brand teal with a peak highlight
      if (isEmpty) {
        doc.setFillColor(226, 232, 240);
      } else if (isPeak) {
        doc.setFillColor(...TEAL);        // dark teal — busiest
      } else {
        // Gradient-like: darker as count approaches peak
        const intensity = t.count / maxCount;
        const r = Math.round(20 + (1 - intensity) * 100);
        const g = Math.round(184 - (1 - intensity) * 60);
        const b = Math.round(166 - (1 - intensity) * 50);
        doc.setFillColor(r, g, b);
      }

      if (barH > 0) {
        doc.roundedRect(barX, barY, barW, barH, 0.8, 0.8, 'F');
      } else {
        // Draw a tiny empty placeholder
        doc.setFillColor(235, 240, 245);
        doc.roundedRect(barX, chartY + 2 + barAreaH - 1.5, barW, 1.5, 0.3, 0.3, 'F');
      }

      // Count label above bar (only if bar is tall enough)
      if (t.count > 0) {
        doc.setFontSize(isPeak ? 6.5 : 5.5);
        doc.setFont('helvetica', isPeak ? 'bold' : 'normal');
        doc.setTextColor(isPeak ? 15 : 30, isPeak ? 118 : 100, isPeak ? 110 : 130);
        doc.text(String(t.count), barX + barW / 2, barY - 1.5, { align: 'center' });
      }

      // Hour label at bottom
      doc.setFontSize(5.5);
      doc.setFont('helvetica', isPeak ? 'bold' : 'normal');
      doc.setTextColor(isPeak ? 15 : 100, isPeak ? 118 : 116, isPeak ? 110 : 139);
      doc.text(t.label, barX + barW / 2, chartY + chartH - 2, { align: 'center' });
    });

    // "Popular times" watermark label top-right inside chart
    doc.setFontSize(6);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(180, 190, 205);
    doc.text('Popular times', chartX + chartW - 3, chartY + 5.5, { align: 'right' });

    curY = chartY + chartH + 8;
  }

  // ── Staff Performance ────────────────────────────────────────────────────
  {
    const startY = heading('Staff Performance');
    const staffRows = Object.entries(staffMap)
      .sort(([, a], [, b]) => b.kd - a.kd || b.sales - a.sales)
      .map(([name, d]) => [name, String(d.sales), `${formatKD(d.kd)} KD`, String(d.followups), String(d.lost)]);
    autoTable(doc, {
      ...tableBase,
      startY,
      head: [['Staff Member', 'Sales', 'Revenue (KD)', 'Follow-ups', 'Lost']],
      body: staffRows.length ? staffRows : [['—', '0', '0.000 KD', '0', '0']],
      styles: { fontSize: 9 },
    });
    tableEnd();
  }

  // ── Brand and product-type breakdown (sales only — lost sales excluded) ──
  // Two narrow tables side by side. If the brand table is long enough to run
  // onto another page they stack instead, so neither is left behind.
  const rowsOf = (m: Breakdown) => Object.entries(m)
    .map(([k, s]) => ({ k, ...s }))
    .sort((a, b) => b.kd - a.kd || b.count - a.count)
    .map(({ k, count, kd }) => [k, String(count), `${formatKD(kd)} KD`]);
  const brandRows = rowsOf(brandSalesMap);
  const typeRows = rowsOf(typeSalesMap);
  if (brandRows.length) {
    const brandW = 104, gap = 6;
    const typeLeft = ML + brandW + gap;
    // Rather than let a long brand table split across the fold, move the whole
    // section to a fresh page when it would fit there entire — that keeps the two
    // tables side by side. Only a table too tall for any page is allowed to span.
    const ROW_H = 7.3, HEAD_H = 10;                       // 9pt striped rows, measured
    const estimate = 8 + HEAD_H + Math.max(brandRows.length, typeRows.length) * ROW_H;
    if (estimate <= CONTENT_BOTTOM - CONTENT_TOP) ensureSpace(estimate);
    const startY = heading('Brand Analytics', 'Revenue by brand and by product type, across every item sold');
    const pageBefore = doc.getCurrentPageInfo().pageNumber;
    autoTable(doc, {
      ...tableBase,
      startY,
      tableWidth: brandW,
      head: [['Brand', 'Items', 'Revenue (KD)']],
      body: brandRows,
      styles: { fontSize: 9 },
    });
    const brandEnd = (doc as any).lastAutoTable.finalY;
    const spanned = doc.getCurrentPageInfo().pageNumber !== pageBefore;
    if (typeRows.length) {
      if (spanned) {
        curY = brandEnd + 8;
        const y2 = heading('By Product Type');
        autoTable(doc, {
          ...tableBase, startY: y2, tableWidth: brandW,
          head: [['Type', 'Items', 'Revenue (KD)']], body: typeRows, styles: { fontSize: 9 },
        });
        tableEnd();
      } else {
        autoTable(doc, {
          ...tableBase,
          startY,
          margin: { ...TABLE_MARGIN, left: typeLeft },
          tableWidth: CONTENT_R - typeLeft,
          head: [['Type', 'Items', 'Revenue (KD)']],
          body: typeRows,
          styles: { fontSize: 9 },
        });
        curY = Math.max(brandEnd, (doc as any).lastAutoTable.finalY) + 8;
      }
    } else {
      curY = brandEnd + 8;
    }
  }

  // ── Follow-up Conversions (own log — excluded from the day's figures) ────
  if (followUpWins.length > 0) {
    const startY = heading(
      'Follow-up Conversions',
      `${followUpWins.length} closed today · ${formatKD(followUpWinRevenue)} KD — from earlier follow-ups, not counted in today's sales figures above`,
    );
    autoTable(doc, {
      ...tableBase,
      startY,
      headStyles: { fillColor: [124, 58, 237] },
      head: [['Time', 'Customer', 'Brand / Product', 'Staff', 'From follow-up', 'Amount (KD)']],
      body: [...followUpWins].sort((a, b) => timeKey(a).localeCompare(timeKey(b))).map(c => [
        c.timeLogged || '—',
        c.customerName || '—',
        c.brand || c.product || '—',
        c.staff || '—',
        c.linkedCaseId || '—',
        formatKD(c.amountKD || 0),
      ]),
      styles: { fontSize: 9 },
      columnStyles: { 5: { halign: 'right' } },
    });
    tableEnd();
  }

  // ── All Cases table ──────────────────────────────────────────────────────
  // Nothing is truncated here: this is the record of the day, and a note cut
  // off mid-word is a note lost. Long cells wrap instead.
  {
    const startY = heading('All Cases');
    const caseRows = [...dayCases]
      .sort((a, b) => timeKey(a).localeCompare(timeKey(b)))
      .map(c => {
        const items = getEffectiveItems(c);
        let brandProduct: string;
        if (items.length > 1) {
          brandProduct = `${items[0].brand || items[0].product || '—'} +${items.length - 1} more`;
        } else if (c.caseType === 'Lost Sale' && c.product && c.product !== c.brand) {
          brandProduct = `${c.brand || ''} — ${c.product}`;
        } else {
          brandProduct = c.brand || c.product || '—';
        }
        return [
          c.timeLogged,
          c.staff,
          c.caseType,
          c.customerName || '—',
          brandProduct,
          c.amountKD ? formatKD(c.amountKD) : '—',
          c.notes || '—',
        ];
      });
    autoTable(doc, {
      ...tableBase,
      startY,
      head: [['Time', 'Staff', 'Type', 'Customer', 'Brand / Product', 'KD', 'Notes / Requirement']],
      body: caseRows,
      styles: { fontSize: 7.5, cellPadding: 1.5, overflow: 'linebreak' },
      columnStyles: {
        0: { cellWidth: 12 },
        1: { cellWidth: 26 },
        2: { cellWidth: 20 },
        3: { cellWidth: 28 },
        4: { cellWidth: 36 },
        5: { cellWidth: 16, halign: 'right' },
        6: { cellWidth: 'auto' },
      },
    });
  }

  // ── Header and footer on every page ──────────────────────────────────────
  // Drawn last, once the page count is known. Both bars sit outside the content
  // band, so painting them over finished pages covers nothing.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    drawHeader(doc, displayDate, outlet);
    drawFooter(doc, p, pages, generatedAt);
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
