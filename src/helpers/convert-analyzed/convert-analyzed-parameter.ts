import { RosettaParameter } from '../../rosetta'
import { AnalyzedParameter } from '../../analysis'
import { convertAnalyzedTypes } from './convert-analyzed-types'
import { removeUndefinedOrEmpty } from '../remove-undefined-or-empty'
import { getHeuristicTypes } from './get-heuristic-types'

export const convertAnalyzedParameter = (
    param: AnalyzedParameter,
    mergeParam?: RosettaParameter,
    keepTypes?: boolean,
    applyHeuristics?: boolean,
): RosettaParameter => {
    const rosettaParam: RosettaParameter = { name: param.name }

    const paramTypes = applyHeuristics
        ? getHeuristicTypes(param.name, param.types)
        : param.types

    const [type, nullable] = convertAnalyzedTypes(paramTypes)

    if (mergeParam && keepTypes) {
        rosettaParam.type = mergeParam.type ?? type
        rosettaParam.nullable = mergeParam.nullable
        rosettaParam.optional = mergeParam.optional
    } else {
        rosettaParam.type = type
        rosettaParam.nullable = nullable || undefined
        rosettaParam.optional = mergeParam?.optional
    }

    rosettaParam.notes = mergeParam?.notes

    return removeUndefinedOrEmpty(rosettaParam)
}
