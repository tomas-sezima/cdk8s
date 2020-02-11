import { JSONSchema4 } from "json-schema";
import { CodeMaker } from 'codemaker';

export interface GroupVersionKind {
  readonly group: string;
  readonly kind: string;
  readonly version: string
}

export const X_GROUP_VERSION_KIND = 'x-kubernetes-group-version-kind';

export function importResource(code: CodeMaker, schema: JSONSchema4, definition: JSONSchema4) {
  const objectNames = definition[X_GROUP_VERSION_KIND] as GroupVersionKind[];
  if (!objectNames) {
    throw new Error(`object must include a ${X_GROUP_VERSION_KIND} key`);
  }

  const objectName = objectNames[0];
  if (!objectName) {
    throw new Error(`no object name`);
  }

  const groupPrefix = objectName.group ? `${objectName.group.toLocaleLowerCase().replace(/\./g, '-')}-` : '';
  const baseName = `${groupPrefix}${objectName.kind.toLocaleLowerCase()}-${objectName.version.toLocaleLowerCase()}`;

  if (!definition.properties?.metadata) {
    console.error(`warning: no "metadata", skipping ${baseName}`);
    return;
  }

  const sourceFile = `${baseName}.ts`;
  const optionsStructName = `${objectName.kind}Options`;

  const emitLater: { [name: string]: () => void } = { };
  const emitted = new Set<string>();

  emitFile();

  function emitFile() {
    code.openFile(sourceFile);
    code.line(`// generated by cdk8s`);
    code.line();

    code.line(`import { ApiObject } from '@awslabs/cdk8s';`);
    code.line(`import { Construct } from '@aws-cdk/core';`);
    code.line();
  
    emitOptionsStruct();

    code.line();

    emitConstruct();
    code.line();

    while (Object.keys(emitLater).length) {
      const name = Object.keys(emitLater)[0];
      const later = emitLater[name];
      later();
      code.line();
      delete emitLater[name];
      emitted.add(name);
    }
  
    code.closeFile(sourceFile);
  }

  function emitOptionsStruct() {
    const copy: JSONSchema4 = { ...definition };
    copy.properties = copy.properties || {};
    delete copy.properties!.apiVersion;
    delete copy.properties!.kind;
    delete copy.properties!.status;

    emitType(optionsStructName, copy);
  }
  
  function emitConstruct() {
    emitDescription(code, definition?.description);

    code.openBlock(`export class ${objectName.kind} extends ApiObject`);

    emitInitializer();
  
    code.closeBlock();
  }

  function emitInitializer() {
    code.openBlock(`public constructor(scope: Construct, ns: string, options: ${optionsStructName})`);
    emitInitializerSuper();

    code.closeBlock();
  }

  function emitInitializerSuper() {
    const groupPrefix = objectName.group ? `${objectName.group}/` : '';
    code.open(`super(scope, ns, {`);
    code.line(`...options,`);
    code.line(`kind: '${objectName.kind}',`);
    code.line(`apiVersion: '${groupPrefix}${objectName.version}',`);
    code.close(`});`);    
  }

  function resolveReference(def: JSONSchema4): JSONSchema4 {
    const ref = def.$ref;
    const localPrefix = '#/definitions/';
    if (!ref || !ref.startsWith(localPrefix)) {
      throw new Error(`expecting a local reference`);
    }

    if (!schema.definitions) {
      throw new Error(`schema does not have "definitions"`);
    }

    const lookup = ref.substr(localPrefix.length);
    const found = schema.definitions[lookup];
    if (!found) {
      throw new Error(`cannot resolve local reference ${ref}`);
    }

    return found;
  }  

  function emitType(typeName: string, schema: JSONSchema4) {
    emitDescription(code, schema.description);

    if (schema.oneOf) {
      emitUnion();
      return;
    }

    if (schema.properties) {
      emitStruct();
      return;
    }

    code.line(`export type ${typeName} = ${typeForProperty(schema)};`);

    function emitUnion() {
      code.openBlock(`export class ${typeName}`);

      for (const option of schema.oneOf || []) {
        switch (option.type) {
          case 'string':
          case 'number':
          case 'boolean':
          case 'integer':
            const type = option.type === 'integer' ? 'number' : option.type;
            const methodName = 'from' + type[0].toUpperCase() + type.substr(1);
            code.openBlock(`public static ${methodName}(value: ${type}): ${typeName}`);
            code.line(`return new ${typeName}(value);`);
            code.closeBlock();
            break;
            
          default:
            throw new Error(`unexpected union type ${option.type}`);
        }
      }

      code.line(`private constructor(public readonly $unionValue: any) { }`);
      code.closeBlock();
    }

    function emitStruct() {
      code.openBlock(`export interface ${typeName}`);
  
      for (const [ propName, propSpec ] of Object.entries(schema.properties || {})) {
        emitProperty(propName, propSpec);
      }
    
      code.closeBlock();
    }

  
    function emitProperty(name: string, spec: JSONSchema4) {
      emitDescription(code, spec.description);
      const propertyType = typeForProperty(spec);
      const required = (Array.isArray(schema.required) && schema.required.includes(name));
      const optional = required ? '' : '?';
  
      code.line(`readonly ${name}${optional}: ${propertyType};`);
      code.line();
    }
  }

  function typeForProperty(spec: JSONSchema4): string {
    if (spec.oneOf) {
      throw new Error(`oneOf`);
    }

    if (spec.anyOf) {
      throw new Error(`anyOf`);
    }

    if (spec.properties) {
      throw new Error(`unexpected spec ${JSON.stringify(spec)}`);
    }

    if (spec.$ref) {
      return typeForRef(spec);
    }

    if (spec.type === 'string' && spec.format === 'date-time') {
      return `Date`;
    }
  
    switch (spec.type) {
      case undefined: return 'string';
      case 'string': return 'string';
      case 'number': return 'number';
      case 'integer': return 'number';
      case 'boolean': return 'boolean';
      case 'array': return `${typeForArray(spec)}[]`;
      case 'object': return typeForObject(spec);
        
      default: 
        throw new Error(`unsupported type ${spec.type}`);
    }
  }

  function typeForObject(spec: JSONSchema4): string {
    if (spec.type !== 'object') {
      throw new Error(`unexpected`);
    }

    if (!spec.properties && spec.additionalProperties && typeof(spec.additionalProperties) === 'object') {
      return `{ [key: string]: ${typeForProperty(spec.additionalProperties)} }`;
    }

    return `"unknown ${spec}"`;
  }

  function typeForRef(spec: JSONSchema4): string {
    if (!spec.$ref) {
      throw new Error(`invalid $ref`);
    }

    const comps = spec.$ref.split('.');
    const typeName = comps[comps.length - 1];
    const schema = resolveReference(spec);

    if (!emitted.has(typeName)) {
      emitLater[typeName] = () => emitType(typeName, schema);
    }

    return typeName;
  }

  function typeForArray(spec: JSONSchema4): string {
    if (!spec.items || typeof(spec.items) !== 'object') {
      throw new Error(`unsupported array type ${spec.items}`);
    }

    return typeForProperty(spec.items);
  }
  
}


function emitDescription(code: CodeMaker, description?: string) {
  if (!description) {
    return;
  }

  const extractDefault = /Defaults?\W+(to|is)\W+(.+)/g.exec(description);
  const def = extractDefault && extractDefault[2];

  code.line('/**');
  code.line(` * ${description}`);
  if (def) {
    code.line(` * @default ${def}`)    
  }
  code.line(' */')
}

/**
 * Returns all schema definitions for API objects (objects that have the 'x-kubernetes-group-version-kind' annotation)
 */
export function findApiObjectDefinitions(schema: JSONSchema4) {
  const result = new Array<JSONSchema4>();
  for (const def of Object.values(schema.definitions || { })) {
    const kinds = def[X_GROUP_VERSION_KIND];
    if (!kinds) {
      continue;
    }

    result.push(def);
  }

  return result;
}