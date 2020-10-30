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


module.exports = {
  resolve,
  deref,
  OpenApiDocument,
};
