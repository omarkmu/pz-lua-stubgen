import { AnalyzedTable } from '../../analysis'
import { RosettaTable, WritableRosettaTable } from '../../rosetta'
import { removeUndefinedOrEmpty } from '../remove-undefined-or-empty'
import { convertAnalyzedFields } from './convert-analyzed-fields'
import { convertAnalyzedFunctions } from './convert-analyzed-functions'
import { convertAnalyzedOverloads } from './convert-analyzed-overloads'

export const convertAnalyzedTable = (
    table: AnalyzedTable,
    mergeTable?: RosettaTable,
    keepTypes?: boolean,
    applyHeuristics?: boolean,
): WritableRosettaTable => {
    const rosettaTable: WritableRosettaTable = {
        name: table.name,
        deprecated: mergeTable?.deprecated,
        mutable: mergeTable?.mutable,
        local: table.local ? true : undefined,
        notes: mergeTable?.notes,
        tags: mergeTable?.tags,
        staticFields: convertAnalyzedFields(
            table.staticFields,
            mergeTable?.staticFields,
            keepTypes,
            applyHeuristics,
        ),
        overloads: convertAnalyzedOverloads(
            table.overloads,
            mergeTable?.overloads,
            applyHeuristics,
        ),
        operators: mergeTable?.operators,
        methods: convertAnalyzedFunctions(
            table.methods,
            mergeTable?.methods,
            keepTypes,
            applyHeuristics,
        ),
        staticMethods: convertAnalyzedFunctions(
            table.functions,
            mergeTable?.staticMethods,
            keepTypes,
            applyHeuristics,
        ),
    }

    return removeUndefinedOrEmpty(rosettaTable)
}
