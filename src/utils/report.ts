import { jsPDF } from 'jspdf';
import autoTable from 'jspdf-autotable';
import { format } from 'date-fns';
import type { Case } from '../types';
import { formatKD } from './formatKD';

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

export function buildDailyStats(cases: Case[]) {
  const sales = cases.filter(c => c.caseType === 'Sale');
  const followups = cases.filter(c => c.caseType === 'Follow-up');
  const lost = cases.filter(c => c.caseType === 'Lost Sale');
  const browsing = cases.filter(c => c.caseType === 'No Interaction');
  const revenue = sales.reduce((s, c) => s + (c.amountKD || 0), 0);
  const total = sales.length + lost.length;
  const convRate = total > 0 ? Math.round((sales.length / total) * 100) : 0;

  const staffMap: Record<string, { sales: number; kd: number; followups: number; lost: number }> = {};
  for (const c of cases) {
    if (!staffMap[c.staff]) staffMap[c.staff] = { sales: 0, kd: 0, followups: 0, lost: 0 };
    if (c.caseType === 'Sale') { staffMap[c.staff].sales++; staffMap[c.staff].kd += c.amountKD || 0; }
    if (c.caseType === 'Follow-up') staffMap[c.staff].followups++;
    if (c.caseType === 'Lost Sale') staffMap[c.staff].lost++;
  }

  const brandSalesMap: Record<string, { count: number; kd: number }> = {};
  for (const c of sales) {
    const brand = c.brand || c.product || 'Unknown';
    if (!brandSalesMap[brand]) brandSalesMap[brand] = { count: 0, kd: 0 };
    brandSalesMap[brand].count++;
    brandSalesMap[brand].kd += c.amountKD || 0;
  }

  const brandLostMap: Record<string, number> = {};
  for (const c of lost) {
    const brand = c.brand || c.product || 'Unknown';
    brandLostMap[brand] = (brandLostMap[brand] || 0) + 1;
  }

  return { sales, followups, lost, browsing, revenue, convRate, staffMap, brandSalesMap, brandLostMap };
}

export function pdfFileName(date: string, outlet?: string) {
  const outletPart = outlet ? `_${outlet.replace(/\s+/g, '_')}` : '';
  return `TIME_KEEPER_Daily_Report_${date}${outletPart}.pdf`;
}

export function generatePDF(date: string, cases: Case[], outlet?: string): string {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const { sales, followups, lost, browsing, revenue, convRate, staffMap, brandSalesMap } =
    buildDailyStats(cases);
  const displayDate = format(new Date(date + 'T12:00:00'), 'd MMMM yyyy');

  // ── Header bar ──────────────────────────────────────────────────────────────
  doc.setFillColor(10, 10, 10);
  doc.rect(0, 0, 210, 28, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(15);
  doc.setFont('helvetica', 'normal');
  doc.setCharSpace(3);
  doc.text('TIME KEEPER', 14, 11);
  doc.setFontSize(7);
  doc.setCharSpace(2);
  doc.setTextColor(180, 180, 180);
  doc.text('EST. 2018', 14, 17);
  doc.setCharSpace(1);
  doc.setFontSize(8);
  doc.setTextColor(200, 200, 200);
  doc.text('DAILY REPORT', 196, 11, { align: 'right' });
  doc.setFontSize(10);
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setCharSpace(0);
  doc.text(displayDate, 196, outlet ? 17 : 20, { align: 'right' });
  if (outlet) {
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(180, 220, 215);
    doc.text(outlet.toUpperCase(), 196, 24, { align: 'right' });
  }
  doc.setFillColor(15, 118, 110);
  doc.rect(0, 28, 210, 1.5, 'F');

  // ── KPI tiles (2 rows × 3) ───────────────────────────────────────────────
  const totalVisitorKd = cases.reduce((s, c) =>
    s + (c.caseType === 'No Interaction' ? (c.visitorCount ?? 1) : 1), 0);
  const kpis = [
    { label: 'Revenue (KD)', value: formatKD(revenue) },
    { label: 'Sales', value: String(sales.length) },
    { label: 'Follow-ups', value: String(followups.length) },
    { label: 'Lost Sales', value: String(lost.length) },
    { label: 'Total Visitors', value: String(totalVisitorKd) },
    { label: 'Conversion', value: `${convRate}%` },
  ];
  const kpiW = 58, kpiH = 18, kpiGap = 3, kpiX0 = 14, kpiY0 = 36;
  kpis.forEach((kpi, i) => {
    const x = kpiX0 + (i % 3) * (kpiW + kpiGap);
    const y = kpiY0 + Math.floor(i / 3) * (kpiH + kpiGap);
    doc.setFillColor(240, 253, 250);
    doc.roundedRect(x, y, kpiW, kpiH, 2, 2, 'F');
    doc.setFontSize(13);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(15, 118, 110);
    doc.text(kpi.value, x + kpiW / 2, y + 7, { align: 'center' });
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(kpi.label, x + kpiW / 2, y + 13, { align: 'center' });
  });

  let curY = kpiY0 + 2 * (kpiH + kpiGap) + 8;

  // ── Store Traffic chart (Google Maps-style popular times) ────────────────
  const traffic = buildHourlyTraffic(cases);
  if (traffic.length > 0) {
    const totalVisitors = cases.reduce((s, c) =>
      s + (c.caseType === 'No Interaction' ? (c.visitorCount ?? 1) : 1), 0);
    const peakEntry = traffic.reduce((mx, t) => t.count > mx.count ? t : mx, traffic[0]);

    // Section heading
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 41, 59);
    doc.text('Store Traffic', 14, curY);

    doc.setFontSize(7.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(100, 116, 139);
    doc.text(`${totalVisitors} total visitors / interactions  ·  Peak: ${peakEntry.label} (${peakEntry.count})`, 14, curY + 5);

    const chartX = 14;
    const chartY = curY + 9;
    const chartW = 182;
    const chartH = 36;           // total chart box height
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
        doc.setFillColor(15, 118, 110);   // dark teal — busiest
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
        const labelY = barY - 1.5;
        doc.text(String(t.count), barX + barW / 2, labelY, { align: 'center' });
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
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('Staff Performance', 14, curY);

  const staffRows = Object.entries(staffMap).map(([name, d]) => [
    name, String(d.sales), `${formatKD(d.kd)} KD`, String(d.followups), String(d.lost),
  ]);
  autoTable(doc, {
    startY: curY + 3,
    head: [['Staff Member', 'Sales', 'Revenue (KD)', 'Follow-ups', 'Lost']],
    body: staffRows.length ? staffRows : [['—', '0', '0.000 KD', '0', '0']],
    theme: 'striped',
    headStyles: { fillColor: [15, 118, 110] },
    margin: { left: 14, right: 14 },
    styles: { fontSize: 9 },
  });
  curY = (doc as any).lastAutoTable.finalY + 8;

  // ── Brand Analytics (sales only — lost sales excluded) ───────────────────
  const hasBrandData = Object.keys(brandSalesMap).length > 0;
  if (hasBrandData) {
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(30, 41, 59);
    doc.text('Brand Analytics', 14, curY);

    const brandRows = Object.entries(brandSalesMap)
      .map(([brand, s]) => ({ brand, sales: s.count, kd: s.kd }))
      .sort((a, b) => b.kd - a.kd || b.sales - a.sales)
      .map(({ brand, sales, kd }) => [brand, String(sales), `${formatKD(kd)} KD`]);

    autoTable(doc, {
      startY: curY + 3,
      head: [['Brand', 'Sales', 'Revenue (KD)']],
      body: brandRows,
      theme: 'striped',
      headStyles: { fillColor: [15, 118, 110] },
      margin: { left: 14, right: 14 },
      styles: { fontSize: 9 },
    });
    curY = (doc as any).lastAutoTable.finalY + 8;
  }

  // ── All Cases table ──────────────────────────────────────────────────────
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text('All Cases', 14, curY);

  const caseRows = cases.map(c => {
    const brandProduct = c.caseType === 'Lost Sale' && c.product && c.product !== c.brand
      ? `${c.brand || ''} — ${c.product}`.substring(0, 28)
      : (c.brand || c.product || '—').substring(0, 28);
    return [
      c.timeLogged,
      c.staff,
      c.caseType,
      (c.customerName || '—').substring(0, 18),
      brandProduct,
      c.amountKD ? formatKD(c.amountKD) : '—',
      (c.notes || '—').substring(0, 35),
    ];
  });
  autoTable(doc, {
    startY: curY + 3,
    head: [['Time', 'Staff', 'Type', 'Customer', 'Brand / Product', 'KD', 'Notes / Requirement']],
    body: caseRows,
    theme: 'striped',
    headStyles: { fillColor: [15, 118, 110] },
    margin: { left: 14, right: 14 },
    styles: { fontSize: 7.5 },
    columnStyles: { 5: { halign: 'right' } },
  });

  // ── Footer bar ────────────────────────────────────────────────────────────
  const pageH = doc.internal.pageSize.height;
  doc.setFillColor(10, 10, 10);
  doc.rect(0, pageH - 12, 210, 12, 'F');
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.setCharSpace(1.5);
  doc.setTextColor(180, 180, 180);
  doc.text('TIME KEEPER', 14, pageH - 5);
  doc.setCharSpace(0);
  doc.setTextColor(120, 120, 120);
  doc.text(`Generated ${format(new Date(), 'dd MMM yyyy HH:mm')}`, 196, pageH - 5, { align: 'right' });

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

export async function shareReport(date: string, pdfUri: string, outlet?: string): Promise<'shared' | 'downloaded'> {
  const fileName = pdfFileName(date, outlet);

  if (navigator.share) {
    try {
      const res = await fetch(pdfUri);
      const blob = await res.blob();
      const file = new File([blob], fileName, { type: 'application/pdf' });

      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'TIME KEEPER Daily Report', files: [file] });
        return 'shared';
      } else {
        await navigator.share({ title: 'TIME KEEPER Daily Report' });
        return 'shared';
      }
    } catch {
      // User cancelled — fall through to download
    }
  }

  downloadReport(date, pdfUri);
  return 'downloaded';
}
