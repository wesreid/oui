/** A schema file of the contract, as a value: JSON Schema (draft 2020-12) with its `$id` and `title`. */
export type ContractSchemaDocument = Readonly<Record<string, unknown>> & {
  readonly $schema: string;
  readonly $id: string;
  readonly title: string;
};
