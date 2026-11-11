/**
 * The JSON Schema keywords Agntree writes. `validateJson()` checks every one
 * of them, so a schema typed with this interface cannot ask for a rule that
 * goes unchecked.
 */
export interface JsonSchema {
  type: 'object' | 'array' | 'string';
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: false;
  items?: JsonSchema;
  maxItems?: number;
  enum?: string[];
}

/**
 * Every way `value` breaks `schema`, each named by its path
 * (`matches[0].quote is missing`). Empty when the value matches.
 */
export function validateJson(value: unknown, schema: JsonSchema, at = ''): string[] {
  const where = at || 'the value';
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        return [`${where} must be a string`];
      }
      return schema.enum && !schema.enum.includes(value)
        ? [`${where} must be one of ${schema.enum.map((option) => JSON.stringify(option)).join(', ')}`]
        : [];
    case 'array': {
      if (!Array.isArray(value)) {
        return [`${where} must be an array`];
      }
      const problems =
        schema.maxItems !== undefined && value.length > schema.maxItems
          ? [`${where} must have at most ${schema.maxItems} ${schema.maxItems === 1 ? 'item' : 'items'}`]
          : [];
      const items = schema.items;
      return items ? problems.concat(...value.map((item, i) => validateJson(item, items, `${at}[${i}]`))) : problems;
    }
    case 'object': {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return [`${where} must be an object`];
      }
      const path = (key: string) => (at ? `${at}.${key}` : key);
      const fields = value as Record<string, unknown>;
      const problems = (schema.required ?? [])
        .filter((key) => !Object.hasOwn(fields, key))
        .map((key) => `${path(key)} is missing`);
      for (const [key, field] of Object.entries(fields)) {
        // Own keys only: "constructor" in a reply is not a schema.
        const property = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
        if (property) {
          problems.push(...validateJson(field, property, path(key)));
        } else if (schema.additionalProperties === false) {
          problems.push(`${path(key)} is not allowed`);
        }
      }
      return problems;
    }
  }
}
