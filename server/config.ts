import 'dotenv/config';
import { z } from 'zod';

const googleServiceAccountSchema = z.object({
  type: z.literal('service_account').optional(),
  project_id: z.string().optional(),
  client_email: z.string().email(),
  private_key: z.string().min(1),
  private_key_id: z.string().optional()
});

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(process.env.VERCEL === '1' ? 80 : 3001),
  DATABASE_PATH: z.string().min(1).default('.data/rooms.sqlite'),
  PRODUCT_NAME: z.string().trim().min(1).max(48).default('Lingua Live'),
  APP_ORIGIN: z.string().url().optional().or(z.literal('')),
  GOOGLE_CLOUD_PROJECT: z.string().trim().min(1).optional().or(z.literal('')),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().trim().optional().or(z.literal('')),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().trim().optional().or(z.literal('')),
  TURN_URL: z.string().trim().optional().or(z.literal('')),
  TURN_USERNAME: z.string().trim().optional().or(z.literal('')),
  TURN_CREDENTIAL: z.string().trim().optional().or(z.literal(''))
});
const result = schema.safeParse(process.env);
if (!result.success) {
  throw new Error('Invalid server configuration: ' + result.error.issues.map((issue) => issue.path.join('.') + ' ' + issue.message).join('; '));
}
const env = result.data;
let googleCredentials: z.infer<typeof googleServiceAccountSchema> | undefined;
if (env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  let parsedCredentials: unknown;
  try {
    parsedCredentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    throw new Error('Invalid server configuration: GOOGLE_SERVICE_ACCOUNT_JSON must contain valid JSON.');
  }
  const credentialsResult = googleServiceAccountSchema.safeParse(parsedCredentials);
  if (!credentialsResult.success) {
    throw new Error('Invalid server configuration: GOOGLE_SERVICE_ACCOUNT_JSON must contain service-account client_email and private_key fields.');
  }
  googleCredentials = credentialsResult.data;
}
if ((env.TURN_URL || env.TURN_USERNAME || env.TURN_CREDENTIAL) && !(env.TURN_URL && env.TURN_USERNAME && env.TURN_CREDENTIAL)) {
  throw new Error('TURN_URL, TURN_USERNAME, and TURN_CREDENTIAL must be set together.');
}
export const config = {
  nodeEnv: env.NODE_ENV,
  port: env.PORT,
  databasePath: env.DATABASE_PATH,
  productName: env.PRODUCT_NAME,
  appOrigin: env.APP_ORIGIN || undefined,
  googleProjectId: env.GOOGLE_CLOUD_PROJECT || undefined,
  googleCredentials,
  googleConfigured: Boolean(env.GOOGLE_CLOUD_PROJECT) &&
    (process.env.VERCEL !== '1' || Boolean(env.GOOGLE_SERVICE_ACCOUNT_JSON || env.GOOGLE_APPLICATION_CREDENTIALS)),
  turn: env.TURN_URL && env.TURN_USERNAME && env.TURN_CREDENTIAL
    ? { urls: env.TURN_URL, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }
    : undefined
};
