import { LuaExpression } from '../../analysis'

export const isTernaryOperation = (expr: LuaExpression): boolean => {
    if (expr.type !== 'operation' || expr.operator !== 'or') {
        return false
    }

    const lhs = expr.arguments[0]
    if (lhs.type !== 'operation' || lhs.operator !== 'and') {
        return false
    }

    return true
}
