/**
 * API tools generated from any OpenAPI 3 document (ADR-0181 §2): the loader, the
 * executor's auth seam, and the input validator every generated tool is checked with.
 */
export { loadOpenApiTools } from './loader.js';
export type { OpenApiTool, OpenApiToolsOptions, OpenApiToolAudience } from './loader.js';
export type { ActAs, OperationRef } from './executor.js';
export { OpenApiToolError } from './document.js';
export type {
  OpenApiDocument,
  OpenApiOperation,
  OpenApiParameter,
  OpenApiPathItem,
  OpenApiRequestBody,
  SecurityRequirement,
  HttpMethod,
} from './document.js';
export { API_OPERATION_EFFECTS } from './x-agent.js';
export { createToolInputValidator } from '../tools/input-validation.js';
export type { ToolInputValidation, ToolInputValidator } from '../tools/input-validation.js';
export type { RegisteredTool, ToolExecutionContext, ToolExecutionResult } from '../tools/types.js';
