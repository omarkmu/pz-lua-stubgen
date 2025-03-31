import { LuaExpression } from '../../analysis'
import { getFunctionPrefix } from './get-function-prefix'

export const getFunctionPrefixFromExpression = (
    expression: LuaExpression,
    allowAmbiguous: boolean,
    tabLevel: number = 0,
): string | undefined => {
    if (expression.type !== 'literal') {
        return
    }

    if (expression.luaType !== 'function') {
        return
    }

    return getFunctionPrefix(
        expression.parameters,
        expression.returnTypes,
        allowAmbiguous,
        tabLevel,
    )
}
