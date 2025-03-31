import ast from 'luaparse'
import { LuaDependencyInfo } from './types'
import { ExpressionOrHasBody, LuaScope } from '../scopes'
import { BaseReader } from '../base'

/**
 * Handles reading dependency information from Lua files.
 */
export class DependencyReader extends BaseReader {
    /**
     * Determines dependency information for a Lua file.
     */
    async getDependencyInfo(
        filePath: string,
    ): Promise<LuaDependencyInfo | undefined> {
        const content = await this.readFileContents(filePath)
        if (!content) {
            return
        }

        const tree = this.parse(content, filePath)
        if (!tree) {
            return
        }

        return this.trackDependencies(tree)
    }

    /**
     * Collects local and global references on the top level of the given expressions.
     */
    protected collectReferences(
        expressions: ExpressionOrHasBody[],
        scope: LuaScope,
        info: LuaDependencyInfo,
    ) {
        const stack = [...expressions]
        while (stack.length > 0) {
            const expr = stack.pop()!

            switch (expr.type) {
                case 'Identifier':
                    // not in scope → global reference
                    if (!scope.hasLocal(expr.name)) {
                        info.reads.add(expr.name)
                    }

                    break

                case 'UnaryExpression':
                    stack.push(expr.argument)
                    break

                case 'BinaryExpression':
                case 'LogicalExpression':
                    stack.push(expr.left)
                    stack.push(expr.right)
                    break

                case 'MemberExpression':
                    // x.y → check x
                    stack.push(expr.base)
                    break

                case 'IndexExpression':
                    // x[y] → check x and y
                    stack.push(expr.base)
                    stack.push(expr.index)
                    break

                case 'StringCallExpression':
                    stack.push(expr.base)
                    const requiredString = this.readRequire(expr)
                    if (requiredString) {
                        info.requires.add(requiredString)
                    }

                    break

                case 'CallExpression':
                    stack.push(expr.base)
                    stack.push(...expr.arguments)
                    const required = this.readRequire(expr)
                    if (required) {
                        info.requires.add(required)
                    }

                    break

                case 'TableCallExpression':
                    stack.push(expr.base)
                    stack.push(expr.arguments)
                    break

                case 'TableConstructorExpression':
                    for (const field of expr.fields) {
                        if (field.type === 'TableKey') {
                            // { [x] = y } → check x and y
                            stack.push(field.key)
                            stack.push(field.value)
                        } else {
                            // { x, y = z } → check x, z
                            stack.push(field.value)
                        }
                    }

                    break

                case 'FunctionDeclaration':
                    const ident = expr.identifier
                    if (ident && ident.type === 'MemberExpression') {
                        // x.y → check x
                        stack.push(ident.base)
                    }

                    break

                case 'IfClause':
                case 'ElseifClause':
                case 'WhileStatement':
                case 'RepeatStatement':
                    stack.push(expr.condition)
                    break

                case 'ForGenericStatement':
                    // for x in y → check y
                    stack.push(...expr.iterators)
                    break

                case 'ForNumericStatement':
                    // for i = x, y, z → check x, y, z
                    stack.push(expr.start)
                    stack.push(expr.end)
                    if (expr.step) {
                        stack.push(expr.step)
                    }

                    break
            }
        }
    }

    /**
     * Tracks global reads, global writes, and require calls.
     */
    protected trackDependencies(tree: ast.Chunk): LuaDependencyInfo {
        const stack: LuaScope[] = []
        this.pushScope(tree, stack)

        const info: LuaDependencyInfo = {
            requires: new Set(),
            writes: new Set(),
            reads: new Set(),
        }

        while (stack.length > 0) {
            const scope = stack.pop()!

            for (const node of scope.body) {
                switch (node.type) {
                    case 'LocalStatement':
                        this.collectReferences(node.init, scope, info)
                        this.pushScopedBlocks(node.init, scope, stack)
                        node.variables.forEach((x) => scope.addLocal(x.name))

                        break

                    case 'AssignmentStatement':
                        this.collectReferences(node.init, scope, info)
                        this.pushScopedBlocks(node.init, scope, stack)

                        for (const variable of node.variables) {
                            if (variable.type === 'IndexExpression') {
                                // x[y] = z → check y
                                this.collectReferences(
                                    [variable.index],
                                    scope,
                                    info,
                                )
                            }

                            if (variable.type === 'Identifier') {
                                if (!scope.hasLocal(variable.name)) {
                                    info.writes.add(variable.name)
                                }
                            } else {
                                const ident = this.getBaseIdentifier(variable)
                                if (ident && !scope.hasLocal(ident.name)) {
                                    // x.y = z → read x
                                    info.reads.add(ident.name)
                                }
                            }
                        }

                        break

                    case 'FunctionDeclaration':
                        this.collectReferences([node], scope, info)
                        this.pushScopedBlocks([node], scope, stack)

                        const ident = node.identifier
                        if (ident && ident.type === 'Identifier') {
                            if (node.isLocal) {
                                scope.addLocal(ident.name)
                            } else if (!scope.hasLocal(ident.name)) {
                                info.writes.add(ident.name)
                            }
                        }

                        break

                    case 'CallStatement':
                        this.collectReferences([node.expression], scope, info)
                        this.pushScopedBlocks([node.expression], scope, stack)
                        break

                    case 'ReturnStatement':
                        this.collectReferences(node.arguments, scope, info)
                        this.pushScopedBlocks(node.arguments, scope, stack)
                        break

                    case 'IfStatement':
                        this.collectReferences(node.clauses, scope, info)
                        this.pushScopedBlocks(node.clauses, scope, stack)
                        break

                    case 'DoStatement':
                        this.pushScopedBlocks([node], scope, stack)
                        break

                    case 'WhileStatement':
                    case 'RepeatStatement':
                    case 'ForNumericStatement':
                    case 'ForGenericStatement':
                        this.collectReferences([node], scope, info)
                        this.pushScopedBlocks([node], scope, stack)
                        break
                }
            }
        }

        return info
    }
}
