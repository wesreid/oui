/**
 * Bedrock for the live evals and the fixture-turn recorder: the environment's
 * keys when set, otherwise the AWS CLI's for `AWS_PROFILE` (an SSO profile
 * included), read through `aws configure export-credentials` so they are never
 * printed or stored.
 */
import { execFileSync } from 'node:child_process';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import type { ProviderOptions } from '../../src/model.js';

export const LIVE_MODEL_ID = process.env.EVAL_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6';

/**
 * What every live turn is sent besides its own config, from the environment:
 * - `EVAL_TEMPERATURE=none` sends no temperature, for a model that takes none
 *   (Claude Sonnet 5.5 on Bedrock).
 * - `EVAL_THINKING_DISPLAY=summarized` (or `omitted`) asks the model to return
 *   its thinking that way, as a host's `modelProviderOptions` would on every
 *   call: the same scenarios then compare a host that shows the person the
 *   model's thinking (ADR-0272 §2.4) with one that does not.
 */
export function liveTurnSettings(): { temperature?: null; modelProviderOptions?: ProviderOptions } {
  const display = process.env.EVAL_THINKING_DISPLAY;
  return {
    ...(process.env.EVAL_TEMPERATURE === 'none' ? { temperature: null } : {}),
    ...(display
      ? { modelProviderOptions: { amazonBedrock: { additionalModelRequestFields: { thinking: { type: 'adaptive', display } } } } }
      : {}),
  };
}

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
