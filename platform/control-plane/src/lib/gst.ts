/**
 * GST (India) for invoices (docs/billing.md → GST).
 *
 *   seller and customer in the same state   CGST rate/2 + SGST rate/2
 *   customer in another Indian state         IGST rate
 *   customer outside India                   export of services: zero-rated under LUT (IGST 0 %),
 *                                            IGST at the full rate without an LUT
 *   customer without billing details         treated as in the seller's state (B2C)
 *
 * Amounts are integers in the currency's minor unit (paise); each tax line is rounded half up.
 */
import { db } from './db.js';

export interface GstSettings {
  enabled: boolean;
  legal_name: string; gstin: string; address: string; state_code: string; email?: string; phone?: string;
  sac_code: string;            // 998315: hosting and IT infrastructure provisioning services
  rate: number;                // percent, e.g. 18
  lut_number?: string;         // Letter of Undertaking: exports without paying IGST
}

export interface BillingProfile {
  legal_name: string; gstin: string | null; address_line1: string; address_line2: string; city: string; postal_code: string;
  state_code: string | null; country: string; email: string | null;
}

export interface TaxLine { name: 'CGST' | 'SGST' | 'IGST'; rate: number; amount: number }

export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana',
  '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh',
  '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya', '18': 'Assam', '19': 'West Bengal',
  '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat',
  '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

const GSTIN_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Format and check digit of a GSTIN (15 characters: state, PAN, entity, Z, checksum). */
export function gstinError(gstin: string): string | null {
  const g = gstin.toUpperCase();
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(g)) return 'GSTIN must look like 29ABCDE1234F1Z5';
  if (!GST_STATES[g.slice(0, 2)]) return `Unknown GST state code ${g.slice(0, 2)}`;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = GSTIN_CHARS.indexOf(g[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  const check = GSTIN_CHARS[(36 - (sum % 36)) % 36];
  return check === g[14] ? null : 'GSTIN check digit is wrong';
}

export async function gstSettings(): Promise<GstSettings | null> {
  const [r] = await db`SELECT value FROM control_plane.platform_settings WHERE key = 'gst'`;
  const v = r?.['value'] as GstSettings | undefined;
  return v?.enabled ? v : null;
}

export async function billingProfile(orgId: string): Promise<BillingProfile | null> {
  const [r] = await db<BillingProfile[]>`SELECT legal_name, gstin, address_line1, address_line2, city, postal_code, state_code, country, email
                                         FROM control_plane.billing_profiles WHERE organization_id = ${orgId}`;
  return r ?? null;
}

const pct = (amount: number, rate: number) => Math.round((amount * rate) / 100);

export function computeGst(s: GstSettings, buyer: BillingProfile | null, subtotal: number) {
  const domestic = !buyer || buyer.country === 'IN';
  if (!domestic) {
    if (s.lut_number) {
      return { lines: [{ name: 'IGST', rate: 0, amount: 0 }] as TaxLine[], note: `Supply meant for export under LUT ${s.lut_number} without payment of IGST`,
        placeOfSupply: `Outside India (${buyer!.country})` };
    }
    return { lines: [{ name: 'IGST', rate: s.rate, amount: pct(subtotal, s.rate) }] as TaxLine[], note: 'Export of services with payment of IGST',
      placeOfSupply: `Outside India (${buyer!.country})` };
  }
  const buyerState = buyer?.state_code || s.state_code;
  const placeOfSupply = `${GST_STATES[buyerState] ?? buyerState} (${buyerState})`;
  if (buyerState === s.state_code) {
    const half = s.rate / 2;
    return { lines: [{ name: 'CGST', rate: half, amount: pct(subtotal, half) }, { name: 'SGST', rate: half, amount: pct(subtotal, half) }] as TaxLine[], note: null, placeOfSupply };
  }
  return { lines: [{ name: 'IGST', rate: s.rate, amount: pct(subtotal, s.rate) }] as TaxLine[], note: null, placeOfSupply };
}

// ── amount in words (Indian numbering: thousand, lakh, crore) ─────────────────
const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen',
  'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function below1000(n: number): string {
  const h = Math.floor(n / 100), r = n % 100;
  const rest = r < 20 ? ONES[r]! : `${TENS[Math.floor(r / 10)]}${r % 10 ? ' ' + ONES[r % 10] : ''}`;
  return [h ? `${ONES[h]} Hundred` : '', rest].filter(Boolean).join(' ');
}
export function indianWords(n: number): string {
  if (n === 0) return 'Zero';
  const parts: string[] = [];
  const crore = Math.floor(n / 1e7); n %= 1e7;
  const lakh = Math.floor(n / 1e5); n %= 1e5;
  const thousand = Math.floor(n / 1000); n %= 1000;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  if (lakh) parts.push(`${below1000(lakh)} Lakh`);
  if (thousand) parts.push(`${below1000(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}
export function amountInWords(minor: number, currency: string): string {
  const major = Math.floor(minor / 100), minorPart = minor % 100;
  if (currency.toLowerCase() === 'inr') {
    return `Rupees ${indianWords(major)}${minorPart ? ` and ${indianWords(minorPart)} Paise` : ''} Only`;
  }
  return `${currency.toUpperCase()} ${indianWords(major)}${minorPart ? ` and ${minorPart}/100` : ''} Only`;
}

// ── the invoice document ─────────────────────────────────────────────────────
const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const money = (minor: number, currency: string) =>
  `${currency.toLowerCase() === 'inr' ? '₹' : currency.toUpperCase() + ' '}${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const d = (v: unknown) => new Date(v as string).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** A printable HTML tax invoice (browsers print it to PDF). */
export function renderInvoiceHtml(inv: Record<string, any>): string {
  const cur = String(inv['currency']);
  const seller = inv['seller'] as GstSettings | null;
  // without billing details the snapshot is just { organization }
  const buyer = inv['buyer'] as (Partial<BillingProfile> & { organization?: string | null }) | null;
  const lines = (inv['lines'] ?? []) as { description: string; quantity: number; unit: string; unit_amount: number; amount: number }[];
  const tax = (inv['tax_lines'] ?? []) as TaxLine[];
  const subtotal = Number(inv['subtotal'] ?? inv['total']);
  const total = Number(inv['total']);
  const title = seller ? 'Tax Invoice' : 'Invoice';
  const buyerAddress = buyer?.legal_name ? [buyer.address_line1, buyer.address_line2, [buyer.city, buyer.postal_code].filter(Boolean).join(' '),
    buyer.state_code ? `${GST_STATES[buyer.state_code] ?? ''} (${buyer.state_code})` : '', buyer.country !== 'IN' ? buyer.country : 'India'].filter(Boolean) : [];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} ${esc(inv['number'])}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #111; margin: 32px; font-size: 13px; }
  h1 { font-size: 20px; margin: 0 0 4px; } .muted { color: #555; } table { width: 100%; border-collapse: collapse; margin-top: 16px; }
  th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; vertical-align: top; } th { background: #f4f4f4; }
  td.n, th.n { text-align: right; white-space: nowrap; } .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
  .box { border: 1px solid #ccc; padding: 10px; } .tot td { font-weight: 600; } .sign { margin-top: 48px; text-align: right; }
  @media print { body { margin: 12mm; } .noprint { display: none; } }
</style></head><body>
<div style="display:flex;justify-content:space-between;align-items:flex-start">
  <div><h1>${title}</h1><div class="muted">Original for recipient</div></div>
  <div style="text-align:right"><div><b>Invoice no.</b> ${esc(inv['number'])}</div><div><b>Date</b> ${d(inv['issued_at'])}</div>
  <div><b>Due</b> ${d(inv['due_at'])}</div><div><b>Status</b> ${esc(inv['status'])}</div></div>
</div>
<div class="grid">
  <div class="box"><b>From</b><br>${seller ? `${esc(seller.legal_name)}<br>${esc(seller.address).replace(/\n/g, '<br>')}<br>
    State: ${esc(GST_STATES[seller.state_code] ?? '')} (${esc(seller.state_code)})<br><b>GSTIN</b> ${esc(seller.gstin)}${seller.email ? `<br>${esc(seller.email)}` : ''}` : 'OwnDatabase'}</div>
  <div class="box"><b>Bill to</b><br>${buyer?.legal_name ? `${esc(buyer.legal_name)}<br>${buyerAddress.map(esc).join('<br>')}
    ${buyer.gstin ? `<br><b>GSTIN</b> ${esc(buyer.gstin)}` : ''}${buyer.email ? `<br>${esc(buyer.email)}` : ''}` : esc(buyer?.organization ?? inv['organization_name'] ?? '')}</div>
</div>
${seller ? `<p><b>Place of supply:</b> ${esc(inv['place_of_supply'])} &nbsp; <b>Reverse charge:</b> No &nbsp; <b>Period:</b> ${d(inv['period_start'])} – ${d(inv['period_end'])}</p>` : ''}
<table><thead><tr><th>#</th><th>Description</th>${seller ? '<th>SAC</th>' : ''}<th class="n">Qty</th><th>Unit</th><th class="n">Rate</th><th class="n">Taxable value</th></tr></thead><tbody>
${lines.map((l, i) => `<tr><td>${i + 1}</td><td>${esc(l.description)}</td>${seller ? `<td>${esc(inv['sac_code'])}</td>` : ''}<td class="n">${l.quantity}</td><td>${esc(l.unit)}</td>
  <td class="n">${money(l.unit_amount, cur)}</td><td class="n">${money(l.amount, cur)}</td></tr>`).join('')}
</tbody></table>
<table style="width:auto;margin-left:auto"><tbody>
<tr><td>Taxable value</td><td class="n">${money(subtotal, cur)}</td></tr>
${tax.map((t) => `<tr><td>${t.name} @ ${t.rate}%</td><td class="n">${money(t.amount, cur)}</td></tr>`).join('')}
<tr class="tot"><td>Total</td><td class="n">${money(total, cur)}</td></tr>
</tbody></table>
<p><b>Amount in words:</b> ${esc(amountInWords(total, cur))}</p>
${inv['tax_note'] ? `<p><b>Note:</b> ${esc(inv['tax_note'])}</p>` : ''}
${seller && tax.length ? `<table style="width:auto"><thead><tr><th>SAC</th><th class="n">Taxable value</th>${tax.map((t) => `<th class="n">${t.name} (${t.rate}%)</th>`).join('')}<th class="n">Total tax</th></tr></thead>
<tbody><tr><td>${esc(inv['sac_code'])}</td><td class="n">${money(subtotal, cur)}</td>${tax.map((t) => `<td class="n">${money(t.amount, cur)}</td>`).join('')}
<td class="n">${money(Number(inv['tax_total'] ?? 0), cur)}</td></tr></tbody></table>` : ''}
${seller ? `<div class="sign">For ${esc(seller.legal_name)}<br><br><br>Authorised signatory</div>` : ''}
<p class="noprint muted" style="margin-top:32px">Use your browser's Print → Save as PDF to keep a copy.</p>
</body></html>`;
}
