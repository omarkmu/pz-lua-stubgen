import ast from 'luaparse'
import type { AnyCallExpression } from './types'

import { readFileContents, readLuaStringLiteral } from '../helpers'
import {
    ExpressionOrHasBody,
    LuaBlockScope,
    LuaFunctionScope,
    LuaModuleScope,
    LuaScope,
    NodeWithBody,
} from '../scopes'
import { log } from '../logger'

/**
 * Handles reading information from Lua files.
 */
export abstract class BaseReader {
    /**
     * Gets potential aliases for a file identifier for requiring.
     */
    getFileAliases(identifier: string): string[] {
        const aliases: string[] = []

        let slash = identifier.indexOf('/')
        while (slash !== -1) {
            identifier = identifier.slice(slash + 1)
            slash = identifier.indexOf('/')
            aliases.push(identifier)
        }

        return aliases
    }

    /**
     * Creates a new Lua scope object.
     */
    protected createScope(node: NodeWithBody, parent?: LuaScope): LuaScope {
        let scope: LuaScope
        switch (node.type) {
            case 'Chunk':
                scope = new LuaModuleScope({ node })
                break

            case 'FunctionDeclaration':
                scope = new LuaFunctionScope({
                    parent,
                    node,
                })

                const ident = node.identifier
                if (
                    ident &&
                    ident.type === 'MemberExpression' &&
                    ident.indexer === ':'
                ) {
                    scope.addSelfParameter()
                }

                for (const param of node.parameters) {
                    scope.addParameter(
                        param.type === 'Identifier' ? param.name : '...',
                    )
                }

                break

            case 'ForGenericStatement':
                scope = new LuaBlockScope({
                    parent,
                    node,
                })

                for (const variable of node.variables) {
                    scope.addLocal(variable.name)
                }

                break

            case 'ForNumericStatement':
                scope = new LuaBlockScope({
                    parent,
                    node,
                })

                scope.addLocal(node.variable.name)
                break

            default:
                scope = new LuaBlockScope({
                    parent,
                    node,
                })

                break
        }

        this.processNewScope(scope)

        return scope
    }

    /**
     * Gets the base identifier of an expression.
     */
    protected getBaseIdentifier(
        expr: ast.Expression,
    ): ast.Identifier | undefined {
        switch (expr.type) {
            case 'Identifier':
                return expr

            case 'MemberExpression':
            case 'IndexExpression':
                const base = expr.base
                if (base.type === 'Identifier') {
                    return base
                }

                return this.getBaseIdentifier(base)
        }
    }

    /**
     * Collects scoped blocks within the given expressions.
     */
    protected getScopedBlocks(
        expressions: ExpressionOrHasBody[],
        scope: LuaScope,
    ) {
        const stack: LuaScope[] = []
        this.pushScopedBlocks(expressions, scope, stack)
        return stack
    }

    /**
     * Returns whether the expression is a call expression type.
     */
    protected isCallExpression(
        expr: ast.Expression,
    ): expr is AnyCallExpression {
        return (
            expr.type === 'CallExpression' ||
            expr.type === 'StringCallExpression' ||
            expr.type === 'TableCallExpression'
        )
    }

    /**
     * Checks whether an operator is a comparison operator.
     */
    protected isComparisonOperator(operator: string): boolean {
        switch (operator) {
            case '~=':
            case '==':
            case '<':
            case '<=':
            case '>':
            case '>=':
                return true
        }

        return false
    }

    /**
     * Checks whether an operator is a mathematical operator.
     */
    protected isMathOperator(operator: string): boolean {
        switch (operator) {
            case '+':
            case '-':
            case '*':
            case '%':
            case '^':
            case '/':
            case '//':
            case '&':
            case '|':
            case '~':
            case '<<':
            case '>>':
                return true
        }

        return false
    }

    /**
     * Parses a Lua string into an AST.
     */
    protected parse(
        lua: string,
        filePath: string,
        includeLocations?: boolean,
    ): ast.Chunk | undefined {
        try {
            return ast.parse(this.sanitizeLua(lua), {
                comments: false,
                locations: includeLocations,
                luaVersion: '5.2', // Kahlua is closer to 5.1, but this gets around the 'break' issue in luaparse
            })
        } catch (e) {
            log.error(`Failed to parse file '${filePath}': ${e}`)
        }
    }

    /**
     * Performs processing on a newly-created scope.
     */
    protected processNewScope(scope: LuaScope) {}

    /**
     * Creates a new Lua scope object and pushes it to a stack.
     */
    protected pushScope(
        node: NodeWithBody,
        stack: LuaScope[],
        parent?: LuaScope,
    ): LuaScope {
        const scope = this.createScope(node, parent)

        stack.push(scope)

        return scope
    }

    /**
     * Collects bodied expressions as new scopes.
     */
    protected pushScopedBlocks(
        expressions: ExpressionOrHasBody[],
        scope: LuaScope,
        stack: LuaScope[],
    ) {
        const exprStack = [...expressions]
        while (exprStack.length > 0) {
            const expr = exprStack.pop()!
            switch (expr.type) {
                case 'UnaryExpression':
                    exprStack.push(expr.argument)
                    break

                case 'BinaryExpression':
                case 'LogicalExpression':
                    exprStack.push(expr.left)
                    exprStack.push(expr.right)
                    break

                case 'MemberExpression':
                    exprStack.push(expr.base)
                    break

                case 'IndexExpression':
                    exprStack.push(expr.base)
                    exprStack.push(expr.index)
                    break

                case 'CallExpression':
                    exprStack.push(expr.base)
                    exprStack.push(...expr.arguments)
                    break

                case 'TableCallExpression':
                    exprStack.push(expr.base)
                    exprStack.push(expr.arguments)
                    break

                case 'StringCallExpression':
                    exprStack.push(expr.base)
                    break

                case 'TableConstructorExpression':
                    for (const field of expr.fields) {
                        if (field.type === 'TableKey') {
                            exprStack.push(field.key)
                            exprStack.push(field.value)
                        } else {
                            exprStack.push(field.value)
                        }
                    }

                    break

                case 'ForGenericStatement':
                case 'ForNumericStatement':
                case 'IfClause':
                case 'ElseifClause':
                case 'ElseClause':
                case 'WhileStatement':
                case 'RepeatStatement':
                case 'DoStatement':
                case 'FunctionDeclaration':
                    this.pushScope(expr, stack, scope)
                    break
            }
        }
    }

    /**
     * Reads the contents of a file.
     */
    protected async readFileContents(
        filePath: string,
    ): Promise<string | undefined> {
        try {
            return readFileContents(filePath)
        } catch (e) {
            log.error(`Failed to read file '${filePath}': ${e}`)
            return
        }
    }

    /**
     * Reads the name of the required module from a `require` call.
     */
    protected readRequire(expr: ast.Expression): string | undefined {
        if (
            expr.type !== 'CallExpression' &&
            expr.type !== 'StringCallExpression'
        ) {
            return
        }

        if (expr.base.type !== 'Identifier' || expr.base.name !== 'require') {
            return
        }

        let argument: ast.StringLiteral | undefined
        if (expr.type !== 'StringCallExpression') {
            if (expr.arguments.length !== 1) {
                return
            }

            if (expr.arguments[0].type !== 'StringLiteral') {
                return
            }

            argument = expr.arguments[0]
        } else {
            if (expr.argument.type !== 'StringLiteral') {
                return
            }

            argument = expr.argument
        }

        if (argument) {
            return readLuaStringLiteral(argument.raw)
        }
    }

    /**
     * Sanitizes a Lua source string for AST parsing.
     * @param source
     */
    protected sanitizeLua(source: string): string {
        // handles Kahlua-specific number quirks
        // replacement based on PipeWrench-Modeler
        source = source.replace(/(\d)[lf]([,;)\s])/g, '$1$2')

        source = source.replace(/[^\\]\\%/g, ' %') // ISZoneDisplay edge case

        return source
    }
}
