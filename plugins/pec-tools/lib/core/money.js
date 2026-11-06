const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);
const POW10 = [1n, 10n, 100n, 1000n, 10000n];
function roundDiv(numerator, denominator) {
  if (denominator === 0n) throw new Error("E_DIV_ZERO: division by zero");
  const negative = numerator < 0n !== denominator < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  const quotient = n / d;
  const remainder = n % d;
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}
function decimalString(input) {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error(`INVALID_ARGUMENT: \u975E\u6CD5\u6570\u5B57 ${input}`);
    return String(input);
  }
  return input.trim();
}
function toFixed(input) {
  const raw = decimalString(input);
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error(`INVALID_ARGUMENT: \u975E\u6CD5\u5341\u8FDB\u5236\u6570 "${raw}"`);
  }
  const negative = raw.startsWith("-");
  const body = negative ? raw.slice(1) : raw;
  const [intPart, fracPart = ""] = body.split(".");
  const frac = fracPart.padEnd(SCALE + 1, "0");
  let value = BigInt(intPart) * FACTOR + BigInt(frac.slice(0, SCALE));
  if (frac.length > SCALE && frac[SCALE] >= "5") value += 1n;
  return negative ? -value : value;
}
function rescale(value, targetScale = 2) {
  if (targetScale >= SCALE) return value * BIG_POW(targetScale - SCALE);
  return roundDiv(value, BIG_POW(SCALE - targetScale));
}
function BIG_POW(exponent) {
  if (exponent < 0) throw new Error("INVALID_ARGUMENT: negative exponent");
  return exponent <= 4 ? POW10[exponent] : 10n ** BigInt(exponent);
}
function mulFixed(a, b) {
  return roundDiv(a * b, FACTOR);
}
function divFixed(a, b) {
  if (b === 0n) throw new Error("E_DIV_ZERO: division by zero");
  return roundDiv(a * FACTOR, b);
}
function ceilInt(value) {
  const quotient = value / FACTOR;
  return value % FACTOR > 0n ? quotient + 1n : quotient;
}
function fixedToString(value, targetScale = 2) {
  const scaled = rescale(value, targetScale);
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const unit = BIG_POW(targetScale);
  const intPart = abs / unit;
  const fracPart = (abs % unit).toString().padStart(targetScale, "0");
  return `${negative ? "-" : ""}${intPart}${targetScale > 0 ? "." + fracPart : ""}`;
}
function formatMoney(value) {
  const [intPart, frac] = fixedToString(value, 2).split(".");
  const negative = intPart.startsWith("-");
  const digits = negative ? intPart.slice(1) : intPart;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${grouped}.${frac}`;
}
function mulIntFixed(integer, value) {
  return mulFixed(BigInt(integer) * FACTOR, value);
}
function rateFromPermille(permille) {
  return divFixed(toFixed(String(permille)), toFixed("1000"));
}
function dayDiff(fromIso, toIso) {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error(`INVALID_ARGUMENT: \u975E\u6CD5\u65E5\u671F ${fromIso}/${toIso}`);
  return Math.round((to - from) / 864e5);
}
export {
  ceilInt,
  dayDiff,
  divFixed,
  fixedToString,
  formatMoney,
  mulFixed,
  mulIntFixed,
  rateFromPermille,
  rescale,
  toFixed
};
//# sourceMappingURL=money.js.map
