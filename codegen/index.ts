import * as ejs from 'ejs';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import {
  TagObject,
  ParameterObject,
  SchemaObject,
  OpenAPIObject,
  OperationObject,
  ReferenceObject,
  isReferenceObject,
} from 'openapi3-ts';

const statusCodeNames: Record<number, string> = {
  [200]: 'Success',
  [201]: 'Created',
  [204]: 'Empty',
  [404]: 'NotFound',
  [403]: 'BadRequest',
  [401]: 'Unauthorized',
};

function removeDuplicates<T>(array: Array<T>): Array<T> {
  const newArray: T[] = [];

  array.forEach((item) => {
    if (newArray.indexOf(item) === -1) {
      newArray.push(item);
    }
  });

  return newArray;
}

/**
 * Capitalizes the given string.
 */
function capitalize(s: string) {
    if (s.length === 0)
        return '';

    return s[0].toUpperCase() + s.substring(1);
}

/**
 * Resolve the given JSON pointer in relation to the given document.
 *
 * @param doc - The document to use as the root.
 * @param pointer - JSON pointer.
 * 
 * @returns A value from doc to which pointer points.
 */
function resolve(doc: object, pointer: string): any {
  const parts = pointer.substring(2).split('/');

  let ret: any = doc;

  for (const part of parts) {
    if (Array.isArray(ret)) {
      ret = ret[parseInt(part)];
    } else if (typeof ret === 'object') {
      ret = ret[part];
    } else {
      return undefined;
    }
  }

  return ret;
}

/**
 * Recursively dereferences doc. Resolves all internal references in relation
 * to root.
 *
 * @param doc - A value to be dereferenced.
 * @param root - Object in relation to which all references are resolved.
 *               If not defined, defaults to doc itself.
 *
 * @returns The given value, but with all contained references replaced
 *          with the values they pointed to.
 */
function deref(doc: any, root?: object): any {
  let _root = doc;

  if (root !== undefined) {
    _root = root;
  }

  if (Array.isArray(doc)) {
    return doc.map((item) => deref(item, root));
  } else if (typeof doc === 'object') {
    if (doc.$ref !== undefined) {
      return {
        '$ref': doc.$ref,
        ... deref(resolve(_root, doc.$ref), root),
      };
    }

    const ret: { [prop: string]: any } = {};

    for (const [prop, value] of Object.entries(doc)) {
      ret[prop] = deref(value, root);
    }

    return ret;
  } else {
    return doc;
  }
}

function hasOwnProperty<X extends {}, Y extends PropertyKey>
  (obj: X, prop: Y): obj is X & Record<Y, unknown> {
  return obj.hasOwnProperty(prop)
}

interface ObjectTypedefParameter {
  type: string;
  jsdoc?: string;
}

interface ObjectTypedef {
  type: 'object';
  properties: Record<string, ObjectTypedefParameter>;
}

interface ArrayTypedef {
  type: 'array';
  item: string;
}

interface EnumTypedef {
  type: 'enum';
  variants: string[];
}

interface UnionTypeDef {
  type: 'union';
  members: string[];
}

type Typedef = (ObjectTypedef | ArrayTypedef | EnumTypedef | UnionTypeDef) & { name: string, description?: string };

interface ApiDef {
  name: string;
  operations: Operation[];
}

interface Operation {
  name: string;
  method: string;
  path: string;
  parameters: OperationParameter[];
  returnType: string;
  jsdoc?: string;
  responseTranslation?: string;
  responses: { statusCode: string, contentType: string, translation: string }[],
}

interface OperationParameter {
  name: string;
  type: string;
  jsdoc?: string;
}

interface GeneratedFile {
  name: string;
  typedefs: Typedef[];
  api: ApiDef;
}

class Codegen {
  spec: OpenAPIObject;
  typedefs: Typedef[];
  apis: ApiDef[];

  files: GeneratedFile[];

  constructor (spec: OpenAPIObject) {
    this.spec = spec;
    this.typedefs = [];
    this.apis = [];
    this.files = [];
  }

  resolveSchemaPath(schema: SchemaObject | ReferenceObject, pointer: string): SchemaObject | undefined {
    const parts = pointer.split('.');

    for (const part of parts) {
      let dereferenced = this.dereference(schema);

      if (dereferenced.type === 'object') {
        if (dereferenced.properties) {
          schema = dereferenced.properties[part];
        } else {
          return undefined;
        }
      } else if (dereferenced.type === 'array') {
        if (dereferenced.items) {
          schema = dereferenced.items;
        } else {
          return undefined;
        }
      } else {
        throw new Error('invalid schema path: ' + pointer);
      }
    }

    return schema;
  }

  /**
   * Resolves the API into which a given operation belongs.
   */
  resolveApi(operation: OperationObject): ApiDef {
    const tags = operation.tags || [];
    let className: string | null = null;

    for (const tag of tags) {
      let tagDefs = this.spec.tags || [];

      const def = tagDefs.find((tagDef: TagObject) => tagDef.name === tag);

      if (def && def['x-codegen-class']) {
        className = def['x-codegen-class'];
        break;
      }
    }

    if (className === null) {
      className = 'DefaultApi';
    }

    let api = this.apis.find((api) => api.name === className);

    if (api === undefined) {
      api = {
        name: className,
        operations: [],
      };

      this.apis.push(api);
    }

    return api;
  }

  /**
   * If the given value contains a reference, returns the referenced value.
   * Otherwise returns the given value.
   */
  dereference<T>(value: T | ReferenceObject): T {
    if (hasOwnProperty(value, '$ref')) {
      return resolve(this.spec, value.$ref);
    } else {
      return value;
    }
  }

  /**
   * Generates a method, which corresponds to an API operation.
   *
   * @param path - Path of the API endpoint.
   * @param method - HTTP method.
   * @param operation - OpenApi operation object.
   */
  generateOperation(path: string, method: string, operation: OperationObject) {
    const api = this.resolveApi(operation);

    let name = operation.operationId || operation['x-codegen-method-name'] ||
      path.replace(/[{}]/g, '').split('/').map(capitalize).join('') + capitalize(method);

    let parameters = (operation.parameters || [])
      .map((param: ParameterObject | ReferenceObject) => this.dereference(param))
      .map((param: ParameterObject) => ({
        name: param.name,
        type: this.resolveSchemaType(param.schema),
        description: param.description,
      }));

    let responses = [];

    const returnTypes = [];

    for (const statusCode of Object.keys(operation.responses || {})) {
      for (const contentType of Object.keys(operation.responses[statusCode].content || {})) {
        const response = operation.responses[statusCode].content[contentType];
        const translation = response['x-codegen-translate-response'];
        let schema = response.schema;

        if (translation) {
          schema = this.resolveSchemaPath(schema, translation);
          responses.push({
            statusCode,
            contentType,
            translation,
          });
        }

        returnTypes.push(
          this.resolveSchemaType(schema, capitalize(name) + statusCodeNames[parseInt(statusCode)] + 'Response')
        );
      }
    }

    if (returnTypes.length === 0) {
      returnTypes.push('void');
    }

    api.operations.push({
      name,
      path,
      method,
      jsdoc: this.generateOperationJsdoc(operation),
      parameters,
      returnType: removeDuplicates(returnTypes).join(' | '),
      responses,
    });
  }

  /**
   * Generates a documentation comment for an API operation.
   *
   * The comment contains summary and description of the operation,
   * as well as descriptions of any possible parameters.
   *
   * @param operation - OpenApi operation object.
   */
  generateOperationJsdoc(operation: OperationObject) {
    let jsdoc = operation.summary;

    if (operation.description) {
      jsdoc += '\n\n' + operation.description;
    }

    if (operation.parameters) {
      let paramlines = [];

      for (let param of operation.parameters) {
        param = this.dereference(param);

        if (param.description) {
          paramlines.push(`@param ${param.name} - ${param.description}`);
        }
      }

      if (paramlines.length > 0) {
        jsdoc += '\n\n';
      }

      jsdoc += paramlines.join('\n');
    }

    return jsdoc;
  }

  /**
   * Resolves a TypeScript type for a given OpenApi schema. 
   *
   * Creates type definitions for any nested types if needed.
   *
   * @param schema - The OpenApi schema object.
   * @param newName - If defined, the created type definitions have
   *                  their names derived from this value.
   *
   * @returns a TypeScript type
   */
  resolveSchemaType (schema: SchemaObject | ReferenceObject | undefined, newName?: string): string {
    if (schema === undefined)
      return 'undefined';

    if (isReferenceObject(schema)) {
      const parts = schema.$ref.split('/');
      return parts[parts.length - 1];
    }

    if (schema.allOf) {
      return schema.allOf.map((s: SchemaObject | ReferenceObject) => this.resolveSchemaType(s)).join(' & ');
    }

    if (schema.type === 'array') {
      return `Array<${ this.resolveSchemaType(schema.items, newName ? newName + 'Item' : undefined) }>`;
    } else if (schema.type === 'object') {
      if (newName) {
        this.generateTypedef(newName, schema);
        return newName;
      } else {
        return 'object';
      }
    } else if (schema.type === undefined) {
      return 'any';
    } else if (schema.type === 'integer') {
      return 'number';
    } else {
      return schema.type;
    }
  }

  /**
   * Generates a type definition from an OpenApi schema object.
   *
   * @param name - Name for the typedef, with which other types can
   *               reference it.
   * @param def - The OpenApi schema object.
   */
  generateTypedef(name: string, def: SchemaObject) {
    if (def.type === 'object') {
      const properties: ObjectTypedef["properties"] = {};

      if (def.properties) {
        for (const name of Object.keys(def.properties)) {
          const prop = def.properties[name];
          const deref: SchemaObject = this.dereference(prop);

          properties[name] = {
            type: this.resolveSchemaType(prop),
            jsdoc: deref.description,
          }
        }
      }

      this.typedefs.push({
        type: 'object',
        name,
        description: def.description || '',
        properties,
      });
    } else if (def.type === 'array') {
      this.typedefs.push({
        type: 'array',
        name,
        item: this.resolveSchemaType(def.items),
      });
    } else if (def.type === 'string' && def.enum) {
      this.typedefs.push({
        type: 'enum',
        name,
        variants: def.enum.map((v: any) => `'${v}'`),
      });
    } else if (def.allOf) {
      this.typedefs.push({
        type: 'union',
        name,
        members: def.allOf.map((v: SchemaObject | ReferenceObject, i) => this.resolveSchemaType(v, `${name}UnionMember${i}`)),
      });
    }
  }

  /**
   * Generates a TypeScript client library based on the OpenApi document.
   *
   * @param outDir - Specifies the directory into which the generated
   *                 TypeScript files should be emitted.
   */
  generate (outDir: string) {
    if (this.spec.components && this.spec.components.schemas) {
      for (const name of Object.keys(this.spec.components.schemas)) {
        this.generateTypedef(name, this.spec.components.schemas[name]);
      } }

    if (this.spec.paths) {
      for (const path of Object.keys(this.spec.paths)) {
        for (const method of Object.keys(this.spec.paths[path])) {
          let operation = this.spec.paths[path][method];
          this.generateOperation(path, method, operation);
        }
      }
    }

    const template = fs.readFileSync('./codegen/template.ejs');
    return ejs.render(String(template), {
      typedefs: this.typedefs,
      apis: this.apis,
    });
  }
}

class FileCodegen {
  imports: Record<string, string>;
  scope: string;
  typedefs: Typedef[];
  root: Codegen;

  constructor (root: Codegen, scope: string) {
    this.root = root;
    this.scope = scope;
    this.imports = {};
    this.typedefs = [];
  }

  getItemType (item: string) {
    for (const symbol of Object.keys(this.imports)) {
      const symbolSource = this.imports[symbol];

      if (symbolSource === item) {
        return symbol;
      }
    }

    let nonce: number | null = null;

    while (true) {
      let components = item.split('.');
      let symbol = components[components.length-1] + (nonce ? nonce : '');

      if (symbol in this.imports) {
        nonce = nonce ? nonce + 1 : 1;
        continue;
      }

      this.imports[symbol] = item;
    }
  }

  generateTypedef(schema: SchemaObject, nameCandidates: string[]): string {
  }
}

function validateOpenApi(_spec: any): _spec is OpenAPIObject {
  return true;
}

async function main() {
  const spec = yaml.safeLoad(String(fs.readFileSync('/home/dogamak/Code/new-rv/rv-backend/openapi.yaml')));

  if (!validateOpenApi(spec)) {
    return;
  }

  if (typeof spec === "string")
    return;

  const codegen = new Codegen(spec);
  console.log(codegen.generate(''));
}

main();
