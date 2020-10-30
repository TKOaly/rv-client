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
 * Creates a Proxy object, which lazily dereferences any internal references in the document
 * and adds a `$path` property to all objects which contains the location of that object
 * in relation to the document's root.
 *
 * The added `$path` property is immutable and non-enumerable.
 *
 * @param {any} value - If the value is not object or array, it is returned as-is.
 * @param {string} path - Path of the value in relation to `_root`. Defaults to `#`.
 * @param {object} _root - Root of the document, which is used to resolve any references
 *    in `value`. Defaults to `value` itself.
 *
 * @returns Lazily dereferencing Proxy object for `value`.
 */
const createOpenApiObject = (value, path = '#', _root = null) => {
  let root = _root;

  if (root === null) {
    root = value;
  }

  // If value contains a reference, resolve the reference for a new value.
  if (value && value.$ref) {
    path = value.$ref;
    value = resolve(root, value.$ref);
  }

  // We cannot define new properties for plain-old-data types,
  // so we'll just return them as-is.
  if (typeof value !== 'object') {
    return value;
  }

  // Afaik, there is no way to clone both Arrays and Object using a single method,
  // in a way that preserves arrays correctly.
  if (Array.isArray(value)) {
    value = [ ...value ];
  } else {
    value = { ...value };
  }

  Object.defineProperty(value, '$path', {
    enumerable: false,
    writable: false,
    value: path,
  });

  return new Proxy(value, {
    get (target, prop, receiver) {
      let _path = null;

      // prop is not neccessairly a string or number in normal operation.
      // For example, Iterators use internally Symbol-objects as property keys.
      if (typeof prop === 'string' || typeof prop === 'number') {
        _path = path + '/' + prop;
      }

      return createOpenApiObject(target[prop], _path, root);
    }
  });
};

module.exports = {
  resolve,
  deref,
  createOpenApiObject,
};
