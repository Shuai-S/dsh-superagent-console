import z from '@deepseek-ai/schemastery'

/** Resolved console settings `apply` reads. */
export type ResolvedConsoleConfig = { target: string }

/** Console settings section (auto-projected into the desktop plugin page). */
export const Config: z<ResolvedConsoleConfig, any> = z.object({
  target: z.string().default('http://127.0.0.1:3082').description('Superagent engine address (the dedicated profile web service)'),
})