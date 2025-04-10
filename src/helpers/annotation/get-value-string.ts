import { LuaExpression } from '../../analysis'
import { RosettaField } from '../../rosetta'
import { getExpressionString } from './get-expression-string'

const isRequiredTableType = (type?: string): boolean => {
    if (!type) {
        return false
    }

    if (type.endsWith('?')) {
        return false
    }

    if (type === 'table' || type.startsWith('table<')) {
        return true
    }

    if (type.endsWith('[]') && !type.includes('|')) {
        return true
    }

    return false
}

export const getValueString = (
    expression: LuaExpression | undefined,
    rosettaField: RosettaField | undefined,
    typeString: string | undefined,
    hasRosettaType: boolean,
    hasTableLiteral: boolean,
    allowAmbiguous: boolean,
    depth: number = 1,
): [string, string | undefined] => {
    let valueString: string
    if (rosettaField?.defaultValue) {
        valueString = rosettaField.defaultValue
        typeString = hasRosettaType ? typeString : undefined
    } else if (expression && !hasRosettaType) {
        valueString = getExpressionString(expression, allowAmbiguous, depth)
    } else {
        valueString = 'nil'

        // use empty table instead of nil for non-optional table types
        if (!rosettaField?.defaultValue && isRequiredTableType(typeString)) {
            valueString = '{}'
            hasTableLiteral = true
        }
    }

    if (valueString === 'nil' && typeString === 'unknown?') {
        typeString = undefined
    }

    // don't write `---@type table` when a table literal is available
    if (hasTableLiteral && typeString === 'table' && valueString !== 'nil') {
        typeString = undefined
    }

    return [valueString.trim(), typeString]
}
