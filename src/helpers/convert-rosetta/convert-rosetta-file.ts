import { AnalyzedModule } from '../../analysis'
import { RosettaFile } from '../../rosetta'
import { convertRosettaClass } from './convert-rosetta-class'
import { convertRosettaFields } from './convert-rosetta-fields'
import { convertRosettaFunctions } from './convert-rosetta-functions'
import { convertRosettaTable } from './convert-rosetta-table'

export const convertRosettaFile = (file: RosettaFile): AnalyzedModule => {
    return {
        id: file.id,
        prefix: file.tags.has('StubGen_Definitions') ? '---@meta _' : undefined,
        classes: Object.values(file.classes).map(convertRosettaClass),
        tables: Object.values(file.tables).map(convertRosettaTable),
        functions: convertRosettaFunctions(file.functions),
        fields: convertRosettaFields(file.fields),
        returns: [],
    }
}
