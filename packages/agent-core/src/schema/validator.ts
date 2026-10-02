import type { RawSchemaDocument, ValidationResult, ValidationError, ValidationWarning } from './types.js';

/**
 * Validate a set of raw schema documents for structural correctness,
 * referential integrity, and domain consistency.
 */
export function validateSchemas(documents: RawSchemaDocument[]): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];

  const domainIds = new Set<string>();
  const entityIds = new Set<string>();
  const intentIds = new Set<string>();
  const entityDomains = new Map<string, string>();

  for (const doc of documents) {
    if (doc.domain) {
      if (domainIds.has(doc.domain.id)) {
        errors.push({
          path: `domain.${doc.domain.id}`,
          message: `Duplicate domain ID: "${doc.domain.id}"`,
          schemaId: doc.domain.id,
          code: 'DUPLICATE_DOMAIN',
        });
      }
      domainIds.add(doc.domain.id);
    }

    if (doc.entity) {
      if (entityIds.has(doc.entity.id)) {
        errors.push({
          path: `entity.${doc.entity.id}`,
          message: `Duplicate entity ID: "${doc.entity.id}"`,
          schemaId: doc.entity.id,
          code: 'DUPLICATE_ENTITY',
        });
      }
      entityIds.add(doc.entity.id);
      entityDomains.set(doc.entity.id, doc.entity.domain);
      validateEntity(doc.entity, errors, warnings);
    }

    if (doc.intent) {
      if (intentIds.has(doc.intent.id)) {
        errors.push({
          path: `intent.${doc.intent.id}`,
          message: `Duplicate intent ID: "${doc.intent.id}"`,
          schemaId: doc.intent.id,
          code: 'DUPLICATE_INTENT',
        });
      }
      intentIds.add(doc.intent.id);
      validateIntent(doc.intent, errors, warnings);
    }
  }

  // Cross-reference validation
  for (const doc of documents) {
    if (doc.intent) {
      validateIntentReferences(doc.intent, entityIds, intentIds, errors);
    }
    if (doc.domain?.relationships) {
      for (const rel of doc.domain.relationships) {
        if (!entityIds.has(rel.from)) {
          errors.push({
            path: `domain.${doc.domain.id}.relationships`,
            message: `Relationship references unknown entity: "${rel.from}"`,
            schemaId: doc.domain.id,
            code: 'UNKNOWN_ENTITY_REF',
          });
        }
        if (!entityIds.has(rel.to)) {
          errors.push({
            path: `domain.${doc.domain.id}.relationships`,
            message: `Relationship references unknown entity: "${rel.to}"`,
            schemaId: doc.domain.id,
            code: 'UNKNOWN_ENTITY_REF',
          });
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function validateEntity(
  entity: NonNullable<RawSchemaDocument['entity']>,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  if (!entity.id) {
    errors.push({ path: 'entity', message: 'Entity missing required "id" field', code: 'MISSING_FIELD' });
  }
  if (!entity.domain) {
    errors.push({ path: `entity.${entity.id}`, message: 'Entity missing required "domain" field', schemaId: entity.id, code: 'MISSING_FIELD' });
  }
  if (!entity.properties || Object.keys(entity.properties).length === 0) {
    warnings.push({ path: `entity.${entity.id}`, message: 'Entity has no properties defined', schemaId: entity.id, code: 'EMPTY_PROPERTIES' });
  }
  if (!entity.display?.title) {
    errors.push({ path: `entity.${entity.id}.display`, message: 'Entity display missing required "title" field', schemaId: entity.id, code: 'MISSING_FIELD' });
  }
}

function validateIntent(
  intent: NonNullable<RawSchemaDocument['intent']>,
  errors: ValidationError[],
  warnings: ValidationWarning[],
): void {
  if (!intent.id) {
    errors.push({ path: 'intent', message: 'Intent missing required "id" field', code: 'MISSING_FIELD' });
  }
  if (!intent.domain) {
    errors.push({ path: `intent.${intent.id}`, message: 'Intent missing required "domain" field', schemaId: intent.id, code: 'MISSING_FIELD' });
  }
  if (!intent.description) {
    errors.push({ path: `intent.${intent.id}`, message: 'Intent missing required "description" field', schemaId: intent.id, code: 'MISSING_FIELD' });
  }
  if (!intent.outcome) {
    warnings.push({ path: `intent.${intent.id}`, message: 'Intent has no outcome defined', schemaId: intent.id, code: 'MISSING_OUTCOME' });
  }
}

function validateIntentReferences(
  intent: NonNullable<RawSchemaDocument['intent']>,
  entityIds: Set<string>,
  intentIds: Set<string>,
  errors: ValidationError[],
): void {
  for (const [paramName, param] of Object.entries(intent.parameters)) {
    if (param.type === 'entity' && param.entity && !entityIds.has(param.entity)) {
      errors.push({
        path: `intent.${intent.id}.parameters.${paramName}`,
        message: `Parameter references unknown entity: "${param.entity}"`,
        schemaId: intent.id,
        code: 'UNKNOWN_ENTITY_REF',
      });
    }
  }

  if (intent.preconditions) {
    for (const precondition of intent.preconditions) {
      if (precondition.remedy && !intentIds.has(precondition.remedy)) {
        errors.push({
          path: `intent.${intent.id}.preconditions`,
          message: `Precondition remedy references unknown intent: "${precondition.remedy}"`,
          schemaId: intent.id,
          code: 'UNKNOWN_INTENT_REF',
        });
      }
    }
  }

  if (intent.composableWith) {
    for (const composable of intent.composableWith) {
      if (!intentIds.has(composable)) {
        errors.push({
          path: `intent.${intent.id}.composableWith`,
          message: `ComposableWith references unknown intent: "${composable}"`,
          schemaId: intent.id,
          code: 'UNKNOWN_INTENT_REF',
        });
      }
    }
  }
}
