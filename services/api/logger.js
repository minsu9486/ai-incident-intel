const pino = require("pino");
const config = require("./config");

const isDev = config.env !== "production";

const baseOptions = {
  level: config.logLevel,
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label })
  }
};

const logger = isDev
  ? pino({
      ...baseOptions,
      transport: {
        target: "pino-pretty",
        options: {
          translateTime: "SYS:HH:MM:ss.l",
          ignore: "pid,hostname",
          singleLine: false
        }
      }
    })
  : pino(baseOptions);

module.exports = logger;
