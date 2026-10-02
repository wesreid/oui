/**
 * The args hash (ADR-0228 §2.3): SHA-256 over the RFC 8785 (JCS) canonical
 * JSON of a call's arguments, lowercase hex.
 *
 * Defined once, in `oui-spec`, where the browser's runtime checks a request
 * against the user's grant, and re-exported here for the worker and the
 * approval store. Every other implementation (the Rust gateway, an engine in
 * another language) is held to `oui-spec/approval-vectors.json`.
 */
export { argsHash, canonicalJson, ARGS_HASH_PATTERN } from 'oui-spec/spec';
