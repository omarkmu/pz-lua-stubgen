import { RosettaParameter } from '../../rosetta'
import { AnalyzedParameter } from '../../analysis'
import { convertAnalyzedParameter } from './convert-analyzed-parameter'

export const convertAnalyzedParameters = (
    params: AnalyzedParameter[],
    mergeParams?: RosettaParameter[],
    keepTypes?: boolean,
): RosettaParameter[] => {
    const converted = params.map((x, i) =>
        convertAnalyzedParameter(x, mergeParams?.[i], keepTypes),
    )

    if (mergeParams && params.length < mergeParams.length) {
        for (let i = params.length; i < mergeParams.length; i++) {
            converted.push(mergeParams[i])
        }
    }

    return converted
}
