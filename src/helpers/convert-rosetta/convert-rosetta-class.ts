import { AnalyzedClass } from '../../analysis'
import { RosettaClass } from '../../rosetta'
import { convertRosettaConstructors } from './convert-rosetta-constructors'
import { convertRosettaFields } from './convert-rosetta-fields'
import { convertRosettaFunctions } from './convert-rosetta-functions'
import { convertRosettaOverloads } from './convert-rosetta-overloads'

export const convertRosettaClass = (cls: RosettaClass): AnalyzedClass => {
    return {
        name: cls.name,
        extends: cls.extends,
        local: cls.local,
        constructors: convertRosettaConstructors(cls.constructors, cls.name),
        fields: convertRosettaFields(cls.fields),
        staticFields: convertRosettaFields(cls.staticFields),
        literalFields: [],
        setterFields: [],
        functions: convertRosettaFunctions(cls.staticMethods),
        methods: convertRosettaFunctions(cls.methods, true),
        functionConstructors: [],
        overloads: convertRosettaOverloads(cls.overloads),
    }
}
