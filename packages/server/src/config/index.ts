import path from 'node:path';
import { z } from 'zod';

export const ConfigSchema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('127.0.0.1'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  BROWSER_HEADLESS: z
    .string()
    .optional()
    .transform((val) => val === 'true' || val === '1'),
  BROWSER_USER_DATA_DIR: z.string().default('./data/browser-profile'),
  BROWSER_SLOW_MO: z.coerce.number().default(0),
  BROWSER_NAVIGATION_TIMEOUT: z.coerce.number().default(30000),
  DISPLAY: z.string().optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

/**
 * Loads and validates environment variables.
 * Resolves paths relative to project root or provided base directory.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env, baseDir = process.cwd()) {
  const parsed = ConfigSchema.parse(env);
  
  // Resolve absolute path for user data directory cross-platform
  const resolvedUserDataDir = path.isAbsolute(parsed.BROWSER_USER_DATA_DIR)
    ? parsed.BROWSER_USER_DATA_DIR
    : path.resolve(baseDir, parsed.BROWSER_USER_DATA_DIR);

  return {
    ...parsed,
    RESOLVED_BROWSER_USER_DATA_DIR: resolvedUserDataDir,
  };
}
