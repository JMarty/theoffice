import pino from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const pretty = process.env.NODE_ENV !== "production" && process.stdout.isTTY;

export const logger = pino(
  pretty
    ? {
        level,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
        },
      }
    : { level }
);

/** Child logger tagged with a component name. */
export function log(component: string) {
  return logger.child({ component });
}
