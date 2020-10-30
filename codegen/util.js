/**
 * Creates a new array from the input array
 * and removes any duplicate items.
 *
 * @returns An array where each item is unique.
 */
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

function escape(string, toEscape) {
  let result = '' + string;

  for (let i = 0; i < result.length; i++) {
    if (toEscape.indexOf(result[i]) !== -1 || result[i] === '\\') {
      result = result.substring(0, i) + '\\' + result.substring(i);
      i += 1;
    }
  }

  return result;
}

module.exports = {
  removeDuplicates,
  capitalize,
  escape,
};
