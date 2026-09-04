/** PLAN §3 — cost estimation: a price table, measured usage, the estimator and the projection calculator. */
export {
  MONTH_DAYS, PRICING, PROVIDER_LABELS, PROVIDER_ORDER, findPrice, pricingTable, unverifiedEntries,
  type MetricKind, type PriceEntry, type ProviderId,
} from './pricing.js'
export {
  billable, daysUntilExhausted, estimate, summariseFreeTier, usedPct,
  type ActualSpend, type CostItem, type CostReport, type EstimateOptions, type FreeTierSummary,
  type ProviderReport, type QuantityInput,
} from './engine.js'
export {
  USAGE_CONSTANTS, caveatsFor, measureUsage, quantitiesFrom, usageFor,
  type MeasuredUsage, type UsageEventTotals, type UsageResult,
} from './usage.js'
export {
  PROJECTION_CONSTANTS, PROJECTION_DEFAULTS, assumptionsFor, project, projectQuantities, withDefaults,
  type Projection, type ProjectionParams,
} from './projection.js'
