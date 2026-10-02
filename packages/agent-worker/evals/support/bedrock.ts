/**
 * Bedrock for the live evals and the fixture-turn recorder: the environment's
 * keys when set, otherwise the AWS CLI's for `AWS_PROFILE` (an SSO profile
 * included), read through `aws configure export-credentials` so they are never
 * printed or stored.
 */
import { execFileSync } from 'node:child_process';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';

export const LIVE_MODEL_ID = process.env.EVAL_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6';

async function credentials() {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }
  const exported = JSON.parse(
    execFileSync('aws', ['configure', 'export-credentials', '--format', 'process'], { encoding: 'utf8' }),
  ) as { AccessKeyId: string; SecretAccessKey: string; SessionToken?: string };
  return {
    accessKeyId: exported.AccessKeyId,
    secretAccessKey: exported.SecretAccessKey,
    sessionToken: exported.SessionToken,
  };
}

/** A live Bedrock provider; `fetch` lets a recorder keep what comes back. */
export function liveBedrock(options: { fetch?: typeof fetch } = {}) {
  return createAmazonBedrock({
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentialProvider: credentials,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
