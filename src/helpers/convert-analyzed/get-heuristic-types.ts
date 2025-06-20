export const getHeuristicTypes = (
    name: string,
    types: Set<string>,
    containerName?: string,
): Set<string> => {
    const checkTypes = new Set(types)
    const nullable = checkTypes.delete('nil')

    if (name.startsWith('_')) {
        name = name.slice(1)
    }

    const heuristicTypes = new Set<string>()
    switch (name.toUpperCase()) {
        case 'OBJ':
            if (checkTypes.size === 0) {
                heuristicTypes.add('IsoObject')
            }

            break

        case 'CONTEXT':
            heuristicTypes.add('ISContextMenu')
            break

        case 'BUTTON':
            if (!containerName) {
                break
            }

            if (containerName?.includes('onJoypad')) {
                heuristicTypes.add('integer')
            } else {
                heuristicTypes.add('ISButton')
            }

            break

        case 'JOYPADINDEX':
            heuristicTypes.add('integer')
            break

        case 'TITLEBARBKG':
            heuristicTypes.add('Texture')
            break

        case 'DOOR':
            heuristicTypes.add('IsoDoor')
            heuristicTypes.add('IsoThumpable')
            break

        case 'JOYPADDATA':
            heuristicTypes.add('JoypadData')
            break

        case 'PLAYEROBJ':
            heuristicTypes.add('IsoPlayer')
            break

        case 'WORLDOBJECTS':
            heuristicTypes.add('IsoObject[]')
            break

        case 'THUMPABLE':
            heuristicTypes.add('IsoThumpable')
            break

        case 'SQ':
        case 'SQUARE':
            heuristicTypes.add('IsoGridSquare')
            break

        case 'DEL':
        case 'DELTA':
            heuristicTypes.add('number')
            break

        case 'PLAYERNUM':
        case 'PLAYERID':
            heuristicTypes.add('integer')
            break

        case 'KEY':
            if (checkTypes.size === 0 || checkTypes.has('number')) {
                heuristicTypes.add('integer')
            }

            break
    }

    if (heuristicTypes.size > 0) {
        if (nullable) {
            heuristicTypes.add('nil')
        }

        return heuristicTypes
    }

    return types
}
