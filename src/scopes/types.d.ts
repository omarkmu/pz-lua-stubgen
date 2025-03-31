import type ast from 'luaparse'

import { LuaBlockScope } from './LuaBlockScope'
import { LuaModuleScope } from './LuaModuleScope'
import { LuaFunctionScope } from './LuaFunctionScope'

export type LuaScope = LuaModuleScope | LuaFunctionScope | LuaBlockScope

export interface BaseLuaScopeArgs {
    parent?: LuaScope

    /**
     * The AST node the scope is based on.
     */
    node: NodeWithBody
}

export type NodeWithBody =
    | ast.Chunk
    | ast.IfClause
    | ast.ElseifClause
    | ast.ElseClause
    | ast.WhileStatement
    | ast.RepeatStatement
    | ast.DoStatement
    | ast.ForGenericStatement
    | ast.ForNumericStatement
    | ast.FunctionDeclaration

export type ExpressionOrHasBody = ast.Expression | NodeWithBody

export type BasicBlockNode = Exclude<
    NodeWithBody,
    ast.FunctionDeclaration | ast.Chunk
>
