import { zValidator as honoZValidator } from '@hono/zod-validator'
import type { Env, ValidationTargets } from 'hono'
import type { ZodSchema, z } from 'zod'
import { badRequest } from './errors.js'

/**
 * `@hono/zod-validator` answers a failed validation with its own `{ success: false, error: ZodError }`
 * body, not the `{ error: { code, message, details? } }` envelope documented in docs/API.md and used by
 * every other 400 in this API (see `lib/errors.ts`). This wraps it with a hook that throws the same
 * `AppError('bad_request', …)` the rest of the app throws, so `app.onError` renders one consistent shape
 * everywhere. Every call site keeps the exact `zValidator(target, schema)` signature and its inferred
 * `c.req.valid(target)` typing — only the import changes, from `@hono/zod-validator` to this module.
 */
export function zValidator<
  T extends ZodSchema<any, z.ZodTypeDef, any>,
  Target extends keyof ValidationTargets,
  E extends Env = Env,
  P extends string = string,
>(target: Target, schema: T) {
  return honoZValidator<T, Target, E, P>(target, schema, (result) => {
    if (!result.success) throw badRequest('validation failed', result.error.issues)
  })
}
