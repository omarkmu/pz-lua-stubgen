import type ast from 'luaparse'
import { BaseLuaScope } from './BaseLuaScope'
import { BaseLuaScopeArgs } from './types'

interface ModuleScopeArgs extends Omit<BaseLuaScopeArgs, 'parent'> {
    node: ast.Chunk
}

export class LuaModuleScope extends BaseLuaScope {
    type: 'module'
    node: ast.Chunk

    protected static nextModuleIndex = 1

    constructor(args: ModuleScopeArgs) {
        super(args)
        this.type = 'module'
        this.id = `@module(${LuaModuleScope.nextModuleIndex++})`
        this.node = args.node
    }
}
