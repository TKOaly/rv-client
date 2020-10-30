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
    // Check whether the wanted symbol is already in the local scope,
    // either because it was defined in the local scope or imported
    // previously.
    const existing = Object.values(this.table)
      .find(({ type, source, local_name }) =>
        (type === 'import' && source === name) ||
        (type === 'definition' && local_name === name ));

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

module.exports = {
  Scope,
};
