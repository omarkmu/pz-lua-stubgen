import { LuaOperation } from '../../analysis'
import { getExpressionString } from './get-expression-string'
import { includeAsIs } from './include-as-is'
import { isTernaryOperation } from './is-ternary-operation'

export const getOperationString = (
    expression: LuaOperation,
    allowAmbiguous: boolean,
    depth?: number,
): string => {
    let lhs = expression.arguments[0]
    let rhs = expression.arguments[1]

    switch (expression.operator) {
        case 'call':
            const callBase = getExpressionString(
                expression.arguments[0],
                allowAmbiguous,
                depth,
            )

            const args: string[] = []
            for (let i = 1; i < expression.arguments.length; i++) {
                args.push(
                    getExpressionString(
                        expression.arguments[i],
                        allowAmbiguous,
                        depth,
                    ),
                )
            }

            return `${callBase}(${args.join(', ')})`

        default:
            let lhsString = getExpressionString(lhs, allowAmbiguous, depth)
            let rhsString = rhs
                ? getExpressionString(rhs, allowAmbiguous, depth)
                : undefined

            if (!isTernaryOperation(expression)) {
                if (!includeAsIs(lhs)) {
                    lhsString = `(${lhsString})`
                }

                if (rhs && !includeAsIs(rhs)) {
                    rhsString = `(${rhsString})`
                }
            }

            if (!rhsString) {
                return `${expression.operator}${lhsString}`
            }

            return `${lhsString} ${expression.operator} ${rhsString}`
    }
}
