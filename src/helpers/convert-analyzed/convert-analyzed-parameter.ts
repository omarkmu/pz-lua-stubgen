import { RosettaParameter } from '../../rosetta'
import { AnalyzedParameter } from '../../analysis'
import { convertAnalyzedTypes } from './convert-analyzed-types'
import { removeUndefinedOrEmpty } from '../remove-undefined-or-empty'

export const convertAnalyzedParameter = (
    param: AnalyzedParameter,
    mergeParam?: RosettaParameter,
    keepTypes?: boolean,
): RosettaParameter => {
    const rosettaParam: RosettaParameter = { name: param.name }
    const [types, nullable] = convertAnalyzedTypes(param.types)

    if (mergeParam && keepTypes) {
        rosettaParam.type = mergeParam.type ?? types
        rosettaParam.nullable = mergeParam.nullable
        rosettaParam.optional = mergeParam.optional
    } else {
        rosettaParam.type = types
        rosettaParam.nullable = nullable || undefined
        rosettaParam.optional = mergeParam?.optional
    }

    rosettaParam.notes = mergeParam?.notes

    return removeUndefinedOrEmpty(rosettaParam)
}
