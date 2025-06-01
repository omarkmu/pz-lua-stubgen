import ast from 'luaparse'
import { LuaScope } from '../scopes'
import { getLuaFieldKey, readLuaStringLiteral } from '../helpers'
import {
    AssignmentItem,
    FunctionDefinitionItem,
    LuaExpression,
    LuaExpressionInfo,
    LuaType,
    RequireAssignmentItem,
    ResolvedClassInfo,
    ResolvedFunctionInfo,
    ResolvedScopeItem,
    ResolvedReturnInfo,
    TableField,
    UsageItem,
    FunctionInfo,
    TableInfo,
    LuaReference,
    ResolvedModule,
    ResolvedRequireInfo,
    LuaMember,
    AnalysisContextArgs,
    ReturnsItem,
    ResolvedFieldInfo,
} from './types'

import { TypeResolver } from './TypeResolver'
import { AnalysisFinalizer } from './AnalysisFinalizer'

const RGBA_NAMES = new Set(['r', 'g', 'b', 'a'])
const POS_SIZE_NAMES = new Set(['x', 'y', 'z', 'w', 'h', 'width', 'height'])
const DX_DY_NAMES = new Set(['dx', 'dy'])
const UNKNOWN_NAMES = /^(?:target|(?:param|arg)\d+)$/

/**
 * Shared context for analysis of multiple Lua files.
 */
export class AnalysisContext {
    /**
     * The identifier of the module being processed.
     */
    currentModule: string

    /**
     * Helper for finalizing analyzed types.
     */
    finalizer: AnalysisFinalizer

    /**
     * Whether the analysis is running in the context of Rosetta initialization or updating.
     */
    isRosettaInit: boolean

    /**
     * Maps file identifiers to resolved modules.
     */
    modules: Map<string, ResolvedModule>

    /**
     * Helper for resolving types.
     */
    typeResolver: TypeResolver

    /**
     * Mapping of files aliases to file identifiers.
     */
    protected aliasMap: Map<string, Set<string>>

    /**
     * Whether heuristics based on item names should be applied.
     */
    protected applyHeuristics: boolean

    /**
     * Definitions for items.
     */
    protected definitions: Map<string, LuaExpressionInfo[]>

    /**
     * Maps function declarations to function IDs.
     */
    protected functionToId: Map<ast.FunctionDeclaration, string>

    /**
     * Maps function IDs to info about the function they describe.
     */
    protected idToFunctionInfo: Map<string, FunctionInfo>

    /**
     * Maps table IDs to info about the table they describe.
     */
    protected idToTableInfo: Map<string, TableInfo>

    /**
     * The next available table ID number.
     */
    protected nextTableIndex: number = 1

    /**
     * The next available function ID number.
     */
    protected nextFunctionIndex: number = 1

    /**
     * Maps parameter IDs to function IDs.
     */
    protected parameterToFunctionId: Map<string, string>

    /**
     * Maps table constructor expressions to table IDs.
     */
    protected tableToId: Map<ast.TableConstructorExpression, string>

    /**
     * Expression types inferred by usage.
     */
    protected usageTypes: Map<LuaExpression, Set<string>>

    constructor(args: AnalysisContextArgs) {
        this.currentModule = ''
        this.aliasMap = new Map()
        this.tableToId = new Map()
        this.functionToId = new Map()
        this.idToTableInfo = new Map()
        this.idToFunctionInfo = new Map()
        this.parameterToFunctionId = new Map()
        this.definitions = new Map()
        this.usageTypes = new Map()
        this.modules = new Map()

        this.typeResolver = new TypeResolver(this)
        this.finalizer = new AnalysisFinalizer(this)

        this.isRosettaInit = args.isRosettaInit ?? false
        this.applyHeuristics = args.heuristics ?? false
    }

    /**
     * Adds an assignment to the list of definitions or fields.
     */
    addAssignment(
        scope: LuaScope,
        item: AssignmentItem | FunctionDefinitionItem | RequireAssignmentItem,
    ) {
        scope.addItem(item)
        const lhs =
            item.type === 'functionDefinition' ? item.expression : item.lhs

        // anonymous functions have no assignment
        if (!lhs) {
            return
        }

        let rhs: LuaExpression
        switch (item.type) {
            case 'assignment':
            case 'requireAssignment':
                rhs = item.rhs
                break

            case 'functionDefinition':
                rhs = item.literal
                break
        }

        const index = item.type === 'assignment' ? item.index : undefined
        switch (lhs.type) {
            case 'reference':
                const tableId = this.tryAddPartialItem(scope, item, lhs, rhs)

                if (tableId) {
                    rhs = {
                        type: 'literal',
                        luaType: 'table',
                        tableId,
                    }
                }

                this.addDefinition(scope, lhs.id, rhs, index)
                break

            case 'index':
                const indexBase = [
                    ...this.typeResolver.resolve({ expression: lhs.base }),
                ]

                if (indexBase.length !== 1) {
                    break
                }

                const resolved = this.typeResolver.resolveToLiteral(lhs.index)
                if (!resolved || !resolved.literal) {
                    break
                }

                const key = this.getLiteralKey(
                    resolved.literal,
                    resolved.luaType,
                )

                this.addField(scope, indexBase[0], key, rhs, lhs, index)
                break

            case 'member':
                let isInstance = false
                const memberBase = [
                    ...this.typeResolver.resolve({ expression: lhs.base }),
                ].filter((x) => {
                    if (!x.startsWith('@self') && !x.startsWith('@instance')) {
                        return true
                    }

                    isInstance = true
                    return false
                })

                if (memberBase.length !== 1) {
                    break
                }

                // ignore __index in instances
                if (isInstance && lhs.member === '__index') {
                    break
                }

                // add original assignment name to tables
                if (rhs.type === 'literal' && rhs.tableId) {
                    const info = this.getTableInfo(rhs.tableId)
                    info.originalName ??= this.getFieldClassName(scope, lhs)
                }

                const memberKey = this.getLiteralKey(lhs.member)
                this.addField(
                    scope,
                    memberBase[0],
                    memberKey,
                    rhs,
                    lhs,
                    index,
                    isInstance,
                )

                break

            // operation or literal should not occur directly in lhs
        }
    }

    /**
     * Finalizes analyzed modules.
     */
    finalizeModules() {
        return this.finalizer.finalize()
    }

    /**
     * Gets the list of definitions for an item ID.
     */
    getDefinitions(id: string): LuaExpressionInfo[] {
        return this.definitions.get(id) ?? []
    }

    /**
     * Gets the ID to use for a function.
     */
    getFunctionId(expr: ast.FunctionDeclaration, name?: string): string {
        let id = this.functionToId.get(expr)
        if (!id) {
            const count = this.nextFunctionIndex++
            id = `@function(${count})` + (name ? `[${name}]` : '')

            this.functionToId.set(expr, id)
        }

        return id
    }

    /**
     * Gets a function ID given an ID of one of its parameter.
     */
    getFunctionIdFromParamId(id: string): string | undefined {
        return this.parameterToFunctionId.get(id)
    }

    /**
     * Gets function info from a function ID, creating it if it doesn't exist.
     */
    getFunctionInfo(id: string): FunctionInfo {
        let info = this.idToFunctionInfo.get(id)
        if (info) {
            return info
        }

        info = {
            id,
            parameters: [],
            parameterNames: [],
            parameterTypes: [],
            returnTypes: [],
            returnExpressions: [],
        }

        this.idToFunctionInfo.set(id, info)
        return info
    }

    /**
     * Gets the literal key to use for a table field mapping.
     */
    getLiteralKey(key: string, type?: LuaType) {
        let internal: string | undefined
        if (!type) {
            internal = key
        } else if (type === 'string') {
            internal = readLuaStringLiteral(key)
        }

        if (!internal) {
            return key
        }

        return '"' + internal.replaceAll('"', '\\"') + '"'
    }

    /**
     * Gets a module given its name.
     */
    getModule(name: string, checkAliases = false): ResolvedModule | undefined {
        let mod = this.modules.get(name)
        if (!mod && checkAliases) {
            let alias = this.aliasMap.get(name)
            const firstAlias = alias ? [...alias][0] : undefined
            if (firstAlias) {
                mod = this.modules.get(firstAlias)
            }
        }

        return mod
    }

    /**
     * Gets the ID to use for a table.
     */
    getTableId(expr: ast.TableConstructorExpression, name?: string): string {
        let id = this.tableToId.get(expr)
        if (!id) {
            id = this.newTableId(name)
            this.tableToId.set(expr, id)
        }

        return id
    }

    /**
     * Gets table info from a table ID, creating it if it doesn't exist.
     */
    getTableInfo(id: string): TableInfo {
        let info = this.idToTableInfo.get(id)
        if (info) {
            return info
        }

        info = {
            id,
            literalFields: [],
            definitions: new Map(),
            definingModule: this.currentModule,
        }

        this.idToTableInfo.set(id, info)
        return info
    }

    /**
     * Gets the types determined based on usage for an expression.
     * Returns undefined if types couldn't be determined.
     */
    getUsageTypes(expr: LuaExpression): Set<string> | undefined {
        const types = this.usageTypes.get(expr)
        if (!types || types.size === 0 || types.size === 5) {
            return
        }

        return types
    }

    /**
     * Resolves the types of the analysis items for a module.
     */
    resolveItems(scope: LuaScope): ResolvedScopeItem {
        // collect usage information
        for (const item of scope.items) {
            if (item.type !== 'usage') {
                continue
            }

            this.addUsage(item)
        }

        // resolve classes, functions, and returns
        const classes: ResolvedClassInfo[] = []
        const functions: ResolvedFunctionInfo[] = []
        const requires: ResolvedRequireInfo[] = []
        const fields: ResolvedFieldInfo[] = []
        const seenClasses = new Set<string>()

        let hasReturn = false
        for (const item of scope.items) {
            hasReturn ||= item.type === 'returns'

            switch (item.type) {
                case 'partial':
                    if (item.classInfo) {
                        const info = this.getTableInfo(item.classInfo.tableId)
                        if (!info.isEmptyClass) {
                            classes.push(item.classInfo)
                        }
                    }

                    if (item.functionInfo) {
                        functions.push(item.functionInfo)
                    }

                    if (item.requireInfo) {
                        requires.push(item.requireInfo)
                    }

                    if (item.fieldInfo) {
                        fields.push(item.fieldInfo)
                    }

                    if (item.seenClassId) {
                        seenClasses.add(item.seenClassId)
                    }

                    break

                case 'resolved':
                    item.functions.forEach((x) => functions.push(x))
                    item.classes.forEach((x) => classes.push(x))
                    item.requires.forEach((x) => requires.push(x))
                    item.fields.forEach((x) => fields.push(x))
                case 'returns':
                    this.resolveReturns(item)
                    break
            }
        }

        let returns: ResolvedReturnInfo[] | undefined
        if (hasReturn || scope.type !== 'block') {
            const funcInfo = this.getFunctionInfo(scope.id)
            returns = funcInfo.returnTypes.map(
                (returnTypes, i): ResolvedReturnInfo => {
                    return {
                        types: new Set(returnTypes),
                        expressions: funcInfo.returnExpressions[i] ?? new Set(),
                    }
                },
            )
        }

        if (scope.type === 'module') {
            const declaredClasses = new Set<string>()
            classes.forEach((x) => declaredClasses.add(x.tableId))

            for (const id of seenClasses) {
                if (declaredClasses.has(id)) {
                    continue
                }

                const info = this.getTableInfo(id)
                if (!info.className || info.isEmptyClass) {
                    continue
                }

                classes.push({
                    name: info.className,
                    tableId: info.id,
                })
            }
        }

        return {
            type: 'resolved',
            id: scope.id,
            classes,
            functions,
            returns,
            requires,
            fields,
            seenClasses,
        }
    }

    resolveReturns(item: ReturnsItem | ResolvedScopeItem) {
        if (item.returns === undefined) {
            return
        }

        const funcInfo = this.getFunctionInfo(item.id)

        // don't add returns to a class constructor
        if (funcInfo.isConstructor) {
            funcInfo.minReturns = Math.min(
                funcInfo.minReturns ?? Number.MAX_VALUE,
                item.returns.length,
            )

            return
        }

        let fullReturnCount = item.returns.length
        for (let i = 0; i < item.returns.length; i++) {
            funcInfo.returnTypes[i] ??= new Set()
            funcInfo.returnExpressions[i] ??= new Set()

            if (item.type === 'resolved') {
                item.returns[i].types.forEach((x) =>
                    funcInfo.returnTypes[i].add(x),
                )

                continue
            }

            const ret = item.returns[i]
            const isTailCall =
                i === item.returns.length - 1 &&
                ret.type === 'operation' &&
                ret.operator === 'call'

            if (isTailCall) {
                const funcReturns = this.typeResolver.resolveReturnTypes(ret)
                if (funcReturns) {
                    fullReturnCount += funcReturns.length - 1
                    funcInfo.returnExpressions[i].add(ret)

                    for (let j = 0; j < funcReturns.length; j++) {
                        funcInfo.returnTypes[i + j] ??= new Set()

                        this.remapBooleans(funcReturns[j]).forEach((x) =>
                            funcInfo.returnTypes[i + j].add(x),
                        )
                    }

                    continue
                }
            }

            funcInfo.returnExpressions[i].add(ret)
            this.remapBooleans(
                this.typeResolver.resolve({ expression: ret }),
            ).forEach((x) => funcInfo.returnTypes[i].add(x))
        }

        funcInfo.minReturns = Math.min(
            funcInfo.minReturns ?? Number.MAX_VALUE,
            fullReturnCount,
        )

        const min = funcInfo.minReturns
        if (min === undefined) {
            return
        }

        if (funcInfo.returnTypes.length <= min) {
            return
        }

        // mark returns exceeding the minimum as nullable
        for (let i = min; i < funcInfo.returnTypes.length; i++) {
            funcInfo.returnTypes[i].add('nil')
        }
    }

    setAliasMap(map: Map<string, Set<string>>) {
        this.aliasMap = map
    }

    setReadingModule(name?: string) {
        this.currentModule = name ?? ''
    }

    /**
     * Sets up basic info for a function.
     */
    setFunctionInfo(
        functionId: string,
        scope: LuaScope,
        node: ast.FunctionDeclaration,
        identExpr: LuaExpression | undefined,
    ): string[] {
        const info = this.getFunctionInfo(functionId)
        info.parameters = []
        info.parameterTypes = []
        info.returnTypes = []
        info.identifierExpression = identExpr

        if (identExpr?.type === 'member') {
            if (identExpr.indexer === ':') {
                const selfId =
                    scope.getLocalId('self') ?? scope.addSelfParameter()

                info.parameters.push(selfId)
            }

            const addedClosureClass = this.checkClosureClass(
                scope,
                node,
                info,
                identExpr,
            )

            if (!addedClosureClass && identExpr.indexer === ':') {
                this.checkClassMethod(scope, info, identExpr)
            }
        }

        for (const param of node.parameters) {
            const paramId = scope.getLocalId(
                param.type === 'Identifier' ? param.name : '...',
            )

            if (paramId) {
                info.parameters.push(paramId)
            }
        }

        info.parameterNames = info.parameters.map(
            (x) => scope.localIdToName(x) ?? x,
        )

        if (this.applyHeuristics) {
            this.applyParamNameHeuristics(info)
        }

        for (const param of info.parameters) {
            this.parameterToFunctionId.set(param, functionId)
        }

        return info.parameters
    }

    /**
     * Modifies types based on a setmetatable call.
     */
    setMetatable(scope: LuaScope, lhs: LuaExpression, meta: LuaExpression) {
        if (lhs.type !== 'reference') {
            return
        }

        const name = scope.localIdToName(lhs.id)
        if (!name) {
            return
        }

        if (meta.type === 'literal') {
            const fields = meta.fields

            // { X = Y }
            if (fields?.length !== 1) {
                return
            }

            // { __index = X }
            const field = fields[0]
            if (field.key.type !== 'string' || field.key.name !== '__index') {
                return
            }

            meta = field.value
        }

        // get metatable type
        const metaTypes = [
            ...this.typeResolver.resolve({ expression: meta }),
        ].filter((x) => !x.startsWith('@self'))

        const resolvedMeta = metaTypes[0]
        if (metaTypes.length !== 1 || !resolvedMeta.startsWith('@table')) {
            return
        }

        // check that metatable is a class
        const metaInfo = this.getTableInfo(resolvedMeta)
        if (!metaInfo.className && !metaInfo.fromHiddenClass) {
            return
        }

        // get lhs types
        const lhsTypes = [
            ...this.typeResolver.resolve({ expression: lhs }),
        ].filter((x) => x !== '@instance')

        if (lhsTypes.find((x) => !x.startsWith('@table'))) {
            // non-table lhs → don't treat as instance
            return
        }

        for (const resolvedLhs of lhsTypes) {
            const lhsInfo = this.getTableInfo(resolvedLhs)
            // don't copy class fields
            if (lhsInfo.className) {
                continue
            }

            // copy table fields to class instance fields
            lhsInfo.definitions.forEach((list, key) => {
                let fieldDefs = metaInfo.definitions.get(key)
                if (!fieldDefs) {
                    fieldDefs = []
                    metaInfo.definitions.set(key, fieldDefs)
                }

                for (const info of list) {
                    fieldDefs.push({
                        expression: info.expression,
                        index: info.index,
                        instance: true,
                        definingModule: this.currentModule,
                        functionLevel: !scope.id.startsWith('@module'),
                    })
                }
            })
        }

        // mark lhs as class instance
        const newId = scope.addInstance(name)
        this.definitions.set(newId, [
            {
                expression: {
                    type: 'literal',
                    luaType: 'table',
                    tableId: resolvedMeta,
                },
            },
        ])
    }

    /**
     * Sets resolved information about a module.
     */
    setModule(id: string, scope: LuaScope, resolved: ResolvedScopeItem) {
        const mod = resolved as ResolvedModule
        mod.scope = scope

        this.modules.set(id, mod)
    }

    /**
     * Sets the fields used to define a table.
     */
    setTableLiteralFields(
        scope: LuaScope,
        tableId: string,
        fields: TableField[],
    ) {
        const info = this.getTableInfo(tableId)
        info.literalFields = fields

        for (const field of fields) {
            const key = field.key

            let literalKey: string | undefined
            switch (key.type) {
                case 'string':
                    literalKey = this.getLiteralKey(key.name)
                    break

                case 'literal':
                    literalKey = this.getLiteralKey(key.literal, key.luaType)
                    break

                case 'auto':
                    literalKey = key.index.toString()
                    break

                // can't resolve expressions
            }

            if (!literalKey) {
                continue
            }

            this.addField(
                scope,
                tableId,
                literalKey,
                field.value,
                undefined,
                1,
                false,
                true,
            )
        }
    }

    protected addAtomUIClass(
        scope: LuaScope,
        name: string,
        literalInfo: TableInfo,
        base?: string,
    ): TableInfo {
        const tableId = this.newTableId()
        const info = this.getTableInfo(tableId)
        info.className = name
        info.isAtomUI = true
        info.isLocalClass = true

        for (const [field, defs] of literalInfo.definitions) {
            info.definitions.set(field, defs)

            if (defs.length !== 1) {
                continue
            }

            // functions with self → methods
            const def = defs[0]
            const expr = def.expression
            if (expr.type !== 'literal' || !expr.functionId) {
                continue
            }

            const funcInfo = this.getFunctionInfo(expr.functionId)
            if (funcInfo.parameterNames[0] !== 'self') {
                continue
            }

            funcInfo.identifierExpression = {
                type: 'member',
                base: { type: 'reference', id: '@generated' },
                member: getLuaFieldKey(field),
                indexer: ':',
            }
        }

        scope.items.push({
            type: 'partial',
            classInfo: {
                name,
                tableId,
                base,
                generated: true,
                definingModule: this.currentModule,
            },
        })

        return info
    }

    protected addDefinition(
        scope: LuaScope,
        id: string,
        expression: LuaExpression,
        index?: number,
    ) {
        let defs = this.definitions.get(id)
        if (!defs) {
            defs = []
            this.definitions.set(id, defs)
        }

        defs.push({
            expression,
            index,
            definingModule: this.currentModule,
            functionLevel: !scope.id.startsWith('@module'),
        })
    }

    protected addField(
        scope: LuaScope,
        id: string,
        field: string,
        rhs: LuaExpression,
        lhs?: LuaExpression,
        index?: number,
        instance?: boolean,
        fromLiteral?: boolean,
    ) {
        if (!id.startsWith('@table')) {
            return
        }

        const info = this.getTableInfo(id)

        // treat closure-based classes' non-function fields as instance fields
        if (info.isClosureClass) {
            instance = rhs.type !== 'literal' || rhs.luaType !== 'function'
        }

        // check for `:derive` calls in field setters
        if (lhs && rhs.type === 'operation') {
            rhs = this.checkFieldCallAssign(scope, lhs, rhs)
        }

        const types = this.typeResolver.resolve({ expression: rhs })
        const tableId = types.size === 1 ? [...types][0] : undefined
        const fieldInfo = tableId?.startsWith('@table')
            ? this.getTableInfo(tableId)
            : undefined

        if (info.className) {
            // include non-declared classes with fields set
            scope.items.push({
                type: 'partial',
                seenClassId: id,
            })

            // mark the table as contained by the class
            if (fieldInfo) {
                fieldInfo.containerId ??= id
            }
        } else if (fieldInfo?.containerId) {
            scope.items.push({
                type: 'partial',
                seenClassId: fieldInfo.containerId,
            })
        } else if (info.containerId) {
            if (fieldInfo) {
                // bubble up container IDs
                fieldInfo.containerId = info.containerId
            }

            scope.items.push({
                type: 'partial',
                seenClassId: info.containerId,
            })
        }

        if (lhs?.type === 'member' || lhs?.type === 'index') {
            this.addSeenClasses(scope, lhs.base)
        }

        let fieldDefs = info.definitions.get(field)
        if (!fieldDefs) {
            fieldDefs = []
            info.definitions.set(field, fieldDefs)
        }

        fieldDefs.push({
            expression: rhs,
            index,
            instance,
            fromLiteral,
            definingModule: this.currentModule,
            functionLevel: !scope.id.startsWith('@module'),
        })

        if (info.className || !info.containerId) {
            return
        }

        if (!lhs || (lhs.type !== 'member' && lhs.type !== 'index')) {
            return
        }

        // function assignment to a member of a non-class contained by a class → create nested class
        if (rhs.type !== 'literal' || !rhs.functionId) {
            return
        }

        this.addImpliedClass(scope, lhs.base, id, info)

        if (!info.className) {
            return
        }

        // extract the field name
        const endIdx = info.className.lastIndexOf('.')
        const targetName = this.getLiteralKey(
            info.className.slice(endIdx ? endIdx + 1 : 0),
        )

        // overwrite defs with reference to class
        const containerInfo = this.getTableInfo(info.containerId)
        if (!containerInfo.definitions.has(targetName)) {
            return
        }

        fieldDefs = []
        fieldDefs.push({
            expression: {
                type: 'literal',
                luaType: 'table',
                tableId: id,
            },
            definingModule: this.currentModule,
        })

        containerInfo.definitions.set(targetName, fieldDefs)
    }

    protected addImpliedClass(
        scope: LuaScope,
        base: LuaExpression,
        tableId: string,
        tableInfo: TableInfo,
    ) {
        let name: string | undefined
        let generated = false
        switch (base.type) {
            case 'reference':
                const localName = scope.localIdToName(base.id)
                name = tableInfo.originalName ?? localName ?? base.id

                generated =
                    tableInfo.originalName !== undefined ||
                    localName !== undefined

                break

            case 'member':
                name =
                    tableInfo.originalName ??
                    this.getFieldClassName(scope, base)

                generated = true
                break
        }

        if (!name) {
            return
        }

        tableInfo.className = name
        tableInfo.isLocalClass = generated
        tableInfo.definingModule ??= this.currentModule
        scope.items.push({
            type: 'partial',
            classInfo: {
                name,
                tableId,
                generated,
                definingModule: tableInfo.definingModule,
            },
        })
    }

    protected addSeenClasses(scope: LuaScope, expression: LuaExpression) {
        switch (expression.type) {
            case 'literal':
            case 'operation':
            case 'require':
                return

            case 'index':
            case 'member':
                this.addSeenClasses(scope, expression.base)
                return
        }

        const types = this.typeResolver.resolve({ expression })
        if (types.size !== 1) {
            return
        }

        const resolved = [...types][0]
        if (!resolved.startsWith('@table')) {
            return
        }

        const info = this.getTableInfo(resolved)
        if (info.className) {
            scope.items.push({
                type: 'partial',
                seenClassId: resolved,
            })
        }
    }

    /**
     * Adds information about the usage of an expression.
     */
    protected addUsage(item: UsageItem) {
        let usageTypes = this.usageTypes.get(item.expression)
        if (!usageTypes) {
            usageTypes = new Set([
                'boolean',
                'function',
                'number',
                'string',
                'table',
            ])

            this.usageTypes.set(item.expression, usageTypes)
        }

        if (item.supportsConcatenation) {
            // string | number
            usageTypes.delete('boolean')
            usageTypes.delete('function')
            usageTypes.delete('table')
        }

        if (item.supportsIndexing || item.supportsLength) {
            // table | string
            usageTypes.delete('boolean')
            usageTypes.delete('function')
            usageTypes.delete('number')
        }

        if (item.supportsIndexAssignment) {
            // table
            usageTypes.delete('boolean')
            usageTypes.delete('function')
            usageTypes.delete('number')
            usageTypes.delete('string')
        }

        if (item.supportsMath || item.inNumericFor) {
            // number
            usageTypes.delete('boolean')
            usageTypes.delete('function')
            usageTypes.delete('string')
            usageTypes.delete('table')
        }

        // handle function argument analysis
        if (item.arguments === undefined) {
            return
        }

        // function
        usageTypes.delete('boolean')
        usageTypes.delete('number')
        usageTypes.delete('string')
        usageTypes.delete('table')

        const types = [
            ...this.typeResolver.resolve({ expression: item.expression }),
        ]

        const id = types[0]
        if (types.length !== 1 || !id.startsWith('@function')) {
            return
        }

        const funcInfo = this.getFunctionInfo(id)
        const parameterTypes = funcInfo.parameterTypes

        // add passed arguments to inferred parameter types
        for (let i = 0; i < item.arguments.length; i++) {
            parameterTypes[i] ??= new Set()
            this.typeResolver
                .resolve({ expression: item.arguments[i] })
                .forEach((x) => parameterTypes[i].add(x))
        }

        // if arguments aren't passed for a parameter, add nil
        for (let i = item.arguments.length; i < parameterTypes.length; i++) {
            parameterTypes[i] ??= new Set()
            parameterTypes[i].add('nil')
        }
    }

    protected applyParamNameHeuristics(info: FunctionInfo) {
        const checkNames = info.parameterNames.map((x) =>
            x.startsWith('_') ? x.slice(1) : x,
        )

        let dxDyCount = 0
        let posSizeCount = 0
        let rgbaCount = 0

        for (const name of checkNames) {
            if (DX_DY_NAMES.has(name)) {
                // both of dx, dy → assume number
                dxDyCount++
            } else if (POS_SIZE_NAMES.has(name)) {
                // 2+ of {x, y, z, w, h, width, height} → assume number
                posSizeCount++
            } else if (RGBA_NAMES.has(name)) {
                // 3+ of {r, g, b, a} → assume number
                rgbaCount++
            }
        }

        for (let i = 0; i < info.parameters.length; i++) {
            const name = checkNames[i]
            const assumeNum =
                (posSizeCount >= 2 && POS_SIZE_NAMES.has(name)) ||
                (rgbaCount >= 3 && RGBA_NAMES.has(name)) ||
                (dxDyCount >= 2 && DX_DY_NAMES.has(name))

            if (assumeNum) {
                info.parameterTypes[i] ??= new Set()
                info.parameterTypes[i].add('number')
                continue
            }

            // isX → boolean
            const third = name.slice(2, 3)
            if (name.startsWith('is') && third.toUpperCase() === third) {
                info.parameterTypes[i] ??= new Set()
                info.parameterTypes[i].add('boolean')
                continue
            }

            // avoid heuristics for doTitle
            const upper = name.toUpperCase()
            if (upper.startsWith('DO')) {
                continue
            }

            // starts or ends with num → assume number
            if (upper.startsWith('NUM') || upper.endsWith('NUM')) {
                info.parameterTypes[i] ??= new Set()
                info.parameterTypes[i].add('number')
                continue
            }

            // ends with name, title, or str → assume string
            if (
                upper.endsWith('STR') ||
                upper.endsWith('NAME') ||
                upper.endsWith('TITLE')
            ) {
                info.parameterTypes[i] ??= new Set()
                info.parameterTypes[i].add('string')
                continue
            }

            // target, paramN, argN → unknown
            if (UNKNOWN_NAMES.test(name)) {
                info.parameterTypes[i] ??= new Set()
                info.parameterTypes[i].add('unknown')
            }
        }
    }

    protected checkBaseUINode(
        scope: LuaScope,
        lhs: LuaExpression,
        rhs: LuaExpression,
    ): LuaExpression | undefined {
        const name = this.getFieldClassName(scope, lhs)
        if (!name) {
            return
        }

        if (rhs.type !== 'operation' || rhs.operator !== 'call') {
            return
        }

        // A(X)
        if (rhs.arguments.length !== 2) {
            return
        }

        // A.B(X)
        const callBase = rhs.arguments[0]
        if (callBase.type !== 'member') {
            return
        }

        // A.__call(X)
        if (callBase.member !== '__call') {
            return
        }

        // A.__call({ ... })
        const callArg = rhs.arguments[1]
        if (callArg.type !== 'literal' || !callArg.tableId) {
            return
        }

        const argInfo = this.getTableInfo(callArg.tableId)
        const atomField = argInfo.literalFields.find(
            (x) => x.key.type === 'string' && x.key.name === '_ATOM_UI_CLASS',
        )

        // A.__call({ _ATOM_UI_CLASS = X, ... })
        if (!atomField || atomField.value.type !== 'reference') {
            return
        }

        const info = this.addAtomUIClass(scope, name, argInfo)
        info.isAtomUIBase = true

        return {
            type: 'literal',
            luaType: 'table',
            tableId: info.id,
        }
    }

    protected checkChildUINode(
        scope: LuaScope,
        lhs: LuaExpression,
        rhs: LuaExpression,
    ): LuaExpression | undefined {
        const name = this.getFieldClassName(scope, lhs)
        if (!name) {
            return
        }

        if (rhs.type !== 'operation' || rhs.operator !== 'call') {
            return
        }

        // A(X)
        if (rhs.arguments.length !== 2) {
            return
        }

        // A({ ... })
        const callArg = rhs.arguments[1]
        if (callArg.type !== 'literal' || !callArg.tableId) {
            return
        }

        // TableRef({ ... })
        const callBase = rhs.arguments[0]
        const types = this.typeResolver.resolve({ expression: callBase })
        const argId = [...types][0]
        if (types.size !== 1 || !argId.startsWith('@table')) {
            return
        }

        // Node({ ... })
        const baseInfo = this.getTableInfo(argId)
        if (!baseInfo.isAtomUI) {
            return
        }

        const argInfo = this.getTableInfo(callArg.tableId)
        const info = this.addAtomUIClass(
            scope,
            name,
            argInfo,
            baseInfo.className,
        )

        return {
            type: 'literal',
            luaType: 'table',
            tableId: info.id,
        }
    }

    protected checkClassMethod(
        scope: LuaScope,
        info: FunctionInfo,
        identExpr: LuaMember,
    ) {
        const base = identExpr.base
        const types = this.typeResolver.resolve({ expression: base })
        if (types.size !== 1) {
            return
        }

        const tableId = [...types][0]
        const tableInfo = tableId.startsWith('@table')
            ? this.getTableInfo(tableId)
            : undefined

        info.parameterTypes.push(types)

        if (identExpr.member !== 'new') {
            return
        }

        // assume Class:new(...) returns Class
        info.returnTypes.push(new Set(types))
        info.isConstructor = true

        if (!tableInfo || tableInfo.className || tableInfo.fromHiddenClass) {
            return
        }

        // `:new` method without class → create class
        this.addImpliedClass(scope, base, tableId, tableInfo)
    }

    protected checkClassTable(expr: LuaExpression): string | undefined {
        if (expr.type === 'operation' && expr.operator === 'call') {
            return
        }

        if (expr.type === 'operation' && expr.operator === 'or') {
            const orLhs = expr.arguments[0]
            const orRhs = expr.arguments[1]
            const orRhsFields = (orRhs.type === 'literal' && orRhs.fields) || []

            // X = X or {} → treat as X
            if (orLhs.type === 'reference' && orRhsFields.length === 0) {
                const result = this.checkClassTable(orLhs)
                if (result) {
                    return result
                }
            }
        }

        const typeSet = this.typeResolver.resolve({ expression: expr })

        // expect unambiguous type
        if (typeSet.size !== 1) {
            return
        }

        // expect table
        const rhs = [...typeSet][0]
        if (!rhs.startsWith('@table')) {
            return
        }

        return rhs
    }

    protected checkClosureClass(
        scope: LuaScope,
        node: ast.FunctionDeclaration,
        info: FunctionInfo,
        identExpr: LuaMember,
    ): boolean {
        const base = identExpr.base
        if (base.type !== 'reference') {
            return false
        }

        // setmetatable instances should be handled elsewhere
        if (this.checkHasSetmetatableInstance(node)) {
            return false
        }

        // all closure-based classes set a local `self` or `publ`
        // this will be either a table or a call to the base class `.new`
        let classTable: ast.TableConstructorExpression | undefined
        let baseClass: string | undefined
        let selfName = 'self'
        for (const child of node.body) {
            // local self/publ = ...
            if (child.type !== 'LocalStatement') {
                continue
            }

            const name = child.variables[0]?.name
            if (name !== 'self' && name !== 'publ') {
                continue
            }

            // local self/publ = {}
            const init = child.init[0]
            if (init.type === 'TableConstructorExpression') {
                classTable = init
                selfName = name
                break
            }

            // no closure-based classes are defined as local publ = X.new(...)
            if (name === 'publ') {
                continue
            }

            // local self = X.new()
            const base = init.type === 'CallExpression' ? init.base : undefined

            if (base?.type !== 'MemberExpression') {
                continue
            }

            if (base.identifier.name !== 'new') {
                continue
            }

            const memberBase = base.base
            if (memberBase.type !== 'Identifier') {
                continue
            }

            selfName = name
            baseClass = memberBase.name
            break
        }

        if (!baseClass && !classTable) {
            return false
        }

        // require at least one `self.X` function to identify it as a closure-based class
        const foundFunction = node.body.find((child) => {
            if (child.type !== 'FunctionDeclaration') {
                return
            }

            if (child.identifier?.type !== 'MemberExpression') {
                return
            }

            const base = child.identifier.base
            if (base.type !== 'Identifier') {
                return
            }

            return base.name === selfName
        })

        if (!foundFunction) {
            return false
        }

        const tableId = classTable
            ? this.getTableId(classTable)
            : this.newTableId()

        const tableInfo = this.getTableInfo(tableId)
        if (tableInfo.className) {
            // already has a class
            return false
        }

        let name: string
        const memberName = identExpr.member
        if (memberName === 'new' || memberName === 'getInstance') {
            name = scope.localIdToName(base.id) ?? base.id

            // name collision → don't emit a class annotation for the container
            const types = this.typeResolver.resolve({ expression: base })
            const resolved = [...types][0]
            if (types.size === 1 && resolved.startsWith('@table')) {
                const containerInfo = this.getTableInfo(resolved)
                if (containerInfo.className === name) {
                    containerInfo.emitAsTable = true
                }
            }
        } else {
            const lastSlash = this.currentModule.lastIndexOf('/')
            name = this.currentModule.slice(lastSlash + 1)
        }

        tableInfo.className = name
        tableInfo.isClosureClass = true
        tableInfo.isLocalClass = true
        scope.items.push({
            type: 'partial',
            classInfo: {
                name,
                tableId,
                definingModule: this.currentModule,
                base: baseClass,
                generated: true,
            },
        })

        scope.classSelfName = selfName
        if (!classTable) {
            // to identify the table when it's being defined
            scope.classTableId = tableId
        }

        // mark the instance in the base class
        const resolvedBaseTypes = [
            ...this.typeResolver.resolve({
                expression: base,
            }),
        ]

        const resolvedBase =
            resolvedBaseTypes.length === 1 ? resolvedBaseTypes[0] : undefined

        if (resolvedBase?.startsWith('@table')) {
            const baseTableInfo = this.getTableInfo(resolvedBase)
            if (baseTableInfo.className) {
                baseTableInfo.instanceName = name
                baseTableInfo.instanceId = tableId
            }
        }

        if (identExpr.indexer === ':') {
            info.parameterTypes.push(
                this.typeResolver.resolve({ expression: base }),
            )
        }

        info.returnTypes.push(new Set([tableId]))
        info.isConstructor = true
        return true
    }

    protected checkDeriveCall(
        expr: LuaExpression,
    ): [string, string] | undefined {
        if (expr.type !== 'operation' || expr.operator !== 'call') {
            return
        }

        // expect single argument (base + arg count)
        if (expr.arguments.length !== 2) {
            return
        }

        // expect string
        const arg = expr.arguments[1]
        if (arg.type !== 'literal' || arg.luaType !== 'string') {
            return
        }

        const type = readLuaStringLiteral(arg.literal ?? '')
        if (!type) {
            return
        }

        // expect X:Y(...)
        const callBase = expr.arguments[0]
        if (callBase?.type !== 'member' || callBase.indexer !== ':') {
            return
        }

        // expect X:derive(...)
        if (callBase.member !== 'derive') {
            return
        }

        // expect base:derive(...)
        const base = callBase.base
        if (base.type !== 'reference') {
            return
        }

        let id = base.id

        // resolve local variables for global classes
        if (id.startsWith('@')) {
            const types = this.typeResolver.resolve({ expression: base })
            const resolved = [...types][0]
            if (types.size !== 1 || !resolved.startsWith('@table')) {
                return
            }

            const tableInfo = this.getTableInfo(resolved)
            if (!tableInfo.className) {
                return
            }

            id = tableInfo.className
        }

        // found derive; return base class name
        return [id, type]
    }

    protected checkFieldCallAssign(
        scope: LuaScope,
        lhs: LuaExpression,
        rhs: LuaExpression,
    ): LuaExpression {
        // check for `:derive` calls
        const [base, deriveName] = this.checkDeriveCall(rhs) ?? []
        const name = base && this.getFieldClassName(scope, lhs)
        if (base && name) {
            const newId = this.newTableId()
            const newInfo = this.getTableInfo(newId)
            newInfo.className = name
            newInfo.isLocalClass = true

            scope.items.push({
                type: 'partial',
                classInfo: {
                    name,
                    tableId: newId,
                    base,
                    deriveName,
                    generated: true,
                    definingModule: this.currentModule,
                },
            })

            return {
                type: 'literal',
                luaType: 'table',
                tableId: newId,
            }
        }

        // check for base `UI.Node` initialization
        const baseUiRhs = this.checkBaseUINode(scope, lhs, rhs)
        if (baseUiRhs) {
            return baseUiRhs
        }

        // check for child UI node initialization
        const childUiRhs = this.checkChildUINode(scope, lhs, rhs)
        if (childUiRhs) {
            return childUiRhs
        }

        return rhs
    }

    protected checkHasSetmetatableInstance(node: ast.FunctionDeclaration) {
        for (const child of node.body) {
            // check for a setmetatable call
            if (child.type !== 'CallStatement') {
                continue
            }

            if (child.expression.type !== 'CallExpression') {
                continue
            }

            const base = child.expression.base
            if (base.type !== 'Identifier' || base.name !== 'setmetatable') {
                continue
            }

            // check for a metatable
            const meta = child.expression.arguments[1]
            if (!meta) {
                continue
            }

            // identifier → using table as index
            if (meta.type === 'Identifier') {
                return true
            }

            if (meta.type !== 'TableConstructorExpression') {
                continue
            }

            // table → check for an __index field
            for (const field of meta.fields) {
                if (field.type !== 'TableKeyString') {
                    continue
                }

                if (field.key.name === '__index') {
                    return true
                }
            }
        }

        return false
    }

    protected getFieldClassName(
        scope: LuaScope,
        expr: LuaExpression,
    ): string | undefined {
        if (expr.type !== 'member') {
            return
        }

        const names: string[] = [expr.member]

        while (expr.type === 'member') {
            const parent: LuaExpression = expr.base
            if (parent.type === 'reference') {
                names.push(scope.localIdToName(parent.id) ?? parent.id)
                break
            } else if (parent.type !== 'member') {
                return
            }

            names.push(parent.member)
            expr = parent
        }

        return names.reverse().join('.')
    }

    protected newTableId(name?: string): string {
        const count = this.nextTableIndex++
        return `@table(${count})` + (name ? `[${name}]` : '')
    }

    protected remapBooleans(types: Set<string>) {
        const remapped = [...types].map((x) =>
            x === 'true' || x === 'false' ? 'boolean' : x,
        )

        types.clear()
        remapped.forEach((x) => types.add(x))

        return types
    }

    protected removeEmptyDefinition(name: string) {
        const defs = this.definitions.get(name)

        // single def?
        if (!defs || defs.length !== 1) {
            return
        }

        // belongs to this module?
        const def = defs[0]
        if (def.definingModule !== this.currentModule) {
            return
        }

        // table?
        const expr = def.expression
        if (expr.type !== 'literal' || expr.luaType !== 'table') {
            return
        }

        if (!expr.tableId) {
            return
        }

        // empty?
        if (expr.fields && expr.fields.length > 0) {
            return
        }

        const info = this.getTableInfo(expr.tableId)
        if (info.definitions.size > 0) {
            return
        }

        // remove the empty table definition
        info.isEmptyClass = true
        defs.splice(0, defs.length)
    }

    protected tryAddPartialItem(
        scope: LuaScope,
        item: AssignmentItem | RequireAssignmentItem | FunctionDefinitionItem,
        lhs: LuaReference,
        rhs: LuaExpression,
    ): string | undefined {
        // edge case: closure-based classes
        if (scope.type === 'function') {
            if (scope.localIdToName(lhs.id) !== scope.classSelfName) {
                return
            }

            // self = {} | Base.new() → use the generated table
            return scope.classTableId
        }

        // module and module-level blocks, excluding functions
        if (!scope.id.startsWith('@module')) {
            return
        }

        if (item.type === 'requireAssignment') {
            scope.items.push({
                type: 'partial',
                requireInfo: {
                    name: lhs.id,
                    module: item.rhs.module,
                },
            })

            return
        }

        // global function definition
        if (item.type === 'functionDefinition') {
            // ignore local functions
            if (item.isLocal) {
                return
            }

            scope.items.push({
                type: 'partial',
                functionInfo: {
                    name: lhs.id,
                    functionId: item.id,
                },
            })

            return
        }

        const [base, deriveName] = this.checkDeriveCall(rhs) ?? []

        if (lhs.id.startsWith('@')) {
            if (base) {
                // if there's a derive call, return a table so fields aren't misattributed

                const newId = this.newTableId()
                const info = this.getTableInfo(newId)
                info.fromHiddenClass = true
                info.originalBase = base
                info.originalDeriveName = deriveName

                return newId
            }

            // ignore local classes otherwise
            return
        }

        const tableId = !base ? this.checkClassTable(rhs) : this.newTableId()

        // global table or derive call → class
        if (tableId) {
            const tableInfo = this.getTableInfo(tableId)

            // assignment to existing class table → add a field instead
            if (
                tableInfo.className &&
                !tableInfo.isEmptyClass &&
                rhs.type !== 'literal' &&
                rhs.type !== 'operation'
            ) {
                scope.items.push({
                    type: 'partial',
                    fieldInfo: {
                        name: lhs.id,
                        types: new Set([tableInfo.className]),
                    },
                })

                return
            }

            tableInfo.className ??= lhs.id
            tableInfo.definingModule ??= this.currentModule

            this.removeEmptyDefinition(lhs.id) // ThermoDebug edge case

            scope.items.push({
                type: 'partial',
                classInfo: {
                    name: lhs.id,
                    tableId,
                    definingModule: tableInfo.definingModule,
                    base: base ?? tableInfo.originalBase,
                    deriveName: deriveName ?? tableInfo.originalDeriveName,
                },
            })

            return tableId
        }

        // global function assignment
        const rhsTypes = [
            ...this.typeResolver.resolve({ expression: item.rhs }),
        ]

        if (rhsTypes.length !== 1) {
            return
        }

        const rhsType = rhsTypes[0]
        if (rhsType.startsWith('@function')) {
            scope.items.push({
                type: 'partial',
                functionInfo: {
                    name: lhs.id,
                    functionId: rhsType,
                },
            })
        }
    }
}
