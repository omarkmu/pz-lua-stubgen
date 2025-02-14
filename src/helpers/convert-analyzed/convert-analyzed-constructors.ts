import { AnalyzedFunction } from '../../analysis'
import { RosettaConstructor } from '../../rosetta'
import { convertAnalyzedParameters } from './convert-analyzed-parameters'

export const convertAnalyzedConstructors = (
    constructors: AnalyzedFunction[],
    mergeConstructors?: RosettaConstructor[],
    keepTypes?: boolean,
): RosettaConstructor[] => {
    const converted = constructors.map((x, i): RosettaConstructor => {
        const cons: RosettaConstructor = {}
        const mergeCons = mergeConstructors ? mergeConstructors[i] : undefined

        if (mergeCons?.deprecated) {
            cons.deprecated = true
        }

        if (mergeCons?.notes) {
            cons.notes = mergeCons.notes
        }

        if (x.parameters.length > 0) {
            cons.parameters = convertAnalyzedParameters(
                x.parameters,
                mergeCons?.parameters,
                keepTypes,
            )
        } else if (mergeCons?.parameters && mergeCons.parameters.length > 0) {
            cons.parameters = mergeCons.parameters
        }

        return cons
    })

    if (mergeConstructors && constructors.length < mergeConstructors.length) {
        for (let i = constructors.length; i < mergeConstructors.length; i++) {
            converted.push(mergeConstructors[i])
        }
    }

    return converted
}
