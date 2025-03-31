import { LuaLiteral } from '../../analysis'
import { getFunctionString } from './get-function-string'
import { getTableString } from './get-table-string'

export const getLiteralString = (
    expression: LuaLiteral,
    allowAmbiguous: boolean,
    depth: number = 1,
): string => {
    switch (expression.luaType) {
        case 'nil':
            return 'nil'

        case 'string':
            return expression.literal ?? '""'

        case 'number':
            return expression.literal ?? '0'

        case 'boolean':
            return expression.literal ?? 'false'

        case 'function':
            const params = [...(expression.parameters ?? [])]
            if (expression.isMethod) {
                params.unshift({ name: 'self', types: new Set() })
            }

            return getFunctionString(undefined, params)

        case 'table':
            return getTableString(expression, allowAmbiguous, depth) ?? '{}'
    }
}
