import type ast from 'luaparse'
import { BaseLuaScope } from './BaseLuaScope'
import { BaseLuaScopeArgs } from './types'

interface FunctionScopeArgs extends BaseLuaScopeArgs {
    node: ast.FunctionDeclaration
}

export class LuaFunctionScope extends BaseLuaScope {
    type: 'function'
    node: ast.FunctionDeclaration

    constructor(args: FunctionScopeArgs) {
        super(args)
        this.type = 'function'
        this.node = args.node
    }
}
