# Ruokavälitys Client Library

This repository contains code used to generate a Typescript library, which implements a client for the Ruokavälitys HTTP API.
Built version of the library can be downloaded from the [Packages](https://github.com/TKOaly/rv-client/packages)-section of this page.

The code generation uses an OpenAPI specification document, which can be found from the
[TKOaly/rv-backend](https://github.com/TKOaly/rv-backend) repository, as it's input and generates a Typescript library.
The generated code containins classes for the normal and admin APIs as well as type definitions for the requests, responses and common structures.

## Development

This project uses Gulp as it's build management system.

 - **Code Generation** The code generation step can be executed using `gulp codegen`.
   This step copies files from under `src/` to `build/` and generates new Typescript files using the code under `codegen/`.
 - **Transpilation** The transpilation from Typescript to Javascript can be done by running `gulp build`.
   Running this command also executes the code generation step.
   The transpiled Javscript files are placed under `dist/`. This command also generates the Typescript code, so excplicitly
   executing the code generation step is not needed.
 - **Documentation** TypeDoc documentation can be generated for the generated Typescript library by running `gulp docs`.
   This command places the documentation under `docs/`. This command also generates the Typescript code, so excplicitly
   executing the code generation step is not needed.

## Project Structure

 - `codegen/`: This directory contains the code generation logic and code for reading and processing the YAML OpenAPI document.
 - `templates/`: This directory contains [EJS-templates](https://ejs.co/) used in the code generation.
 - `src/`: This directory contains Typescript classes and types used by the generated Typescript code.
 - `build/`: This directory is created when needed and contains the output files from the code generation step.
 - `dist/`: This directory is created when needed and contains the compiled-to-Javascript versions of the Typescript files from `build/`.
 - `docs/`: This directory is created when needed and contains TypeDoc-documentation for the generated Typescript library.
