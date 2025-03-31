import { LuaExpression } from '../../analysis'

export const isLiteralTable = (expr: LuaExpression): boolean => {
    if (expr.type !== 'literal') {
        return false
    }

    return expr.luaType === 'table'
}
