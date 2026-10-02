/** The shapes the approval endpoints and the `approval:decide` event accept. Unknown keys are refused. */
import Joi from 'joi';
import { APPROVAL_CHANNELS, ARGS_HASH_PATTERN } from '@ouispec/agent-core';

const id = Joi.string().min(1).max(200);
const text = (max: number) => Joi.string().max(max);

export const pendingApprovalSchema = Joi.object({
  approvalId: id.required(),
  toolCallId: id.required(),
  conversationId: id.required(),
  turnId: id.required(),
  userId: id.required(),
  tool: id.required(),
  args: Joi.object().unknown(true).required(),
  argsHash: Joi.string().pattern(ARGS_HASH_PATTERN).required(),
  effect: Joi.string().min(1).max(64).required(),
  destructive: Joi.boolean().required(),
  argsSensitive: Joi.boolean().required(),
  expiresAt: Joi.number().integer().positive().required(),
  preview: Joi.object({
    title: text(500).min(1).required(),
    consequence: text(2000),
    arguments: Joi.array()
      .items(Joi.object({ name: text(200).required(), label: text(500).required(), value: text(4000).allow('').required() }))
      .max(50)
      .required(),
    readback: text(8000).allow('').required(),
  }).required(),
});

export const decidePayloadSchema = Joi.object({
  approvalId: id.required(),
  decision: Joi.string().valid('approve', 'decline').required(),
});

export const internalDecideSchema = Joi.object({
  userId: id.required(),
  decision: Joi.string().valid('approve', 'decline').required(),
  channel: Joi.string()
    .valid(...APPROVAL_CHANNELS)
    .required(),
});

export const redeemSchema = Joi.object({
  token: Joi.string().max(4096).required(),
  userId: id.required(),
  conversationId: id.required(),
});
