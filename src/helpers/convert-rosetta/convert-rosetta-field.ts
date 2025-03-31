import { AnalyzedField } from '../../analysis'
import { RosettaField } from '../../rosetta'
import { convertRosettaTypes } from './convert-rosetta-types'

export const convertRosettaField = (
    field: RosettaField,
    name: string,
): AnalyzedField => {
    return {
        name,
        types: convertRosettaTypes(field.type, field.nullable),
    }
}
