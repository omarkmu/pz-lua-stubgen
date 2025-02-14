import { AnalyzedField } from '../../analysis'
import { RosettaField } from '../../rosetta'
import { convertAnalyzedField } from './convert-analyzed-field'

export const convertAnalyzedFields = (
    fields: AnalyzedField[],
    mergeFields?: Record<string, RosettaField>,
    keepTypes?: boolean,
    applyHeuristics?: boolean,
): Record<string, RosettaField> => {
    const converted = fields
        .map((x): [string, RosettaField] => [
            x.name,
            convertAnalyzedField(
                x,
                mergeFields?.[x.name],
                keepTypes,
                applyHeuristics,
            ),
        ])
        .reduce<Record<string, RosettaField>>((rec, value) => {
            rec[value[0]] = value[1]
            return rec
        }, {})

    for (const [key, field] of Object.entries(mergeFields ?? {})) {
        if (!converted[key]) {
            converted[key] = field
        }
    }

    return converted
}
