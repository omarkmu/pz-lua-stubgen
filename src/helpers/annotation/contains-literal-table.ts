import { LuaExpression } from '../../analysis'
import { isLiteralTable } from './is-literal-table'

export const containsLiteralTable = (expr: LuaExpression): boolean => {
    switch (expr.type) {
        case 'reference':
        case 'require':
            return false

        case 'member':
            return containsLiteralTable(expr.base)

        case 'index':
            return (
                containsLiteralTable(expr.base) ||
                containsLiteralTable(expr.index)
            )

        case 'literal':
            return isLiteralTable(expr)

        case 'operation':
            for (const arg of expr.arguments) {
                if (containsLiteralTable(arg)) {
                    return true
                }
            }

            return false
    }
}
