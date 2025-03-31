import { LuaExpression } from '../analysis'
import { containsLiteralTable, getExpressionString } from './annotation'

export const expressionToDefaultValue = (
    expression: LuaExpression,
    tableDefault?: string,
): string | undefined => {
    if (containsLiteralTable(expression)) {
        return tableDefault
    }

    const value = getExpressionString(expression)
    if (value !== 'nil') {
        return value
    }
}
