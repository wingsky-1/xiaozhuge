/** runtime 统一错误类型：工具层（P3）按 code 装配模型可读的拒绝理由。 */

export class RuntimeError extends Error {
  /** 稳定小写 kebab 错误码，供上游路由与断言。 */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}

export class LedgerError extends RuntimeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LedgerError";
  }
}

export class LockError extends RuntimeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "LockError";
  }
}

export class GateError extends RuntimeError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "GateError";
  }
}
