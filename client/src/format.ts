const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
export const rupees = (paise: number | null | undefined) => (paise === null || paise === undefined ? '—' : inr.format(paise / 100));

const dateFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const dateTimeFmt = new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/** yyyy-mm-dd → "02 Oct 2026" (calendar date, no timezone shift). */
export const date = (iso: string | null | undefined) => (iso ? dateFmt.format(new Date(iso.length === 10 ? `${iso}T12:00:00+05:30` : iso)) : '—');
export const dateTime = (iso: string | null | undefined) => (iso ? `${dateTimeFmt.format(new Date(iso))} IST` : '—');

export const units = (n: number | null | undefined, unit: string) => (n === null || n === undefined ? '—' : `${n.toLocaleString('en-IN', { maximumFractionDigits: 3 })} ${unit}`);

export const humanize = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function ago(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}
