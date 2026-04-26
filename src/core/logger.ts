import pino from "pino";

// 全モジュール共通の親ロガー。子ロガーは level を継承するので、setLogLevel が全体に伝播する。
const root = pino({ name: "mihari" });

export function logger(component: string): pino.Logger {
  return root.child({ component });
}

export function setLogLevel(level: string): void {
  root.level = level;
}
