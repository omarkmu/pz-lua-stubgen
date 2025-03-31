import { LuaExpression } from '../../analysis'

export const includeAsIs = (expr: LuaExpression): boolean => {
    if (expr.type !== 'operation') {
        return true
    }

    switch (expr.operator) {
        case 'call':
        case '..':
        case '#':
            return true

        case '-':
            // unary minus as-is, binary minus with parentheses
            return expr.arguments.length === 1

        default:
            return false
    }
}
