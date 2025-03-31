import winston from 'winston'
import supportsColor from 'supports-color'

const supportsOutColor = supportsColor.stdout
const supportsErrColor = supportsColor.stderr

const colorizer = winston.format.colorize({
    colors: {
        error: 'red',
        warn: 'yellow',
        info: [],
        verbose: 'blue',
        debug: 'cyan',
    },
})

export const Logger = winston.createLogger({
    level: 'info',
    format: winston.format.errors({ stack: true }),
    transports: [
        new winston.transports.Console({
            forceConsole: true,
            stderrLevels: ['error'],
            format: winston.format.printf((log): string => {
                const level = log.level

                let message = (log.stack ?? log.message) as string
                const doColor =
                    !process.env.NO_COLOR &&
                    (level === 'error' ? supportsErrColor : supportsOutColor)

                const doPrefix =
                    !doColor && level !== 'info' && level !== 'verbose'

                if (doPrefix) {
                    message = `[${level.toUpperCase()}] ${message}`
                }

                if (doColor) {
                    message = colorizer.colorize(level, message)
                }

                return message
            }),
        }),
    ],
})
