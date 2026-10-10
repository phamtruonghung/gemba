// src/pricing.mjs — money, in VND, integer-only.
// Vietnam keeps prices in đồng and people read them as "500k" or "500.000đ", so the
// currency is an integer, never a float, and formatting is the Vietnamese convention.

export const PLATFORM_TAKE_RATE = 0.2;
export const MIN_MINUTES = 30;
export const DEFAULT_MINUTES = 45;

/** Round to the nearest 10.000đ: nobody quotes a consultation at 483.333đ. */
export function roundVnd(n, step = 10000) {
  return Math.round(n / step) * step;
}

export function priceFor(rateVnd, minutes) {
  return roundVnd((rateVnd * minutes) / 60);
}

export function split(priceVnd, takeRate = PLATFORM_TAKE_RATE) {
  const fee = roundVnd(priceVnd * takeRate, 1000);
  return { price_vnd: priceVnd, fee_vnd: fee, payout_vnd: priceVnd - fee };
}

export function quote(rateVnd, minutes = DEFAULT_MINUTES, takeRate = PLATFORM_TAKE_RATE) {
  if (minutes < MIN_MINUTES) throw new Error(`tối thiểu ${MIN_MINUTES} phút`);
  return { minutes, ...split(priceFor(rateVnd, minutes), takeRate) };
}

/** "600.000đ" — the way the number is written in Vietnam (dot thousands separator). */
export function formatVnd(n) {
  return `${Math.round(n).toLocaleString('de-DE')}đ`;
}

/** A safe default when an expert has not set a rate: seniority, cheap-first. */
export function suggestRateVnd(years = 0) {
  if (years >= 15) return 900000;
  if (years >= 10) return 700000;
  if (years >= 5) return 500000;
  return 350000;
}

/**
 * VietQR/EMVCo-style transfer payload. This is the instruction a customer's banking app
 * understands; the platform never claims a payment is settled until a human confirms it.
 */
export function transferInstruction({ bankBin, account, amountVnd, ref }) {
  const amount = Math.round(amountVnd);
  const qr = `https://img.vietqr.io/image/${bankBin}-${account}-compact2.png?amount=${amount}&addInfo=${encodeURIComponent(ref)}`;
  return { bank_bin: bankBin, account, amount_vnd: amount, ref, qr_url: qr };
}
