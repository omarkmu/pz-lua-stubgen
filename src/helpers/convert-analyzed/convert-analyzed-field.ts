import { AnalyzedField } from '../../analysis'
import { RosettaField } from '../../rosetta'
import { expressionToDefaultValue } from '../expression-to-default-value'
import { removeUndefinedOrEmpty } from '../remove-undefined-or-empty'
import { convertAnalyzedTypes } from './convert-analyzed-types'
import { getHeuristicTypes } from './get-heuristic-types'

export const convertAnalyzedField = (
    field: AnalyzedField,
    mergeField?: RosettaField,
    keepTypes?: boolean,
    applyHeuristics?: boolean,
): RosettaField => {
    const rosettaField: RosettaField = {}

    const fieldTypes = applyHeuristics
        ? getHeuristicTypes(field.name, field.types)
        : field.types

    const [type, nullable] = convertAnalyzedTypes(fieldTypes)

    let hasValue = false
    let defaultValue: string | undefined
    if (keepTypes && mergeField?.defaultValue) {
        hasValue = true
        defaultValue = mergeField.defaultValue
    } else if (field.expression) {
        hasValue = true
        defaultValue = expressionToDefaultValue(
            field.expression,
            mergeField?.defaultValue,
        )
    }

    if (mergeField && keepTypes) {
        rosettaField.type =
            mergeField.type ??
            (!hasValue || mergeField.nullable ? type : undefined)

        rosettaField.nullable = mergeField.nullable
    } else {
        if (type && (!hasValue || nullable)) {
            rosettaField.type = type
        }

        if (nullable) {
            rosettaField.nullable = nullable
        }
    }

    rosettaField.notes = mergeField?.notes
    rosettaField.tags = mergeField?.tags
    rosettaField.defaultValue = defaultValue

    return removeUndefinedOrEmpty(rosettaField)
}
