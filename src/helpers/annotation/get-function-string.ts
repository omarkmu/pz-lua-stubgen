import { AnalyzedParameter } from '../../analysis'
import { getFunctionStringFromParamNames } from './get-function-string-from-param-names'

export const getFunctionString = (
    name: string | undefined,
    parameters: AnalyzedParameter[],
): string => {
    return getFunctionStringFromParamNames(
        name,
        parameters.map((x) => x.name),
    )
}
