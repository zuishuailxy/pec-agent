/**
 * 定点十进制运算（不依赖第三方库）。
 *
 * 题目 R1 要求 DECIMAL(18,4) + ROUND_HALF_UP，且禁止 JS number 累加；预装 package.json
 * 只读、没有 decimal.js，所以这里用 BigInt 实现 4 位定点：
 *   Fixed = 真实值 × 10^4
 *
 * 所有对外金额一律输出两位小数字符串（例如 "57600.00"），便于评测逐位比对。
 */

const SCALE = 4
const FACTOR = 10n ** BigInt(SCALE)
const POW10 = [1n, 10n, 100n, 1000n, 10000n]

export type Fixed = bigint

function roundDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error('E_DIV_ZERO: division by zero')
  const negative = (numerator < 0n) !== (denominator < 0n)
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  const quotient = n / d
  const remainder = n % d
  const rounded = remainder * 2n >= d ? quotient + 1n : quotient
  return negative ? -rounded : rounded
}

function decimalString(input: string | number): string {
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new Error(`INVALID_ARGUMENT: 非法数字 ${input}`)
    // JS 的 String(number) 保证最短往返表示，不会引入额外小数位。
    return String(input)
  }
  return input.trim()
}

/** 解析为 4 位定点；多余小数位按 HALF_UP 舍入。 */
export function toFixed(input: string | number): Fixed {
  const raw = decimalString(input)
  if (!/^-?\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error(`INVALID_ARGUMENT: 非法十进制数 "${raw}"`)
  }
  const negative = raw.startsWith('-')
  const body = negative ? raw.slice(1) : raw
  const [intPart, fracPart = ''] = body.split('.')
  const frac = fracPart.padEnd(SCALE + 1, '0')
  let value = BigInt(intPart) * FACTOR + BigInt(frac.slice(0, SCALE))
  // 第 5 位小数决定是否进位（HALF_UP）
  if (frac.length > SCALE && frac[SCALE] >= '5') value += 1n
  return negative ? -value : value
}

/** 把 Fixed 保留到 targetScale 位（HALF_UP）。 */
export function rescale(value: Fixed, targetScale = 2): Fixed {
  if (targetScale >= SCALE) return value * BIG_POW(targetScale - SCALE)
  return roundDiv(value, BIG_POW(SCALE - targetScale))
}

function BIG_POW(exponent: number): bigint {
  if (exponent < 0) throw new Error('INVALID_ARGUMENT: negative exponent')
  return exponent <= 4 ? POW10[exponent] : 10n ** BigInt(exponent)
}

/** 定点乘法定点，HALF_UP 到 4 位。 */
export function mulFixed(a: Fixed, b: Fixed): Fixed {
  return roundDiv(a * b, FACTOR)
}

/** 定点除法，HALF_UP 到 4 位；除数为 0 抛 E_DIV_ZERO。 */
export function divFixed(a: Fixed, b: Fixed): Fixed {
  if (b === 0n) throw new Error('E_DIV_ZERO: division by zero')
  return roundDiv(a * FACTOR, b)
}

/** 向上取整到整数（计费体积 R2）。 */
export function ceilInt(value: Fixed): bigint {
  const quotient = value / FACTOR
  return value % FACTOR > 0n ? quotient + 1n : quotient
}

/** 两位小数字符串，例如 57600.00；千分位由调用方决定。 */
export function fixedToString(value: Fixed, targetScale = 2): string {
  const scaled = rescale(value, targetScale)
  const negative = scaled < 0n
  const abs = negative ? -scaled : scaled
  const unit = BIG_POW(targetScale)
  const intPart = abs / unit
  const fracPart = (abs % unit).toString().padStart(targetScale, '0')
  return `${negative ? '-' : ''}${intPart}${targetScale > 0 ? '.' + fracPart : ''}`
}

/** 带千分位的金额，用于 render（模型/人读）。 */
export function formatMoney(value: Fixed): string {
  const [intPart, frac] = fixedToString(value, 2).split('.')
  const negative = intPart.startsWith('-')
  const digits = negative ? intPart.slice(1) : intPart
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}${grouped}.${frac}`
}

/** 整数乘定点（数量 × 单价）。 */
export function mulIntFixed(integer: bigint | number, value: Fixed): Fixed {
  return mulFixed(BigInt(integer) * FACTOR, value)
}

/** 百分比/千分比等字符串转定点，例如 "3‰" → 0.003。 */
export function rateFromPermille(permille: string | number): Fixed {
  return divFixed(toFixed(String(permille)), toFixed('1000'))
}

/** 日期差（天），ISO 日期都按 UTC 零点解析，避免本地时区偏移。 */
export function dayDiff(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`)
  const to = Date.parse(`${toIso}T00:00:00Z`)
  if (Number.isNaN(from) || Number.isNaN(to)) throw new Error(`INVALID_ARGUMENT: 非法日期 ${fromIso}/${toIso}`)
  return Math.round((to - from) / 86_400_000)
}
