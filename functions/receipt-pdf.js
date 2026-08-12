// Node port of the receipt PDF from public/js/pdf.js (generateReceiptPdf).
// Keep the two in sync visually — same banner, amount panel, details and
// patrol summary. This version returns base64 for a nodemailer attachment.

const { jsPDF } = require('jspdf');

const BLUE = '#003660';
const ORANGE = '#E95F13';
const YELLOW = '#E2E000';

function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('sv-SE', {
      year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Europe/Stockholm'
    });
  } catch {
    return String(iso).slice(0, 10);
  }
}

function renderReceiptPdfBase64(comp, reg, payment) {
  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, H = 297;

  // Banner
  const bannerH = 46;
  pdf.setFillColor(BLUE);
  pdf.rect(0, 0, W, bannerH, 'F');
  pdf.setTextColor(YELLOW);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.text('ESKIL · SCOUTTÄVLING', 15, 13);
  pdf.setTextColor('#ffffff');
  pdf.setFontSize(26);
  pdf.text('Kvitto', 15, 28);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(11);
  pdf.setTextColor('#a7bccf');
  const compLabel = `${comp.shortName || comp.name || ''}${comp.year ? ' · ' + comp.year : ''}${comp.location ? ' · ' + comp.location : ''}`;
  pdf.text(compLabel, 15, 38);

  // Amount panel
  let y = 62;
  pdf.setFillColor('#f3f6fa');
  pdf.roundedRect(15, y - 8, W - 30, 26, 2, 2, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(ORANGE);
  pdf.text('BETALT BELOPP', 21, y);
  pdf.setFontSize(24);
  pdf.setTextColor(BLUE);
  pdf.text(`${payment.amount} kr`, 21, y + 11);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor('#8a8a8a');
  pdf.text('BETALNINGSREFERENS', W - 21, y, { align: 'right' });
  pdf.setFont('courier', 'bold');
  pdf.setFontSize(16);
  pdf.setTextColor('#282727');
  pdf.text(payment.reference || '', W - 21, y + 10, { align: 'right' });

  // Details
  y += 34;
  const row = (label, value) => {
    if (!value) return;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor('#8a8a8a');
    pdf.text(label.toUpperCase(), 15, y);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    pdf.setTextColor('#282727');
    pdf.text(String(value), 70, y);
    y += 8;
  };

  row('Registrerad betald', fmtDate(payment.paidAt) || fmtDate(new Date().toISOString()));
  row('Betalning skapad', fmtDate(payment.createdAt));
  row('Kår', reg.kar);
  row('Anmälningsansvarig', reg.contact && reg.contact.name);
  row('E-post', reg.contact && reg.contact.email);

  // Patrols summary
  y += 4;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.setTextColor(ORANGE);
  pdf.text('ANMÄLAN OMFATTAR', 15, y);
  y += 8;
  const patrols = reg.patrols || [];
  for (const p of patrols) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(11);
    pdf.setTextColor('#282727');
    pdf.text(`• ${p.name}`, 18, y);
    pdf.setTextColor('#8a8a8a');
    pdf.text(`${p.avdelning || ''} · ${p.antal || 0} scouter`, W - 15, y, { align: 'right' });
    y += 7;
  }
  const nScouts = patrols.reduce((s, p) => s + (Number(p.antal) || 0), 0);
  pdf.setDrawColor('#e5e5e5');
  pdf.setLineWidth(0.3);
  pdf.line(15, y - 2, W - 15, y - 2);
  y += 4;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.setTextColor(BLUE);
  pdf.text(`${patrols.length} patrull${patrols.length === 1 ? '' : 'er'} · ${nScouts} scouter`, 15, y);

  // All payments for context (if more than one)
  const payments = reg.payments || [];
  if (payments.length > 1) {
    y += 12;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(11);
    pdf.setTextColor(ORANGE);
    pdf.text('SAMTLIGA BETALNINGAR FÖR ANMÄLAN', 15, y);
    y += 8;
    for (const p of payments) {
      pdf.setFont('courier', 'normal');
      pdf.setFontSize(10);
      pdf.setTextColor('#282727');
      pdf.text(p.reference || '', 18, y);
      pdf.setFont('helvetica', 'normal');
      pdf.text(`${p.amount} kr`, 80, y);
      pdf.setTextColor(p.paid ? '#2d7a1c' : '#8a6d00');
      pdf.text(p.paid ? `Betald ${fmtDate(p.paidAt)}` : 'Väntar på betalning', W - 15, y, { align: 'right' });
      y += 6;
    }
  }

  // Issuer + footer
  y = Math.max(y + 14, 200);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(10);
  pdf.setTextColor('#525252');
  const issuer = comp.organizer
    ? `Betalningen är mottagen och registrerad av ${comp.organizer}.`
    : 'Betalningen är mottagen och registrerad av tävlingsledningen.';
  pdf.text(pdf.splitTextToSize(`${issuer} Detta kvitto är genererat av ESKIL och gäller som bekräftelse på inbetald anmälningsavgift.`, W - 30), 15, y);

  pdf.setTextColor('#a7bccf');
  pdf.setFontSize(8);
  pdf.text('ESKIL — scouttävlingssystem', 15, H - 10);
  pdf.text(`Kvitto · ${payment.reference || ''}`, W - 15, H - 10, { align: 'right' });

  return Buffer.from(pdf.output('arraybuffer')).toString('base64');
}

module.exports = { renderReceiptPdfBase64 };
