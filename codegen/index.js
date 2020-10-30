const ejs = require('ejs');
const fs = require('fs');
const yaml = require('js-yaml');
const path = require('path');
const util = require('util');
const stream = require('stream');
const Vinyl = require('vinyl');
const _ = require('lodash');

const { statusCodeNames } = require('./http'); 
const { createOpenApiObject } = require('./openapi');
const { capitalize, removeDuplicates, escape } = require('./util');
const { Scope } = require('./scope');

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);

class Codegen {
  constructor (spec) {
    this.spec = spec;
    this.apis = [];
  }

  /**
   * Returns the API object, into which the operation belongs.
   *
   * APIs correspond to tags defined in the OpenApi document,
   * which have the `x-codegen-class` property in their tag definition.
   */
  resolveApi(operation) {
    // Find the first tag, which has an associated `x-codegen-class` property.
    const className = (operation.tags || [])
      .map((tag) => (this.spec.tags || []).find(def => def.name === tag))
      .filter(def => def && def['x-codegen-class'])
      .map((def) => def['x-codegen-class'])
      .find(() => true);

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

  getOperations() {
    const paths = this.spec.paths || {};
    const operations = [];

    for (const [path, value] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(value)) {
        operations.push({
          path,
          method,
          operation,
        });
      }
    }

    return _.groupBy(operations, (i) => this.resolveApi(i.operation).name);
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
      this.spec
    );

    if (this.spec.components && this.spec.components.schemas) {
      for (const name of Object.keys(this.spec.components.schemas)) {
        definition_codegen.generateTypedef(name, this.spec.components.schemas[name]);
      }
    }

    yield await definition_codegen.emit();

    const byApi = this.getOperations();

    for (const apiName of Object.keys(byApi)) {
      const path = `apis/${apiName}.ts`;
      const api_scope = root_scope.scope(apiName, path);
      api_scope.import('client.Client', 'Client');
      api_scope.define(apiName, { public: true });

      const api_codegen = new FileCodegen(path, api_scope, apiName, this.spec);

      for (const { path, method, operation } of byApi[apiName]) {
        api_codegen.generateOperation(path, method, operation);
      }

      yield await api_codegen.emit();
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

    // Check whether there already exists a type definition generated from
    // this path in the OpenApi document.
    const symbol = this.scope.find((entry) =>
      entry.type === 'definition' &&
      entry.spec_path === schema.$path);

    // If a type definition has already been generated elsewhere,
    // import it to the local scope instead of generateing a duplicate.
    if (symbol) {
      return this.scope.import(symbol.local_name);
    }

    // The allOf-property maps nicely to TypeScript union types.
    // Recursively resolve types for the union members.
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

    if (schema.enum) {
      let variantFormat = null;

      if (schema.type === 'string') {
        variantFormat = (v) => `"${escape(v, '"')}"`;
      } else if (variant.type === 'integer' || variant.type === 'number') {
        variantFormat = (v) => '' + v;
      }

      if (variantFormat) {
        return schema.enum.map(variantFormat).join(' | ');
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
          const prop = def.properties[name];

          properties[name] = {
            type: this.resolveSchemaType(prop),
            jsdoc: prop.description,
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
      .map((param) => ({
        argument_name: getUniqueSymbolName(param.name),
        path_name: param.name,
        type: this.resolveSchemaType(param.schema),
        description: param.description,
      }));

    let bodyParameter = null;

    if (
      operation.requestBody &&
      operation.requestBody.content &&
      operation.requestBody.content['application/json'] &&
      operation.requestBody.content['application/json'].schema
    ) {
      const requestSchema = operation.requestBody.content['application/json'].schema;
      const requestType = this.resolveSchemaType(requestSchema, capitalize(name) + 'Request');

      bodyParameter = getUniqueSymbolName('payload');

      parameters.push({
        argument_name: bodyParameter,
        type: requestType,
        description: 'Request body',
      });
    }

    // Extract information about all different responses
    // (status code and content-type combinations) defined
    // for this operation.
    let responses = this.getOperationResponses(operation, name);

    const returnTypes = responses
      .map(i => i.returnType)
      .filter(_.identity);

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
      responseTranslations: responses.filter(r => r.translation),
      bodyParameter,
    });
  }

  getOperationResponses(operation, name) {
    const responses = [];

    for (const [statusCode, value] of Object.entries(operation.responses)) {
      if (!value.content)
        continue;

      for (const [contentType, responseDef] of Object.entries(value.content)) {
        const translation = responseDef['x-codegen-translate-response'];
        let schema = responseDef.schema;

        let response = {
            statusCode,
            contentType,
        };

        if (translation) {
          schema = this.spec.resolveSchemaPath(schema, translation);
          responses.push({
            statusCode,
            contentType,
            translation,
          });
        } else if (schema.type === 'object') {
          const props = Object.keys(schema.properties || {});

          if (
            schema.type === 'object' &&
            schema.properties &&
            props.length === 1
          ) {
            schema = schema.properties[props[0]];
            response.translation = props[0];
          }
        }

        response.returnType = this.resolveSchemaType(
          schema,
          capitalize(name) + statusCodeNames[parseInt(statusCode)] + 'Response',
        );

        responses.push(response);
      }
    }

    return responses;
  }

  /**
   * Creates a TypeScript expression that constructs the URL path for the operation
   * from operation arguments.
   *
   * @param {object} operation - Operation definition.
   * @param {string} path - Path template as defined in the operation definition.
   * @param {Array.<object>} parameters - List of parameters defined for the operation method.
   *
   * @returns A string containing a TypeScript expression.
   */
  generatePathExpression(operation, path, parameters) {
    const inner = path.replace(/{([^}]+)}/g, (_, p1) => {
      const param = parameters
        .find((param) => {
          return param.path_name === p1;
        });

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
   *
   * @returns String containing the documentation comment's contents,
   *    excluding the comment syntax.
   */
  generateOperationJsdoc(operation) {
    let jsdoc = operation.summary || '';

    if (operation.description) {
      jsdoc += '\n\n' + operation.description;
    }

    if (operation.parameters) {
      let paramlines = [];

      for (let param of operation.parameters) {
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
   * Generates the code for the APIs and type definitions by rendering
   * the EJS templates.
   *
   * @returns String containing TypeScript code.
   */
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
}

module.exports = function codegen(filename) {
  return stream.Readable.from(async function* () {
    const contents = await readFile(filename);
    const spec = yaml.safeLoad(contents);
    const codegen = new Codegen(createOpenApiObject(spec));
    yield* codegen.generate();
  }());
}
