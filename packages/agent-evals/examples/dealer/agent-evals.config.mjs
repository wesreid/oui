/**
 * The dealer example's eval configuration: three channels, one suite, the
 * dealer agent as its worker would be configured, and Claude on Bedrock.
 *
 *   agent-evals --config examples/dealer/agent-evals.config.mjs            replay the recordings (CI)
 *   AWS_PROFILE=… agent-evals --config examples/dealer/agent-evals.config.mjs --record
 */
import { execFileSync } from 'node:child_process';
import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { defineEvals } from '@ouispec/agent-evals';
import { dealerAgent } from './dealer-agent.mjs';

export const MODEL_ID = process.env.EVAL_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6';

/** The environment's keys, or the AWS CLI's for AWS_PROFILE, read without printing or storing them. */
async function liveCredentials() {
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }
  const exported = JSON.parse(execFileSync('aws', ['configure', 'export-credentials', '--format', 'process'], { encoding: 'utf8' }));
  return { accessKeyId: exported.AccessKeyId, secretAccessKey: exported.SecretAccessKey, sessionToken: exported.SessionToken };
}

/** A replay signs with throwaway keys: nothing leaves the process. */
const replayCredentials = async () => ({ accessKeyId: 'AKIDAGENTEVALSREPLAY', secretAccessKey: 'agent-evals-replay-secret' });

export default defineEvals({
  root: new URL('.', import.meta.url),
  suites: ['dealer.evals.yaml'],
  cassettes: 'cassettes',
  channels: {
    web_chat: { approvals: 'ui' },
    sms: { approvals: 'sms' },
    voice: { approvals: 'voice', input: { mode: 'voice', language: 'en' } },
  },
  model: ({ fetch, mode }) =>
    createAmazonBedrock({
      region: process.env.AWS_REGION ?? 'us-east-1',
      credentialProvider: mode === 'replay' ? replayCredentials : liveCredentials,
      fetch,
    })(MODEL_ID),
  agent: ({ channel }) => dealerAgent({ channel }),
});
