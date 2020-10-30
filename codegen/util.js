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

module.exports = {
  removeDuplicates,
  capitalize,
};
