import { z } from "zod";

const configSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.coerce
    .number()
    .int()
    .positive()
    .default(3000),

  DATABASE_URL: z.string().optional(),
  DIRECT_URL: z.string().optional()
});

export type AppConfig = z.infer<typeof configSchema>;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env
): AppConfig {
  return configSchema.parse(env);
}
