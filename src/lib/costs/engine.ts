/**
 * PLAN §3 — turns quantities into a cost report: billable = max(0, quantity − free_quota), what
 * percentage of each free tier is gone, which metric runs out first and how many days that leaves at the
 * measured daily rate.
 *
 * Pure: no database, no network, no clock beyond `generated_at`.
 */
import {
  MONTH_DAYS, PRICING, PROVIDER_ORDER, findPrice,
  type PriceEntry, type ProviderId,
} from './pricing.js'

export interface QuantityInput {
  provider: ProviderId
  metric: string
  /** Quantity for one 30-day billing month — the number billing is applied to. */
  quantity: number
  /**
   * Quantity already consumed in the current period (a `flow` metric's window total, or a `level`
   * metric's present level). Used for `days_until_free_exhausted`; defaults to 0 for flows and to
   * `quantity` for levels.
   */
  measured?: number
  /** Units per day at the current rate. Defaults to `quantity / 30` for flows and 0 for levels. */
  daily_rate?: number
  /** Where the number came from, e.g. `api_usage`, `usage_events:ably_publish`, `projection`. */
  basis?: string
}

export interface CostItem {
  provider: ProviderId
  metric: string
  label: string
  quantity: number
  measured_quantity: number | null
  unit: string
  free_quota: number
  billable_quantity: number
  unit_price_usd: number
  cost_usd: number
  /** Percentage of the monthly free quota this quantity uses; null when the metric has no free quota. */
  used_pct: number | null
  /** Days before the free quota is gone at `daily_rate`; 0 when already gone, null when not derivable. */
  days_until_free_exhausted: number | null
  source: string
  as_of: string
  verified: boolean
  basis: string | null
  note?: string
}

export interface FreeTierSummary {
  used_pct_max: number
  first_exhausted_metric?: string
  days_until_paid_at_current_rate?: number
}

export interface ProviderReport {
  provider: ProviderId
  provider_label: string
  items: CostItem[]
  total_usd: number
  free_tier: FreeTierSummary
}

export interface ActualSpend {
  gcp: { total_usd: number; by_service: Record<string, number>; days: number } | null
}

export interface CostReport {
  generated_at: string
  /** Days of measurement behind the quantities; null for a pure projection. */
  window_days: number | null
  month_days: number
  providers: ProviderReport[]
  grand_total_usd: number
  /** Same figure as `grand_total_usd`: quantities are always normalised to a 30-day month. */
  monthly_run_rate_usd: number
  free_tier: FreeTierSummary
  actual: ActualSpend
  /** `provider/metric` of every price whose number could not be read from the provider's own page. */
  unverified_metrics: string[]
}

export interface EstimateOptions {
  pricing?: readonly PriceEntry[]
  window_days?: number | null
  actual?: ActualSpend
}

const round = (n: number, dp = 6): number => {
  const f = 10 ** dp
  return Math.round((Number.isFinite(n) ? n : 0) * f) / f
}

/** `max(0, quantity − free_quota)` — the whole of the billing model in one line. */
export function billable(quantity: number, freeQuota: number): number {
  return Math.max(0, quantity - Math.max(0, freeQuota))
}

/** Percentage of a monthly free quota a quantity consumes; null when the metric has no free quota. */
export function usedPct(quantity: number, freeQuota: number): number | null {
  if (freeQuota <= 0) return null
  return round((quantity / freeQuota) * 100, 4)
}

/**
 * Days before the free quota is used up: what is left of the quota divided by the daily rate. 0 when the
 * quota has already gone, null when there is no quota or no rate to extrapolate from.
 */
export function daysUntilExhausted(consumed: number, freeQuota: number, dailyRate: number): number | null {
  if (freeQuota <= 0) return null
  if (consumed >= freeQuota) return 0
  if (!(dailyRate > 0)) return null
  return round((freeQuota - consumed) / dailyRate, 3)
}

function itemFor(input: QuantityInput, entry: PriceEntry): CostItem {
  const quantity = Math.max(0, input.quantity)
  const consumed = Math.max(0, input.measured ?? (entry.kind === 'level' ? quantity : 0))
  const dailyRate = input.daily_rate ?? (entry.kind === 'flow' ? quantity / MONTH_DAYS : 0)
  const billableQuantity = billable(quantity, entry.free_quota)
  return {
    provider: entry.provider,
    metric: entry.metric,
    label: entry.label,
    quantity: round(quantity, 6),
    measured_quantity: input.measured === undefined ? null : round(input.measured, 6),
    unit: entry.unit,
    free_quota: entry.free_quota,
    billable_quantity: round(billableQuantity, 6),
    unit_price_usd: entry.unit_price_usd,
    cost_usd: round(billableQuantity * entry.unit_price_usd, 6),
    used_pct: usedPct(quantity, entry.free_quota),
    days_until_free_exhausted: daysUntilExhausted(consumed, entry.free_quota, dailyRate),
    source: entry.source,
    as_of: entry.as_of,
    verified: entry.verified,
    basis: input.basis ?? null,
    ...(entry.note ? { note: entry.note } : {}),
  }
}

/**
 * Free-tier headline for a set of items: the fullest free tier, and the metric that will run out first
 * (soonest exhaustion, ties broken by the fuller quota). Metrics with no free quota — the Apple
 * membership — are never "the first to exhaust" because they are billable from the first unit.
 */
export function summariseFreeTier(items: CostItem[]): FreeTierSummary {
  const gated = items.filter((i) => i.free_quota > 0)
  if (gated.length === 0) return { used_pct_max: 0 }
  const used_pct_max = round(Math.max(...gated.map((i) => i.used_pct ?? 0)), 4)
  const ranked = gated
    .filter((i) => i.days_until_free_exhausted !== null)
    .sort((a, b) => (a.days_until_free_exhausted! - b.days_until_free_exhausted!) || ((b.used_pct ?? 0) - (a.used_pct ?? 0)))
  const first = ranked[0]
  if (!first) return { used_pct_max }
  return {
    used_pct_max,
    first_exhausted_metric: `${first.provider}/${first.metric}`,
    days_until_paid_at_current_rate: first.days_until_free_exhausted ?? undefined,
  }
}

/**
 * Costs one month of usage. Quantities are monthly (`usage.ts` normalises measured windows, `projection.ts`
 * produces them directly); unknown provider/metric pairs are ignored rather than throwing, so a stale
 * caller can never break the endpoint.
 */
export function estimate(quantities: QuantityInput[], opts: EstimateOptions = {}): CostReport {
  const table = opts.pricing ?? PRICING
  const byKey = new Map(table.map((p) => [`${p.provider}/${p.metric}`, p]))
  const items: CostItem[] = []
  for (const q of quantities) {
    const entry = byKey.get(`${q.provider}/${q.metric}`) ?? findPrice(q.provider, q.metric)
    if (!entry) continue
    items.push(itemFor(q, entry))
  }

  const labels = new Map<ProviderId, string>(table.map((p) => [p.provider, p.provider_label]))
  const providers: ProviderReport[] = []
  const seen = new Set<ProviderId>(items.map((i) => i.provider))
  const order = [...PROVIDER_ORDER.filter((p) => seen.has(p)), ...[...seen].filter((p) => !PROVIDER_ORDER.includes(p))]
  for (const provider of order) {
    const own = items.filter((i) => i.provider === provider)
    if (own.length === 0) continue
    providers.push({
      provider,
      provider_label: labels.get(provider) ?? provider,
      items: own,
      total_usd: round(own.reduce((s, i) => s + i.cost_usd, 0), 6),
      free_tier: summariseFreeTier(own),
    })
  }

  const grand = round(providers.reduce((s, p) => s + p.total_usd, 0), 6)
  return {
    generated_at: new Date().toISOString(),
    window_days: opts.window_days ?? null,
    month_days: MONTH_DAYS,
    providers,
    grand_total_usd: grand,
    monthly_run_rate_usd: grand,
    free_tier: summariseFreeTier(items),
    actual: opts.actual ?? { gcp: null },
    unverified_metrics: items.filter((i) => !i.verified).map((i) => `${i.provider}/${i.metric}`),
  }
}
