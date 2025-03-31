import { BaseLuaScope } from './BaseLuaScope'
import { BaseLuaScopeArgs, BasicBlockNode } from './types'

interface BlockScopeArgs extends BaseLuaScopeArgs {
    node: BasicBlockNode
}

export class LuaBlockScope extends BaseLuaScope {
    type: 'block'
    node: BasicBlockNode

    constructor(args: BlockScopeArgs) {
        super(args)
        this.type = 'block'
        this.node = args.node
    }
}
