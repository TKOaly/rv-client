const ejs = require('ejs');
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const util = require('util');
const stream = require('stream');
const Vinyl = require('vinyl');

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);

const statusCodeNames = {
  [200]: 'Success',
  [201]: 'Created',
  [204]: 'Empty',
  [404]: 'NotFound',
  [403]: 'BadRequest',
  [401]: 'Unauthorized',
};

function removeDuplicates(array) {
  const newArray = [];

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
function capitalize(s) {
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
function resolve(doc, pointer) {
  const parts = pointer.substring(2).split('/');

  let ret = doc;

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
function deref(doc, path = '#', root = undefined) {
  let _root = doc;

  if (root !== undefined) {
    _root = root;
  }

  let ret;

  if (Array.isArray(doc)) {
    ret = doc.map((item, index) => deref(item, `${path}/${index}`, root));
  } else if (typeof doc === 'object') {
    if (doc.$ref !== undefined) {
      path = doc.$ref;
      ret = {
        '$ref': doc.$ref,
        ... deref(resolve(_root, doc.$ref), doc.$ref, _root),
      };
    } else {
      const _ret = {};

      for (const [prop, value] of Object.entries(doc)) {
        _ret[prop] = deref(value, `${path}/${prop.replace(/\//g, '\\/')}`, _root);
      }

      ret = _ret;
    }
  } else {
    ret = doc;
  }

  if (ret !== undefined) {
    ret.$path = path;
  }

  return ret;
}

/**
 * Contains information about symbols defined in and imported to a scope.
 *
 * Scopes can have a parent scope, and can thus form trees.
 * However, in this case there are only two levels of scopes: 
 *  - File-specific scopes.
 *  - The global scope, which is parent to all of the file-scopes.
 *
 * @property {string} name - Name of the scope.
 *    Used to construct globally unique name for the symbols defined in the scope.
 * @property {string} path - File path, if the scope corresponds to a file.
 * @property {Scope} parent - Parent scope, from which symbols can be imported
 *    from, and to which symbol definitions propagate.
 * @property {Map.<string, SymbolTableEntry>} table - Map of symbols in the scope.
 */
class Scope {
  constructor (name, path, parent = null) {
    this.path = path;
    this.name = name;
    this.parent = parent;
    this.table = {};
  }

  /**
   * Searches the scope and parent scopes for a symbol matching a predicate.
   *
   * @param {function} predicate - Function which takes a SymbolTableEntry as it's sole arguments
   *    and returns true or false, depending on if the entry matches a criteria.
   *
   * @returns The first Entry matching the predicate or udnefined if no matching entries could be found.
   */
  find(predicate) {
    const local_match = Object.values(this.table).find(predicate);

    if (local_match) {
      return local_match;
    }

    if (this.parent) {
      return this.parent.find(predicate);
    }
    
    return undefined;
  }

  /**
   * Get a symbol by it's name.
   */
  getEntry(name) {
    if (name in this.table) {
      return this.table[name];
    } else if (this.parent) {
      return this.parent.getEntry(name);
    } else {
      return undefined;
    }
  }

  /**
   * Imports a symbol from a parent scope into the local scope.
   *
   * @param {string} name - Name of the external symbol.
   * @param {string} local_name - Optional local name for the imported symbol.
   *    If not defined, a non-conflicting name is derived from the external
   *    symbol's short name.
   *
   * @returns The name, by which the imported symbol is known in the local scope.
   */
  import(name, local_name = null) {
    // Find an existing import of the same symbol.
    const existing = Object.values(this.table)
      .find(({ type, source, local_name }) => (type === 'import' && source === name) || (type === 'definition' && local_name === name ));

    // Do not add redundant import, if we already
    // have what we want in the scope.
    if (existing) {
      return existing.local_name;
    }

    // Derive a non-conflicting local name from the external
    // symbol's original short name if a local name is not provided.
    if (local_name === null) {
      const short_name = name.split('.').pop();
      let nonce = 1;
      local_name = short_name;

      while (local_name in this.table) {
        nonce += 1;
        local_name = `${short_name}_${nonce}`;
      }
    } else if (local_name in this.table) {
      throw new Error(`symbol '${ local_name }' already defined in scope '${ this.name }'`);
    }

    this.table[local_name] = {
      type: 'import',
      local_name,
      public: false,
      source: name,
    };

    return local_name;
  }

  /** Create a new child scope. */
  scope(name, path) {
    return new Scope(name, path, this);
  }

  /** Get a globally unique name for a local symbol. */
  globalName(name) {
    if (this.parent) {
      return this.parent.globalName(this.name) + '.' + name;
    } else {
      return name;
    }
  }

  /** Add an entry to the local symbol table and propagate to parent scopes. */
  _define(entry) {
    this.table[entry.local_name] = entry;

    if (this.parent) {
      this.parent._define({
        ...entry,
        local_name: this.name + '.' + entry.local_name,
     });
    }
  }

  /** Returns true if a symbol with the given name exists in the local scope. */
  exists(name) {
    return this.table[name] !== undefined;
  }

  /** 
   * Define a symbol in the local scope.
   *
   * @param {string} name - Local short name of the symbol.
   * @param {object} symbol_info - Properties of the symbol.
   * @param {string} symbol_info.spec_path - Location in the OpenApi spec, in which the symbol was defined.
   * @param {boolean} symbol_info.public - Should the symbol be propagated to the parent scope.
   */
  define(name, symbol_info) {
    const entry = {
      ... symbol_info,
      type: 'definition',
      local_name: name,
      defined_in: this.path,
    };

    if (symbol_info.public) {
      entry.global_name = this.globalName(name);
    }

    this._define(entry);
  }
}

class Codegen {
  constructor (spec) {
    this.spec = spec;
    this.apis = [];

    this.stream = new stream.Readable({
      objectMode: true,
    });

    this.stream._read = () => {};
  }

  /**
   * Resolves the API into which a given operation belongs.
   */
  resolveApi(operation) {
    const tags = operation.tags || [];
    let className = null;

    for (const tag of tags) {
      let tagDefs = this.spec.tags || [];

      const def = tagDefs.find((tagDef) => tagDef.name === tag);

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

  async emit(codegen) {
    const contents = await codegen.render();

    this.stream.push(new Vinyl({
      path: codegen.filename,
      contents: Buffer.from(contents),
    }));
  }

  emitFile (path, typedefs, api = undefined) {
    const template = fs.readFileSync('./templates/api.ejs');

    const rendered = ejs.render(String(template), {
      imports: [],
      typedefs,
      apis: [api],
    });

    fs.writeFileSync(path, rendered);
  }

  /**
   * Generates a TypeScript client library based on the OpenApi document.
   */
  async* generate () {
    const root_scope = new Scope('root', null);

    const client_scope = root_scope.scope('client', 'client.ts');
    client_scope.define('Client', { public: true });

    const definition_scope = root_scope.scope('definitions', 'definitions.ts');

    const definition_codegen = new FileCodegen(
      'definitions.ts',
      definition_scope,
      null,
      new OpenApiDocument(this.spec)
    );

    if (this.spec.components && this.spec.components.schemas) {
      for (const name of Object.keys(this.spec.components.schemas)) {
        definition_codegen.generateTypedef(name, this.spec.components.schemas[name]);
      }
    }

    yield await definition_codegen.emit();

    const byApi = {};

    if (this.spec.paths) {
      for (const path of Object.keys(this.spec.paths)) {
        for (const method of Object.keys(this.spec.paths[path])) {
          if (path === '$path' || method === '$path') continue;

          const operation = this.spec.paths[path][method];
          const api = this.resolveApi(operation);

          if (api.name in byApi) {
            byApi[api.name].push({ path, method, operation });
          } else {
            byApi[api.name] = [{ path, method, operation }];
          }
        }
      }
    }

    for (const apiName of Object.keys(byApi)) {
      const path = `apis/${apiName}.ts`;
      const api_scope = root_scope.scope(apiName, path);
      api_scope.import('client.Client', 'Client');
      api_scope.define(apiName, { public: true });

      const api_codegen = new FileCodegen(path, api_scope, apiName, new OpenApiDocument(this.spec));

      for (const { path, method, operation } of byApi[apiName]) {
        api_codegen.generateOperation(path, method, operation);
      }

      yield await api_codegen.emit();
      // api_codegen.emitFile();
    }

    yield await this.generateIndex(root_scope, 'index.ts');
  }

  async generateIndex(scope, filename) {
    const exports = Object.values(scope.table)
      .filter((entry) => entry.public)
      .map((entry) => {
        let { local_name, defined_in } = entry;
        let short_name = local_name.split('.').pop();

        let source = path.relative(path.dirname(filename), defined_in).replace(/\.ts$/, '');

        if (source[0] !== '.') {
            source = './' + source;
        }

        return {
          source,
          short_name,
          local_name: short_name,
        };
      });

    const template = await readFile('./templates/index.ejs');
    const rendered = ejs.render(String(template), { exports }, { filename: './templates/index.ejs' });

    return new Vinyl({
      path: filename,
      contents: Buffer.from(rendered),
    });
  }
}

class OpenApiDocument {
  constructor (inner) {
    this.inner = inner;
  }

  resolve (pointer) {
    return resolve(this.inner, pointer);
  }

  /**
   * If the given value contains a reference, returns the referenced value.
   * Otherwise returns the given value.
   */
  dereference(value) {
    if (value.$ref !== undefined) {
      return resolve(this.inner, value.$ref);
    } else {
      return value;
    }
  }

  resolveSchemaPath(schema, pointer) {
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
}

class FileCodegen {
  constructor(filename, scope, name, spec) {
    this.filename = filename;
    this.spec = spec;
    this.scope = scope;
    this.typedefs = [];
    this.operations = [];
    this.name = name;
  }

  async emit () {
    const contents = await this.render();

    return new Vinyl({
      path: this.filename,
      contents: Buffer.from(contents),
    });
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
  resolveSchemaType (schema, newName = undefined) {
    if (schema === undefined)
      return 'undefined';

    const schemaMatch = /^.*#\/components\/schemas\/([^/]+)$/.test(schema.$path);

    // If the schema points to a schema object under `#/components/schemas`,
    // create a typedef for the schema or import an existing one.
    // if (schemaMatch) {
    const symbol = this.scope.find((entry) =>
      entry.type === 'definition' &&
      entry.spec_path === schema.$path);

    if (symbol) {
      return this.scope.import(symbol.local_name);
    }

    /*const short_name = schema.$path.split('/').pop();
      let remote_schema = this.spec.resolve(schema.$path);

      this.generateTypedef(short_name, remote_schema);

      return short_name;
    }*/

    if (schema.allOf) {
      return schema.allOf
        .map((item) => this.resolveSchemaType(item))
        .join(' & ');
    }

    if (schema.type === 'array') {
      const itemTypeName = newName ? newName + 'Item' : undefined;
      const itemType = this.resolveSchemaType(schema.items, itemTypeName);
      return `Array<${itemType}>`;
    }

    if (schema.type === 'object') {
      if (newName) {
        this.generateTypedef(newName, schema);
        return newName;
      } else {
        return 'object';
      }
    }

    if (schema.type === undefined) {
      return 'any';
    }

    if (schema.type === 'integer') {
      return 'number';
    }

    return schema.type;
  }

  /**
   * Generates a type definition from an OpenApi schema object.
   *
   * @param name - Name for the typedef, with which other types can
   *               reference it.
   * @param def - The OpenApi schema object.
   */
  generateTypedef(name, def) {
    this.scope.define(name, {
      spec_path: def.$path,
    });

    if (def.type === 'object') {
      const properties = {};

      if (def.properties) {
        for (const name of Object.keys(def.properties)) {
          if (name === '$path') continue;

          const prop = def.properties[name];
          const deref = this.spec.dereference(prop);

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
        variants: def.enum.map((v) => `'${v}'`),
      });
    } else if (def.allOf) {
      this.typedefs.push({
        type: 'union',
        name,
        members: def.allOf.map((v, i) => this.resolveSchemaType(v, `${name}UnionMember${i}`)),
      });
    }

    return name;
  }

  /**
   * Generates a method, which corresponds to an API operation.
   *
   * @param path - Path of the API endpoint.
   * @param method - HTTP method.
   * @param operation - OpenApi operation object.
   */
  generateOperation(path, method, operation) {
    let name = operation.operationId || operation['x-codegen-method-name'] ||
      path.replace(/[{}]/g, '').split('/').map(capitalize).join('') + capitalize(method);

    const scopeVariables = ['res'];

    const getUniqueSymbolName = (base) => {
      let name = base;
      let nonce = 1;

      while (scopeVariables.indexOf(name) !== -1) {
        nonce += 1;
        name = `${base}${nonce}`;
      }

      scopeVariables.push(name);
      return name;
    };

    let parameters = (operation.parameters || [])
      .map((param) => this.spec.dereference(param))
      .map((param) => ({
        argument_name: getUniqueSymbolName(param.name),
        path_name: param.name,
        type: this.resolveSchemaType(param.schema),
        description: param.description,
      }));

    if (
      operation.requestBody &&
      operation.requestBody.content &&
      operation.requestBody.content['application/json'] &&
      operation.requestBody.content['application/json'].schema
    ) {
      const requestSchema = operation.requestBody.content['application/json'].schema;
      const requestType = this.resolveSchemaType(requestSchema, capitalize(name) + 'Request');

      parameters.push({
        name: 'payload',
        type: requestType,
        description: 'Request body',
      });
    }

    let responses = [];

    const returnTypes = [];

    for (const statusCode of Object.keys(operation.responses || {})) {
      for (const contentType of Object.keys(operation.responses[statusCode].content || {})) {
        if (statusCode === '$path' || contentType === '$path') continue;

        const response = operation.responses[statusCode].content[contentType];
        const translation = response['x-codegen-translate-response'];
        let schema = response.schema;

        if (translation) {
          schema = this.spec.resolveSchemaPath(schema, translation);
          responses.push({
            statusCode,
            contentType,
            translation,
          });
        } else if (schema.type === 'object') {
          const props = Object.keys(schema.properties || {})
            .filter(p => p !== '$path');

          if (
            schema.type === 'object' &&
            schema.properties &&
            props.length === 1
          ) {
            schema = schema.properties[props[0]];
            responses.push({
              statusCode,
              contentType,
              translation: props[0],
            });
          }
        }

        returnTypes.push(
          this.resolveSchemaType(schema, capitalize(name) + statusCodeNames[parseInt(statusCode)] + 'Response')
        );
      }
    }

    if (returnTypes.length === 0) {
      returnTypes.push('void');
    }

    this.operations.push({
      name,
      path: this.generatePathExpression(operation, path, parameters),
      method,
      jsdoc: this.generateOperationJsdoc(operation),
      parameters,
      returnType: removeDuplicates(returnTypes).join(' | '),
      responses,
    });
  }

  generatePathExpression(operation, path, parameters) {
    const inner = path.replace(/{([^}]+)}/g, (_, p1) => {
      const param = parameters
        .find((param) => param.path_name === p1);

      if (param === undefined) {
        throw new Error(`parameter '${p1}' used in path but not defined (${operation.operationId})`);
      }

      return '${' + param.argument_name + '}';
    });

    return '`' + inner + '`';
  }

  /**
   * Generates a documentation comment for an API operation.
   *
   * The comment contains summary and description of the operation,
   * as well as descriptions of any possible parameters.
   *
   * @param operation - OpenApi operation object.
   */
  generateOperationJsdoc(operation) {
    let jsdoc = operation.summary || '';

    if (operation.description) {
      jsdoc += '\n\n' + operation.description;
    }

    if (operation.parameters) {
      let paramlines = [];

      for (let param of operation.parameters) {
        param = this.spec.dereference(param);

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

  async render() {
    const template = await readFile('./templates/api.ejs');

    const data = {
      imports: Object.values(this.scope.table)
        .filter((entry) => entry.type === 'import')
        .map((entry) => {
          const source_symbol = this.scope.getEntry(entry.source);

          let source_path = path.relative(
            path.dirname(this.filename),
            source_symbol.defined_in,
          );

          if (source_path[0] !== '.') {
            source_path = './' + source_path;
          }

          return {
            short_name: source_symbol.local_name.split('.').pop(),
            local_name: entry.local_name,
            source: source_path.replace(/\.ts/, ''),
          };
        }),
      typedefs: this.typedefs,
      apis: this.name ? [{
        name: this.name,
        operations: this.operations,
      }] : [],
    };

    const rendered = ejs.render(String(template), data, {
      filename: './templates/api.ejs',
    });

    return rendered;
  }

  async emitFile () {
    await writeFile(this.filename, await this.render());
  }
}

module.exports = function codegen(filename) {
  return stream.Readable.from(async function* () {
    const contents = await readFile(filename);
    const spec = yaml.safeLoad(contents);
    const codegen = new Codegen(deref(spec));
    yield* codegen.generate();
  }());
}
