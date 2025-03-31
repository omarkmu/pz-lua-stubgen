import { AnalyzedTable } from '../../analysis'
import { RosettaTable } from '../../rosetta'
import { convertRosettaFields } from './convert-rosetta-fields'
import { convertRosettaFunctions } from './convert-rosetta-functions'
import { convertRosettaOverloads } from './convert-rosetta-overloads'

export const convertRosettaTable = (table: RosettaTable): AnalyzedTable => {
    return {
        name: table.name,
        local: table.local,
        staticFields: convertRosettaFields(table.staticFields),
        methods: convertRosettaFunctions(table.methods),
        functions: convertRosettaFunctions(table.staticMethods),
        overloads: convertRosettaOverloads(table.overloads),
    }
}
