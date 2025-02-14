import { AnalyzedClass } from '../../analysis'
import { RosettaClass, WritableRosettaClass } from '../../rosetta'
import { removeUndefinedOrEmpty } from '../remove-undefined-or-empty'
import { convertAnalyzedConstructors } from './convert-analyzed-constructors'
import { convertAnalyzedFields } from './convert-analyzed-fields'
import { convertAnalyzedFunctions } from './convert-analyzed-functions'
import { convertAnalyzedOverloads } from './convert-analyzed-overloads'

export const convertAnalyzedClass = (
    cls: AnalyzedClass,
    mergeCls?: RosettaClass,
    keepTypes?: boolean,
): WritableRosettaClass => {
    const rosettaCls: WritableRosettaClass = {
        name: cls.name,
        extends: cls.extends ?? mergeCls?.extends,
        deprecated: mergeCls?.deprecated,
        mutable: mergeCls?.mutable,
        local: cls.local ? true : undefined,
        notes: mergeCls?.notes,
        tags: mergeCls?.tags,
        constructors: convertAnalyzedConstructors(
            cls.constructors,
            mergeCls?.constructors,
            keepTypes,
        ),
        staticFields: convertAnalyzedFields(
            [...cls.staticFields, ...cls.setterFields],
            mergeCls?.staticFields,
            keepTypes,
        ),
        fields: convertAnalyzedFields(cls.fields, mergeCls?.fields, keepTypes),
        overloads: convertAnalyzedOverloads(cls.overloads, mergeCls?.overloads),
        operators: mergeCls?.operators,
        methods: convertAnalyzedFunctions(
            cls.methods,
            mergeCls?.methods,
            keepTypes,
        ),
        staticMethods: convertAnalyzedFunctions(
            [...cls.functions, ...cls.functionConstructors],
            mergeCls?.staticMethods,
            keepTypes,
        ),
    }

    return removeUndefinedOrEmpty(rosettaCls)
}
