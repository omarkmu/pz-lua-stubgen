import { RosettaParameter } from '../../rosetta'
import { AnalyzedParameter } from '../../analysis'
import { convertRosettaTypes } from './convert-rosetta-types'

export const convertRosettaParameters = (
    params: RosettaParameter[] | undefined,
): AnalyzedParameter[] => {
    if (!params) {
        return []
    }

    return params.map((x): AnalyzedParameter => {
        return {
            name: x.name,
            types: convertRosettaTypes(x.type, x.nullable || x.optional),
        }
    })
}
