// src/pricing.mjs — money, in VND, integer-only.
// Prices are in VND and people read them as "500k", so the
// currency is an integer, never a float, and formatting is the Vietnamese convention.

export const PLATFORM_TAKE_RATE = 0.2;
export const PLATFORM_TAKE_PCT = 20;
export const MIN_MINUTES = 30;
export const MAX_MINUTES = 480;
export const DEFAULT_MINUTES = 45;
/** One rounding step: a price can never be 0. A business floor is the operator's call, not this constant. */
export const MIN_PRICE_VND = 10_000;

/** Round to the nearest 10,000 VND: nobody quotes a consultation at 483,333 VND. */
export function roundVnd(n, step = 10000) {
  return Math.round(n / step) * step;
}

/** One division of an exact integer: no intermediate float to round twice. */
export function priceFor(rateVnd, minutes) {
  return Math.round((rateVnd * minutes) / 600000) * 10000;
}

/** `takePct` is a whole percent (20, not 0.2), so the fee is one division of an exact integer. */
export function split(priceVnd, takePct = PLATFORM_TAKE_PCT) {
  const fee = Math.round((priceVnd * takePct) / 100000) * 1000;
  return { price_vnd: priceVnd, fee_vnd: fee, payout_vnd: priceVnd - fee };
}

export function quote(rateVnd, minutes = DEFAULT_MINUTES, takePct = PLATFORM_TAKE_PCT, minMinutes = MIN_MINUTES) {
  if (!Number.isInteger(rateVnd) || rateVnd < 0) throw new Error('The practitioner rate must be a whole number of VND.');
  if (!Number.isInteger(minutes)) throw new Error('minutes must be a whole number');
  if (minutes < minMinutes) throw new Error(`minimum ${minMinutes} minutes`);
  if (minutes > MAX_MINUTES) throw new Error(`maximum ${MAX_MINUTES} minutes`);
  if (!Number.isInteger(takePct) || takePct < 0 || takePct > 100) throw new Error('The platform share must be a whole percent.');
  const price = priceFor(rateVnd, minutes);
  if (!Number.isSafeInteger(price) || price < MIN_PRICE_VND) {
    throw new Error("This practitioner's rate is too low to quote a session.");
  }
  return { minutes, ...split(price, takePct) };
}

/** "600,000 VND" — integer VND, no decimals, thousands separated. */
export function formatVnd(n) {
  return `${Math.round(n).toLocaleString('en-US')} VND`;
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
