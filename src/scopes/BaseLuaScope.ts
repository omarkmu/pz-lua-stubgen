import type ast from 'luaparse'
import type { AnalysisItem } from '../analysis'
import { BaseLuaScopeArgs, LuaScope, NodeWithBody } from './types'

export class BaseLuaScope {
    /**
     * The ID of the scope.
     * Function scopes will match the function declaration ID, and non-module scopes will use their parent ID.
     */
    id: string

    /**
     * The parent scope.
     */
    parent?: BaseLuaScope

    /**
     * The node that the scope is based on.
     */
    node: NodeWithBody

    /**
     * The statements in the scope.
     */
    body: ast.Statement[]

    /**
     * The depth of the scope.
     * 0 is the main module-level scope.
     */
    depth: number

    /**
     * Information about items in scope.
     */
    items: AnalysisItem[]

    /**
     * The table ID to use for a closure-based class.
     */
    classTableId?: string

    /**
     * The local identifier for a closure-based class.
     */
    classSelfName?: string

    /**
     * Maps locals defined in this scope to their IDs.
     */
    protected localToId: Map<string, string>

    /**
     * Maps IDs to locals defined in this scope.
     */
    protected idToLocal: Map<string, string>

    static nextIndexMap: Map<string, number> = new Map()

    constructor(args: BaseLuaScopeArgs) {
        this.id = '@unknown'
        this.parent = args.parent
        this.node = args.node
        this.body = args.node.body
        this.items = []
        this.depth = args.parent ? args.parent.depth + 1 : 0

        this.localToId = new Map()
        this.idToLocal = new Map()
    }

    /**
     * Adds a local to the scope and marks it as a class instance.
     */
    addInstance(name: string) {
        return this.addLocalItem(name, 'instance')
    }

    /**
     * Adds an analysis item to the scope.
     */
    addItem<T extends AnalysisItem>(item: T): T {
        item.depth = this.depth
        this.items.push(item)
        return item
    }

    /**
     * Adds a local defined in this scope.
     */
    addLocal(name: string): string {
        return this.addLocalItem(name)
    }

    /**
     * Adds a local function to the scope.
     */
    addLocalFunction(name: string, id: string): string {
        this.localToId.set(name, id)
        this.idToLocal.set(id, name)

        return id
    }

    /**
     * Adds a local to the scope and marks it as a parameter.
     */
    addParameter(parameter: string) {
        return this.addLocalItem(parameter, 'parameter')
    }

    /**
     * Adds a local to the scope and marks it as an implicit self parameter.
     */
    addSelfParameter() {
        return this.addLocalItem('self', 'self')
    }

    /**
     * Gets the defining scope for a local.
     */
    getDefiningScope(id: string): LuaScope | undefined {
        if (this.idToLocal.get(id)) {
            return this as any as LuaScope
        }

        return this.parent?.getDefiningScope(id)
    }

    /**
     * Gets the ID associated with a local.
     * @param name
     * @returns
     */
    getLocalId(name: string): string | undefined {
        return this.localToId.get(name) ?? this.parent?.getLocalId(name)
    }

    /**
     * Checks whether a name is local and defined in this scope.
     */
    hasDefinedLocal(name?: string): boolean {
        if (!name) {
            return false
        }

        return this.localToId.get(name) !== undefined
    }

    /**
     * Checks whether a name is local, defined in any accessible scope.
     */
    hasLocal(name?: string): boolean {
        if (!name) {
            return false
        }

        if (this.localToId.get(name)) {
            return true
        }

        return this.parent ? this.parent.hasLocal(name) : false
    }

    /**
     * Gets the name of the local associated with the given ID, if it's a local.
     */
    localIdToName(id: string): string | undefined {
        return this.idToLocal.get(id) ?? this.parent?.localIdToName(id)
    }

    /**
     * Adds a local, parameter, or self parameter to the scope.
     */
    protected addLocalItem(name: string, type: string = 'local'): string {
        const id = this.getNextLocalID(name, type)
        this.localToId.set(name, id)
        this.idToLocal.set(id, name)

        return id
    }

    /**
     * Gets an ID to use for a local.
     */
    protected getNextLocalID(name: string, type: string = 'local'): string {
        const nextIndex = BaseLuaScope.nextIndexMap.get(type) ?? 1
        BaseLuaScope.nextIndexMap.set(type, nextIndex + 1)

        if (type === 'self') {
            return `@${type}(${nextIndex})`
        }

        return `@${type}(${nextIndex})[${name}]`
    }
}
