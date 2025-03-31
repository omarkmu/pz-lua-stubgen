# pz-lua-stubgen

A command-line tool for generating Lua typestubs that are compatible with [lua-language-server](https://github.com/LuaLS/lua-language-server).

The generated stubs can be found in the [pz-lua-stubs](https://github.com/omarkmu/pz-lua-stubs) repository.

## Usage

The primary command of the tool generates typestubs given a Lua source directory.
From the top-level directory:
```
npm i
npm run build
pz-lua-stubgen -i <DIRECTORY> -o <DIRECTORY>
```

On Linux, use `./pz-lua-stubgen` instead.

For information about other commands or the other available options, use `pz-lua-stubgen --help`.
