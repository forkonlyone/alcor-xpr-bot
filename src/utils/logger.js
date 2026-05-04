import winston from 'winston';
import { mkdirSync } from 'fs';

mkdirSync('logs', { recursive: true });

export function createLogger(level = 'info') {
  return winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message }) => {
        return `[${timestamp}] ${level.toUpperCase()}: ${message}`;
      }),
    ),
    transports: [
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.timestamp({ format: 'HH:mm:ss' }),
          winston.format.printf(({ timestamp, level, message }) => {
            return `[${timestamp}] ${level}: ${message}`;
          }),
        ),
      }),
      new winston.transports.File({ filename: 'logs/bot.log', maxsize: 10_000_000, maxFiles: 5 }),
      new winston.transports.File({ filename: 'logs/error.log', level: 'error', maxsize: 5_000_000, maxFiles: 3 }),
      new winston.transports.File({ filename: 'logs/trades.log', level: 'info', maxsize: 10_000_000, maxFiles: 5 }),
    ],
  });
}
