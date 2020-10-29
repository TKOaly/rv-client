const { src, dest, series } = require('gulp');
const _codegen = require('./codegen');
const ts = require('gulp-typescript');
const typedoc = require('gulp-typedoc');
const del = require('del');

const codegen = () => {
  return _codegen('backend/openapi.yaml')
    .pipe(src('src/**/*.ts'))
    .pipe(dest('build/'))
};

const build = () => {
  return _codegen('backend/openapi.yaml')
    .pipe(src('src/**/*.ts'))
    .pipe(dest('build/'))
    .pipe(ts({
      esModuleInterop: true,
    }))
    .pipe(dest('dist/'));
};

const docs = () => {
  return _codegen('backend/openapi.yaml')
    .pipe(src('src/**/*.ts'))
    .pipe(dest('build/'))
    .pipe(typedoc({
      out: 'docs/',
    }));
};

const clean_codegen = () => del(['build/*']);

const clean_docs = () => del(['docs/*']);

const clean_build = () => del(['build/*']);

Object.assign(exports, {
  codegen: series(clean_codegen, codegen),
  build: series(clean_build, build),
  docs: series(clean_docs, docs),
  clean: series(clean_codegen, clean_docs, clean_build),
});

exports.default = exports.build;
