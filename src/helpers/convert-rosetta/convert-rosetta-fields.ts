import { AnalyzedField } from '../../analysis'
import { RosettaField } from '../../rosetta'
import { convertRosettaField } from './convert-rosetta-field'

export const convertRosettaFields = (
    fields: Record<string, RosettaField> | undefined,
): AnalyzedField[] => {
    if (!fields) {
        return []
    }

    return Object.entries(fields).map(([name, field]) =>
        convertRosettaField(field, name),
    )
}
