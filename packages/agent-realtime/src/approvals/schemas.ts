/** The shapes the approval endpoints and the `approval:decide` and `approval:claim` events accept. Unknown keys are refused. */
import Joi from 'joi';
import { APPROVAL_CHANNELS, APPROVAL_PREVIEW_LIMITS as L, ARGS_HASH_PATTERN } from '@ouispec/agent-core';

const id = Joi.string().min(1).max(200);
const text = (max: number) => Joi.string().max(max);

export const pendingApprovalSchema = Joi.object({
  approvalId: id.required(),
  toolCallId: id.required(),
  conversationId: id.required(),
  turnId: id.required(),
  userId: id.required(),
  accountId: id,
  tool: id.required(),
  toolKind: Joi.string().valid('ui', 'backend'),
  // The room of the turn that asked, for an action on the person's page; the route checks it is one of the product's.
  room: Joi.string().min(1).max(200),
  operationId: id,
  // An origin; the store checks it is exactly one.
  audience: Joi.string().max(2048).pattern(/^https?:\/\/[^/?#]+$/),
  args: Joi.object().unknown(true).required(),
  argsHash: Joi.string().pattern(ARGS_HASH_PATTERN).required(),
  effect: Joi.string().min(1).max(64).required(),
  destructive: Joi.boolean().required(),
  argsSensitive: Joi.boolean().required(),
  expiresAt: Joi.number().integer().positive().required(),
  preview: Joi.object({
    title: text(L.title).min(1).required(),
    consequence: text(L.consequence),
    arguments: Joi.array()
      .items(
        Joi.object({
          name: text(L.argumentName).required(),
          label: text(L.argumentLabel).required(),
          value: text(L.argumentValue).allow('').required(),
        }),
      )
      .max(L.arguments)
      .required(),
    readback: text(L.readback).allow('').required(),
    spokenReadback: text(L.readback).allow(''),
  }).required(),
});

export const decidePayloadSchema = Joi.object({
  approvalId: id.required(),
  decision: Joi.string().valid('approve', 'decline').required(),
});

export const claimPayloadSchema = Joi.object({
  approvalId: id.required(),
  grantId: id.required(),
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
