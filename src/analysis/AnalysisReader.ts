import ast from 'luaparse'
import { AnalysisContext } from './AnalysisContext'
import { ExpressionOrHasBody, LuaModuleScope, LuaScope } from '../scopes'

import {
    AnyCallExpression,
    AssignmentLHS,
    BaseReader,
    BasicLiteral,
} from '../base'

import {
    AnalysisItem,
    BasicLuaType,
    LuaExpression,
    TableField,
    TableKey,
} from './types'
import { readLuaStringLiteral } from '../helpers'

/**
 * Handles reading Lua files for analysis.
 */
export class AnalysisReader extends BaseReader {
    protected context: AnalysisContext
    protected expressionCache: Map<ast.Node, LuaExpression>

    constructor(context: AnalysisContext) {
        super()
        this.context = context
        this.expressionCache = new Map()
    }

    /**
     * Reads information about module definitions in a Lua file.
     */
    async readModuleInfo(identifier: string, filename: string) {
        const content = await this.readFileContents(filename)
        if (content === undefined) {
            return
        }

        const tree = this.parse(content, filename, true)
        if (!tree) {
            return
        }

        this.context.setReadingModule(identifier)

        const scope = this.createScope(tree) as LuaModuleScope
        this.context.setModule(identifier, scope, this.readScope(scope))

        this.context.setReadingModule()
        this.expressionCache.clear()
    }

    /**
     * Creates analysis items for variable assignment.
     */
    protected analyzeAssignment(
        node: ast.LocalStatement | ast.AssignmentStatement,
        scope: LuaScope,
    ) {
        if (node.init.length === 0) {
            if (node.type !== 'LocalStatement') {
                return
            }

            // local x → no assignment, but add variables as locals
            for (const variable of node.variables) {
                scope.addLocal(variable.name)
            }

            return
        }

        for (let i = 0; i < node.init.length; i++) {
            const lhs = node.variables[i]
            if (!lhs) {
                // x = 1, 2 → ignore 2
                break
            }

            const rhs = node.init[i]
            switch (rhs.type) {
                case 'CallExpression':
                case 'TableCallExpression':
                case 'StringCallExpression':
                    this.analyzeCallAssignment(scope, node, lhs, rhs, i + 1)
                    break

                default:
                    const rhsExpression = this.getLuaExpression(rhs, scope)
                    const lhsExpression = this.getLuaExpression(
                        lhs,
                        scope,
                        node.type === 'LocalStatement',
                    )

                    this.context.addAssignment(scope, {
                        type: 'assignment',
                        lhs: lhsExpression,
                        rhs: rhsExpression,
                    })

                    break
            }
        }

        if (node.variables.length <= node.init.length) {
            return
        }

        // analyze trailing variables for call expressions
        // x, y = z() → y is second return of z
        const last = node.init[node.init.length - 1]
        if (!last || !this.isCallExpression(last)) {
            if (node.type !== 'LocalStatement') {
                return
            }

            // not a call expression → add trailing locals to scope
            for (let i = node.init.length; i < node.variables.length; i++) {
                scope.addLocal(node.variables[i].name)
            }

            return
        }

        for (let i = node.init.length; i < node.variables.length; i++) {
            this.analyzeCallAssignment(
                scope,
                node,
                node.variables[i],
                last,
                i - node.init.length + 2,
            )
        }
    }

    /**
     * Analyzes `setmetatable` calls.
     */
    protected analyzeCall(node: ast.CallStatement, scope: LuaScope) {
        const expr = node.expression
        if (expr.type !== 'CallExpression') {
            return
        }

        const ident = expr.base
        if (ident.type !== 'Identifier' || ident.name !== 'setmetatable') {
            return
        }

        const args = expr.arguments
        if (args.length !== 2) {
            return
        }

        const lhs = this.getLuaExpression(args[0], scope)
        const meta = this.getLuaExpression(args[1], scope)

        this.context.setMetatable(scope, lhs, meta)
    }

    /**
     * Analyzes assignment to the result of a function call.
     */
    protected analyzeCallAssignment(
        scope: LuaScope,
        node: ast.Node,
        lhs: AssignmentLHS,
        rhs: AnyCallExpression,
        index: number,
    ) {
        const mod = this.readRequire(rhs)
        if (mod) {
            this.context.addAssignment(scope, {
                type: 'requireAssignment',
                lhs: this.getLuaExpression(
                    lhs,
                    scope,
                    node.type === 'LocalStatement',
                ),
                rhs: {
                    type: 'require',
                    module: mod,
                },
                index,
            })

            return
        }

        const rhsExpression = this.getLuaExpression(rhs, scope)
        const lhsExpression = this.getLuaExpression(
            lhs,
            scope,
            node.type === 'LocalStatement',
        )

        this.context.addAssignment(scope, {
            type: 'assignment',
            lhs: lhsExpression,
            rhs: rhsExpression,
            index,
        })

        if (node.type === 'LocalStatement') {
            this.handleNewAssignment(scope, lhsExpression, rhsExpression)
        }
    }

    /**
     * Analyzes a table constructor.
     */
    protected analyzeTableFields(
        cons: ast.TableConstructorExpression,
        scope: LuaScope,
    ) {
        const fields: TableField[] = []

        let nextIdx = 1
        for (const field of cons.fields) {
            let key: TableKey
            switch (field.type) {
                case 'TableValue':
                    key = {
                        type: 'auto',
                        index: nextIdx++,
                    }

                    break

                case 'TableKeyString':
                    key = {
                        type: 'string',
                        name: field.key.name,
                    }

                    break

                case 'TableKey':
                    const literalType = this.getBasicLiteralType(field.key)
                    if (literalType) {
                        const literal = field.key as BasicLiteral
                        key = {
                            type: 'literal',
                            literal: literal.raw,
                            luaType: literalType,
                        }

                        if (literalType === 'string') {
                            key.name = readLuaStringLiteral(literal.raw)
                        }

                        break
                    }

                    key = {
                        type: 'expression',
                        expression: this.getLuaExpression(field.key, scope),
                    }

                    break
            }

            const value = this.getLuaExpression(field.value, scope)
            fields.push({ key, value })
        }

        return fields
    }

    /**
     * Analyzes how items are used within the node.
     */
    protected analyzeUsage(node: ast.Node, scope: LuaScope) {
        const stack = [node]
        while (stack.length > 0) {
            const node = stack.pop()!
            switch (node.type) {
                case 'StringCallExpression':
                case 'TableCallExpression':
                case 'CallExpression':
                    // x() → x is `table | function`

                    const args: LuaExpression[] = []
                    const called = this.getLuaExpression(node.base, scope)

                    if (
                        node.base.type === 'MemberExpression' &&
                        node.base.indexer === ':'
                    ) {
                        args.push(this.getLuaExpression(node.base.base, scope))
                    }

                    stack.push(node.base)
                    if (node.type === 'CallExpression') {
                        stack.push(...node.arguments)
                        args.push(
                            ...node.arguments.map((x) =>
                                this.getLuaExpression(x, scope),
                            ),
                        )
                    } else if (node.type === 'TableCallExpression') {
                        args.push(this.getLuaExpression(node.arguments, scope))
                        stack.push(node.arguments)
                    } else {
                        args.push(this.getLuaExpression(node.argument, scope))
                    }

                    scope.addItem({
                        type: 'usage',
                        expression: called,
                        arguments: args,
                    })

                    break

                case 'AssignmentStatement':
                    // x.y = 1 → y is `table`
                    for (const lhs of node.variables) {
                        for (const indexed of this.getAssignmentBases(lhs)) {
                            scope.addItem({
                                type: 'usage',
                                expression: this.getLuaExpression(
                                    indexed,
                                    scope,
                                ),
                                supportsIndexAssignment: true,
                            })
                        }
                    }

                    stack.push(...node.variables)
                    stack.push(...node.init)
                    break

                case 'MemberExpression':
                case 'IndexExpression':
                    // x.y → x is `table | string`
                    scope.addItem({
                        type: 'usage',
                        expression: this.getLuaExpression(node.base, scope),
                        supportsIndexing: true,
                    })

                    stack.push(node.base)

                    if (node.type === 'IndexExpression') {
                        stack.push(node.index)
                    }

                    break

                case 'UnaryExpression':
                    if (node.operator === '#') {
                        scope.addItem({
                            type: 'usage',
                            expression: this.getLuaExpression(
                                node.argument,
                                scope,
                            ),
                            supportsLength: true,
                        })
                    }

                    stack.push(node.argument)
                    break

                case 'BinaryExpression':
                case 'LogicalExpression':
                    const supportsConcatenation = node.operator === '..'
                    const supportsMath = this.isMathOperator(node.operator)
                    if (supportsConcatenation || supportsMath) {
                        const left = this.getLuaExpression(node.left, scope)
                        const right = this.getLuaExpression(node.right, scope)

                        if (left.type !== 'literal') {
                            const leftItem: AnalysisItem = {
                                type: 'usage',
                                expression: left,
                            }

                            if (supportsMath) {
                                leftItem.supportsMath = true
                            }

                            if (supportsConcatenation) {
                                leftItem.supportsConcatenation = true
                            }

                            scope.addItem(leftItem)
                        }

                        if (right.type !== 'literal') {
                            const rightItem: AnalysisItem = {
                                type: 'usage',
                                expression: right,
                            }

                            if (supportsMath) {
                                rightItem.supportsMath = true
                            }

                            if (supportsConcatenation) {
                                rightItem.supportsConcatenation = true
                            }

                            scope.addItem(rightItem)
                        }
                    }

                    stack.push(node.left)
                    stack.push(node.right)
                    break

                case 'CallStatement':
                    stack.push(node.expression)
                    break

                case 'LocalStatement':
                    stack.push(...node.init)
                    break

                case 'ReturnStatement':
                    stack.push(...node.arguments)
                    break

                case 'IfStatement':
                    stack.push(...node.clauses)
                    break

                case 'WhileStatement':
                case 'RepeatStatement':
                case 'IfClause':
                case 'ElseifClause':
                    stack.push(node.condition)
                    break

                case 'TableKey':
                    stack.push(node.key)
                case 'TableKeyString':
                case 'TableValue':
                    stack.push(node.value)
                    break
            }
        }
    }

    /**
     * Creates an object representing a Lua expression.
     */
    protected createLuaExpression(
        node: ast.Expression,
        scope: LuaScope,
        isNewLocal?: boolean,
    ): LuaExpression {
        switch (node.type) {
            case 'Identifier':
                if (isNewLocal) {
                    scope.addLocal(node.name)
                }

                return {
                    type: 'reference',
                    id: scope.getLocalId(node.name) ?? node.name,
                }

            case 'VarargLiteral':
                return {
                    type: 'reference',
                    id: '...',
                }

            case 'FunctionDeclaration':
                const ident = node.identifier
                const name =
                    ident?.type === 'Identifier' ? ident.name : undefined
                const functionId = this.context.getFunctionID(node, name)
                return {
                    type: 'literal',
                    luaType: 'function',
                    functionId,
                }

            case 'TableConstructorExpression':
                const tableId = this.context.getTableID(node)
                const fields = this.analyzeTableFields(node, scope)
                this.context.setTableLiteralFields(scope, tableId, fields)

                return {
                    type: 'literal',
                    luaType: 'table',
                    tableId,
                    fields,
                }

            case 'NilLiteral':
            case 'StringLiteral':
            case 'NumericLiteral':
            case 'BooleanLiteral':
                return {
                    type: 'literal',
                    luaType: this.getBasicLiteralType(node),
                    literal: node.raw,
                }

            case 'MemberExpression':
                return {
                    type: 'member',
                    base: this.getLuaExpression(node.base, scope),
                    member: node.identifier.name,
                    indexer: node.indexer,
                }

            case 'IndexExpression':
                return {
                    type: 'index',
                    base: this.getLuaExpression(node.base, scope),
                    index: this.getLuaExpression(node.index, scope),
                }

            case 'UnaryExpression':
                return {
                    type: 'operation',
                    operator: node.operator,
                    arguments: [this.getLuaExpression(node.argument, scope)],
                }

            case 'BinaryExpression':
            case 'LogicalExpression':
                return {
                    type: 'operation',
                    operator: node.operator,
                    arguments: [
                        this.getLuaExpression(node.left, scope),
                        this.getLuaExpression(node.right, scope),
                    ],
                }

            case 'StringCallExpression':
                return {
                    type: 'operation',
                    operator: 'call',
                    arguments: [
                        this.getLuaExpression(node.base, scope),
                        this.getLuaExpression(node.argument, scope),
                    ],
                }

            case 'TableCallExpression':
            case 'CallExpression':
                const args =
                    node.type === 'CallExpression'
                        ? node.arguments
                        : [node.arguments]

                return {
                    type: 'operation',
                    operator: 'call',
                    arguments: [
                        this.getLuaExpression(node.base, scope),
                        ...args.map((x) => this.getLuaExpression(x, scope)),
                    ],
                }
        }
    }

    /**
     * Gets the identifier bases used in an indexer or member assignment.
     */
    protected getAssignmentBases(lhs: AssignmentLHS): ast.Expression[] {
        if (lhs.type === 'Identifier') {
            return []
        }

        const bases: ast.Expression[] = []
        const stack: ast.Expression[] = [lhs]

        while (stack.length > 0) {
            const expr = stack.pop()!

            switch (expr.type) {
                case 'MemberExpression':
                case 'IndexExpression':
                    bases.push(expr.base)
                    stack.push(expr.base)
                    stack.push(
                        expr.type === 'IndexExpression'
                            ? expr.index
                            : expr.identifier,
                    )

                    break
            }
        }

        return bases
    }

    /**
     * Returns the Lua type for a string, a number,
     * a boolean, or nil.
     */
    protected getBasicLiteralType(expr: BasicLiteral): BasicLuaType
    protected getBasicLiteralType(
        expr: ast.Expression,
    ): BasicLuaType | undefined
    protected getBasicLiteralType(
        expr: ast.Expression,
    ): BasicLuaType | undefined {
        switch (expr.type) {
            case 'StringLiteral':
                return 'string'
            case 'NumericLiteral':
                return 'number'
            case 'BooleanLiteral':
                return 'boolean'
            case 'NilLiteral':
                return 'nil'
        }
    }

    /**
     * Creates an object representing a Lua expression.
     */
    protected getLuaExpression(
        node: ast.Expression,
        scope: LuaScope,
        isNewLocal?: boolean,
    ): LuaExpression {
        const existing = this.expressionCache.get(node)
        if (existing) {
            return existing
        }

        const created = this.createLuaExpression(node, scope, isNewLocal)
        this.expressionCache.set(node, created)
        return created
    }

    /**
     * Handles assignment to `X.new(self, ...)`.
     */
    protected handleNewAssignment(
        scope: LuaScope,
        lhs: LuaExpression,
        rhs: LuaExpression,
    ) {
        if (lhs.type !== 'reference') {
            return
        }

        if (rhs.type !== 'operation') {
            return
        }

        // A = X.Y(B, ...)
        if (rhs.operator !== 'call' || rhs.arguments.length < 2) {
            return
        }

        // A = X.Y(B, ...)
        const callBase = rhs.arguments[0]
        if (callBase?.type !== 'member' || callBase.indexer !== '.') {
            return
        }

        // A = X.new(B, ...)
        if (callBase.member !== 'new') {
            return
        }

        // B is local identifier
        const firstArg = rhs.arguments[1]
        if (firstArg?.type !== 'reference' || !firstArg.id.startsWith('@')) {
            return
        }

        // treat A = X.new(B) as setmetatable(A, B)
        // local o = ISPanel.new(self) → setmetatable(o, self)
        this.context.setMetatable(scope, lhs, firstArg)
    }

    /**
     * Creates a new Lua scope object.
     */
    protected processNewScope(scope: LuaScope) {
        const parent = scope.parent as LuaScope
        if (!parent) {
            // no processing needed for modules
            return
        }

        if (scope.type === 'block') {
            // for blocks, just use the id from the previous block
            scope.id = parent.id

            // for i = ... → i is `number`
            const node = scope.node
            if (node.type === 'ForNumericStatement') {
                for (const expr of [node.start, node.step, node.end]) {
                    if (!expr) {
                        continue
                    }

                    scope.addItem({
                        type: 'usage',
                        expression: this.getLuaExpression(expr, scope),
                        inNumericFor: true,
                    })
                }
            }

            return
        }

        if (scope.type !== 'function') {
            return
        }

        const node = scope.node
        const ident = node.identifier
        const name = ident?.type === 'Identifier' ? ident.name : undefined

        const id = this.context.getFunctionID(node, name)
        scope.id = id

        const isLocal = node.isLocal || parent.hasLocal(name)
        const expression = ident
            ? this.getLuaExpression(ident, parent, node.isLocal)
            : undefined
        const literal = this.getLuaExpression(node, parent)

        const identExpr = ident
            ? this.getLuaExpression(ident, parent)
            : undefined

        const parameters = this.context.setFunctionInfo(
            id,
            scope,
            node,
            identExpr,
        )

        this.context.addAssignment(parent, {
            type: 'functionDefinition',
            expression,
            literal,
            id,
            isLocal,
            parameters,
        })

        // add local functions to parent scope
        if (name && node.isLocal) {
            parent.addLocalFunction(name, id)
        }

        // if no return statement is found as a direct child, add an empty return
        if (!node.body.find((x) => x.type === 'ReturnStatement')) {
            scope.addItem({
                type: 'returns',
                id,
                returns: [],
            })
        }
    }

    /**
     * Analyzes statements in the scope's body.
     */
    protected readScope(scope: LuaScope) {
        for (const node of scope.body) {
            this.analyzeUsage(node, scope)

            switch (node.type) {
                case 'LocalStatement':
                    this.readScopedBlocks(node.init, scope)
                    this.analyzeAssignment(node, scope)
                    break

                case 'AssignmentStatement':
                    this.readScopedBlocks(node.init, scope)
                    this.readScopedBlocks(node.variables, scope)
                    this.analyzeAssignment(node, scope)
                    break

                case 'ReturnStatement':
                    this.readScopedBlocks(node.arguments, scope)
                    scope.addItem({
                        type: 'returns',
                        id: scope.id,
                        returns: node.arguments.map((x) =>
                            this.getLuaExpression(x, scope),
                        ),
                    })

                    break

                case 'IfStatement':
                    this.readScopedBlocks(node.clauses, scope)
                    break

                case 'CallStatement':
                    this.readScopedBlocks([node.expression], scope)
                    this.analyzeCall(node, scope)
                    break

                case 'DoStatement':
                case 'WhileStatement':
                case 'RepeatStatement':
                case 'ForNumericStatement':
                case 'ForGenericStatement':
                case 'FunctionDeclaration':
                    this.readScopedBlocks([node], scope)
                    break
            }
        }

        const resolved = this.context.resolveItems(scope)
        if (scope.parent) {
            scope.parent.items.push(resolved)
        }

        return resolved
    }

    /**
     * Reads scoped blocks within the given expressions.
     */
    protected readScopedBlocks(
        expressions: ExpressionOrHasBody[],
        scope: LuaScope,
    ) {
        for (const childScope of this.getScopedBlocks(expressions, scope)) {
            this.readScope(childScope)
        }
    }
}
